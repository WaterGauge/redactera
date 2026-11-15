# Redactera source icon images

- `redactera-macos-source.png`: Original macOS artwork approved by the project owner. PNG RGBA, 1254 x 1254, but the canvas is **opaque**: any surrounding black/background pixels are not transparency.
- `redactera-windows-source.png`: Selected transparent-background *concept* (Windows A) with folded document and red ribbon. PNG RGB, 1254 x 1254, **no alpha channel**. Visible checkered background is actually baked into the source pixels. This is NOT suitable as a ready-to-ship Windows ICO. Carefully reconstruct a real alpha-masked foreground or ask for a better layered source; never ship the baked checkerboard. Verify edges with light and dark backgrounds.
- Do not alter the recognized document/ribbon visual identity; prepare clean production icons per platform. Preserve originals in version control or designated design-source directory.

## Production masters and regeneration

The original concept images are preserved above. `redactera-macos-cutout.png` and
`redactera-windows-cutout.png` are the reviewed RGBA working masters. Their background
matting was produced with the built-in `image_gen` tool. The exact requests are saved
in `cleanup-prompts.json`. The white document, fold and red wrap remain the approved
artwork. The Windows shadow/edge alpha is reconstructed; the original RGB concept
cannot provide its lost alpha channel losslessly.

Use Python 3.11 and the existing `Pillow==11.1.0` pin in
`python-backend/requirements.txt`. No new image-processing dependency is needed.

```sh
npm run icons:generate
npm run icons:check
npm run icons:verify
```

The generator uses `PDF_BUILD_PYTHON` when set, otherwise `python3` on macOS and
`python` on Windows. Set it to the Python environment containing the pinned project
dependencies. The check command is Node-only. The verify command rebuilds all bytes
in memory and compares the committed files without modifying them.

| Output | Used by |
| --- | --- |
| `assets/icon.icns` | macOS app, Finder, Dock and DMG volume |
| `assets/icon.ico` | Windows EXE, window, Setup, updater, execution stub and shortcuts |
| `assets/redactera-macos.png` | macOS development Dock and documentation |
| `assets/redactera-windows.png` | Windows master preview and documentation |
| `assets/installer.gif` | Squirrel installation animation |
| `assets/icon-manifest.json` | Input/output hashes, alpha and frame-size checks |

The traditional ICNS preserves the blue tile and adds transparent breathing room.
Its PNG entries include 16/32/128/256/512 point sizes and their Retina variants up
to 1024 px. ICO entries are 16, 20, 24, 32, 40, 48, 64, 96, 128 and 256 px, all 32-bit
RGBA PNGs. Each size is rendered directly from its platform master with premultiplied
alpha, rather than downscaling a previous small icon. Windows uses an unplated,
transparent document/ribbon silhouette.

Only the reviewed alpha matte is quantized: alpha <=1/255 becomes transparent and
alpha >=250/255 becomes opaque. RGB colors are not used to distinguish background
from the white paper. Transparent RGB is cleared to prevent matte fringes. The
original concept files and cutouts remain unchanged by the generator.

After changing artwork, regenerate and review actual 16/24/32 px icons on light and
dark backgrounds. Commit both sources and outputs. The Forge and release gates
reject stale/missing outputs, changed masters and malformed frame tables. CI also
runs the full Pillow decode and byte-reproduction check on both platforms.

The app's bundle IDs, Squirrel package ID and settings locations are unchanged by
this icon update. Windows may cache icons for an existing shortcut or pinned item;
check the embedded EXE/ICO and a freshly created shortcut before attributing an old
shell image to packaging. Do not delete the user's system icon cache automatically.

References: [Electron Forge Squirrel.Windows](https://www.electronforge.io/config/makers/squirrel.windows),
[Microsoft icon construction](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction),
[Apple app icons](https://developer.apple.com/design/human-interface-guidelines/app-icons).

## Squirrel bootstrapper resources and signing order

Squirrel embeds its native Setup template, including icon groups 107 and 108.
`setupIcon` adds the shell icon but leaves those native groups unchanged. The Forge
post-make hook replaces every group in the assembled **unsigned** Setup. Executable
sections and every non-icon resource, including the entire application ZIP payload,
are checked unchanged before the file is replaced atomically. Upstream vendor files
and the application payload are not modified.

Current Windows builds are unsigned. The hook refuses PE files carrying an
Authenticode security directory. If Windows signing is introduced, perform it after
this hook; a previously signed installer is deliberately rejected rather than
silently losing its signature. macOS signing and Electron fuses are unaffected.
The Windows release check validates every icon group in Setup, the app EXE, updater
and execution stub, plus the embedded installation animation and application files.
