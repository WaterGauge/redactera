# macOS 安装与首次打开

macOS 发行采用临时签名（ad hoc），未经 Apple 公证。

1. 从 [Releases](https://github.com/WaterGauge/redactera/releases) 下载适合你的 Mac 的 DMG，并核对同一版本的 SHA256 校验文件。可在终端运行 `shasum -a 256 <DMG路径>`。
2. 退出正在使用的旧版，将 App 拖入「应用程序」。已有 Redactera.app 时选择替换。从旧名版本升级时，按下方步骤处理。
3. 尝试打开 App。若 macOS 拦截，前往「系统设置 → 隐私与安全性」，在可用时选择「仍要打开」。

核对过来源和完整性后，也可以只移除这个 App 的下载隔离属性。

```sh
xattr -dr com.apple.quarantine "/Applications/Redactera.app"
```

历史发行版的 App 名为 `PDF Desensitization.app`。使用命令时请填写实际安装的 App 路径。若文件校验失败或签名无效，请重新获取匹配的安装包。

维护者可运行 `npm run check:mac-signing` 检查签名环境，运行 `npm run check:mac-release` 核对普通 App、内置后端、资源、签名和 DMG。采用 Developer ID 与 Apple 公证的发行需通过显式 `--notarized` 检查。签名凭据和私钥保存在仓库之外。

## 从旧名版本升级

1. 退出「PDF Desensitization」和「页隐」，将新镜像里的 Redactera.app 拖入「应用程序」。
2. 从「应用程序」打开新 App，在设置的「更新与版本」确认本次下载的版本，并验证常用设置。
3. 将「应用程序」中旧的 PDF Desensitization.app 移到废纸篓。两种名称对应的 App 可以同时存在，单纯拖入新名 App 会保留旧 App。
4. 如程序坞中固定了旧入口，将其移除，再把正在运行的页隐保留在程序坞。

现有设置沿用原保存位置。访问旧版保存的云凭据时，macOS 可能请求钥匙串授权。授权窗口的 Safe Storage 条目可能沿用旧名。应用无需获取真实 PDF 或系统密码来完成设置迁移。
