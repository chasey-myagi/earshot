# Earshot

一个轻量的 macOS 录音与语音输入应用。录音留在本机，转写使用你自己的百炼 API 密钥，直接请求 DashScope。

[English](README.md) · [文档目录](docs/README.md) · [隐私与数据](docs/privacy.md)

## 能做什么

- 麦克风与系统音频双轨录制，录中查看完整转录，断线时继续保存原音。
- 停录后自动转写、区分说话人；给说话人起名，利用本机声纹在后续会话尝试认人。
- 会话改名、按时间戳回听、TXT / JSON 导出、删除与短暂撤销。
- 按住快捷键说话，松开后将文字填入支持的输入控件；也可以先预览再插入。
- 可选语音输入文字润色，默认关闭。没有纪要、Agent、账号或托管中继。

## 开发与安装

当前验证目标为 Apple Silicon Mac；需要 Node.js 22.18 或更新版本、npm。原生依赖需要编译时安装 Xcode Command Line Tools。Intel Mac 尚未验证。

```sh
git clone https://github.com/chasey-myagi/earshot.git
cd earshot
npm ci
npm run fetch:voiceprint
npm run dev
```

声纹模型下载到被 Git 忽略的 `models/`，可以省略；省略后无法跨会自动认人，仍能录音、转写和手动起名。

```sh
npm run package
open dist/Earshot.app
```

日常安装可运行 `npm run install:app`，它会重新构建并替换 `/Applications/Earshot.app`。执行前停止录音并退出应用。构建优先使用本机 Apple Development 证书，否则使用临时签名；没有公证与自动更新流程。

## 第一次使用

在设置填写北京地域的百炼 API 密钥。录会需要麦克风及屏幕/系统音频权限；语音输入需要麦克风权限，跨应用回填还需要辅助功能权限。应用位置或签名身份变化可能让 macOS 重新请求权限。

默认 `⌃⌥R` 开始录会或回到当前录音，按住 `⌥空格` 说话、松开结束语音输入。设置可更改快捷键、先预览或直接插入、识别模型与文字润色。录会与语音输入互斥。

回填前会检查输入控件、焦点、原文与选区；目标失效时保留识别结果，供手动复制。它不会模拟回车。语音输入文字保存在会库，音频仅临时保留在内存中。

## 数据与验证边界

密钥是权限为 `0600` 的本机明文文件，不进钥匙串。录音、转录、名字和声纹保存在 `~/Library/Application Support/Earshot/`。识别会发送音频到 DashScope，启用润色还会发送识别文字，并产生服务商费用；这不是离线转写。详见[隐私说明](docs/privacy.md)。

这是早期 macOS 项目。[验收记录](docs/validation.md)区分自动测试、真机结果与未验证项。权限、真实键盘按住/松开、系统声音和跨应用回填不能由 headless 测试证明。

开发检查：`npm run typecheck`、`npm test`、`npm run build`。贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。源代码与项目资源采用 [MIT](LICENSE)，第三方依赖与模型另见[许可说明](THIRD_PARTY_NOTICES.md)。
