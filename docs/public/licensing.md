# 第三方组件许可

页隐项目源码采用 [GNU AGPLv3](../../LICENSE)（AGPL-3.0-only）。第三方运行时、PDF 引擎、OCR 工具和字体继续适用各自的许可。

- PDF 处理使用 PyMuPDF 和 MuPDF。上游提供 AGPLv3 与商业许可，所用 PyMuPDF 源码版本附带 AGPLv3 文本。[PyMuPDF 许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright) · [PyMuPDF 1.28.2 的许可文本](https://github.com/pymupdf/PyMuPDF/blob/1.28.2/COPYING)
- 桌面运行时包含 Electron 及其 Chromium、Node.js 等依赖。运行时的许可声明以 Electron 对应版本的发行内容为准。[Electron 许可](https://github.com/electron/electron/blob/v45.3.3/LICENSE)
- 预览使用 PDF.js。其主代码采用 Apache 2.0，随附的字体、CMap 和解码资源有各自的声明文件。[PDF.js 源码及许可](https://github.com/mozilla/pdf.js)
- 本地 OCR 使用 Tesseract 和语言模型。Tesseract 主项目采用 Apache 2.0，模型与平台动态库的许可按实际构建资源核对。[Tesseract 许可](https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE) · [语言模型](https://github.com/tesseract-ocr/tessdata)
- 界面字体 DM Sans 与 IBM Plex Sans 采用 SIL Open Font License 1.1。[DM Sans](https://github.com/googlefonts/dm-fonts) · [IBM Plex](https://github.com/IBM/plex)

Windows 安装器使用 Squirrel.Windows、Windows Template Library 9.0（CPL 1.0）、NuGet、Mono.Cecil 0.11.2 和 WpfAnimatedGif 1.4.15。实际分发的许可文本在应用资源的 `third-party-licenses/windows-installer/`。项目源码中的[构建输入锁](../../scripts/windows-installer/lock.json)记录上游源码、包和校验值。[启动器补丁](../../scripts/windows-installer/squirrel-launcher.patch)与[更新器补丁](../../scripts/windows-installer/squirrel-full-only.patch)记录相对于锁定源码的改动。[WTL 9.0 上游源码](https://sourceforge.net/projects/wtl/files/WTL%209.0/)

应用资源包含项目的 `LICENSE`、界面和预览依赖的 `third-party-licenses/`，以及 CPython 和冻结后端所用 Python 发行包的 `dist/python-licenses.zip`。发行工作流锁定 Python Build Standalone 的原生归档，随发行版提供项目、PyMuPDF、MuPDF、CPython 和该 Python 构建所用 OpenSSL 的对应源码，以及其他实际分发组件的许可与适用源码。 [构建与源码锁](../../scripts/release-upstream.json) · [版本与发布](../releases.md)
