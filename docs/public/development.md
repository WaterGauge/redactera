# 开发与构建

项目使用Electron45.2.1、React19、TypeScript5、Python3.11和PyMuPDF。构建工具为Node24、Electron Forge8与PyInstaller6.19.0。Windows与macOS分别使用本机原生工具构建，不能复用另一平台的后端、node_modules或Python虚拟环境。

准备 Node 24、Python 3.11 和 Tesseract 5.5.4 或更新版本，确认 eng、chi_sim、chi_tra 语言数据可用。创建项目 Python 虚拟环境，安装 python-backend/requirements.txt 中的固定依赖，再运行 npm ci。

常用命令：

```sh
npm start
npm run typecheck
npm run lint
npm test
npm run build:backend
npm run package
npm run make
```

使用PDF_DESENSITIZATION_PYTHON指定开发后端解释器，PDF_BUILD_PYTHON指定构建解释器；必要时用PDF_TESSERACT_PATH和PDF_TESSDATA_DIR指定现有OCR资源。Windows变量使用实际Windows路径。

Windows 可以在安装 Node 依赖后运行 `node scripts/prepare-windows-ocr.cjs`，将输出的可执行文件路径设为 `PDF_TESSERACT_PATH`。脚本按锁定的 Windows 包和文件 SHA256 准备项目内的 OCR 运行文件。

Windows x64 的 `npm run make` 使用 Git 和原生 Python 3.11 构建原生启动器与完整包更新器。使用 Visual Studio 2026（18.x）或 2022（17.x）的 Build Tools，并在同一实例中安装 MSVC v143（v14.44）x86/x64、对应的 C++ ATL 和 Windows 11 SDK 10.0.26100.0。构建优先选较新的可用实例，显式指定该实例的 v14.44 工具版本，并将 MSBuild 所属实例版本和工具版本写入回执。首次运行下载并校验 .NET SDK、上游源码和 NuGet 包，后续可从 `.project-state/windows-installer/inputs` 复用校验过的输入。打包时用更新器自带的 NuGet 读取器核对新完整包的清单。产物检查还会核对 Setup 启动器的代码和数据节、完整包的原始 ZIP 条目名及两份更新器，以 Setup 的 SHA256 保存回执。可用 `npm run check:windows-release` 复查同一组产物。

Windows可通过WSL调度原生node.exe和python.exe；先运行python3 scripts/windows-wsl-audit.py做只读环境核验。该脚本只确认环境，不证明Windows桌面GUI已通过。副本应放Windows文件系统的独立目录，传给exe的路径先转换并核对；Linux或WSLg应用结果不算Windows原生验证。

package/make会重新构建后端并执行资源与三语言自检；后端版本、协议、源码摘要或打包资源不匹配时拒绝继续。正式包关闭Node调试入口，不包含E2E宿主。Windows安装包需在Windows本机构建；macOS安装包需在对应架构Mac构建。

双平台 CI 使用 `scripts/release-upstream.json` 中锁定的 Python 和 OpenSSL。运行 `node scripts/prepare-release-python.cjs` 可将同一归档解包到项目的 `.project-state/release-python` 目录。命令输出的 `executable` 可用于设置 `PDF_BUILD_PYTHON`，发行构建同时设置 `PDF_REQUIRE_RELEASE_RUNTIME=1`。后端自检记录实际冻结的 Python、OpenSSL、PDF 引擎及 OCR 版本。

需要准备版本时，运行 `npm run set-version -- 2.0.0-beta.1` 同步项目与锁文件。`node scripts/release-version.cjs refs/tags/v2.0.0-beta.1` 只核对版本一致性。正式分发按[版本与发布](../releases.md)执行。

Windows 原生后端使用系统的 Microsoft Visual C++ x64 运行库。如需安装，请使用 [Microsoft 提供的 x64 发行包](https://learn.microsoft.com/zh-cn/cpp/windows/latest-supported-vc-redist)。

## 图标资源

双平台原图、透明母版与生成说明在 [redactera-icon-sources](../../redactera-icon-sources/ASSET_NOTES.md)。修改图标后运行 `npm run icons:generate`，再运行 `npm run icons:check` 和 `npm run icons:verify`。生成环境沿用项目锁定的 Pillow 11.1.0，可通过 `PDF_BUILD_PYTHON` 指定 Python。构建会校验源文件与各尺寸资源的一致性。

## 后端源码身份与子包

Python 与 Node 使用同一递归输入规则：对 `python-backend/` 中未排除的普通文件按仓库相对路径（`/` 分隔，ASCII 字典序）计算原始字节 SHA256。后端身份继续绑定发行上游锁和应用版本；应用源码身份使用同一后端文件集合，但仍单独覆盖应用、构建配置及其他既有输入。新增、修改、删除或改名的生产子模块、配置及资源都需要重建，不得复用旧冻结后端。协议版本不变。

后端源文件及目录名使用 ASCII 字母、数字、下划线、点和连字符，首字符为字母、数字或下划线，不使用末尾点、Windows 设备保留名或大小写冲突名。生产输入禁止符号链接、目录联接及特殊文件。所有层级排除隐藏项、`__pycache__`、`.pyc`、`.pyo`；仅后端根层保留 `tests`、`build`、`dist`、`coverage`、`htmlcov`、`venv`、`env`、`node_modules`、`tmp`、`temp`、`logs`、`coverage.xml` 作为非生产用途（不区分大小写）。不得从排除项导入生产模块或加载生产资源；本地私有资料与生成产物应放在项目专用状态目录或其他隔离位置，不放进生产树。此命名规则不限制用户打开或导出的文件名。

从后端目录运行 `python source_inventory.py --check-types`，对同一输入集合中的所有 Python 模块执行 mypy。冻结构建对 PyInstaller Analysis 实际收集的 Python 源文件逐项检查，当前仅原生构建入口 `build_backend.py` 是明确的构建专用模块例外。Analysis 同时拒绝实际收集到的未列入清单的后端目录内模块；所选解释器在根层 `venv`、`env` 或 `.venv` 下的环境依赖继续由原依赖与许可检查约束。新增动态导入、模型、词表、原生库等资源仍需显式核对冻结配置、实际产物、许可与来源；源码摘要不能替代资源打包与成品验证。
