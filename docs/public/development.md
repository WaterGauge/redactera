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

默认 package/make 会重新构建后端并执行资源与三语言自检；后端版本、协议、源码摘要或打包资源不匹配时拒绝继续。正式包关闭Node调试入口，不包含E2E宿主。Windows安装包需在Windows本机构建；macOS安装包需在对应架构Mac构建。

双平台 CI 使用 `scripts/release-upstream.json` 中锁定的 Python 和 OpenSSL。运行 `node scripts/prepare-release-python.cjs` 可将同一归档解包到项目的 `.project-state/release-python` 目录。命令输出的 `executable` 可用于设置 `PDF_BUILD_PYTHON`，发行构建同时设置 `PDF_REQUIRE_RELEASE_RUNTIME=1`。后端自检记录实际冻结的 Python、OpenSSL、PDF 引擎及 OCR 版本。

需要准备版本时，运行 `npm run set-version -- 2.0.0-beta.1` 同步项目与锁文件。`node scripts/release-version.cjs refs/tags/v2.0.0-beta.1` 只核对版本一致性。正式分发按[版本与发布](../releases.md)执行。

Windows 原生后端使用系统的 Microsoft Visual C++ x64 运行库。如需安装，请使用 [Microsoft 提供的 x64 发行包](https://learn.microsoft.com/zh-cn/cpp/windows/latest-supported-vc-redist)。

## 图标资源

双平台原图、透明母版与生成说明在 [redactera-icon-sources](../../redactera-icon-sources/ASSET_NOTES.md)。修改图标后运行 `npm run icons:generate`，再运行 `npm run icons:check` 和 `npm run icons:verify`。生成环境沿用项目锁定的 Pillow 11.1.0，可通过 `PDF_BUILD_PYTHON` 指定 Python。构建会校验源文件与各尺寸资源的一致性。

## 后端源码身份与子包

Python 与 Node 使用同一递归输入规则：对 `python-backend/` 中未排除的普通文件按仓库相对路径（`/` 分隔，ASCII 字典序）计算原始字节 SHA256。后端身份继续绑定发行上游锁和应用版本；应用源码身份使用同一后端文件集合，但仍单独覆盖应用、构建配置及其他既有输入。新增、修改、删除或改名的生产子模块、配置及资源都需要重建，不得复用旧冻结后端。协议版本不变。

后端源文件及目录名使用 ASCII 字母、数字、下划线、点和连字符，首字符为字母、数字或下划线，不使用末尾点、Windows 设备保留名或大小写冲突名。生产输入禁止符号链接、目录联接及特殊文件。所有层级排除隐藏项、`__pycache__`、`.pyc`、`.pyo`；仅后端根层保留 `tests`、`build`、`dist`、`coverage`、`htmlcov`、`venv`、`env`、`node_modules`、`tmp`、`temp`、`logs`、`coverage.xml` 作为非生产用途（不区分大小写）。不得从排除项导入生产模块或加载生产资源；本地私有资料与生成产物应放在项目专用状态目录或其他隔离位置，不放进生产树。此命名规则不限制用户打开或导出的文件名。

从后端目录运行 `python source_inventory.py --check-types`，对同一输入集合中的所有 Python 模块执行 mypy。冻结构建对 PyInstaller Analysis 实际收集的 Python 源文件逐项检查，当前仅原生构建入口 `build_backend.py` 是明确的构建专用模块例外。Analysis 同时拒绝未列入清单的项目模块及未声明的外部来源；只允许实际解释器标准库与其选定库目录内由已安装发行包记录的源文件，不将整个虚拟环境视为可信来源。Windows Node 枚举还须与原生 Python 枚举一致，后者检查 Windows 文件属性。新增动态导入、模型、词表、原生库等资源仍需显式核对冻结配置、实际产物、许可与来源；源码摘要不能替代资源打包与成品验证。

正式构建设置 `PDF_REQUIRE_RELEASE_RUNTIME=1`，以 `PDF_RELEASE_SOURCE_COMMIT`（未指定时为起始 HEAD）固定源码提交；参与身份的文件必须属于该提交，实际工作树及 Git 对应源码归档的全部跟踪字节必须一致。正式构建前后与发布归档准备时检查，未跟踪或被忽略的生产输入、Git 导出转换或字节不一致即失败。普通开发及无 Git 的公开源码归档构建不启用正式发行门禁，仍保留原有身份及资源检查。

## Windows 共同应用构建与安装器分离

原生 Windows x64 可先运行 `npm run package` 生成正常应用，再运行 `npm run make -- --from-package` 使用同一份应用目录制作现有安装器，不重新构建后端或应用。默认 `npm run make` 仍可完整构建。测试版不能用于安装器。正常应用通过原打包校验后，构建在 `.project-state/application-payload/` 按 buildId 写入独立的共同应用回执，包含相对路径、目录、所有普通文件的大小及 SHA256、应用/后端/许可身份；正式发行额外绑定固定源码提交。该回执不得随意修改、重建或放入应用目录。制作安装器前及复查时重新核对实际应用和回执，缺失或不同即失败并要求重新构建；E2E、其他架构和跨平台复用拒绝。正式复查须保持原正式构建模式和固定提交。

共同应用摘要是构建输入身份，不是签名、实际安装目录完整性、ACL 或 NTFS 附加数据流审计。当前仍使用既有 Squirrel 安装器和实际完整包、更新器、图标验证；其封装文件集合不等同整个 Forge 输出目录。应用和回执目录必须为受控且无并发写入的构建目录。此阶段不生成或启用商店安装包，也不改变应用安装身份、数据目录、更新方式或 macOS 构建。


## 发行渠道与更新基础

桌面版继续使用原有应用身份、用户数据和系统加密凭据。当前未启用商店版：检测到 MSIX 或 MAS 包上下文时拒绝启动桌面业务，不得将其路由到旧版配置、会话清理或 GitHub 更新。未来商店版本需要先完成原生包身份与获批发行身份的匹配，核验 LocalState 实际位置、所有权及重解析点，再在 Electron ready 前配置独立数据路径。仅有包类型标志或字符串路径不能证明身份与隔离。

Windows 安装器复查现在对完整嵌入应用普通文件集合逐件比较共同应用回执。仅允许现有模板规定的根目录构建辅助文件省略以及安装器专有更新器/执行存根增加；根 Chromium 许可证存在时须保留完全一致的资源内副本。既有启动器、更新器、许可及图标专门校验不变。检查完整包的原始 ZIP 条目，拒绝非普通条目、路径冲突和非法路径。该检查针对打包文件而非实际安装目录、ACL 或附加数据流。

`node --test scripts/trusted-update-policy.node-test.cjs` 可执行可信更新目标选择合同测试；Python 测试套件也在 Node 可用时运行同一测试。目标选择层仅接收未来经可信更新框架（TUF）刷新及校验的目标信息，限制 GitHub 渠道、Windows x64 与 macOS arm64、完整安装包、严格发行版本和预发行授权。逻辑目标路径不是已启用的网络下载地址。此模块不验证 TUF 签名，不选择生产密钥，不下载或运行安装包，也不替代现有手动检查更新。真正启用可信更新前必须完成正式依赖与许可证验证、信任根与角色密钥管理、元数据发布和防回滚状态持久化、网络与下载边界、安装前授权以及对应原生验收。
