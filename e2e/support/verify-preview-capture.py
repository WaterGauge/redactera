"""Compare the rendered canvas and actual viewport capture, with a lost-prefix control."""
import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw


def dark(image: Image.Image) -> int:
    # Subpixel antialiasing can darken text without darkening every channel.
    return sum(pixel < 100 for pixel in image.convert("L").getdata())


def check(directory: Path, name: str) -> dict:
    metrics = json.loads((directory / (name + ".json")).read_text())
    canvas = Image.open(directory / (name + "-canvas.png"))
    shot = Image.open(directory / (name + "-window.png"))
    frame = metrics["frame"]
    scale_x, scale_y = shot.width / metrics["viewport"][0], shot.height / metrics["viewport"][1]
    assert abs(scale_x - scale_y) < .02, "Viewport capture scaling is inconsistent"
    prefix = [40 / 595, 40 / 842, 112 / 595, 65 / 842]
    source_box = tuple(round(v * (canvas.width if i % 2 == 0 else canvas.height)) for i, v in enumerate(prefix))
    rect = [(frame[0] + prefix[0] * frame[2]) * scale_x,
            (frame[1] + prefix[1] * frame[3]) * scale_y,
            (frame[0] + prefix[2] * frame[2]) * scale_x,
            (frame[1] + prefix[3] * frame[3]) * scale_y]
    target_box = (math.floor(rect[0]), math.floor(rect[1]), math.ceil(rect[2]), math.ceil(rect[3]))
    assert target_box[0] >= 0 and target_box[1] >= 0 and target_box[2] <= shot.width and target_box[3] <= shot.height
    source = canvas.crop(source_box)
    expected = dark(source.resize((target_box[2] - target_box[0], target_box[3] - target_box[1])))
    visible = dark(shot.crop(target_box))
    assert expected > 100, "Source canvas does not contain the known Chinese prefix"
    assert visible >= expected * .75, "Viewport capture lost the rendered Chinese prefix"
    # The same check must reject a capture whose prefix was actually omitted.
    corrupted = shot.copy()
    ImageDraw.Draw(corrupted).rectangle(target_box, fill="white")
    assert dark(corrupted.crop(target_box)) < expected * .75, "Lost-prefix control was accepted"
    return {"verified": True, "canvasDarkPixels": expected, "visibleDarkPixels": visible,
            "lostPrefixControlRejected": True, "captureSize": list(shot.size)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--name", required=True)
    args = parser.parse_args()
    print(json.dumps(check(args.directory, args.name)))
