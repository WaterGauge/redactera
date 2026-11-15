### macOS 首次打开 / First launch

此 macOS 版本采用临时签名（ad hoc），未经 Apple 公证。下载后请核对 SHA256，将 App 拖入「应用程序」，然后尝试打开。若 macOS 拦截，在「系统设置 → 隐私与安全性」选择「仍要打开」。

核对来源和完整性后，也可以只移除这个 App 的下载隔离属性。

```sh
xattr -dr com.apple.quarantine "/Applications/Redactera.app"
```

使用实际安装的 App 路径。校验失败或签名无效时，请重新获取匹配的安装包。详细步骤见[安装指南](https://github.com/WaterGauge/redactera/blob/main/docs/handbook/mac-signing-notarization.md)。

This macOS build is ad hoc signed. Verify the SHA256 checksum and drag the app to Applications. If macOS blocks the first launch, use System Settings → Privacy & Security → Open Anyway when available. After verifying the download, the command above removes quarantine from this app only.
