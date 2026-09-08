# Earshot

一个轻量的 macOS 录音与语音输入应用。录音留在本机，转写使用你自己的百炼 API 密钥，直接请求 DashScope。

[English](README.md) · [文档目录](docs/README.md) · [隐私与数据](docs/privacy.md)

## 能做什么

- 麦克风与系统音频双轨录制，录中查看完整转录，断线时继续保存原音。
- 停录后自动转写、区分说话人；给说话人起名，利用本机声纹在后续会话尝试认人。
- 会话改名、按时间戳回听、0.75–2 倍速、前后 5 秒、TXT / JSON 导出、删除与短暂撤销。
- 本机搜索标题、正文和说话人；单段纠错可撤销，原稿保留；录中或回听时添加时间标记。
- 导入 WAV、MP3、M4A，每个最多 64 MiB、30 分钟，原文件副本保留。
- 保存个人热词，查看本机处理量与参考费用；估算和实际账单分开，推理 Key 无法读取账户余额。
- 按住快捷键说话，松开后尝试填入原输入位置；关闭自动填入后显示结果，手动复制。
- 可选语音输入文字润色，默认关闭。没有纪要、Agent、账号或托管中继。

## 下载安装

下载 [0.1.0 Apple Silicon 预览版](https://github.com/chasey-myagi/earshot/releases/tag/v0.1.0)，要求 **macOS 26.4 或更新版本**。本版采用开发签名，**未公证**，Gatekeeper 可能需要你明确允许打开。请先阅读[安装指南](docs/install.md)。下载 Earshot 安装附件；Source code 压缩包是源码。当前仅在 macOS 26.7 本机验证，其他系统版本和全新 Mac 安装仍未验证。

## 从源码构建

当前安装包目标为 Apple Silicon、macOS 26.4 或更新版本；需要 Node.js 22.18 或更新版本、npm。原生依赖需要编译时安装 Xcode Command Line Tools。Intel Mac 尚未验证。

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

关闭主窗口后，Earshot 保留在菜单栏并响应全局快捷键；选择退出才结束应用。

默认 `⌃⌥R` 开始录会或回到当前录音，按住 `⌥空格` 说话、松开结束语音输入。设置可更改快捷键、自动填入、识别模型与文字润色。录会与语音输入互斥。

自动填入统一使用临时剪贴板与一次 Cmd+V，不自动按回车或补发。可读取目标时核对原文和选区；已知位置变化时停止填入，无法确认结果时保留文字供检查或复制。粘贴后仅在仍持有临时内容时恢复原剪贴板，用户期间的新复制会保留。关闭自动填入后手动复制。语音输入文字保存在会库，音频仅临时保留在内存中。

## 数据与验证边界

密钥是权限为 `0600` 的本机明文文件，不进钥匙串。录音、转录、名字和声纹保存在 `~/Library/Application Support/Earshot/`。识别会发送音频到 DashScope，启用润色还会发送识别文字，并产生服务商费用；这不是离线转写。详见[隐私说明](docs/privacy.md)。

这是早期 macOS 项目。[验收记录](docs/validation.md)区分自动测试、真机结果与未验证项。权限、真实键盘按住/松开、系统声音和跨应用回填不能由 headless 测试证明。

开发检查：`npm run typecheck`、`npm test`、`npm run build`。贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。源代码与项目资源采用 [MIT](LICENSE)，第三方依赖与模型另见[许可说明](THIRD_PARTY_NOTICES.md)。
