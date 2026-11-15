## 下载与安装

- macOS 使用 DMG。核对 SHA256 后将 App 拖入「应用程序」，首次打开见 [macOS 安装指南](https://github.com/WaterGauge/redactera/blob/main/docs/handbook/mac-signing-notarization.md)。
- Mac 从旧名版本升级后，按安装指南移除旧 App 并更新程序坞入口，确认新版本后继续使用原设置。
- Windows x64 使用 Setup.exe。核对 SHA256 后运行安装程序，升级前先退出应用。若系统缺少 Visual C++ x64 运行库，请先从 [Microsoft 下载安装](https://learn.microsoft.com/zh-cn/cpp/windows/latest-supported-vc-redist)。

从 1.x 升级到 2.0.0 时，请直接从 [Redactera Releases](https://github.com/WaterGauge/redactera/releases) 下载对应平台的 2.0.0 安装包并手动安装。1.x 的应用内更新检查可能无法使用。

用同一发行版的 `SHA256SUMS.txt` 核对安装包和 `Redactera-*-source.tar.gz`。项目源码归档来自本版本标签，包含许可证、构建脚本、锁文件及变更日志。PyMuPDF、MuPDF、CPython 和发行 Python 所用 OpenSSL 的对应源码也随本版本提供，校验值见同一文件。

## Download and install

Use the DMG on macOS and Setup.exe on Windows x64. Verify the installer against `SHA256SUMS.txt` before opening it. The same checksums file covers the tagged project source and the corresponding PyMuPDF, MuPDF, CPython, and OpenSSL source archives. See the macOS installation guide above for first-launch steps. To upgrade from 1.x to 2.0.0, download the 2.0.0 installer directly from [Redactera Releases](https://github.com/WaterGauge/redactera/releases) and install it manually.
