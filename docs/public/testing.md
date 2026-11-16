# 测试

TypeScript使用Vitest，Python使用pytest和mypy，Electron业务测试使用WebdriverIO。测试验证最终导出文件，界面出现黑块不是内容已移除的充分证据。

```sh
npm test
npm run test:coverage
npm run typecheck
npm run lint
# 在python-backend目录、已准备的Python环境中
python -m pytest
python source_inventory.py --check-types
```

先安装当前平台原生Tesseract及三语言数据；PDF_TEST_PYTHON指定现有测试解释器。运行以下入口会创建隔离profile和合成样本，启动真实Main/Preload/Renderer与后端：

```sh
npm run test:e2e
npm run test:e2e:readiness
npm run package -- --test-inspect
npm run test:e2e:packaged
```

专用inspect包只用于自动化，不能生成发行安装包。默认测试替换系统文件面板并隔离凭证存储；真实面板必须另在可用的登录桌面验证。native-dialogs套件目前仅支持macOS，Windows不能将它改成跳过后视为通过。GUI期间保持桌面可用，只有一个操作者。

在 Windows 复验本地 OCR 的长路径时，将 `TEMP` 和 `TMP` 指向同一个隔离目录，使生成的 `run-pdf-e2e-*` 根目录至少有 125 个字符。扫描与混合页测试要检查实际导出的像素和保留内容，并确认退出后没有自有后端或会话目录。另用常规临时目录核对资源管理器定位功能；系统返回的 8.3 短目录名和长目录名可能指向同一目录。

`npm run test:e2e -- --negative-control ocr-overlay`故意保留底层敏感像素，预期退出1。只有指定内容断言失败、negative-control.json显示verified、源码不变和退出清理完成时，才证明门禁能发现这类错误；启动失败或超时不是有效负控制。

最终文件检查包括敏感文字与PDF对象、存储图像及公开内容保留；PNG ZIP核对像素、尺寸和DPI。覆盖率入口会检查实际JSON/HTML/LCOV产物，不把无测试或空报告视为通过。

GitHub Actions 的 Tests 在 macOS 和 Windows 上独立运行。每轮的 E2E 回执和 macOS 覆盖率报告均可从该次运行的 Artifacts 下载。LCOV 和 Python XML 报告分别以 `coverage-typescript-macos` 和 `coverage-python-macos` 开头，末尾标明重跑轮次。

双平台发行验收使用对应系统的原生安装包，记录实际测试的系统、架构、应用版本和 SHA256。预览检查包含中文标题、不同缩放、大文件翻页和标题缺失的负控制。真实文件面板、安装升级、退出清理与系统凭据按变更范围分别验证。

安装包检查同时比对当前应用源码摘要、ASAR 和冻结后端。Mac 检查 DMG 卷图标、签名、类别和设备用途文案。Windows 运行 npm run check:windows-release，从 Setup 提取并比对实际应用，检查安装器、主程序、更新器和启动器的项目图标。用同版本旧包与其配套镜像验证过期源码会被拒绝。

递归源码身份专项测试在后端目录运行 `python -m pytest tests/test_source_inventory.py`（需要 Node 24 与项目 Python 环境），实际比较两种语言的摘要，检查嵌套模块、配置及资源增删改、排除项、旧冻结清单拒绝、类型检查与 Analysis 输入发现。随后在两个支持平台重新冻结并运行既有真实启动、OCR、打包及成品门禁；合成清单拒绝用例不替代实际冻结后端验证。

源码对应性专项使用合成 Git 仓库验证固定提交、未跟踪/忽略输入、修改及导出转换拒绝，并检查可信源码导出在普通开发模式具有相同摘要。冻结来源专项覆盖被排除路径链接逃逸、未声明外部来源和合法依赖记录；真实 PyInstaller TOC 及 Windows 重解析点仍需原生验证。
