import os
import socket
import pytest
import pymupdf as fitz
import zipfile
from unittest.mock import Mock, patch, MagicMock
from pdf_processor import PDFProcessor, normalize_settings, validate_paddle_api_url


class MockTextPage:
    def __init__(self, text, words, search_map=None, blocks=None):
        self._text = text
        self._words = words
        self._search_map = search_map or {}
        self._blocks = blocks or []

    def get_text(self, mode=None, sort=False):
        if mode == "words":
            return self._words
        if mode == "blocks":
            return self._blocks
        return self._text

    def search_for(self, query):
        return self._search_map.get(query, [])


class TestPDFProcessor:
    def test_init(self):
        """测试 PDFProcessor 初始化"""
        processor = PDFProcessor()
        assert processor._ocr_cache == {}
        assert processor._temp_files == []
        assert processor._baidu_token_cache == {}
        assert processor._tesseract_configured == False

    def test_cleanup(self):
        """测试清理临时文件"""
        processor = PDFProcessor()
        processor._temp_files = ['/fake/path1', '/fake/path2']

        with patch.object(processor, '_remove_path') as mock_remove:
            processor.cleanup()
            assert mock_remove.call_count == 2
            assert processor._temp_files == []

    def test_is_scanned_with_text(self):
        """测试检测有文本的页面"""
        processor = PDFProcessor()
        mock_page = Mock()
        mock_page.get_text.return_value = "Some text content"

        result = processor._is_scanned(mock_page)
        assert result == False

    def test_is_scanned_without_text(self):
        """测试检测扫描页面（无文本）"""
        processor = PDFProcessor()
        mock_page = Mock()
        mock_page.get_text.return_value = ""

        result = processor._is_scanned(mock_page)
        assert result == True

    @patch('pdf_processor.requests.post')
    def test_get_baidu_token_success(self, mock_post):
        """测试成功获取百度 token"""
        processor = PDFProcessor()

        # Mock 成功响应
        mock_response = Mock(status_code=200)
        mock_response.json.return_value = {
            'access_token': 'test_token_123',
            'expires_in': 2592000
        }
        mock_post.return_value = mock_response

        token = processor._get_baidu_token('test_api_key', 'test_secret_key')

        assert token == 'test_token_123'
        assert processor._baidu_token_cache['token'] == 'test_token_123'

    @patch('pdf_processor.requests.post')
    def test_get_baidu_token_error(self, mock_post):
        """测试百度 token 获取失败"""
        processor = PDFProcessor()

        # Mock 错误响应
        mock_response = Mock(status_code=200)
        mock_response.json.return_value = {
            'error': 'invalid_client',
            'error_description': 'Invalid API key'
        }
        mock_post.return_value = mock_response

        with pytest.raises(RuntimeError, match="Baidu token error"):
            processor._get_baidu_token('invalid_key', 'invalid_secret')

    @patch('pdf_processor.requests.post')
    def test_get_baidu_token_cached(self, mock_post):
        """测试百度 token 缓存"""
        processor = PDFProcessor()

        # 设置缓存的 token
        import time
        processor._baidu_token_cache = {
            'token': 'cached_token',
            'expires_at': time.time() + 1000
        }

        # 调用获取 token，应该使用缓存
        token = processor._get_baidu_token('test_api_key', 'test_secret_key')

        assert token == 'cached_token'
        # 不应该调用 API
        mock_post.assert_not_called()

    def test_get_page_ocr_data_baidu_empty_credentials(self):
        """测试百度 OCR 空凭证"""
        processor = PDFProcessor()
        mock_page = Mock()

        with pytest.raises(ValueError, match="api_key and secret_key cannot be empty"):
            processor._get_page_ocr_data_baidu(mock_page, '', '')

    @patch('pdf_processor.os.path.isfile')
    @patch('pdf_processor.os.remove')
    def test_remove_path_file(self, mock_remove, mock_isfile):
        """测试删除文件"""
        processor = PDFProcessor()
        mock_isfile.return_value = True

        processor._remove_path('/fake/file.txt')

        mock_remove.assert_called_once_with('/fake/file.txt')

    @patch('pdf_processor.os.path.isdir')
    @patch('pdf_processor.shutil.rmtree')
    def test_remove_path_directory(self, mock_rmtree, mock_isdir):
        """测试删除目录"""
        processor = PDFProcessor()
        mock_isdir.return_value = True

        processor._remove_path('/fake/directory')

        mock_rmtree.assert_called_once_with('/fake/directory')

    def test_search_cross_line_handles_trailing_spaces(self):
        """跨行匹配应忽略行尾空白并正确回投影坐标"""
        processor = PDFProcessor()
        page = MockTextPage(
            text="ABCD   \n1234\n",
            words=[
                (10.0, 10.0, 60.0, 20.0, "ABCD", 0, 0, 0),
                (10.0, 30.0, 50.0, 40.0, "1234", 0, 1, 0),
            ],
            search_map={"ABCD": [fitz.Rect(10, 10, 60, 20)], "1234": [fitz.Rect(10, 30, 50, 40)]},
        )

        rects, warning = processor._search_cross_line(page, "ABCD1234")

        assert len(rects) == 1
        assert rects[0].y0 == pytest.approx(10.0)
        assert rects[0].y1 == pytest.approx(40.0)
        assert warning is not None
        assert warning["keyword"] == "ABCD1234"
        assert warning["lines"] == ["ABCD", "1234"]

    def test_search_cross_line_avoids_repeated_fragment_mislocation(self):
        """重复文本片段应定位到各自出现位置，不可总是首个 search_for 结果"""
        processor = PDFProcessor()
        first_abc = fitz.Rect(10, 10, 60, 20)
        first_123 = fitz.Rect(10, 30, 50, 40)
        second_abc = fitz.Rect(10, 110, 60, 120)
        second_123 = fitz.Rect(10, 130, 50, 140)
        page = MockTextPage(
            text="ABC\n123\nX\nABC\n123\n",
            words=[
                (10.0, 10.0, 60.0, 20.0, "ABC", 0, 0, 0),
                (10.0, 30.0, 50.0, 40.0, "123", 0, 1, 0),
                (10.0, 70.0, 20.0, 80.0, "X", 0, 2, 0),
                (10.0, 110.0, 60.0, 120.0, "ABC", 0, 3, 0),
                (10.0, 130.0, 50.0, 140.0, "123", 0, 4, 0),
            ],
            search_map={"ABC": [first_abc, second_abc], "123": [first_123, second_123]},
        )

        rects, _ = processor._search_cross_line(page, "ABC123")

        assert len(rects) == 2
        assert rects[0].y0 == pytest.approx(10.0)
        assert rects[1].y0 == pytest.approx(110.0)
        assert rects[1].y1 == pytest.approx(140.0)

    def test_find_rects_for_keyword_matches_ocr_across_tokens(self):
        """OCR 模式下应支持跨 token 匹配关键词"""
        processor = PDFProcessor()
        tokens = [
            ("AB", 10, 10, 20, 10),
            ("CD", 40, 10, 20, 10),
        ]

        rects = processor._find_rects_for_keyword(
            tokens=tokens,
            keyword="ABCD",
            page_height=200,
            scale_to_pdf=1.0,
            settings=None,
        )

        assert len(rects) == 1
        assert rects[0].x0 == pytest.approx(8.0)
        assert rects[0].x1 == pytest.approx(62.0)

    @patch("pdf_processor.read_ocr_data")
    def test_get_page_ocr_data_normalizes_local_ocr_tokens(self, mock_image_to_data):
        processor = PDFProcessor()
        page = Mock()
        pixmap = Mock()
        pixmap.tobytes.return_value = b"fake-png"
        page.get_pixmap.return_value = pixmap
        mock_image_to_data.return_value = {
            "text": [" SECRET ", "", "skip"],
            "conf": ["95", "88", "-1"],
            "left": [10, 20, 30],
            "top": [11, 21, 31],
            "width": [12, 22, 32],
            "height": [13, 23, 33],
            "block_num": [1, 1, 2],
            "par_num": [1, 1, 1],
            "line_num": [1, 2, 3],
        }

        result = processor._get_page_ocr_data(page, dpi=144, lang="eng")

        page.get_pixmap.assert_called_once_with(dpi=144)
        mock_image_to_data.assert_called_once()
        assert result["scale_to_pdf"] == pytest.approx(0.5)
        assert result["tokens"] == [
            {
                "text": "SECRET",
                "x": 10.0,
                "y": 11.0,
                "w": 12.0,
                "h": 13.0,
                "line_id": "block-1-par-1-line-1",
                "block_id": "block-1-par-1",
                "source": "local",
                "coarse": False,
            }
        ]

    def test_normalize_settings_rejects_invalid_redaction_scope(self):
        with pytest.raises(ValueError, match="redaction_scope"):
            normalize_settings({"redaction_scope": "invalid"})

    def test_normalize_settings_rejects_invalid_fuzzy_threshold(self):
        with pytest.raises(ValueError, match="fuzzy_match_threshold"):
            normalize_settings({"fuzzy_match_threshold": 1.5})

    @patch("paddle_http.socket.getaddrinfo")
    def test_validate_paddle_api_url_accepts_public_https_endpoint(self, mock_getaddrinfo):
        mock_getaddrinfo.return_value = [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443)),
        ]

        validated = validate_paddle_api_url("https://example.com/ocr")

        assert validated == "https://example.com/ocr"

    def test_validate_paddle_api_url_rejects_private_address(self):
        with pytest.raises(ValueError, match="private"):
            validate_paddle_api_url("https://127.0.0.1:8000/ocr")

    def test_validate_paddle_api_url_rejects_unsupported_scheme(self):
        with pytest.raises(ValueError, match="scheme"):
            validate_paddle_api_url("ftp://example.com/ocr")

    def test_find_text_rects_strict_scope_skips_cross_line_match(self):
        processor = PDFProcessor()
        page = MockTextPage(
            text="ABCD\n1234\n",
            words=[
                (10.0, 10.0, 60.0, 20.0, "ABCD", 0, 0, 0),
                (10.0, 30.0, 50.0, 40.0, "1234", 0, 1, 0),
            ],
            search_map={},
            blocks=[
                (10.0, 10.0, 60.0, 40.0, "ABCD\n1234\n", 0, 0),
            ],
        )

        rects, warnings = processor._find_text_rects(page, "ABCD1234", normalize_settings({"redaction_scope": "strict"}))

        assert rects == []
        assert warnings == []

    def test_find_text_rects_line_scope_expands_to_full_line(self):
        processor = PDFProcessor()
        partial = fitz.Rect(42, 10, 58, 20)
        page = MockTextPage(
            text="prefix SECRET suffix\n",
            words=[
                (10.0, 10.0, 35.0, 20.0, "prefix", 0, 0, 0),
                (40.0, 10.0, 60.0, 20.0, "SECRET", 0, 0, 1),
                (65.0, 10.0, 95.0, 20.0, "suffix", 0, 0, 2),
            ],
            search_map={"SECRET": [partial]},
            blocks=[
                (10.0, 10.0, 95.0, 20.0, "prefix SECRET suffix", 0, 0),
            ],
        )

        rects, warnings = processor._find_text_rects(page, "SECRET", normalize_settings({"redaction_scope": "line"}))

        assert warnings == []
        assert len(rects) == 1
        assert rects[0].x0 == pytest.approx(8.0)
        assert rects[0].x1 == pytest.approx(97.0)

    def test_find_text_rects_paragraph_scope_expands_to_block(self):
        processor = PDFProcessor()
        partial = fitz.Rect(42, 30, 58, 40)
        page = MockTextPage(
            text="line one\nprefix SECRET suffix\nline three\n",
            words=[
                (10.0, 10.0, 40.0, 20.0, "line", 0, 0, 0),
                (45.0, 10.0, 65.0, 20.0, "one", 0, 0, 1),
                (10.0, 30.0, 35.0, 40.0, "prefix", 0, 1, 0),
                (40.0, 30.0, 60.0, 40.0, "SECRET", 0, 1, 1),
                (65.0, 30.0, 95.0, 40.0, "suffix", 0, 1, 2),
                (10.0, 50.0, 40.0, 60.0, "line", 0, 2, 0),
                (45.0, 50.0, 80.0, 60.0, "three", 0, 2, 1),
            ],
            search_map={"SECRET": [partial]},
            blocks=[
                (10.0, 10.0, 95.0, 60.0, "line one\nprefix SECRET suffix\nline three\n", 0, 0),
            ],
        )

        rects, warnings = processor._find_text_rects(page, "SECRET", normalize_settings({"redaction_scope": "paragraph"}))

        assert warnings == []
        assert len(rects) == 1
        assert rects[0].x0 == pytest.approx(8.0)
        assert rects[0].y0 == pytest.approx(8.0)
        assert rects[0].x1 == pytest.approx(97.0)
        assert rects[0].y1 == pytest.approx(62.0)

    def test_find_ocr_rects_strict_scope_skips_cross_token_match(self):
        processor = PDFProcessor()
        tokens = [
            ("AB", 10, 10, 20, 10),
            ("CD", 40, 10, 20, 10),
        ]

        rects, warnings = processor._find_ocr_rects_with_warnings(
            tokens=tokens,
            keyword="ABCD",
            page_height=200,
            page_width=200,
            scale_to_pdf=1.0,
            settings=normalize_settings({"redaction_scope": "strict"}),
        )

        assert rects == []
        assert warnings == []

    def test_find_ocr_rects_line_scope_expands_to_full_line(self):
        processor = PDFProcessor()
        tokens = [
            {"text": "prefix", "x": 10, "y": 10, "w": 20, "h": 10, "line_id": "line-1", "block_id": "block-1"},
            {"text": "SECRET", "x": 40, "y": 10, "w": 20, "h": 10, "line_id": "line-1", "block_id": "block-1"},
            {"text": "suffix", "x": 70, "y": 10, "w": 25, "h": 10, "line_id": "line-1", "block_id": "block-1"},
        ]

        rects, warnings = processor._find_ocr_rects_with_warnings(
            tokens=tokens,
            keyword="SECRET",
            page_height=200,
            page_width=200,
            scale_to_pdf=1.0,
            settings=normalize_settings({"redaction_scope": "line"}),
        )

        assert warnings == []
        assert len(rects) == 1
        assert rects[0].x0 == pytest.approx(8.0)
        assert rects[0].x1 == pytest.approx(97.0)

    def test_find_ocr_rects_paddle_partial_match_warns_and_degrades_to_line(self):
        processor = PDFProcessor()
        tokens = [
            {
                "text": "prefix SECRET suffix",
                "x": 10,
                "y": 10,
                "w": 90,
                "h": 10,
                "line_id": "line-1",
                "block_id": "block-1",
                "source": "paddle",
                "coarse": True,
            },
        ]

        rects, warnings = processor._find_ocr_rects_with_warnings(
            tokens=tokens,
            keyword="SECRET",
            page_height=200,
            page_width=200,
            scale_to_pdf=1.0,
            settings=normalize_settings({"redaction_scope": "normal"}),
        )

        assert len(rects) == 1
        assert rects[0].x0 == pytest.approx(8.0)
        assert rects[0].x1 == pytest.approx(102.0)
        assert len(warnings) == 1
        assert warnings[0]["keyword"] == "SECRET"
        assert "PaddleOCR" in warnings[0]["message"]

    def test_find_ocr_rects_paddle_paragraph_scope_expands_to_block_with_warning(self):
        processor = PDFProcessor()
        tokens = [
            {
                "text": "prefix SECRET suffix",
                "x": 10,
                "y": 10,
                "w": 90,
                "h": 10,
                "line_id": "line-1",
                "block_id": "block-1",
                "source": "paddle",
                "coarse": True,
            },
            {
                "text": "second line context",
                "x": 10,
                "y": 25,
                "w": 110,
                "h": 12,
                "line_id": "line-2",
                "block_id": "block-1",
                "source": "paddle",
                "coarse": True,
            },
        ]

        rects, warnings = processor._find_ocr_rects_with_warnings(
            tokens=tokens,
            keyword="SECRET",
            page_height=200,
            page_width=200,
            scale_to_pdf=1.0,
            settings=normalize_settings({"redaction_scope": "paragraph"}),
        )

        assert len(rects) == 1
        assert rects[0].x0 == pytest.approx(8.0)
        assert rects[0].y0 == pytest.approx(8.0)
        assert rects[0].x1 == pytest.approx(122.0)
        assert rects[0].y1 == pytest.approx(39.0)
        assert len(warnings) == 1
        assert warnings[0]["keyword"] == "SECRET"
        assert "文本块" in warnings[0]["message"]

    def test_desensitize_handles_normal_and_cross_line_matches_for_same_keyword(self, tmp_path):
        """同页同关键词同时出现普通命中与跨行命中时，两者都应被处理"""
        processor = PDFProcessor()
        keyword = "ABCDEF"
        input_path = tmp_path / "mixed-matches.pdf"

        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((72, 72), f"普通命中 {keyword}")
        page.insert_text((72, 102), "跨行命中 ABC")
        page.insert_text((72, 132), "DEF")
        doc.save(input_path)
        doc.close()

        with fitz.open(str(input_path)) as source_doc:
            source_page = source_doc[0]
            assert len(source_page.search_for(keyword)) == 1
            cross_line_rects, _ = processor._search_cross_line(source_page, keyword)
            assert len(cross_line_rects) >= 2

        result = processor.desensitize(str(input_path), [keyword], settings={})
        output_path = result["output_path"]

        with fitz.open(output_path) as output_doc:
            output_page = output_doc[0]
            assert len(output_page.search_for(keyword)) == 0
            cross_line_rects, _ = processor._search_cross_line(output_page, keyword)
            assert len(cross_line_rects) == 0

    def test_extract_text_returns_page_text(self, tmp_path):
        processor = PDFProcessor()
        input_path = tmp_path / "extract.pdf"

        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((72, 72), "Hello")
        doc.save(input_path)
        doc.close()

        result = processor.extract_text(str(input_path))

        assert result["pages"] == [{"page_num": 1, "text": "Hello\n"}]

    def test_export_pdf_copies_to_requested_path(self, tmp_path):
        processor = PDFProcessor()
        input_path = tmp_path / "source.pdf"
        output_path = tmp_path / "copied.pdf"

        doc = fitz.open()
        doc.new_page()
        doc.save(input_path)
        doc.close()

        result = processor.export(str(input_path), "pdf", str(output_path))

        assert result == {"output_path": str(output_path)}
        assert output_path.exists()

    def test_export_to_png_and_png_zip_creates_outputs(self, tmp_path):
        processor = PDFProcessor()
        input_path = tmp_path / "pages.pdf"

        doc = fitz.open()
        doc.new_page()
        doc.new_page()
        doc.save(input_path)
        doc.close()

        png_result = processor.export(str(input_path), "png")
        assert len(png_result["output_files"]) == 2
        for output_file in png_result["output_files"]:
            assert output_file.endswith(".png")
            assert os.path.exists(output_file)

        zip_result = processor.export(str(input_path), "png_zip")
        assert zip_result["zip_path"].endswith(".zip")
        assert os.path.exists(zip_result["zip_path"])

        with zipfile.ZipFile(zip_result["zip_path"], "r") as archive:
            assert sorted(archive.namelist()) == ["page_1.png", "page_2.png"]
