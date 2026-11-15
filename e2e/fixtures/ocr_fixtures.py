"""Known raster targets and independent stored-pixel checks for real OCR."""
import hashlib
import math
from pathlib import Path

import pymupdf as fitz
from PIL import Image, ImageChops

OCR_CONTRACT = {
    "scanned.pdf": {"pageCount": 2, "keywords": ["SECRET", "张三"], "public": [],
                    "rasterWords": ["SECRET", "张三"], "imageFrames": [[0, 0, 400, 180], [0, 0, 400, 180]]},
    "mixed.pdf": {"pageCount": 1, "keywords": ["TEXTSECRET", "IMAGESECRET"], "public": ["PUBLIC HEADER"],
                  "rasterWords": ["IMAGESECRET"], "imageFrames": [[24, 100, 424, 280]]},
}


def _bitmap(word, font="helv"):
    with fitz.open() as template:
        page = template.new_page(width=400, height=180)
        page.insert_text((24, 40), "PUBLIC CONTROL", fontsize=18)
        page.insert_text((24, 95), word, fontname=font, fontsize=32)
        return page.get_pixmap(dpi=150, alpha=False).tobytes("png")


def generate_ocr(directory: Path):
    with fitz.open() as document:
        for word, font in (("SECRET", "helv"), ("张三", "china-s")):
            page = document.new_page(width=400, height=180)
            page.insert_image(page.rect, stream=_bitmap(word, font), keep_proportion=False)
        document.save(directory / "scanned.pdf", garbage=4, deflate=True)
    with fitz.open() as document:
        page = document.new_page(width=460, height=350)
        page.insert_text((24, 32), "PUBLIC HEADER", fontsize=16)
        page.insert_text((24, 70), "TEXTSECRET", fontsize=20)
        page.insert_image(fitz.Rect(24, 100, 424, 280), stream=_bitmap("IMAGESECRET"), keep_proportion=False)
        document.save(directory / "mixed.pdf", garbage=4, deflate=True)


def _pixel_rect(points, width, height):
    return tuple((fitz.Rect(points) * fitz.Matrix(width / 400, height / 180)).irect)


def inspect_ocr(directory: Path):
    fixtures = {}
    for name, contract in OCR_CONTRACT.items():
        file = directory / name
        raster = []
        with fitz.open(file) as document:
            if len(document) != contract["pageCount"]:
                raise ValueError("Wrong OCR fixture page count")
            text = "\n".join(page.get_text() for page in document)
            if name == "scanned.pdf" and text.strip():
                raise ValueError("Scanned fixture must have no text layer")
            if name == "mixed.pdf" and ("TEXTSECRET" not in text or "PUBLIC HEADER" not in text or "IMAGESECRET" in text):
                raise ValueError("Mixed fixture must require both native and raster paths")
            for index, page in enumerate(document):
                images = page.get_images(full=True)
                placements = page.get_image_info(xrefs=True)
                if len(images) != 1 or len(placements) != 1 or list(placements[0]["bbox"]) != contract["imageFrames"][index]:
                    raise ValueError("Unexpected source raster placement")
                pix = fitz.Pixmap(document, images[0][0])
                if pix.n != 3 or (pix.width, pix.height) != (math.ceil(400 * 150 / 72), 375):
                    raise ValueError("Unexpected OCR source image format")
                image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                band = _pixel_rect([20, 60, 380, 110], pix.width, pix.height)
                bounds = ImageChops.invert(image.crop(band)).getbbox()
                if not bounds:
                    raise ValueError("Known target ink is missing")
                ink = [bounds[0] + band[0], bounds[1] + band[1], bounds[2] + band[0], bounds[3] + band[1]]
                public = _pixel_rect([20, 20, 360, 48], pix.width, pix.height)
                if not ImageChops.invert(image.crop(public)).getbbox():
                    raise ValueError("Public raster control is missing")
                raster.append({"page": index + 1, "word": contract["rasterWords"][index], "width": pix.width,
                               "height": pix.height, "frame": contract["imageFrames"][index], "inkRectPx": ink,
                               "publicRectPx": list(public), "rgbSha256": hashlib.sha256(pix.samples).hexdigest()})
        fixtures[name] = {**contract, "rasterTargets": raster, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    return fixtures


def verify_ocr_result(output: Path, source: Path, contract):
    with fitz.open(source) as original, fitz.open(output) as result:
        assert len(result) == len(original), "OCR output page count differs"
        text = "\n".join(page.get_text() for page in result)
        assert all(word not in text for word in contract["keywords"]), "Sensitive native text remains"
        assert all(word in text for word in contract["public"]), "Public native text was removed"
        checked_images = set()
        for target in contract["rasterTargets"]:
            index = target["page"] - 1
            source_pix = fitz.Pixmap(original, original[index].get_images(full=True)[0][0])
            expected = Image.frombytes("RGB", (source_pix.width, source_pix.height), source_pix.samples)
            images = result[index].get_images(full=True)
            assert len(images) == 1, "Unexpected output raster count"
            xref = images[0][0]
            checked_images.add(xref)
            pix = fitz.Pixmap(result, xref)
            assert (pix.width, pix.height, pix.n) == (target["width"], target["height"], 3)
            actual = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            secret = actual.crop(target["inkRectPx"])
            # MuPDF removes original image pixels to white and draws the black
            # mask separately. Inspect both storage and display independently.
            assert secret.getextrema() == ((255, 255), (255, 255), (255, 255)), "Sensitive pixels remain in a stored PDF image"
            box = target["publicRectPx"]
            assert actual.crop(box).tobytes() == expected.crop(box).tobytes(), "Public raster control changed"
            # Independently check displayed pixels; stored replacement alone is insufficient.
            frame = fitz.Rect(target["frame"])
            ink = fitz.Rect(target["inkRectPx"]) * fitz.Matrix(frame.width / pix.width, frame.height / pix.height)
            ink += (frame.x0, frame.y0, frame.x0, frame.y0)
            displayed = result[index].get_pixmap(dpi=150, clip=ink, alpha=False)
            assert set(displayed.samples) == {0}, "Displayed target is not fully redacted"
        all_images = {xref for xref in range(1, result.xref_length()) if result.xref_get_key(xref, "Subtype") == ("name", "/Image")}
        assert all_images == checked_images, "Unchecked image objects remain in the output PDF"
