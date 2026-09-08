# 安装与更新 / Installation

**Earshot 0.1.0 Apple Silicon 预览版**：[下载页面](https://github.com/chasey-myagi/earshot/releases/tag/v0.1.0)。本版是未公证预览，适合愿意接受已知限制的测试用户。

## 先确认适用范围

| 项目 | 当前包的实际状态 |
| --- | --- |
| CPU | Apple Silicon / arm64；没有 Intel 或 Universal 包 |
| 操作系统 | 当前包在 macOS 26.7 验证启动；包内 ONNX Runtime 最低部署目标 26.4，旧系统未验证 |
| 最低系统声明 | App 的最低系统字段已统一为 26.4，打包时核对 native runtime 的最低部署目标 |
| 界面 | 中文 |
| 识别服务 | 北京地域 DashScope / 百炼，自备 API Key，按服务商计费；不是离线转写 |
| 声纹 | 当前完整包包含 CAM++ 模型；识人尽力而为，远场认回存在缺口 |
| 签名 | 当前为 Apple Development 签名，未公证；下载后的 Gatekeeper 首次打开尚未验证 |
| 更新 | 手动下载和替换，无自动更新服务 |

26.4 是最低部署目标，不代表已在 26.4 实机通过全部功能。当前仅在 macOS 26.7 本机验证启动，全新电脑从互联网首次安装仍未验证。

## 下载和安装

按以下步骤安装：

1. 在 Releases 选择明确标记为预览版的版本，阅读该版本的系统要求和已知限制。
2. 下载 `Earshot-0.1.0-macos-arm64.zip` 和 `SHA256SUMS.txt`。`Source code (zip/tar.gz)` 是源码，需要自行构建。
3. 可在下载目录运行 `shasum -a 256 -c SHA256SUMS.txt` 检查文件是否与清单一致。校验值用于核对文件，不能代替开发者身份和 Apple 公证。
4. 解压，将 `Earshot.app` 拖到“应用程序”。第一次安装无需安装 Node.js、npm、Python、ffmpeg 或单独下载模型。
5. 从“应用程序”打开 Earshot，再在设置中填写自己的百炼 Key。

如果 macOS 无法验证开发者或公证，先确认下载来源和校验值，再参考 [Apple 的安全打开说明](https://support.apple.com/en-us/102445)。个人可信来源的例外操作与公司设备管理策略可能不同。不要全局关闭 Gatekeeper，不要忽略“将损坏电脑”等恶意软件警告。

## 首次使用与权限

- 会议录制：麦克风与屏幕/系统音频权限。系统音频用于录下电脑播放的声音，不保存屏幕画面。
- 语音输入：麦克风；自动填入其他 App 时还需要辅助功能权限。
- `⌃⌥R` 开始录制或回到当前录音；按住 `⌥空格` 说话，松开结束。快捷键可在设置修改。
- 等待浮窗提示可以说话再开始口述；首次准备可能较慢。
- 自动填入使用一次临时剪贴板粘贴，不自动发送消息。关闭“自动填入”后手动复制。显示未确认时先检查目标内容，不要盲目重复。
- 关闭主窗口仍在菜单栏运行；使用“退出”真正结束应用。录会与语音输入不能同时进行。

Key 在本机以 `0600` 明文文件保存，转写音频直接发往 DashScope。隐私、剪贴板、云端保留与删除边界见 [privacy.md](privacy.md)。

## 更新、备份和回退

1. 停止录音与导入，等待文件保存和必要清理完成，使用菜单正常退出。
2. 备份旧 App，以及 `~/Library/Application Support/Earshot/` 中需要保留的数据。该目录含密钥、私人录音和稿件；只保存在自己的安全位置，不上传到 GitHub 或问题反馈。
3. 替换“应用程序”中的 App，重新打开并检查旧会话和设置。不要同时运行不同目录中具有同一身份的 Earshot。
4. 签名或位置变化可能需要重新授予权限；不要将本机一次授权沿用视为所有电脑都不会弹窗。
5. 如需回退，先退出新版，恢复旧 App；数据格式跨版本回退并无通用保证。不要用旧备份覆盖升级后新增的录音，应先另外保存新增数据。

删除 App 本身不会删除历史。完全卸载数据前，退出应用并确认已导出或备份，再删除上述数据目录；此操作也会删除 Key、设置、名字与声纹。

## 反馈

在 [Issues](https://github.com/chasey-myagi/earshot/issues) 提供版本、macOS 版本、芯片、复现步骤、预期/实际结果及合成示例。不要上传密钥、私人会话、原始录音或完整 Application Support。安全问题通过 [私密漏洞报告](https://github.com/chasey-myagi/earshot/security/advisories/new) 提交。

## English quick guide

Download the 0.1.0 Apple Silicon preview from the linked release. It requires macOS 26.4 or later, matching its bundled ONNX Runtime. The app metadata and native dependency preflight enforce that minimum. Only macOS 26.7 was tested locally; Intel, other macOS versions, and installation on a fresh Mac remain unverified.

Download the Earshot ZIP and checksum file, verify the checksum, unzip, and move Earshot.app to Applications. GitHub’s source archives are not installers. The complete binary includes its runtime and CAM++ model; Node.js and a separate model download are unnecessary for end users.

The current build uses an Apple Development certificate and is not notarized. Follow Apple’s linked guidance for warnings; do not disable Gatekeeper globally. Enter your own Beijing DashScope key in Settings. Microphone and system-audio permission enable meeting recording; Accessibility enables cross-app dictation. The UI is Chinese and cloud recognition incurs provider charges.

Quit before replacing an older app, keep a private backup, and reopen to check saved sessions. There is no automatic updater. Deleting the app does not delete your local data. Report problems with synthetic examples and never upload credentials or private audio.
