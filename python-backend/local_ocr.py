"""Read Tesseract TSV while keeping Windows scan images off disk."""

import io
import subprocess
import sys
from typing import Any, cast

from PIL import Image
import pytesseract

_TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'


def _windows_ocr_data(png: bytes, lang: str, timeout: float | None, psm: int | None) -> dict[str, list[Any]]:
    # The Windows OCR executable cannot open image paths at MAX_PATH, even
    # when Python and the OS support long paths. Do not shorten or move the
    # Main-owned worker directory; send pixels and receive TSV through pipes.
    command = [pytesseract.pytesseract.tesseract_cmd, 'stdin', 'stdout', '-l', lang, '-c', 'tessedit_create_tsv=1']
    if psm is not None:
        command.extend(('--psm', str(psm)))
    try:
        result = subprocess.run(command, input=png, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except FileNotFoundError:
        raise RuntimeError('Tesseract is not installed or not in your PATH') from None
    except subprocess.TimeoutExpired:
        raise TimeoutError('Local OCR timed out') from None
    except (OSError, subprocess.CalledProcessError):
        raise RuntimeError('Tesseract could not process the page') from None

    try:
        tsv = result.stdout.decode('utf-8').replace('\r\n', '\n')
    except UnicodeDecodeError:
        raise RuntimeError('Tesseract returned invalid OCR data') from None
    header, _, rows = tsv.rstrip('\n').partition('\n')
    if header != _TSV_HEADER or not rows or any(row.count('\t') != 11 for row in rows.split('\n')):
        raise RuntimeError('Tesseract returned invalid OCR data')
    # Use the pinned pytesseract decoder to preserve existing token grouping
    # and its confidence conversion on both platforms.
    return cast(dict[str, list[Any]], pytesseract.pytesseract.file_to_dict(tsv, '\t', -1))


def read_ocr_data(png: bytes, lang: str, *, timeout: float | None = None, psm: int | None = None) -> dict[str, list[Any]]:
    # The input contract is an internally rendered PNG, not an arbitrary image
    # container. Do not dispatch unrelated Pillow decoders at this boundary.
    with Image.open(io.BytesIO(png), formats=['PNG']) as image:
        if sys.platform == 'win32':
            # Match the PNG pytesseract previously saved, including omission
            # of optional DPI metadata. Changing transport should not change OCR.
            with io.BytesIO() as buffer:
                image.save(buffer, format='PNG')
                return _windows_ocr_data(buffer.getvalue(), lang, timeout, psm)
        return cast(dict[str, list[Any]], pytesseract.image_to_data(
            image, lang=lang, output_type=pytesseract.Output.DICT,
            timeout=timeout if timeout is not None else 0, config=f'--psm {psm}' if psm is not None else '',
        ))
