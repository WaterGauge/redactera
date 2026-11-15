"""Generate the committed Redactera icon resources from the reviewed RGBA masters."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import struct
import sys

from PIL import Image, ImageDraw, __version__ as pillow_version

ROOT = Path(__file__).resolve().parent.parent
PINNED_PILLOW = '11.1.0'  # Already pinned by python-backend/requirements.txt.
ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
ICNS_SIZES = {'icp4': 16, 'ic11': 32, 'icp5': 32, 'ic12': 64,
              'ic07': 128, 'ic13': 256, 'ic08': 256, 'ic14': 512,
              'ic09': 512, 'ic10': 1024}
INPUTS = ('redactera-icon-sources/redactera-macos-source.png',
          'redactera-icon-sources/redactera-windows-source.png',
          'redactera-icon-sources/redactera-macos-cutout.png',
          'redactera-icon-sources/redactera-windows-cutout.png',
          'scripts/generate-icons.py')
MANIFEST = 'assets/icon-manifest.json'


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def png(image: Image.Image) -> bytes:
    output = io.BytesIO()
    image.save(output, format='PNG', compress_level=9)
    return output.getvalue()


def master(platform: str) -> Image.Image:
    with Image.open(ROOT / f'redactera-icon-sources/redactera-{platform}-cutout.png') as source:
        source.load()
        if source.mode != 'RGBA' or min(source.size) < 1024 or source.width != source.height:
            raise ValueError(f'{platform}: expected a square RGBA master of at least 1024 px')
        # Quantize only the reviewed alpha matte, never paper/background colors.
        # Remove invisible <=1/255 exterior noise and restore confident opaque pixels.
        image = Image.new('RGBA', source.size)
        image.putdata([(0, 0, 0, 0) if a <= 1 else (r, g, b, 255 if a >= 250 else a)
                       for r, g, b, a in source.getdata()])
    if image.getchannel('A').getextrema() != (0, 255):
        raise ValueError(f'{platform}: master must contain transparent and opaque pixels')
    bounds = image.getchannel('A').getbbox()
    if not bounds or min(bounds[:2]) <= 0 or bounds[2] >= image.width or bounds[3] >= image.height:
        raise ValueError(f'{platform}: foreground touches the canvas boundary')
    return image.crop(bounds)


def frame(source: Image.Image, size: int, coverage: float) -> Image.Image:
    # Traditional ICNS needs transparent padding around its already-rounded tile.
    # Windows uses the unplated foreground and a larger target-size silhouette.
    longest = max(1, round(size * coverage))
    ratio = longest / max(source.size)
    dimensions = tuple(max(1, round(side * ratio)) for side in source.size)
    # Resize premultiplied pixels so hidden matte RGB cannot make dark/white fringes.
    resized = source.convert('RGBa').resize(dimensions, Image.Resampling.LANCZOS).convert('RGBA')
    result = Image.new('RGBA', (size, size))
    result.alpha_composite(resized, ((size - resized.width) // 2, (size - resized.height) // 2))
    return result


def alpha_info(image: Image.Image) -> dict:
    alpha = image.getchannel('A')
    histogram = alpha.histogram()
    border = [image.getpixel((x, y))[3] for x in range(image.width) for y in (0, image.height - 1)]
    border += [image.getpixel((x, y))[3] for y in range(image.height) for x in (0, image.width - 1)]
    if alpha.getextrema()[0] != 0 or alpha.getextrema()[1] < 240 or any(border):
        raise ValueError('Icon must have a clear border, real alpha and an opaque foreground')
    return {'alphaMin': 0, 'alphaMax': alpha.getextrema()[1], 'transparentPixels': histogram[0],
            'opaquePixels': histogram[255], 'alphaBounds': list(alpha.getbbox())}


def ico(frames: dict[int, Image.Image]) -> bytes:
    entries, payloads = [], []
    offset = 6 + len(frames) * 16
    for size, image in frames.items():
        data = png(image)
        entries.append(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
        payloads.append(data)
        offset += len(data)
    return struct.pack('<HHH', 0, 1, len(frames)) + b''.join(entries + payloads)


def icns(frames: dict[str, Image.Image]) -> bytes:
    chunks = []
    for kind, image in frames.items():
        data = png(image)
        chunks.append(kind.encode('ascii') + struct.pack('>I', len(data) + 8) + data)
    body = b''.join(chunks)
    return b'icns' + struct.pack('>I', len(body) + 8) + body


def installer_animation(image: Image.Image) -> bytes:
    frames = []
    glyph = image.convert('RGBa').resize((160, 160), Image.Resampling.LANCZOS).convert('RGBA')
    for tick in range(12):
        panel = Image.new('RGBA', (256, 256), 'white')
        panel.alpha_composite(glyph, (48, 28))
        draw = ImageDraw.Draw(panel)
        for index in range(3):
            active = (tick // 2) % 3 == index
            x = 112 + index * 16
            draw.ellipse((x - 3, 218, x + 3, 224), fill='#364b78' if active else '#d5dbe5')
        frames.append(panel.convert('RGB'))
    output = io.BytesIO()
    frames[0].save(output, format='GIF', append_images=frames[1:], save_all=True,
                   duration=100, loop=0, disposal=2)
    return output.getvalue()


def outputs() -> tuple[dict[str, bytes], dict]:
    if pillow_version != PINNED_PILLOW:
        raise ValueError(f'Use Pillow {PINNED_PILLOW}; install the existing pinned Python requirements')
    mac, windows = master('macos'), master('windows')
    mac_png, windows_png = frame(mac, 1024, 0.82), frame(windows, 1024, 0.90)
    win_frames = {size: frame(windows, size, 0.90) for size in ICO_SIZES}
    mac_frames = {kind: frame(mac, size, 0.82) for kind, size in ICNS_SIZES.items()}
    assets = {'assets/redactera-macos.png': png(mac_png),
              'assets/redactera-windows.png': png(windows_png),
              'assets/icon.ico': ico(win_frames), 'assets/icon.icns': icns(mac_frames),
              'assets/installer.gif': installer_animation(windows_png)}
    # Independently decode every embedded size with Pillow, as well as inspect our containers.
    with Image.open(io.BytesIO(assets['assets/icon.ico'])) as decoded:
        if decoded.ico.sizes() != {(size, size) for size in ICO_SIZES}:
            raise ValueError('ICO size table differs from the generation plan')
        for size in ICO_SIZES:
            actual = decoded.ico.getimage((size, size)).convert('RGBA')
            if actual.tobytes() != win_frames[size].tobytes():
                raise ValueError(f'ICO frame changed during encoding: {size}')
    with Image.open(io.BytesIO(assets['assets/icon.icns'])) as decoded:
        for dimensions in decoded.info['sizes']:
            alpha_info(decoded.icns.getimage(dimensions).convert('RGBA'))
    manifest = {'schema': 1, 'generator': 'scripts/generate-icons.py', 'pillowVersion': PINNED_PILLOW,
                'alphaPolicy': {'transparentAtMost': 1, 'opaqueAtLeast': 250},
                'coverage': {'macos': 0.82, 'windows': 0.90},
                'inputs': {name: sha((ROOT / name).read_bytes()) for name in INPUTS},
                'outputs': {name: sha(data) for name, data in assets.items()},
                'icoFrames': {str(size): alpha_info(image) for size, image in win_frames.items()},
                'icnsFrames': {kind: {'size': image.width, **alpha_info(image)} for kind, image in mac_frames.items()},
                'pngs': {'assets/redactera-macos.png': alpha_info(mac_png),
                         'assets/redactera-windows.png': alpha_info(windows_png)}}
    return assets, manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Rebuild in memory and reject stale resources')
    args = parser.parse_args()
    assets, manifest = outputs()
    assets[MANIFEST] = (json.dumps(manifest, indent=2) + '\n').encode()
    if args.check:
        stale = [name for name, data in assets.items() if not (ROOT / name).is_file() or (ROOT / name).read_bytes() != data]
        if stale:
            raise ValueError('Icon resources need regeneration: ' + ', '.join(stale))
    else:
        for name, data in assets.items():
            destination = ROOT / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
    print(json.dumps({'verified': True, 'checkOnly': args.check, 'icoSizes': ICO_SIZES,
                      'icnsSizes': ICNS_SIZES, 'outputFiles': list(assets)}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
