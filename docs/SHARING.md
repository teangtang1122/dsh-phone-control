# 怎么分享给别人

## 直接发压缩包

从 [v0.1.2 Release](https://github.com/teangtang1122/dsh-phone-control/releases/tag/v0.1.2) 下载 `dsh-phone-control-0.1.2.zip`，可以附这段说明：

> 这是我用 ADB 和 scrcpy 封装的安卓手机控制 MCP，接入 DSH 后可以看手机画面、点按、滑动、启动应用，也带中文输入和准星定位。不是微信协议插件。解压后按 README 安装依赖、配置自己的手机即可。首版还需要自己配 ADB，模型也可能点错，先用备用机试。

`dist/SHA256SUMS.txt` 是压缩包校验和。不要直接压缩当前电脑上的整个鱼鱼运行目录。

希望对方的 AI 帮忙安装时，请让对方先解压，再把 `README.md` 和 `docs/AI_SETUP.md` 交给能读取本地文件的助手。只把 ZIP 发到 QQ，不保证其鱼鱼能读取文件或完成安装；QQ 桥接的工具与权限接入需要另外核对。

## 分享公开仓库

直接发仓库链接即可：

https://github.com/teangtang1122/dsh-phone-control

接收者可以下载源码 ZIP，也可以克隆仓库：

```powershell
git clone https://github.com/teangtang1122/dsh-phone-control.git
cd dsh-phone-control
```

仓库包含许可、依赖锁文件、说明和测试。二次开发可按相应许可 fork；项目自己的代码采用 MIT，scrcpy 等外部组件保持各自许可。

发布前可先执行 `npm test`、`npm run release`。本地设备配置和运行目录已经加入 `.gitignore`。初次上传时仍应核对 Git 的待提交文件列表；不要上传 `config.json`、截图和聊天记录。

当前版本标签为 `v0.1.2`，Release 附有源码 ZIP 和校验和。

仓库简介可用：

> ADB-based Android phone control MCP for DSH: screenshots, OCR targets, taps, swipes, Unicode input and visual aiming.

评论区可以写：

> 手机控制工具已单独开源成 MCP，支持 DSH。安装步骤在 README，需要安卓 USB 调试。仓库：https://github.com/teangtang1122/dsh-phone-control
