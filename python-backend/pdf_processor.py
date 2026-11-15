"""PDF processing and redaction helpers for the beta desensitization backend."""

from __future__ import annotations

import base64
import difflib
import io
import math
import os
import shutil
import sys
import tempfile
import time
import zipfile
from contextlib import ExitStack
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator, Mapping, Optional, Sequence, Union
from urllib.parse import quote

import pymupdf as fitz
import pytesseract
import requests
from fontTools.cffLib import CFFFontSet
from fontTools.ttLib import TTFont

from request_context import check_deadline, has_deadline, report_progress, request_timeout, wait_for
from diagnostics import log_event
from local_ocr import read_ocr_data
from paddle_http import normalize_paddle_url, paddle_request, validate_paddle_api_url

ProgressCallback = Callable[[str], None]
OcrTokenLike = Union[Mapping[str, Any], Sequence[Any]]
WarningDict = dict[str, Any]

ALLOWED_OCR_MODES = {"local", "paddle", "baidu"}
ALLOWED_REDACTION_SCOPES = {"strict", "normal", "loose", "line", "paragraph"}
ALLOWED_OCR_LANGUAGES = {"chi_sim+eng", "chi_tra+eng", "eng"}
ALLOWED_EXPORT_DPI = {150, 200, 300}
DEFAULT_FUZZY_THRESHOLD = 0.7
LOCAL_OCR_REVIEW_SCORE = 80.0  # Tesseract score out of 100, not a probability.
MAX_OUTLINE_OCR_PIXELS = 20_000_000
OUTLINE_COMPACT_RECTANGLE_COUNT = 6
OUTLINE_COMPACT_RECTANGLE_ASPECT = 2.0


def _warning(kind: str, keyword: str, lines: Sequence[str], message: str,
             reason: str, action: str, region_kind: str = "line") -> WarningDict:
    """Build a readable warning; the caller supplies a 1-based page if known."""
    regions = ([{"kind": region_kind, "text": text} for text in lines]
               if region_kind in {"line", "block"} else [{"kind": region_kind}])
    return {"type": kind, "keyword": keyword, "page": None, "lines": list(lines),
            "message": message, "reason": reason, "suggestedAction": action, "affectedRegions": regions}


def _cross_line_warning(keyword: str, lines: Sequence[str], message: str) -> WarningDict:
    return _warning("cross_line", keyword, lines, message,
                    "关键词跨越多行，打码区域可能较大。",
                    "请对照原件检查每行及其间区域，确认完整关键词均被覆盖。")


@dataclass(frozen=True)
class RedactionSettings:
    """Validated settings used by the backend during desensitization."""

    ocr_mode: str = "local"
    redaction_scope: str = "normal"
    paddle_api_url: str = ""
    paddle_token: str = ""
    baidu_api_key: str = ""
    baidu_secret_key: str = ""
    ocr_language: str = "chi_sim+eng"
    export_dpi: int = 150
    fuzzy_match_enabled: bool = False
    fuzzy_match_threshold: float = DEFAULT_FUZZY_THRESHOLD


@dataclass(frozen=True)
class OCRToken:
    """Normalized OCR token with optional line and block grouping metadata."""

    text: str
    x: float
    y: float
    w: float
    h: float
    line_id: str
    block_id: str
    source: str = "local"
    coarse: bool = False
    block_inferred: bool = False


@dataclass(frozen=True)
class OCRMatch:
    """Internal OCR match result before padding/expansion is applied."""

    rect: fitz.Rect
    token_indexes: tuple[int, ...]
    line_ids: tuple[str, ...]
    block_ids: tuple[str, ...]
    approximate: bool = False


@dataclass(frozen=True)
class TextStreamMatch:
    """Internal text-layer match result produced from the page character stream."""

    rect: fitz.Rect
    line_ids: tuple[tuple[int, int], ...]
    block_ids: tuple[int, ...]
    approximate: bool = False


def _unique_in_order(values: Sequence[Any]) -> list[Any]:
    """Return values with order preserved and duplicates removed."""

    result: list[Any] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def _coerce_bool(value: object, field_name: str) -> bool:
    """Validate a boolean setting."""

    if isinstance(value, bool):
        return value
    raise ValueError(f"{field_name} must be a boolean")


def _coerce_string(value: object, field_name: str) -> str:
    """Validate a string setting."""

    if isinstance(value, str):
        return value
    raise ValueError(f"{field_name} must be a string")


def _coerce_float(value: object, field_name: str) -> float:
    """Validate a numeric setting and convert it to float."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a number")
    return float(value)


def _coerce_int(value: object, field_name: str) -> int:
    """Validate an integer setting."""

    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field_name} must be an integer")
    return value


def normalize_settings(settings: Optional[Mapping[str, object]]) -> RedactionSettings:
    """Validate incoming settings and return a normalized backend settings object."""

    raw = dict(settings or {})

    ocr_mode = _coerce_string(raw.get("ocr_mode", "local"), "ocr_mode")
    if ocr_mode not in ALLOWED_OCR_MODES:
        raise ValueError(f"ocr_mode must be one of {sorted(ALLOWED_OCR_MODES)}")

    redaction_scope = _coerce_string(raw.get("redaction_scope", "normal"), "redaction_scope")
    if redaction_scope not in ALLOWED_REDACTION_SCOPES:
        raise ValueError(f"redaction_scope must be one of {sorted(ALLOWED_REDACTION_SCOPES)}")

    export_dpi = _coerce_int(raw.get("export_dpi", 150), "export_dpi")
    if export_dpi not in ALLOWED_EXPORT_DPI:
        raise ValueError(f"export_dpi must be one of {sorted(ALLOWED_EXPORT_DPI)}")

    ocr_language = _coerce_string(raw.get("ocr_language", "chi_sim+eng"), "ocr_language")
    if ocr_language not in ALLOWED_OCR_LANGUAGES:
        raise ValueError(f"ocr_language must be one of {sorted(ALLOWED_OCR_LANGUAGES)}")

    fuzzy_match_enabled = _coerce_bool(raw.get("fuzzy_match_enabled", False), "fuzzy_match_enabled")
    fuzzy_match_threshold = _coerce_float(raw.get("fuzzy_match_threshold", DEFAULT_FUZZY_THRESHOLD), "fuzzy_match_threshold")
    if not 0 <= fuzzy_match_threshold <= 1:
        raise ValueError("fuzzy_match_threshold must be between 0 and 1")

    paddle_api_url = _coerce_string(raw.get("paddle_api_url", ""), "paddle_api_url")
    paddle_token = _coerce_string(raw.get("paddle_token", ""), "paddle_token")
    baidu_api_key = _coerce_string(raw.get("baidu_api_key", ""), "baidu_api_key")
    baidu_secret_key = _coerce_string(raw.get("baidu_secret_key", ""), "baidu_secret_key")

    if ocr_mode == "paddle":
        if not paddle_token.strip():
            raise ValueError("paddle_token is required for paddle mode")
        paddle_api_url = validate_paddle_api_url(paddle_api_url)
    if ocr_mode == "baidu" and (not baidu_api_key.strip() or not baidu_secret_key.strip()):
        raise ValueError("baidu_api_key and baidu_secret_key are required for baidu mode")

    return RedactionSettings(
        ocr_mode=ocr_mode,
        redaction_scope=redaction_scope,
        paddle_api_url=paddle_api_url,
        paddle_token=paddle_token,
        baidu_api_key=baidu_api_key,
        baidu_secret_key=baidu_secret_key,
        ocr_language=ocr_language,
        export_dpi=export_dpi,
        fuzzy_match_enabled=fuzzy_match_enabled,
        fuzzy_match_threshold=fuzzy_match_threshold,
    )


class PDFProcessor:
    """Process PDFs for text extraction, redaction, and export."""

    def __init__(self) -> None:
        self._ocr_cache: dict[str, dict[str, Any]] = {}
        self._temp_files: list[str] = []
        self._baidu_token_cache: dict[str, Any] = {}
        self._tesseract_configured = False

    def cleanup(self) -> None:
        """Delete tracked temporary files and directories."""

        for path in self._temp_files:
            self._remove_path(path)
        self._temp_files = []

    def _remove_path(self, path: str) -> None:
        """Delete a single file or directory if it still exists."""

        try:
            if os.path.isfile(path):
                os.remove(path)
            elif os.path.isdir(path):
                shutil.rmtree(path)
        except OSError as exc:
            log_event('cleanup.failed', error=exc)

    def _is_scanned(self, page: fitz.Page) -> bool:
        """Return True when a page has no text layer and likely needs OCR."""

        return len(page.get_text().strip()) == 0

    def _get_page_ocr_data(self, page: fitz.Page, dpi: int = 300, lang: str = "chi_sim+eng",
                           *, png: bytes | None = None) -> dict[str, Any]:
        """Run local OCR for a page and return normalized token metadata."""

        if getattr(sys, "frozen", False) and not self._tesseract_configured:
            base_path = sys._MEIPASS  # type: ignore[attr-defined]
            if sys.platform == "darwin":
                pytesseract.pytesseract.tesseract_cmd = os.path.join(base_path, "tesseract", "tesseract")
                os.environ["TESSDATA_PREFIX"] = os.path.join(base_path, "tesseract", "tessdata")
            elif sys.platform == "win32":
                pytesseract.pytesseract.tesseract_cmd = os.path.join(base_path, "tesseract", "tesseract.exe")
                os.environ["TESSDATA_PREFIX"] = os.path.join(base_path, "tesseract", "tessdata")
            self._tesseract_configured = True

        scale_to_pdf = 72.0 / dpi
        if png is None:
            png = page.get_pixmap(dpi=dpi).tobytes("png")
        check_deadline()
        data = read_ocr_data(png, lang, timeout=request_timeout(15 * 60) if has_deadline() else None)

        tokens: list[dict[str, Any]] = []
        low_score_text: list[str] = []
        for index in range(len(data["text"])):
            text = str(data["text"][index]).strip()
            if not text:
                continue
            try:
                confidence = float(data["conf"][index])
            except (TypeError, ValueError):
                confidence = -1
            if not math.isfinite(confidence):
                confidence = -1
            if 0 <= confidence < LOCAL_OCR_REVIEW_SCORE:
                low_score_text.append(text)
            if confidence <= 0:
                continue
            block_num = int(data.get("block_num", [0])[index])
            par_num = int(data.get("par_num", [0])[index])
            line_num = int(data.get("line_num", [index])[index])
            tokens.append(
                {
                    "text": text,
                    "x": float(data["left"][index]),
                    "y": float(data["top"][index]),
                    "w": float(data["width"][index]),
                    "h": float(data["height"][index]),
                    "line_id": f"block-{block_num}-par-{par_num}-line-{line_num}",
                    "block_id": f"block-{block_num}-par-{par_num}",
                    "source": "local",
                    "coarse": False,
                }
            )

        result: dict[str, Any] = {"tokens": tokens, "scale_to_pdf": scale_to_pdf}
        if low_score_text:
            result["low_confidence_lines"] = _unique_in_order(low_score_text)
        return result

    @staticmethod
    def _has_outline_candidates(page: fitz.Page) -> bool:
        """Find possible outlined text while screening out ordinary table geometry."""

        paint = {kind for kind, _ in page.get_bboxlog()}
        if "fill-shade" in paint:
            return True
        if not paint.intersection({"fill-path", "stroke-path"}):
            return False

        compact_fills: set[tuple[float, float, float, float]] = set()
        for drawing in page.get_cdrawings():
            check_deadline()
            items = drawing.get("items", [])
            rectangles: Iterable[tuple[float, float, float, float]]
            if all(item[0] == "re" for item in items):
                rectangles = (item[1] for item in items)
            elif all(item[0] == "l" and (item[1][0] == item[2][0] or item[1][1] == item[2][1])
                     for item in items):
                if drawing["type"] == "s" and not drawing.get("closePath") and all(
                    first[2] != second[1] for first, second in zip(items, items[1:])
                ):
                    continue  # Separate horizontal and vertical rules, such as a table grid.
                if not (len(items) == 4 and all(item[1] != item[2] for item in items)
                        and all(items[index - 1][2] == item[1] for index, item in enumerate(items))):
                    return True
                corners = {item[1] for item in items}
                if not (len(corners) == 4 and len({x for x, _ in corners}) == len({y for _, y in corners}) == 2):
                    return True
                rectangles = (drawing["rect"],)
            else:
                return True

            if drawing["type"] == "s" or drawing.get("fill_opacity") == 0:
                continue
            # Several compact fills can be the dots of a typeface. Wide
            # backgrounds and stroked cell borders still use the fast path.
            for bounds in rectangles:
                check_deadline()
                x0, y0, x1, y1 = bounds
                width, height = x1 - x0, y1 - y0
                shorter_side = min(width, height)
                if 0 < shorter_side and max(width, height) <= OUTLINE_COMPACT_RECTANGLE_ASPECT * shorter_side:
                    compact_fills.add(bounds)
                    if len(compact_fills) >= OUTLINE_COMPACT_RECTANGLE_COUNT:
                        return True
        return False

    @staticmethod
    def _render_outline_ocr_image(page: fitz.Page, dpi: int) -> bytes | None:
        """Render non-text paint in the unrotated visible page coordinates."""

        width, height = page.rect.width * dpi / 72, page.rect.height * dpi / 72
        if not (0 < width <= MAX_OUTLINE_OCR_PIXELS and 0 < height <= MAX_OUTLINE_OCR_PIXELS
                and math.ceil(width) * math.ceil(height) <= MAX_OUTLINE_OCR_PIXELS):
            return None
        mupdf = fitz.mupdf
        native_page = mupdf.fz_load_page(page.parent.this, page.number)
        scale = mupdf.fz_scale(dpi / 72, dpi / 72)
        bounds = mupdf.fz_round_rect(mupdf.fz_transform_rect(mupdf.fz_bound_page(native_page), scale))
        pixmap = mupdf.fz_new_pixmap_with_bbox(mupdf.fz_device_gray(), bounds, mupdf.FzSeparations(), 0)
        mupdf.fz_clear_pixmap_with_value(pixmap, 255)
        device = mupdf.fz_new_draw_device(scale, pixmap)
        device.m_internal.fill_text = None
        device.m_internal.stroke_text = None
        try:
            mupdf.fz_run_page(native_page, device, mupdf.FzMatrix(), mupdf.FzCookie())
        finally:
            mupdf.fz_close_device(device)
        buffer = mupdf.fz_new_buffer_from_pixmap_as_png(pixmap, mupdf.FzColorParams())
        return bytes(mupdf.fz_buffer_extract_copy(buffer))

    def _get_outline_ocr_data(self, page: fitz.Page, settings: RedactionSettings) -> tuple[dict[str, Any] | None, WarningDict | None]:
        """Check native-text pages locally, without adding cloud OCR requests."""

        rotation = page.rotation
        try:
            if rotation:
                page.set_rotation(0)
            if not self._has_outline_candidates(page):
                return None, None
            check_deadline()
            png = self._render_outline_ocr_image(page, settings.export_dpi)
        finally:
            if rotation:
                page.set_rotation(rotation)
        if png is None:
            warning = _warning("outline_text", "", [], "本页可能含有轮廓文字，页面尺寸超出本机补识别范围。",
                "可见文字可能以图形保存，原生文字搜索可能遗漏。",
                "请对照原件核对本页，或降低识别分辨率后重试。", "page")
            data = None
        else:
            data = self._get_page_ocr_data(page, dpi=settings.export_dpi, lang=settings.ocr_language, png=png)
            warning = _warning("outline_text", "", [], "本页含有疑似轮廓文字。识别遗漏的文字可能仍留在导出文件中。",
                "同一关键词在本页其他位置的命中只覆盖报告标出的区域。",
                "请对照原件核对本页的轮廓文字。", "page")
        warning["page"] = page.number + 1
        return data, warning

    def _get_baidu_token(self, api_key: str, secret_key: str) -> str:
        """Return a cached Baidu OCR token or fetch a fresh one."""

        cache = self._baidu_token_cache
        if cache.get("token") and time.time() < cache.get("expires_at", 0):
            return str(cache["token"])

        url = "https://aip.baidubce.com/oauth/2.0/token"
        data = {
            "grant_type": "client_credentials",
            "client_id": api_key,
            "client_secret": secret_key,
        }
        try:
            http_response = requests.post(url, data=data, timeout=request_timeout(10), allow_redirects=False)
            if 300 <= http_response.status_code < 400:
                http_response.close()
                raise requests.HTTPError("Baidu token redirects are not allowed")
            http_response.raise_for_status()
            response = http_response.json()
            if not isinstance(response, dict):
                raise ValueError("Baidu returned an invalid token response")
            if "error" in response:
                raise RuntimeError(f"Baidu token error: {response.get('error_description', response['error'])}")
            token = response["access_token"]
            if not isinstance(token, str) or not token.strip():
                raise ValueError("Baidu returned no access token")
            expires_at = time.time() + int(response.get("expires_in", 2592000)) - 60
            cache.update(token=token, expires_at=expires_at)
            return token
        except (requests.RequestException, KeyError, ValueError) as exc:
            raise RuntimeError(f"Failed to get Baidu token: {exc}") from exc

    def _get_page_ocr_data_baidu(
        self,
        page: fitz.Page,
        api_key: str,
        secret_key: str,
        dpi: int = 150,
    ) -> dict[str, Any]:
        """Run Baidu OCR for a page and return normalized token metadata."""

        if not api_key or not secret_key:
            raise ValueError("api_key and secret_key cannot be empty")
        matrix = fitz.Matrix(dpi / 72, dpi / 72)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        image_b64 = base64.b64encode(pix.tobytes("png")).decode()
        token = self._get_baidu_token(api_key, secret_key)
        url = f"https://aip.baidubce.com/rest/2.0/ocr/v1/general?access_token={token}"
        try:
            for attempt in range(2):
                http_response = requests.post(url, data={"image": image_b64, "detect_direction": "false"}, timeout=request_timeout(30), allow_redirects=False)
                if 300 <= http_response.status_code < 400:
                    http_response.close()
                    raise requests.HTTPError("Baidu OCR redirects are not allowed")
                http_response.raise_for_status()
                response = http_response.json()
                if not isinstance(response, dict):
                    raise ValueError("Baidu OCR returned an invalid response")
                if response.get("error_code") == 18 and attempt == 0:
                    wait_for(1)
                    continue
                break
            if "error_code" in response:
                raise RuntimeError(f"Baidu OCR error: {response.get('error_msg', response['error_code'])}")
            if not isinstance(response.get("words_result"), list):
                raise ValueError("Baidu OCR returned no valid words_result")
            tokens: list[dict[str, Any]] = []
            for index, item in enumerate(response["words_result"]):
                location = item["location"]
                tokens.append(
                    {
                        "text": item["words"],
                        "x": float(location["left"]),
                        "y": float(location["top"]),
                        "w": float(location["width"]),
                        "h": float(location["height"]),
                        "line_id": f"line-{index}",
                        "block_id": "",  # This response identifies lines, not paragraphs.
                        "source": "baidu",
                        "coarse": False,
                    }
                )
            wait_for(0.15)
            return {"tokens": tokens, "scale_to_pdf": 72.0 / dpi}
        except (requests.RequestException, KeyError, ValueError, TypeError) as exc:
            raise RuntimeError(f"Failed to call Baidu OCR: {exc}") from exc

    def _fetch_paddle_all_pages(
        self,
        file_path: str,
        api_url: str,
        token: str,
        dpi: int = 150,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> list[dict[str, Any]]:
        """Fetch Paddle OCR results for a full PDF and cache line/block metadata."""

        import json as json_module

        normalized_path = os.path.normpath(file_path)
        headers = {"Authorization": f"bearer {token}"}
        try:
            base_url = normalize_paddle_url(api_url.strip(), base=True)
            job_url = f"{base_url.rstrip('/')}/api/v2/ocr/jobs"
            for attempt in range(5):
                report_progress('ocr', f'正在提交 OCR 任务（第{attempt + 1}次）')
                with open(normalized_path, "rb") as handle:
                    response = paddle_request(
                        "POST", job_url,
                        headers=headers,
                        data={
                            "model": "PaddleOCR-VL-1.5",
                            "optionalPayload": json_module.dumps({
                                "useDocOrientationClassify": False,
                                "useDocUnwarping": False,
                            }),
                        },
                        files={"file": handle},
                        timeout=request_timeout(30),
                    )
                if response.status_code == 200:
                    break
                error_payload = (
                    response.json()
                    if response.headers.get("content-type", "").startswith("application/json")
                    else {}
                )
                if error_payload.get("code") == 10010:
                    wait_for((attempt + 1) * 10)
                    continue
                raise RuntimeError(f"PaddleOCR job submit failed {response.status_code}: {response.text[:200]}")
            else:
                raise RuntimeError("PaddleOCR job submit failed: queue full after 5 retries")

            job_id = response.json()["data"]["jobId"]
            if not isinstance(job_id, str) or not job_id:
                raise ValueError("PaddleOCR returned an invalid job ID")
            poll_url = f"{job_url}/{quote(job_id, safe='')}"

            jsonl_url = ""
            poll_started = time.monotonic()
            for attempt in range(120):
                if progress_callback:
                    progress_callback(f"PaddleOCR 处理中...（已等待{int(time.monotonic() - poll_started)}秒）")
                wait_for(5)
                poll_response = paddle_request("GET", poll_url, headers=headers, timeout=request_timeout(15))
                poll_response.raise_for_status()
                state = poll_response.json()["data"]["state"]
                if state == "done":
                    jsonl_url = poll_response.json()["data"]["resultUrl"]["jsonUrl"]
                    break
                if state == "failed":
                    raise RuntimeError(f"PaddleOCR job failed: {poll_response.json()['data'].get('errorMsg', '')}")
            else:
                raise RuntimeError("PaddleOCR job did not complete within 120 polls")

            result_response = paddle_request("GET", jsonl_url, timeout=request_timeout(30))
            result_response.raise_for_status()
            lines = result_response.text.strip().split("\n")
            pages: list[dict[str, Any]] = []
            for line in lines:
                if not line.strip():
                    continue
                result = json_module.loads(line).get("result", {})
                for page_index, layout_result in enumerate(result.get("layoutParsingResults", [])):
                    pruned = layout_result.get("prunedResult", {})
                    # Boxes must describe the original rendered page. A cloud
                    # rotation or nonlinear unwarping cannot be undone by the
                    # PDF page's derotation matrix alone.
                    preprocessing = pruned.get("doc_preprocessor_res") or {}
                    preprocessing_settings = preprocessing.get("model_settings", {})
                    angle = preprocessing.get("angle")
                    if (
                        preprocessing_settings.get("use_doc_unwarping")
                        or angle not in (None, -1, 0)
                        or (preprocessing_settings.get("use_doc_orientation_classify") and angle is None)
                        or (pruned.get("model_settings", {}).get("use_doc_preprocessor") and not preprocessing)
                    ):
                        raise ValueError("PaddleOCR returned transformed page coordinates; disable orientation and unwarping")
                    image_width = float(pruned.get("width") or 0)
                    image_height = float(pruned.get("height") or 0)
                    tokens: list[dict[str, Any]] = []
                    for block_index, block in enumerate(pruned.get("parsing_res_list", [])):
                        content = str(block.get("block_content", "")).strip()
                        if not content:
                            continue
                        bbox = block.get("block_bbox", [0, 0, 0, 0])
                        bx1, by1, bx2, by2 = [float(value) for value in bbox]
                        block_width = bx2 - bx1
                        block_height = by2 - by1
                        block_id = f"page-{page_index}-block-{block_index}"
                        lines_in_block = [entry for entry in content.split("\n") if entry.strip()] or [content]
                        line_height = block_height / len(lines_in_block) if lines_in_block else block_height
                        for line_index, line_text in enumerate(lines_in_block):
                            line_y = by1 + line_index * line_height
                            tokens.append(
                                {
                                    "text": line_text,
                                    "x": bx1,
                                    "y": line_y,
                                    "w": block_width,
                                    "h": line_height,
                                    "line_id": f"{block_id}-line-{line_index}",
                                    "block_id": block_id,
                                    "source": "paddle",
                                    "coarse": True,
                                }
                            )
                    pages.append({"tokens": tokens, "img_w": image_width, "img_h": image_height})
            return pages
        except (requests.RequestException, KeyError, ValueError) as exc:
            raise RuntimeError(f"Failed to call PaddleOCR: {exc}") from exc

    def _get_page_ocr_data_by_mode(self, page: fitz.Page, settings: RedactionSettings, page_key: str) -> dict[str, Any]:
        """Return OCR data for a page according to the configured OCR mode."""

        if settings.ocr_mode == "baidu":
            return self._get_page_ocr_data_baidu(page, settings.baidu_api_key, settings.baidu_secret_key, dpi=settings.export_dpi)
        if settings.ocr_mode == "paddle":
            cached = self._ocr_cache.get(page_key)
            if cached is not None:
                return cached
            raise RuntimeError(f"PaddleOCR cache miss for page_key={page_key}. 请确保已调用预取。")

        if page_key in self._ocr_cache:
            return self._ocr_cache[page_key]
        result = self._get_page_ocr_data(page, dpi=settings.export_dpi, lang=settings.ocr_language)
        self._ocr_cache[page_key] = result
        return result

    def _normalize_for_match(self, text: str) -> str:
        """Normalize text for matching by removing all whitespace."""

        return "".join(character for character in text if not character.isspace())

    def _iter_match_positions(self, text: str, keyword: str) -> Iterator[int]:
        """Yield all exact match positions for keyword inside text."""

        if not text or not keyword:
            return
        start = 0
        while True:
            position = text.find(keyword, start)
            if position == -1:
                return
            yield position
            start = position + 1

    def _iter_approximate_ranges(self, text: str, keyword: str, threshold: float) -> Iterator[tuple[int, int]]:
        """Yield approximate matches in a normalized text stream."""

        if not text or not keyword or len(keyword) < 4:
            return
        seen: set[tuple[int, int]] = set()
        target_length = len(keyword)
        exact_positions = list(self._iter_match_positions(text, keyword))
        min_length = max(1, target_length - 1)
        max_length = min(len(text), target_length + 1)
        for size in range(min_length, max_length + 1):
            exact_index = 0
            for start in range(0, len(text) - size + 1):
                end = start + size
                while exact_index < len(exact_positions) and exact_positions[exact_index] + target_length <= start:
                    exact_index += 1
                if exact_index < len(exact_positions) and exact_positions[exact_index] < end:
                    continue
                window = text[start:end]
                if difflib.SequenceMatcher(None, window, keyword).ratio() < threshold:
                    continue
                key = (start, end)
                if key in seen:
                    continue
                seen.add(key)
                yield key

    def _append_unique_rect(self, rects: list[fitz.Rect], rect: fitz.Rect) -> None:
        """Discard fully covered rectangles; preserve partial overlaps."""

        if any(existing.contains(rect) for existing in rects):
            return
        rects[:] = [existing for existing in rects if not rect.contains(existing)]
        rects.append(rect)

    def _build_page_char_stream(
        self,
        page: Any,
    ) -> tuple[str, list[dict[str, Any]], dict[tuple[int, int], fitz.Rect], dict[int, fitz.Rect], dict[tuple[int, int], str]]:
        """Build a normalized character stream for a text PDF page."""

        words = page.get_text("words", sort=True) or []
        stream_chars: list[str] = []
        char_meta: list[dict[str, Any]] = []
        line_rects: dict[tuple[int, int], fitz.Rect] = {}
        block_rects: dict[int, fitz.Rect] = {}
        line_text_by_id: dict[tuple[int, int], str] = {}
        line_words: dict[tuple[int, int], list[str]] = {}

        for word in words:
            if len(word) < 8:
                continue
            x0, y0, x1, y1, text, block_no, line_no, _ = word[:8]
            if not text:
                continue
            line_id = (int(block_no), int(line_no))
            block_id = int(block_no)
            rect = fitz.Rect(float(x0), float(y0), float(x1), float(y1))
            line_rects[line_id] = line_rects.get(line_id, rect) | rect if line_id in line_rects else fitz.Rect(rect)
            block_rects[block_id] = block_rects.get(block_id, rect) | rect if block_id in block_rects else fitz.Rect(rect)
            line_words.setdefault(line_id, []).append(str(text))
            for character in str(text):
                if character.isspace():
                    continue
                stream_chars.append(character)
                char_meta.append({"rect": rect, "line_id": line_id, "block_id": block_id})

        for line_id, parts in line_words.items():
            line_text_by_id[line_id] = " ".join(parts).strip()

        return "".join(stream_chars), char_meta, line_rects, block_rects, line_text_by_id

    def _search_cross_line(self, page: Any, keyword: str) -> tuple[list[fitz.Rect], Optional[WarningDict]]:
        """Search for cross-line text matches and return match rectangles plus one warning."""

        matches = self._search_text_stream(page, keyword, approximate=False)
        rects: list[fitz.Rect] = []
        warning: Optional[WarningDict] = None
        for match in matches:
            self._append_unique_rect(rects, fitz.Rect(match.rect))
            if warning is None and len(match.line_ids) > 1:
                _, _, _, _, line_text_by_id = self._build_page_char_stream(page)
                lines = [line_text_by_id.get(line_id, "").strip() for line_id in match.line_ids]
                lines = [line for line in lines if line]
                warning = _cross_line_warning(keyword, lines,
                    f'关键词"{keyword}"跨越{len(lines)}行，已按当前范围打码，请复核各行及其间区域。')
        return rects, warning

    def _search_text_stream(
        self,
        page: Any,
        keyword: str,
        approximate: bool = False,
        threshold: float = DEFAULT_FUZZY_THRESHOLD,
    ) -> list[TextStreamMatch]:
        """Search the text-layer character stream for normalized exact or approximate matches."""

        normalized_keyword = self._normalize_for_match(keyword)
        if not normalized_keyword:
            return []

        stream_text, char_meta, _, _, _ = self._build_page_char_stream(page)
        if not stream_text:
            return []

        ranges: Iterator[tuple[int, int]]
        if approximate:
            ranges = self._iter_approximate_ranges(stream_text, normalized_keyword, threshold)
        else:
            ranges = ((start, start + len(normalized_keyword)) for start in self._iter_match_positions(stream_text, normalized_keyword))

        matches: list[TextStreamMatch] = []
        for start, end in ranges:
            matched = char_meta[start:end]
            if not matched:
                continue
            rects = [item["rect"] for item in matched]
            line_ids = tuple(_unique_in_order([item["line_id"] for item in matched]))
            block_ids = tuple(_unique_in_order([item["block_id"] for item in matched]))
            if approximate and len(line_ids) != 1:
                continue
            match = TextStreamMatch(
                rect=fitz.Rect(
                    min(rect.x0 for rect in rects),
                    min(rect.y0 for rect in rects),
                    max(rect.x1 for rect in rects),
                    max(rect.y1 for rect in rects),
                ),
                line_ids=line_ids,
                block_ids=block_ids,
                approximate=approximate,
            )
            if not any(existing.rect.intersects(match.rect) and existing.line_ids == match.line_ids for existing in matches):
                matches.append(match)
        return matches

    def _get_text_blocks(self, page: Any) -> list[tuple[int, fitz.Rect]]:
        """Return text block rectangles keyed by block number."""

        blocks = page.get_text("blocks", sort=True) or []
        results: list[tuple[int, fitz.Rect]] = []
        for block in blocks:
            if len(block) < 5:
                continue
            x0, y0, x1, y1 = block[:4]
            block_no = int(block[5]) if len(block) > 5 else len(results)
            results.append((block_no, fitz.Rect(float(x0), float(y0), float(x1), float(y1))))
        return results

    def _pad_rect(self, rect: fitz.Rect, padding: float, page_width: float, page_height: float) -> fitz.Rect:
        """Pad a rectangle and clip it to the page bounds."""

        return fitz.Rect(
            max(0, rect.x0 - padding),
            max(0, rect.y0 - padding),
            min(page_width, rect.x1 + padding),
            min(page_height, rect.y1 + padding),
        )

    def _padding_for_scope(self, scope: str) -> float:
        """Return the configured padding for a redaction scope."""

        return 1.0 if scope == "strict" else 2.0

    def _page_derotation_matrix(self, page: Any) -> fitz.Matrix:
        """Map displayed points to the unrotated visible page origin."""

        matrix = getattr(page, "derotation_matrix", None)
        if matrix is None:
            return fitz.Matrix(1, 1)
        matrix = fitz.Matrix(matrix)
        bounds = page.rect * matrix
        # In PyMuPDF 1.24.14 the rotation matrix translations can omit
        # /UserUnit. Anchor the transformed visible bounds at (0, 0) instead
        # of trusting those unscaled translations or adding CropBox offsets.
        return fitz.Matrix(
            matrix.a, matrix.b, matrix.c, matrix.d,
            matrix.e - bounds.x0, matrix.f - bounds.y0,
        )

    def _expand_text_matches_to_lines(self, page: Any, matches: Sequence[fitz.Rect]) -> list[fitz.Rect]:
        """Expand text matches to their containing full lines."""

        _, _, line_rects, _, _ = self._build_page_char_stream(page)
        expanded: list[fitz.Rect] = []
        for match in matches:
            found = False
            for line_rect in line_rects.values():
                if line_rect.intersects(match):
                    self._append_unique_rect(expanded, fitz.Rect(line_rect))
                    found = True
            if not found:
                self._append_unique_rect(expanded, fitz.Rect(match))
        return expanded

    def _expand_text_matches_to_blocks(self, page: Any, matches: Sequence[fitz.Rect]) -> list[fitz.Rect]:
        """Expand text matches to their containing full text blocks."""

        blocks = self._get_text_blocks(page)
        expanded: list[fitz.Rect] = []
        for match in matches:
            found = False
            for _, block_rect in blocks:
                if block_rect.intersects(match):
                    self._append_unique_rect(expanded, fitz.Rect(block_rect))
                    found = True
            if not found:
                self._append_unique_rect(expanded, fitz.Rect(match))
        return expanded

    def _find_text_rects(
        self,
        page: Any,
        keyword: str,
        settings: RedactionSettings,
        match_details: Optional[list[tuple[fitz.Rect, bool]]] = None,
    ) -> tuple[list[fitz.Rect], list[WarningDict]]:
        """Find redaction rectangles for a text-layer PDF page under the configured scope."""

        page_rect = getattr(page, "rect", fitz.Rect(0, 0, 10_000, 10_000))
        # Text search/expansion already returns unrotated, CropBox-relative
        # coordinates; Page.rect alone reflects the displayed rotation.
        page_rect = page_rect * self._page_derotation_matrix(page)
        padding = self._padding_for_scope(settings.redaction_scope)
        warnings: list[WarningDict] = []
        raw_matches: list[fitz.Rect] = []
        details: list[tuple[fitz.Rect, bool]] = []

        for rect in page.search_for(keyword):
            self._append_unique_rect(raw_matches, fitz.Rect(rect))
            details.append((fitz.Rect(rect), False))

        exact_stream_matches = self._search_text_stream(page, keyword, approximate=False)
        for match in exact_stream_matches:
            if len(match.line_ids) > 1 and settings.redaction_scope == "strict":
                continue
            self._append_unique_rect(raw_matches, fitz.Rect(match.rect))
            details.append((fitz.Rect(match.rect), False))
            if len(match.line_ids) > 1:
                _, _, _, _, line_text_by_id = self._build_page_char_stream(page)
                lines = [line_text_by_id.get(line_id, "").strip() for line_id in match.line_ids]
                lines = [line for line in lines if line]
                warnings.append(_cross_line_warning(keyword, lines,
                    f'关键词"{keyword}"跨越{len(lines)}行，已按当前范围打码，请复核各行及其间区域。'))

        if settings.fuzzy_match_enabled:
            for match in self._search_text_stream(page, keyword, approximate=True, threshold=settings.fuzzy_match_threshold):
                self._append_unique_rect(raw_matches, fitz.Rect(match.rect))
                details.append((fitz.Rect(match.rect), True))

        if settings.redaction_scope == "line":
            raw_matches = self._expand_text_matches_to_lines(page, raw_matches)
        elif settings.redaction_scope == "paragraph":
            raw_matches = self._expand_text_matches_to_blocks(page, raw_matches)

        rects: list[fitz.Rect] = []
        for rect in raw_matches:
            self._append_unique_rect(rects, self._pad_rect(rect, padding, float(page_rect.width), float(page_rect.height)))
        if match_details is not None:
            for approximate in (False, True):
                candidates = [rect for rect, method in details if method == approximate]
                if settings.redaction_scope == "line":
                    candidates = self._expand_text_matches_to_lines(page, candidates)
                elif settings.redaction_scope == "paragraph":
                    candidates = self._expand_text_matches_to_blocks(page, candidates)
                for rect in candidates:
                    match_details.append((self._pad_rect(rect, padding, float(page_rect.width), float(page_rect.height)), approximate))
        return rects, warnings

    def _coerce_ocr_tokens(self, tokens: Sequence[OcrTokenLike]) -> list[OCRToken]:
        """Normalize mixed OCR token inputs into a consistent internal token structure."""

        normalized: list[OCRToken] = []
        current_line = 0
        line_anchor_y: Optional[float] = None
        line_height = 0.0

        for index, token in enumerate(tokens):
            if isinstance(token, Mapping):
                text = str(token.get("text", ""))
                x = float(token.get("x", 0))
                y = float(token.get("y", 0))
                w = float(token.get("w", 0))
                h = float(token.get("h", 0))
                line_id = str(token.get("line_id") or "")
                block_id = str(token.get("block_id") or "")
                source = str(token.get("source", "local"))
                coarse = bool(token.get("coarse", False))
            else:
                if len(token) < 5:
                    continue
                text = str(token[0])
                x = float(token[1])
                y = float(token[2])
                w = float(token[3])
                h = float(token[4])
                line_id = ""
                block_id = ""
                source = "local"
                coarse = False

            if not text:
                continue

            if not line_id:
                if line_anchor_y is None:
                    current_line += 1
                    line_anchor_y = y
                    line_height = h or 1
                elif abs(y - line_anchor_y) > max(line_height, h or 1) * 0.6:
                    current_line += 1
                    line_anchor_y = y
                    line_height = h or line_height or 1
                line_id = f"line-{current_line}"
            block_inferred = not block_id
            if not block_id:
                block_id = line_id

            normalized.append(
                OCRToken(
                    text=text,
                    x=x,
                    y=y,
                    w=w,
                    h=h,
                    line_id=line_id,
                    block_id=block_id,
                    source=source,
                    coarse=coarse,
                    block_inferred=block_inferred,
                )
            )
        return normalized

    def _build_ocr_char_stream(self, tokens: Sequence[OCRToken]) -> tuple[str, list[int]]:
        """Build a normalized character stream for OCR tokens."""

        stream_chars: list[str] = []
        token_indexes: list[int] = []
        for index, token in enumerate(tokens):
            for character in token.text:
                if character.isspace():
                    continue
                stream_chars.append(character)
                token_indexes.append(index)
        return "".join(stream_chars), token_indexes

    def _build_ocr_group_rects(self, tokens: Sequence[OCRToken], group: str) -> dict[str, fitz.Rect]:
        """Build union rectangles for OCR line or block groups."""

        result: dict[str, fitz.Rect] = {}
        for token in tokens:
            key = token.line_id if group == "line" else token.block_id
            rect = fitz.Rect(token.x, token.y, token.x + token.w, token.y + token.h)
            if key in result:
                result[key] = result[key] | rect
            else:
                result[key] = rect
        return result

    def _match_is_unstable_for_paddle(self, match: OCRMatch, tokens: Sequence[OCRToken], keyword: str) -> bool:
        """Detect Paddle matches that need line-level fallback to avoid false precision."""

        normalized_keyword = self._normalize_for_match(keyword)
        if not any(tokens[index].source == "paddle" for index in match.token_indexes):
            return False
        return any(self._normalize_for_match(tokens[index].text) != normalized_keyword for index in match.token_indexes)

    def _build_ocr_warning(self, keyword: str, line_ids: Sequence[str], scope: str,
                           tokens: Sequence[OCRToken]) -> WarningDict:
        """Create a warning for coarse Paddle OCR fallback expansion."""

        target = "文本块" if scope == "paragraph" else "整行"

        blocks = {token.block_id for token in tokens if token.line_id in line_ids}
        selected = [token for token in tokens if
                    (token.block_id in blocks if scope == "paragraph" else token.line_id in line_ids)]
        groups: dict[str, list[str]] = {}
        for token in selected:
            key = token.block_id if scope == "paragraph" else token.line_id
            groups.setdefault(key, []).append(token.text)
        lines = [" ".join(parts) for parts in groups.values()]
        warning = _warning("coarse_location", keyword, lines,
                        f'PaddleOCR 无法稳定定位关键词"{keyword}"的细粒度位置，已退化为{target}打码。',
                        "OCR仅提供粗粒度坐标，无法可靠定位到单字。",
                        "请检查该行或文本块是否覆盖完整敏感内容，同时确认公开文字是否被误遮盖。",
                        "block" if scope == "paragraph" else "line")
        for region, group_id in zip(warning["affectedRegions"], groups):
            region["id"] = group_id
        return warning

    def _find_ocr_exact_matches(self, tokens: Sequence[OCRToken], keyword: str, allow_multi_token: bool) -> list[OCRMatch]:
        """Find exact OCR matches either within a token or across contiguous tokens in a line."""

        normalized_keyword = self._normalize_for_match(keyword)
        if not normalized_keyword:
            return []

        matches: list[OCRMatch] = []
        if not allow_multi_token:
            for index, token in enumerate(tokens):
                normalized_text = self._normalize_for_match(token.text)
                if normalized_keyword not in normalized_text:
                    continue
                rect = fitz.Rect(token.x, token.y, token.x + token.w, token.y + token.h)
                matches.append(
                    OCRMatch(
                        rect=rect,
                        token_indexes=(index,),
                        line_ids=(token.line_id,),
                        block_ids=(token.block_id,),
                    )
                )
            return matches

        tokens_by_line: dict[str, list[int]] = {}
        for index, token in enumerate(tokens):
            tokens_by_line.setdefault(token.line_id, []).append(index)

        for line_indexes in tokens_by_line.values():
            line_tokens = [tokens[index] for index in line_indexes]
            stream_text, token_index_by_char = self._build_ocr_char_stream(line_tokens)
            for start in self._iter_match_positions(stream_text, normalized_keyword):
                end = start + len(normalized_keyword)
                matched_local_indexes = token_index_by_char[start:end]
                if not matched_local_indexes:
                    continue
                matched_indexes = tuple(_unique_in_order([line_indexes[index] for index in matched_local_indexes]))
                rects = [
                    fitz.Rect(tokens[index].x, tokens[index].y, tokens[index].x + tokens[index].w, tokens[index].y + tokens[index].h)
                    for index in matched_indexes
                ]
                matches.append(
                    OCRMatch(
                        rect=fitz.Rect(
                            min(rect.x0 for rect in rects),
                            min(rect.y0 for rect in rects),
                            max(rect.x1 for rect in rects),
                            max(rect.y1 for rect in rects),
                        ),
                        token_indexes=matched_indexes,
                        line_ids=tuple(_unique_in_order([tokens[index].line_id for index in matched_indexes])),
                        block_ids=tuple(_unique_in_order([tokens[index].block_id for index in matched_indexes])),
                    )
                )
        return matches

    def _find_ocr_cross_line_matches(
        self, tokens: Sequence[OCRToken], keyword: str,
    ) -> tuple[list[OCRMatch], list[WarningDict]]:
        """Join only adjacent, geometrically aligned lines in reading order."""

        groups: list[list[int]] = []
        seen_lines: set[str] = set()
        for index, token in enumerate(tokens):
            if not groups or tokens[groups[-1][0]].line_id != token.line_id:
                if token.line_id in seen_lines:
                    return [], []  # Interleaved line identities have ambiguous order.
                seen_lines.add(token.line_id)
                groups.append([])
            groups[-1].append(index)

        runs: list[list[int]] = []
        previous: Optional[tuple[list[int], fitz.Rect]] = None
        for indexes in groups:
            entries = [tokens[index] for index in indexes]
            valid = all(math.isfinite(value) for token in entries for value in (token.x, token.y, token.w, token.h))
            valid = valid and all(token.w > 0 and token.h > 0 for token in entries)
            valid = valid and all(left.x <= right.x for left, right in zip(entries, entries[1:]))
            if not valid:
                previous = None
                continue
            rect = fitz.Rect(min(t.x for t in entries), min(t.y for t in entries),
                             max(t.x + t.w for t in entries), max(t.y + t.h for t in entries))
            join = False
            if previous:
                previous_indexes, prior = previous
                combined = [tokens[index] for index in previous_indexes + indexes]
                inferred = all(token.block_inferred for token in combined)
                same_block = not any(token.block_inferred for token in combined) and len({t.block_id for t in combined}) == 1
                height = min(prior.height, rect.height)
                gap = rect.y0 - prior.y1
                join = (inferred or same_block) and max(prior.height, rect.height) <= height * 2
                join = join and rect.y0 >= prior.y0 + height * 0.5 and -height * 0.25 <= gap <= height * 1.5
                join = join and abs(rect.x0 - prior.x0) <= height * 2 and min(prior.x1, rect.x1) > max(prior.x0, rect.x0)
            if join:
                runs[-1].extend(indexes)
            else:
                runs.append(list(indexes))
            previous = indexes, rect

        matches: list[OCRMatch] = []
        warnings: list[WarningDict] = []
        seen: set[tuple[int, ...]] = set()
        normalized_keyword = self._normalize_for_match(keyword)
        line_text = {tokens[group[0]].line_id: " ".join(tokens[i].text for i in group) for group in groups}
        for run in runs:
            stream, mapping = self._build_ocr_char_stream([tokens[index] for index in run])
            for start in self._iter_match_positions(stream, normalized_keyword):
                matched_indexes = tuple(_unique_in_order([run[i] for i in mapping[start:start + len(normalized_keyword)]]))
                line_ids = tuple(_unique_in_order([tokens[i].line_id for i in matched_indexes]))
                if len(line_ids) < 2 or matched_indexes in seen:
                    continue
                seen.add(matched_indexes)
                for line_id in line_ids:
                    selected = tuple(i for i in matched_indexes if tokens[i].line_id == line_id)
                    entries = [tokens[i] for i in selected]
                    rect = fitz.Rect(min(t.x for t in entries), min(t.y for t in entries),
                                     max(t.x + t.w for t in entries), max(t.y + t.h for t in entries))
                    matches.append(OCRMatch(rect, selected, (line_id,), tuple(_unique_in_order([t.block_id for t in entries]))))
                warnings.append(_cross_line_warning(keyword, [line_text[line] for line in line_ids],
                    f'关键词"{keyword}"跨越{len(line_ids)}行，已按各行分别打码，请复核识别内容与阅读顺序。'))
        return matches, warnings

    def _find_ocr_approximate_matches(
        self, tokens: Sequence[OCRToken], keyword: str, threshold: float, allow_multi_token: bool = True,
    ) -> list[OCRMatch]:
        """Find approximate OCR matches inside a single line."""

        normalized_keyword = self._normalize_for_match(keyword)
        if not normalized_keyword:
            return []

        matches: list[OCRMatch] = []
        tokens_by_line: dict[str, list[int]] = {}
        for index, token in enumerate(tokens):
            group = token.line_id if allow_multi_token else f"token-{index}"
            tokens_by_line.setdefault(group, []).append(index)

        for line_indexes in tokens_by_line.values():
            line_tokens = [tokens[index] for index in line_indexes]
            stream_text, token_index_by_char = self._build_ocr_char_stream(line_tokens)
            for start, end in self._iter_approximate_ranges(stream_text, normalized_keyword, threshold):
                matched_local_indexes = token_index_by_char[start:end]
                if not matched_local_indexes:
                    continue
                matched_indexes = tuple(_unique_in_order([line_indexes[index] for index in matched_local_indexes]))
                rects = [
                    fitz.Rect(tokens[index].x, tokens[index].y, tokens[index].x + tokens[index].w, tokens[index].y + tokens[index].h)
                    for index in matched_indexes
                ]
                match = OCRMatch(
                    rect=fitz.Rect(
                        min(rect.x0 for rect in rects),
                        min(rect.y0 for rect in rects),
                        max(rect.x1 for rect in rects),
                        max(rect.y1 for rect in rects),
                    ),
                    token_indexes=matched_indexes,
                    line_ids=tuple(_unique_in_order([tokens[index].line_id for index in matched_indexes])),
                    block_ids=tuple(_unique_in_order([tokens[index].block_id for index in matched_indexes])),
                    approximate=True,
                )
                if not any(existing.rect.intersects(match.rect) and existing.line_ids == match.line_ids for existing in matches):
                    matches.append(match)
        return matches

    def _find_ocr_rects_with_warnings(
        self,
        tokens: Sequence[OcrTokenLike],
        keyword: str,
        page_height: float,
        page_width: float,
        scale_to_pdf: float,
        settings: RedactionSettings,
        scale_y_to_pdf: Optional[float] = None,
        match_details: Optional[list[tuple[fitz.Rect, bool]]] = None,
    ) -> tuple[list[fitz.Rect], list[WarningDict]]:
        """Find OCR redaction rectangles and warnings under the configured scope."""

        normalized_tokens = self._coerce_ocr_tokens(tokens)
        if not normalized_tokens:
            return [], []
        scale_y = scale_to_pdf if scale_y_to_pdf is None else scale_y_to_pdf

        allow_multi_token = settings.redaction_scope != "strict"
        matches = self._find_ocr_exact_matches(normalized_tokens, keyword, allow_multi_token=allow_multi_token)
        warnings: list[WarningDict] = []
        if allow_multi_token:
            cross_matches, warnings = self._find_ocr_cross_line_matches(normalized_tokens, keyword)
            matches.extend(cross_matches)
        if settings.fuzzy_match_enabled:
            matches.extend(self._find_ocr_approximate_matches(
                normalized_tokens, keyword, settings.fuzzy_match_threshold, allow_multi_token=allow_multi_token,
            ))

        line_rects = self._build_ocr_group_rects(normalized_tokens, group="line")
        block_rects = self._build_ocr_group_rects(normalized_tokens, group="block")
        rects: list[fitz.Rect] = []

        def append_rect(rect: fitz.Rect, approximate: bool) -> None:
            self._append_unique_rect(rects, rect)
            if match_details is not None:
                match_details.append((fitz.Rect(rect), approximate))

        for match in matches:
            raw_rect = fitz.Rect(match.rect)
            if self._match_is_unstable_for_paddle(match, normalized_tokens, keyword):
                if settings.redaction_scope == "paragraph":
                    fallback_rects = [block_rects[block_id] for block_id in match.block_ids if block_id in block_rects]
                else:
                    fallback_rects = [line_rects[line_id] for line_id in match.line_ids if line_id in line_rects]
                if not fallback_rects:
                    fallback_rects = [raw_rect]

                for fallback_rect in fallback_rects:
                    append_rect(
                        self._pad_rect(
                            fitz.Rect(
                                fallback_rect.x0 * scale_to_pdf,
                                fallback_rect.y0 * scale_y,
                                fallback_rect.x1 * scale_to_pdf,
                                fallback_rect.y1 * scale_y,
                            ),
                            self._padding_for_scope(settings.redaction_scope),
                            page_width,
                            page_height,
                        ),
                        match.approximate,
                    )
                warnings.append(self._build_ocr_warning(keyword, match.line_ids, settings.redaction_scope, normalized_tokens))
                continue

            if settings.redaction_scope == "line":
                group_rects = [line_rects[line_id] for line_id in match.line_ids if line_id in line_rects]
            elif settings.redaction_scope == "paragraph":
                group_rects = [block_rects[block_id] for block_id in match.block_ids if block_id in block_rects]
            else:
                group_rects = [raw_rect]

            for group_rect in group_rects:
                scaled_rect = fitz.Rect(
                    group_rect.x0 * scale_to_pdf,
                    group_rect.y0 * scale_y,
                    group_rect.x1 * scale_to_pdf,
                    group_rect.y1 * scale_y,
                )
                append_rect(
                    self._pad_rect(scaled_rect, self._padding_for_scope(settings.redaction_scope), page_width, page_height),
                    match.approximate,
                )

        return rects, warnings

    def _find_rects_for_keyword(
        self,
        tokens: Sequence[OcrTokenLike],
        keyword: str,
        page_height: float,
        scale_to_pdf: float,
        settings: Optional[RedactionSettings] = None,
    ) -> list[fitz.Rect]:
        """Backward-compatible OCR match helper used by existing tests."""

        normalized_settings = settings or normalize_settings({})
        rects, _ = self._find_ocr_rects_with_warnings(
            tokens=tokens,
            keyword=keyword,
            page_height=page_height,
            page_width=1_000_000,
            scale_to_pdf=scale_to_pdf,
            settings=normalized_settings,
        )
        return rects

    def extract_text(self, file_path: str) -> dict[str, list[dict[str, Any]]]:
        """Extract text for every page of a PDF."""

        normalized_path = os.path.normpath(file_path)
        with fitz.open(normalized_path) as document:
            pages: list[dict[str, Any]] = []
            for page_num in range(len(document)):
                check_deadline()
                page = document[page_num]
                pages.append({"page_num": page_num + 1, "text": page.get_text()})
        return {"pages": pages}

    @staticmethod
    def _page_has_inline_images(page: fitz.Page) -> bool:
        """Inspect content tokens, not image digests, on the pinned MuPDF."""

        # get_image_info(xrefs=True) associates by pixel digest: an inline
        # image can inherit an unrelated XObject's xref. MuPDF's lexer skips
        # comments and strings and lets us stop at BI before binary image data.
        # Include nested Form streams. Unused Forms may conservatively reject
        # an image hit, which is preferable to losing unrelated image content.
        streams = [page.read_contents()]
        streams.extend(page.parent.xref_stream(xref) for xref in
                       {entry[0] for entry in page.get_xobjects()})
        mupdf = fitz.mupdf
        for data in streams:
            buffer = mupdf.fz_new_buffer_from_copied_data(data)
            stream = mupdf.fz_open_buffer(buffer)
            lexbuf = mupdf.PdfLexbuf(256)
            while True:
                token = mupdf.pdf_lex(stream, lexbuf)
                if token == mupdf.PDF_TOK_EOF:
                    break
                if token == mupdf.PDF_TOK_KEYWORD and lexbuf.m_internal.scratch == "BI":
                    return True
        return False

    def _visible_page_copy(
        self, source: fitz.Document,
    ) -> tuple[fitz.Document, list[list[fitz.Quad]], list[bool], dict[str, Any]]:
        """Rewrite visible drawing operations without grafting private objects."""

        if not source.is_pdf:
            raise RuntimeError("仅支持PDF文件")
        if source.xref_get_key(source.pdf_catalog(), "AcroForm/XFA")[0] != "null":
            raise RuntimeError("暂不支持XFA动态表单，请先生成静态PDF副本")
        for xref in range(1, source.xref_length()):
            kind = source.xref_get_key(xref, "Type")[1]
            field_type = source.xref_get_key(xref, "FT")[1]
            if (
                kind in ("/Sig", "/DocTimeStamp")
                or source.xref_get_key(xref, "V/Type")[1] in ("/Sig", "/DocTimeStamp")
                or (field_type == "/Sig" and source.xref_get_key(xref, "V")[0] != "null")
                or (source.xref_get_key(xref, "ByteRange")[0] == "array"
                    and source.xref_get_key(xref, "Contents")[0] == "string")
                or (source.xref_get_key(xref, "V/ByteRange")[0] == "array"
                    and source.xref_get_key(xref, "V/Contents")[0] == "string")
            ):
                raise RuntimeError("暂不处理带数字签名的PDF，请先生成无签名的静态副本")

        geometry: list[tuple[Any, Any, int, float]] = []
        redactions: list[list[fitz.Quad]] = []
        inline_pages: list[bool] = []
        summary: dict[str, Any] = {"policy": "visible-page-content", "form_fields": 0,
                                   "annotations": 0, "applied_redactions": 0}
        for page in source.pages():
            mupdf = fitz.mupdf
            page_object = mupdf.pdf_lookup_page_obj(fitz._as_pdf_document(source), page.number)
            unit_object = mupdf.pdf_dict_gets(page_object, "UserUnit")
            if mupdf.pdf_is_null(unit_object):
                unit = 1.0
            elif mupdf.pdf_is_number(unit_object):
                unit = float(mupdf.pdf_to_real(unit_object))
            else:
                raise RuntimeError("PDF页面缩放值无效")
            if not math.isfinite(unit) or unit <= 0:
                raise RuntimeError("PDF页面缩放值无效")
            geometry.append((fitz.Rect(page.mediabox), fitz.Rect(page.cropbox), page.rotation, unit))
            inline_pages.append(bool(page.get_image_info()) and self._page_has_inline_images(page))
            page_redactions: list[fitz.Quad] = []
            source_rotation = page.rotation
            try:
                # The pinned engine also misreports annotation rectangles for
                # non-unit UserUnit on rotated pages. Read them at rotation 0.
                page.set_rotation(0)
                summary["form_fields"] += len(list(page.widgets() or []))
                for annotation in list(page.annots() or []):
                    if annotation.type[0] == mupdf.PDF_ANNOT_REDACT:
                        # A rendering rewrite alone would turn this into an
                        # overlay. Keep its deletion intent and apply it below.
                        vertices = annotation.vertices
                        if vertices:
                            if len(vertices) % 4:
                                raise RuntimeError("PDF打码区域的四点坐标不完整")
                            page_redactions.extend(fitz.Quad(vertices[start:start + 4])
                                                   for start in range(0, len(vertices), 4))
                        else:
                            rect = annotation.rect
                            page_redactions.append(fitz.Quad(rect.tl, rect.tr, rect.bl, rect.br))
                        page.delete_annot(annotation)
                    else:
                        summary["annotations"] += 1
            finally:
                page.set_rotation(source_rotation)
            redactions.append(page_redactions)
            summary["applied_redactions"] += len(page_redactions)

        # Rendering to a new PDF keeps drawing operations and current visible
        # appearances, not the source's metadata, forms, Names/AF or actions.
        # Unlike bake(), it respects Invisible/Hidden/NoView annotations and
        # the active layer configuration. Restore the original page geometry.
        with fitz.open(stream=self._render_visible_pdf(source), filetype="pdf") as visible, fitz.open() as clean:
            for page in visible:
                self._clear_outside_image_pixels(page)
            summary["font_programs"] = self._clean_font_metadata(visible)
            for index, (media, crop, rotation, unit) in enumerate(geometry):
                page = clean.new_page(width=media.width, height=media.height)
                page.set_mediabox(media)
                page.set_cropbox(crop)
                clean.xref_set_key(page.xref, "UserUnit", str(unit))
                page = clean.reload_page(page)
                if visible[index].get_contents():
                    page.show_pdf_page(page.rect, visible, index, rotate=rotation)
                page.set_rotation(rotation)
            clean.set_metadata({})
            # Decode images before Flate compression so passthrough JPEG EXIF
            # and other compressed-image wrappers cannot retain private data.
            data = clean.tobytes(garbage=4, deflate=True, expand=1)
        return fitz.open(stream=data, filetype="pdf"), redactions, inline_pages, summary

    @staticmethod
    def _render_visible_pdf(
        source: fitz.Document, *, page_indices: Optional[Sequence[int]] = None,
        prune_empty: bool = False,
    ) -> bytes:
        """Pinned MuPDF PDF-device conversion with invisible text disabled."""

        mupdf = fitz.mupdf
        output = mupdf.PdfDocument()
        for index in range(len(source)) if page_indices is None else page_indices:
            check_deadline()
            page = mupdf.fz_load_page(source.this, index)
            bounds = mupdf.fz_bound_page(page)
            device, resources, contents = mupdf.pdf_page_write(output, bounds)
            # 1.24.14's convert_to_pdf writes ignored text as visible glyphs.
            # Disable that callback for page content AND nested appearances.
            device.m_internal.ignore_text = None
            try:
                if prune_empty:
                    # The display list omits clips whose enclosed drawing
                    # operations were all removed. Replaying raw page operators
                    # retains their recoverable geometry even in an empty q/Q.
                    display = mupdf.fz_new_display_list_from_page(page)
                    mupdf.fz_run_display_list(display, device, mupdf.FzMatrix(), bounds, mupdf.FzCookie())
                else:
                    mupdf.fz_run_page(page, device, mupdf.FzMatrix(), mupdf.FzCookie())
            finally:
                mupdf.fz_close_device(device)
            obj = mupdf.pdf_add_page(output, bounds, 0, resources, contents)
            mupdf.pdf_insert_page(output, -1, obj)
        options = mupdf.PdfWriteOptions()
        options.do_garbage = 4
        options.do_compress = options.do_compress_images = options.do_compress_fonts = 1
        options.do_sanitize = options.do_clean = 1
        buffer = mupdf.fz_new_buffer(8192)
        target = mupdf.FzOutput(buffer)
        mupdf.pdf_write_document(output, target, options)
        target.fz_close_output()
        return bytes(mupdf.fz_buffer_extract_copy(buffer))

    @staticmethod
    def _check_redacted_vectors(
        page: fitz.Page, rects: Sequence[Union[fitz.Rect, fitz.Quad]], *, after: bool = False,
    ) -> None:
        """Reject vector removal that would also erase unselected content."""
        if not rects:
            return
        quads = [rect if isinstance(rect, fitz.Quad)
                 else fitz.Quad(rect.tl, rect.tr, rect.bl, rect.br) for rect in rects]
        envelopes = [quad.rect for quad in quads]

        def covered(bounds: fitz.Rect, quad: fitz.Quad) -> bool:
            polygon = (quad.ul, quad.ur, quad.lr, quad.ll)
            for point in (bounds.tl, bounds.tr, bounds.br, bounds.bl):
                crosses = [(b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
                           for a, b in zip(polygon, (*polygon[1:], polygon[0]))]
                if not (all(value >= 0 for value in crosses) or all(value <= 0 for value in crosses)):
                    return False
            return True

        drawings = page.get_drawings(extended=True)
        simple_lines: dict[int, fitz.Rect] = {}
        for drawing in drawings:
            check_deadline()
            items = drawing.get("items", [])
            if drawing.get("type") == "clip" and after:
                points = []
                for item in items:
                    if item[0] not in ("l", "c", "re", "qu"):
                        raise RuntimeError("PDF裁剪图形无法安全处理，请先转为扫描PDF后重试。")
                    for value in item[1:]:
                        if isinstance(value, fitz.Point):
                            points.append(value)
                        elif isinstance(value, fitz.Rect):
                            points.extend((value.tl, value.tr, value.br, value.bl))
                        elif isinstance(value, fitz.Quad):
                            points.extend((value.ul, value.ur, value.lr, value.ll))
                if not points or not all(math.isfinite(value) for point in points for value in (point.x, point.y)):
                    raise RuntimeError("PDF裁剪图形范围无效，本次未生成结果")
                bounds = fitz.Rect(min(point.x for point in points), min(point.y for point in points),
                                   max(point.x for point in points), max(point.y for point in points))
                overlaps = [area for area in envelopes if bounds.intersects(area)]
                if overlaps:
                    # The page/Form viewport is structural. Its four edges are
                    # outside the selected region; other clip geometry can
                    # encode the sensitive shape even after all paint is gone.
                    corners = {(point.x, point.y) for point in (bounds.tl, bounds.tr, bounds.br, bounds.bl)}
                    rectangular = (
                        len(items) == 1 and items[0][0] in ("re", "qu")
                        and {(point.x, point.y) for point in points} == corners
                    ) or (
                        len(items) == 4 and all(item[0] == "l" and
                            (item[1].x == item[2].x or item[1].y == item[2].y) for item in items)
                        and {(point.x, point.y) for point in points} == corners
                    )
                    if not (rectangular and (bounds.contains(page.rect)
                            or all(bounds.contains(area) for area in overlaps))):
                        raise RuntimeError(f"第{page.number + 1}页裁剪图形与打码区域相交，无法安全移除；请先转为扫描PDF后重试。")
            if (drawing.get("type") == "s" and len(items) == 1 and items[0][0] == "l"
                    and not drawing.get("closePath") and isinstance(drawing.get("seqno"), int)):
                width = float(drawing.get("width", 0))
                if math.isfinite(width) and width > 0:
                    a, b = items[0][1:]
                    # A single segment has no miter join. One line width
                    # conservatively contains every cap style without MuPDF's
                    # unrelated 10x miter expansion into nearby selected text.
                    simple_lines[drawing["seqno"]] = fitz.Rect(min(a.x, b.x) - width, min(a.y, b.y) - width,
                                                               max(a.x, b.x) + width, max(a.y, b.y) + width)

        for sequence, (kind, coordinates) in enumerate(page.get_bboxlog()):
            if kind not in ("fill-path", "stroke-path", "fill-shade"):
                continue
            check_deadline()
            bounds = simple_lines.get(sequence, fitz.Rect(coordinates)) if kind == "stroke-path" else fitz.Rect(coordinates)
            if not all(math.isfinite(value) for value in (bounds.x0, bounds.y0, bounds.x1, bounds.y1)) or bounds.is_infinite:
                raise RuntimeError("PDF图形范围无效，本次未生成结果")
            # Hairlines can have zero area while their path still carries data.
            if bounds.is_empty:
                bounds = fitz.Rect(bounds.x0 - 0.001, bounds.y0 - 0.001,
                                   bounds.x1 + 0.001, bounds.y1 + 0.001)
            if not any(bounds.intersects(area) for area in envelopes):
                continue
            if after:
                raise RuntimeError(f"第{page.number + 1}页图形未能安全移除，本次未生成结果；请先转为扫描PDF后重试。")
            if kind == "fill-shade" or not any(covered(bounds, quad) for quad in quads):
                raise RuntimeError(f"第{page.number + 1}页图形跨越打码区域，无法安全保留其他内容；请先转为扫描PDF后重试。")

    def _apply_page_redactions(
        self, page: fitz.Page, rects: Sequence[Union[fitz.Rect, fitz.Quad]], source_inline: bool = False,
        *, mask_rects: Optional[Sequence[Union[fitz.Rect, fitz.Quad]]] = None,
    ) -> None:
        image_hit = any((rect.rect if isinstance(rect, fitz.Quad) else rect).intersects(fitz.Rect(info["bbox"]))
                        for rect in rects for info in page.get_image_info())
        if image_hit and (source_inline or self._page_has_inline_images(page)):
            raise RuntimeError(f"第{page.number + 1}页图像无法安全地局部打码，本次未生成结果；请先转换该PDF。")
        rotation = page.rotation
        try:
            page.set_rotation(0)
            self._check_redacted_vectors(page, rects)
            for rect in rects:
                page.add_redact_annot(rect, fill=None)
            if rects:
                page.apply_redactions(fitz.mupdf.PDF_REDACT_IMAGE_PIXELS,
                                      fitz.mupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED, 0)
                # Remove now-empty clip scopes before checking retained
                # geometry. This also handles a Form viewport intersecting a
                # padded keyword or entirely covered by an existing Redact.
                encoded = self._render_visible_pdf(page.parent, page_indices=[page.number], prune_empty=True)
                with fitz.open(stream=encoded, filetype="pdf") as visible:
                    contents = page.parent.get_new_xref()
                    page.parent.update_object(contents, "<<>>")
                    page.parent.update_stream(contents, b"")
                    page.set_contents(contents)
                    page.parent.xref_set_key(page.xref, "Resources", "<<>>")
                    if visible[0].get_contents():
                        page.show_pdf_page(page.rect, visible, 0)
                self._check_redacted_vectors(page, rects, after=True)
            masks = rects if mask_rects is None else mask_rects
            if masks:
                shape = page.new_shape()
                for rect in masks:
                    shape.draw_quad(rect if isinstance(rect, fitz.Quad) else fitz.Quad(rect.tl, rect.tr, rect.bl, rect.br))
                    shape.finish(color=None, fill=(0, 0, 0))
                shape.commit()
        finally:
            page.set_rotation(rotation)

    def _review_region(
        self, page: fitz.Page, rect: Union[fitz.Rect, fitz.Quad], origin: str,
        keywords: Sequence[str], identifier: str,
    ) -> Optional[dict[str, Any]]:
        """Describe the visible mask, in displayed-page normalized coordinates.

        This is geometry from an applied mask, not another text search. Use
        the inverse of our UserUnit-corrected derotation, including quads from
        source Redact annotations. Clip the polygon, not its bounding box.
        """
        quad = rect if isinstance(rect, fitz.Quad) else fitz.Quad(rect.tl, rect.tr, rect.bl, rect.br)
        matrix = ~self._page_derotation_matrix(page)
        frame = page.rect
        polygon = [[(point.x - frame.x0) / frame.width, (point.y - frame.y0) / frame.height]
                   for point in (corner * matrix for corner in (quad.ul, quad.ur, quad.lr, quad.ll))]
        if not all(math.isfinite(value) for point in polygon for value in point):
            raise ValueError("遮盖位置无效，本次未生成结果")
        for axis, boundary, direction in ((0, 0.0, 1), (0, 1.0, -1), (1, 0.0, 1), (1, 1.0, -1)):
            clipped: list[list[float]] = []
            for start, end in zip(polygon, polygon[1:] + polygon[:1]):
                start_in = direction * (start[axis] - boundary) >= 0
                end_in = direction * (end[axis] - boundary) >= 0
                if start_in != end_in:
                    fraction = (boundary - start[axis]) / (end[axis] - start[axis])
                    intersection = [start[i] + fraction * (end[i] - start[i]) for i in (0, 1)]
                    intersection[axis] = boundary
                    clipped.append(intersection)
                if end_in:
                    clipped.append(end)
            polygon = clipped
        area = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(polygon, polygon[1:] + polygon[:1]))) / 2
        if len(polygon) < 3 or area <= 0:
            return None
        return {"id": identifier, "page": page.number + 1, "origin": origin,
                "keywords": list(_unique_in_order(keywords)), "polygon": polygon}

    @staticmethod
    def _clear_outside_image_pixels(page: fitz.Page) -> None:
        """Remove image pixels beyond the visible viewport without touching text."""

        frame = page.rect
        bounds = fitz.Rect(frame)
        for info in page.get_image_info():
            bounds |= fitz.Rect(info["bbox"])
        strips = [fitz.Rect(bounds.x0, bounds.y0, frame.x0, bounds.y1),
                  fitz.Rect(frame.x1, bounds.y0, bounds.x1, bounds.y1),
                  fitz.Rect(frame.x0, bounds.y0, frame.x1, frame.y0),
                  fitz.Rect(frame.x0, frame.y1, frame.x1, bounds.y1)]
        outside = [rect for rect in strips if not rect.is_empty]
        for rect in outside:
            page.add_redact_annot(rect, fill=None)
        if outside:
            page.apply_redactions(fitz.mupdf.PDF_REDACT_IMAGE_PIXELS, fitz.mupdf.PDF_REDACT_LINE_ART_NONE,
                                  fitz.mupdf.PDF_REDACT_TEXT_NONE)

    @staticmethod
    def _clean_cff_metadata(cff: Any, name: str) -> None:
        cff.fontNames = [name if index == 0 else f"{name}-{index}" for index in range(len(cff.fontNames))]
        for top in cff.topDictIndex:
            for key in ("version", "Notice", "Copyright", "FullName", "FamilyName", "PostScript", "BaseFontName"):
                top.rawDict.pop(key, None)
                top.__dict__.pop(key, None)
            # Weight and ItalicAngle affect FreeType's style interpretation.
            # Keep only a standard weight label, never arbitrary descriptions.
            weight = str(getattr(top, "Weight", "Regular")).lower()
            top.Weight = next((label for label in ("Black", "Bold", "Light", "Medium")
                               if label.lower() in weight), "Regular")
            if "FontName" in top.rawDict or "FontName" in top.__dict__:
                top.FontName = name
            for index, fd in enumerate(getattr(top, "FDArray", [])):
                fd.FontName = f"{name}-{index}"

    def _clean_font_metadata(self, document: fitz.Document) -> int:
        """Use a font parser to clear descriptive tables without editing glyphs."""

        names: dict[int, str] = {}
        streams: dict[int, str] = {}
        for descriptor in range(1, document.xref_length()):
            for key in ("FontFile", "FontFile2", "FontFile3"):
                reference = document.xref_get_key(descriptor, key)
                if reference[0] != "xref":
                    continue
                xref = int(reference[1].split()[0])
                name = streams.get(xref, f"CLEANF+Sanitized{len(streams)}")
                if xref not in streams:
                    data = document.xref_stream(xref)
                    buffer = io.BytesIO()
                    try:
                        if data[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
                            with TTFont(io.BytesIO(data), recalcBBoxes=False, recalcTimestamp=False) as font:
                                for tag in ("name", "meta", "DSIG", "FFTM", "Debg", "PfEd"):
                                    if tag in font:
                                        del font[tag]
                                if "head" in font:
                                    font["head"].created = font["head"].modified = 2082844800
                                if "OS/2" in font:
                                    font["OS/2"].achVendID = "NONE"
                                for tag in ("CFF ", "CFF2"):
                                    if tag in font:
                                        self._clean_cff_metadata(font[tag].cff, name)
                                font.save(buffer)
                        elif data and data[0] in (1, 2):
                            cff = CFFFontSet()
                            font_context = TTFont(recalcBBoxes=False)
                            cff.decompile(io.BytesIO(data), font_context)
                            self._clean_cff_metadata(cff, name)
                            cff.compile(buffer, font_context)
                        else:
                            raise ValueError("unsupported embedded font format")
                    except Exception as error:
                        raise RuntimeError("无法安全清理嵌入字体，请先生成标准静态PDF副本") from error
                    document.update_stream(xref, buffer.getvalue())
                    streams[xref] = name
                names[descriptor] = name
                document.xref_set_key(descriptor, "FontName", f"/{name}")
                document.xref_set_key(descriptor, "FontFamily", "null")
        mupdf = fitz.mupdf
        pdf = fitz._as_pdf_document(document)
        for xref in range(1, document.xref_length()):
            if document.xref_get_key(xref, "Type")[1] != "/Font":
                continue
            obj = mupdf.pdf_load_object(pdf, xref)
            descendant = mupdf.pdf_array_get(mupdf.pdf_dict_gets(obj, "DescendantFonts"), 0)
            owner = descendant if not mupdf.pdf_is_null(descendant) else obj
            descriptor = mupdf.pdf_to_num(mupdf.pdf_dict_gets(owner, "FontDescriptor"))
            if descriptor in names:
                document.xref_set_key(xref, "BaseFont", f"/{names[descriptor]}")
        return len(streams)

    def desensitize(
        self,
        file_path: str,
        keywords: Sequence[str],
        settings: Optional[Mapping[str, object]] = None,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> dict[str, Any]:
        """Apply redactions to a PDF and return the temporary output path."""

        normalized_settings = normalize_settings(settings)
        report_progress('preparing', '正在准备文件…')
        normalized_path = os.path.normpath(file_path)
        if not keywords:
            raise ValueError("keywords cannot be empty")

        fd, output_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        self._temp_files.append(output_path)
        self._ocr_cache = {}
        self._baidu_token_cache.clear()
        warnings: list[WarningDict] = []
        matched_keywords: set[str] = set()
        review_regions: list[dict[str, Any]] = []

        with fitz.open(normalized_path) as source:
            clean_document, existing_redactions, source_inline, sanitization = self._visible_page_copy(source)
        with ExitStack() as processing:
            # The serial worker can reuse the token across pages of this document.
            processing.callback(self._baidu_token_cache.clear)
            document = processing.enter_context(clean_document)
            for index, prior_rects in enumerate(existing_redactions):
                if prior_rects:
                    self._apply_page_redactions(document[index], prior_rects, source_inline[index], mask_rects=[])
                    for prior_rect in prior_rects:
                        region = self._review_region(document[index], prior_rect, "existing", [], f"r{len(review_regions) + 1}")
                        if region is not None:
                            review_regions.append(region)
            has_text = [not self._is_scanned(page) for page in document]
            # Inspect displayed images, including inline and Form images,
            # rather than counting possibly unused resource-table entries.
            page_images = [page.get_image_info() for page in document]
            ocr_pages = {index for index in range(len(document))
                         if not has_text[index] or page_images[index]}
            if normalized_settings.ocr_mode == "paddle" and ocr_pages:
                fd, ocr_path = tempfile.mkstemp(suffix=".pdf")
                os.close(fd)
                self._temp_files.append(ocr_path)
                document.save(ocr_path, garbage=4, deflate=True)
                all_pages = self._fetch_paddle_all_pages(
                    ocr_path,
                    normalized_settings.paddle_api_url,
                    normalized_settings.paddle_token,
                    dpi=normalized_settings.export_dpi,
                    progress_callback=progress_callback,
                )
                if len(all_pages) != len(document):
                    raise ValueError("PaddleOCR page count does not match PDF")
                for page_index, page_data in enumerate(all_pages):
                    if page_index not in ocr_pages:
                        continue
                    pdf_page = document[page_index]
                    image_width = float(page_data.get("img_w") or 0)
                    image_height = float(page_data.get("img_h") or 0)
                    if not all(math.isfinite(size) and size > 0 for size in (image_width, image_height)):
                        raise ValueError("PaddleOCR returned invalid page image dimensions")
                    page_data["scale_to_pdf"] = float(pdf_page.rect.width) / image_width
                    page_data["scale_y_to_pdf"] = float(pdf_page.rect.height) / image_height
                    self._ocr_cache[f"{normalized_path}_{page_index}"] = page_data

            for page_num in range(len(document)):
                report_progress('redacting', f'正在处理第{page_num + 1}/{len(document)}页', page_num, len(document))
                page = document[page_num]
                ocr_bounds = page.rect
                ocr_to_pdf = self._page_derotation_matrix(page)
                page_redactions: list[fitz.Rect] = []
                keyword_rects: list[tuple[str, fitz.Rect]] = []
                keyword_details: list[tuple[str, fitz.Rect, bool]] = []
                ocr_data: Optional[dict[str, Any]] = None
                if page_num in ocr_pages:
                    page_key = f"{normalized_path}_{page_num}"
                    ocr_data = self._get_page_ocr_data_by_mode(page, normalized_settings, page_key)
                else:
                    ocr_data, outline_warning = self._get_outline_ocr_data(page, normalized_settings)
                    if outline_warning is not None:
                        warnings.append(outline_warning)
                        ocr_bounds = ocr_bounds * ocr_to_pdf
                        ocr_to_pdf = fitz.Matrix(1, 1)
                if ocr_data is not None:
                    low_score_text = ocr_data.get("low_confidence_lines", [])
                    if low_score_text:
                        warning = _warning("low_confidence", "", low_score_text,
                            "本地 OCR 存在识别评分低于80/100的文字。",
                            "低分文字可能出现漏字或错字，关键词匹配可能遗漏。",
                            "请对照原件逐页核对识别内容与打码结果。", "page")
                        warning["page"] = page_num + 1
                        warnings.append(warning)

                for keyword in keywords:
                    check_deadline()
                    rects: list[fitz.Rect] = []
                    keyword_warnings: list[WarningDict] = []
                    text_details: list[tuple[fitz.Rect, bool]] = []
                    if has_text[page_num]:
                        rects, keyword_warnings = self._find_text_rects(page, keyword, normalized_settings, text_details)
                    keyword_details.extend((keyword, rect, method) for rect, method in text_details)
                    if ocr_data is not None:
                        ocr_details: list[tuple[fitz.Rect, bool]] = []
                        ocr_rects, ocr_warnings = self._find_ocr_rects_with_warnings(
                            tokens=ocr_data["tokens"],
                            keyword=keyword,
                            page_height=float(ocr_bounds.height),
                            page_width=float(ocr_bounds.width),
                            scale_to_pdf=float(ocr_data["scale_to_pdf"]),
                            settings=normalized_settings,
                            scale_y_to_pdf=ocr_data.get("scale_y_to_pdf"),
                            match_details=ocr_details,
                        )
                        keyword_details.extend((keyword, rect * ocr_to_pdf, method)
                                               for rect, method in ocr_details)
                        for rect in ocr_rects:
                            self._append_unique_rect(rects, rect * ocr_to_pdf)
                        keyword_warnings.extend(ocr_warnings)

                    for warning in keyword_warnings:
                        warning["page"] = page_num + 1
                        warnings.append(warning)

                    for rect in rects:
                        self._append_unique_rect(page_redactions, fitz.Rect(rect))
                        keyword_rects.append((keyword, fitz.Rect(rect)))
                    if rects:
                        matched_keywords.add(keyword)

                self._apply_page_redactions(page, page_redactions, source_inline[page_num],
                    mask_rects=[*existing_redactions[page_num], *page_redactions])
                for rect in page_redactions:
                    region = self._review_region(page, rect, "keyword",
                        [keyword for keyword, candidate in keyword_rects if rect.contains(candidate)],
                        f"r{len(review_regions) + 1}")
                    if region is not None:
                        kinds: dict[str, str] = {}
                        for word in region["keywords"]:
                            methods = {method for matched_word, candidate, method in keyword_details
                                       if word == matched_word and rect.contains(candidate)}
                            if methods:
                                kinds[word] = "mixed" if len(methods) > 1 else "approximate" if True in methods else "exact"
                        if kinds:
                            region["matchKinds"] = kinds
                        review_regions.append(region)
                if len(review_regions) > 100_000:
                    raise ValueError("遮盖区域过多，请减少要遮盖的文字或拆分文件后重试")
                report_progress('redacting', f'已处理{page_num + 1}/{len(document)}页', page_num + 1, len(document))

            # Redaction replaces page streams/images. Remove their discarded
            # originals from the file, not only from the visible page contents.
            report_progress('finalizing', '正在保存处理结果...')
            document.save(output_path, garbage=4, deflate=True)

        for keyword in _unique_in_order(keywords):
            if keyword not in matched_keywords:
                warnings.append(_warning("no_match", keyword, [],
                    f'未找到“{keyword}”。',
                    "未找到不代表文件中没有敏感内容，可能有文字未被识别。",
                    "请检查原件、输入的文字和遮盖范围，必要时更换识别方式重试。", "document"))
        review = {"version": 1, "pageCount": len(existing_redactions), "regions": review_regions}
        report_progress('validating', '正在检查输出文件…')
        self._validate_final_output(output_path, review)
        result: dict[str, Any] = {"output_path": output_path, "sanitization": sanitization, "review": review}
        if warnings:
            result["warnings"] = warnings
        return result

    @staticmethod
    def _validate_final_output(output_path: str, report: dict[str, Any]) -> None:
        """Check the closed, saved file before it can become an exportable result.

        This checks file/report integrity, not whether OCR found every secret.
        Content removal is independently covered by the final-file regressions.
        """
        invalid = "输出文件检查未通过，请重新处理"
        count, regions = report.get("pageCount"), report.get("regions")
        if (report.get("version") != 1 or type(count) is not int or count < 1
                or not isinstance(regions, list) or len(regions) > 100_000):
            raise ValueError(invalid)
        try:
            with fitz.open(output_path) as saved:
                if (not saved.is_pdf or saved.needs_pass or saved.is_repaired
                        or saved.page_count != count):
                    raise ValueError(invalid)
                for page in saved:
                    check_deadline()
                    if not all(math.isfinite(value) and value > 0 for value in (page.rect.width, page.rect.height)):
                        raise ValueError(invalid)
        except (RuntimeError, fitz.FileDataError, fitz.EmptyFileError) as error:
            raise ValueError(invalid) from error
        ids: set[str] = set()
        for region in regions:
            check_deadline()
            if not isinstance(region, dict):
                raise ValueError(invalid)
            page, identity, points = region.get("page"), region.get("id"), region.get("polygon")
            words, origin = region.get("keywords"), region.get("origin")
            if (type(page) is not int or not 1 <= page <= count or not isinstance(identity, str)
                    or not identity or identity in ids or origin not in ("keyword", "existing")
                    or not isinstance(words, list) or not all(isinstance(word, str) and word for word in words)
                    or (origin == "keyword" and not words) or (origin == "existing" and words)
                    or not isinstance(points, list) or not 3 <= len(points) <= 8):
                raise ValueError(invalid)
            kinds = region.get("matchKinds")
            if "matchKinds" in region and (origin != "keyword" or not isinstance(kinds, dict)
                    or any(word not in words or kind not in ("exact", "approximate", "mixed")
                           for word, kind in kinds.items())):
                raise ValueError(invalid)
            if not all(isinstance(point, (list, tuple)) and len(point) == 2
                       and all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
                               for value in point) for point in points):
                raise ValueError(invalid)
            area = abs(sum(point[0] * points[(i + 1) % len(points)][1]
                           - points[(i + 1) % len(points)][0] * point[1] for i, point in enumerate(points)))
            if area <= 0:
                raise ValueError(invalid)
            ids.add(identity)

    def export(self, file_path: str, format_type: str, save_path: Optional[str] = None, dpi: int = 150) -> dict[str, Any]:
        """Export a processed PDF in the requested format."""

        report_progress('exporting', '正在生成导出文件...')
        if type(dpi) is not int or dpi not in ALLOWED_EXPORT_DPI:
            raise ValueError("dpi must be one of 150, 200, 300")
        normalized_path = os.path.normpath(file_path)
        normalized_save_path = os.path.normpath(save_path) if save_path else None

        if format_type == "pdf":
            if normalized_save_path:
                shutil.copy2(normalized_path, normalized_save_path)
                return {"output_path": normalized_save_path}
            return {"output_path": normalized_path}
        if format_type == "png":
            return self._export_to_png(normalized_path, dpi=dpi)
        if format_type == "png_zip":
            return self._export_to_png_zip(normalized_path, dpi=dpi)
        raise ValueError(f"Unsupported export format: {format_type}")

    def _export_to_png(self, file_path: str, dpi: int = 150) -> dict[str, list[str]]:
        """Export each page of a PDF to a temporary PNG file."""

        normalized_path = os.path.normpath(file_path)
        temp_dir = tempfile.mkdtemp()
        self._temp_files.append(temp_dir)
        output_files: list[str] = []

        with fitz.open(normalized_path) as document:
            for page_num in range(len(document)):
                report_progress('exporting', f'正在渲染第{page_num + 1}/{len(document)}页', page_num, len(document))
                page = document[page_num]
                pix = page.get_pixmap(dpi=dpi)
                output_file = os.path.join(temp_dir, f"page_{page_num + 1}.png")
                pix.save(output_file)
                output_files.append(output_file)
                report_progress('exporting', f'已渲染{page_num + 1}/{len(document)}页', page_num + 1, len(document))

        return {"output_files": output_files}

    def _export_to_png_zip(self, file_path: str, dpi: int = 150) -> dict[str, str]:
        """Export PNG pages and bundle them into a temporary ZIP archive."""

        result = self._export_to_png(file_path, dpi=dpi)
        output_files = result["output_files"]
        fd, zip_path = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        self._temp_files.append(zip_path)

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for png_file in output_files:
                check_deadline()
                archive.write(png_file, os.path.basename(png_file))

        for png_file in output_files:
            try:
                os.remove(png_file)
            except OSError:
                pass

        return {"zip_path": zip_path}
