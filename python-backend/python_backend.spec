# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules
import sys
import os
import json
from pathlib import Path

source_directory = Path(SPEC).resolve().parent
sys.path.insert(0, str(source_directory))
from build_info import source_contract

input_path = os.environ.get('PDF_BACKEND_BUILD_INPUT')
if not input_path or not Path(input_path).is_absolute():
    raise RuntimeError('Use the controlled backend build entry; build inputs are required')
build_input = json.loads(Path(input_path).read_text(encoding='utf-8'))
if build_input['contract'] != source_contract():
    raise RuntimeError('Backend source changed before PyInstaller started')

datas = []
binaries = collect_dynamic_libs('pymupdf')
hiddenimports = ['pymupdf', 'pytesseract', 'PIL', 'PIL.Image', 'requests', 'difflib', 'zipfile', 'base64', 'encodings.utf_8', 'encodings.gbk', 'encodings.cp936']
hiddenimports += ['fontTools.cffLib', 'fontTools.ttLib']
hiddenimports += collect_submodules('fontTools.ttLib.tables')

# Missing exe/languages are fatal in the preflight and again here; no warning fallback.
resources = build_input['resources']
for item in resources['binaries']:
    if not Path(item).is_file():
        raise RuntimeError('Required OCR executable/library disappeared')
    if sys.platform != 'win32':
        binaries.append((item, 'tesseract'))
for item in resources['data']:
    if not Path(item).is_file():
        raise RuntimeError('Required OCR language disappeared')
    datas.append((item, 'tesseract/tessdata'))
# Runtime only needs the contract, not build-machine OCR source locations.
runtime_metadata = Path(input_path).parent / 'runtime-contract' / 'backend-build.json'
runtime_metadata.parent.mkdir()
runtime_metadata.write_text(json.dumps({'contract': build_input['contract']}), encoding='utf-8')
datas.append((str(runtime_metadata), '.'))


a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['pymupdf.__main__'],
    noarchive=False,
    optimize=0,
)
if sys.platform == "win32":
    # Use the installed Microsoft x64 redistributable at runtime. PyInstaller
    # can otherwise pick up a machine's copy while resolving MuPDF imports.
    microsoft_runtime = {"msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"}
    a.binaries = [entry for entry in a.binaries if Path(entry[0]).name.casefold() not in microsoft_runtime]
    # The separate OCR executable has its own verified DLL closure. Add it after
    # Analysis so PyInstaller does not also copy its dependencies into the Python root.
    a.datas.extend((str(Path('tesseract') / Path(item).name), item, 'DATA') for item in resources['binaries'])
# Build evidence stays beside the analysis work directory. The frozen backend
# only receives the runtime contract above.
(Path(input_path).parent / 'analyzed-inputs.json').write_text(json.dumps({
    'modules': a.pure, 'scripts': a.scripts, 'binaries': a.binaries, 'data': a.datas,
}), encoding='utf-8')
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='python_backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    # Keep onefile DLL extraction short on Windows. Document TEMP remains
    # the Main-owned session directory passed by the process manager.
    runtime_tmpdir=(r'%LOCALAPPDATA%\Temp\pdf-desensitization-runtime'
                    if sys.platform == 'win32' else None),
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
