# GitHub 预览版发布流程

当前版本：**Earshot 0.1.0 Apple Silicon Preview**，标签 `v0.1.0`，GitHub 标记 **Pre-release**。下载页和附件以 [GitHub Release](https://github.com/chasey-myagi/earshot/releases/tag/v0.1.0) 为准。

本版面向愿意配置自己的北京 DashScope Key、接受中文界面和预览限制的测试用户。没有 Earshot 账号、托管中继或自动更新服务。

## 发布材料

| 材料 | 位置 |
| --- | --- |
| 项目入口 | [README](../README.md)、[中文说明](../README.zh-CN.md) |
| 安装、权限、更新、卸载 | [install.md](install.md) |
| 版本说明与限制 | [releases/v0.1.0.md](releases/v0.1.0.md) |
| 数据与云请求边界 | [privacy.md](privacy.md) |
| 验证与历史证据范围 | [validation.md](validation.md) |
| 依赖及模型许可 | [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)、[licenses](../licenses) |
| 安装附件 | `Earshot-0.1.0-macos-arm64.zip` |
| 下载校验 | `SHA256SUMS.txt` |
| 版本来源 | `release-manifest.json`：源码 commit、锁文件、平台、运行时、模型和 ZIP 哈希 |
| 源码 | GitHub 对应标签自动生成的 Source code 归档 |
| 反馈与安全 | [Issues](https://github.com/chasey-myagi/earshot/issues)、[私密漏洞报告](https://github.com/chasey-myagi/earshot/security/advisories/new) |

首版 ZIP 包含 App、Electron/native runtime、CAM++ 模型和许可证。用户无需 Node.js、npm 或单独下载模型。DMG、PKG、Intel/Universal、Homebrew 和自动更新不是本版交付项。

## 兼容性与签名决策

- 仅 arm64，最低 macOS **26.4**。当前上游 ONNX Runtime 二进制的 Mach-O 部署目标为 26.4，已核对 npm 官方包与本机安装文件一致。App plist 已统一为 26.4，打包前检查 native runtime 不能超过公开声明。
- 仅 macOS 26.7 做过本机验证。最低部署目标不是最低系统的完整实机验收；26.4 实机、Intel、所有系统版本组合并未通过。
- 当前使用 Apple Development 签名，未公证。该签名通过完整性检查，不等同于 Developer ID 分发身份或 Gatekeeper 接受。
- 本机没有可用 Developer ID Application 身份，因此本版明确作为**未公证预览**发布。全新 Mac 的首次安装仍未验证，用户可能需要按 [Apple 官方说明](https://support.apple.com/en-us/102445) 为可信来源应用明确允许打开。不提供全局关闭 Gatekeeper 的脚本。
- 普通用户的完整分发链路仍需 Developer ID、适合 Electron 的 Hardened Runtime/entitlements、公证和 staple，再验证互联网首次打开。没有把这些未完成事项标为通过。

## 从冻结源码生成附件

在 macOS 26.4+ Apple Silicon 的干净工作区中执行；发布者还应使用当前验证过的系统版本：

```sh
npm ci
npm run fetch:voiceprint
npm run typecheck
npm test
npm audit --audit-level=high
npm run prepare:release
```

`prepare:release` 拒绝未提交或新出现的未跟踪源码文件，固定完整 HEAD，要求模型哈希正确，再构建、签名、检查最低系统版本并生成 `release/0.1.0/` 的三个附件。已有版本输出目录会导致拒绝，避免静默覆盖。输出目录不入 Git。修改或重签名后要重新打包和生成哈希。

`package-app.mjs` 检查 Electron、权限、koffi 和声纹动态库的 native 部署目标。权限模块无运行用途的 `obj.target` 中间文件不再复制到最终包；许可证和真正的 `.node` 文件保留。

不得直接给旧 HEAD 打标签后上传包含未提交修改的 App。manifest 的 sourceCommit 应与 Release 标签、远端代码和验证的 CI head 一致。生成包时不复制 Application Support、录音、密钥、个人设置或本机部署备份。

## 发布与核对

1. 将完整实现、测试和文档固定到提交；运行该提交的独立审查、检查及远端 CI。当前 Checks 使用 macOS 26，除测试和构建外，还验证完整模型包及签名。
2. 在干净工作区使用锁定依赖重新生成附件；对 ZIP 做安全路径检查、解压、文件/符号链接和可执行位比对、签名检查。manifest 保留真实的未公证及首次安装未验证状态。
3. 创建指向该提交的标签和 Draft Release，设置 Pre-release，附齐 ZIP、校验和 manifest，再公开发布。正文使用该标签下的完整文档链接。
4. 实际下载公开附件，核对所有附件哈希，验证下载 ZIP 解压后签名和内容一致；回读标签 commit、Release 状态和附件列表。
5. 不覆盖同版本附件。后续修正发布新版本，说明数据兼容与手动升级方式。

[GitHub Releases 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)介绍草稿、预览标记与附件。CI 是检查流程，不会自动公开发布安装包。

## 内容与许可检查

当前源码、Git 历史和包内文本做过常见 provider/GitHub/AWS/私钥模式检查，未发现命中；包内未发现个人会话、录音、Key 或签名私钥，也没有指向包外的符号链接。这是有范围的模式和文件名检查，不是无泄漏保证。npm audit 当前报告 0 项漏洞，不覆盖所有 native runtime 风险。

App 包含项目 MIT、Electron/Chromium、native runtime 和 CAM++ 模型 notices；模型 SHA-256 固定为 `f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11`。源代码、模型和依赖保留各自许可。截图或演示只能使用合成会话，不能公开当前正式界面中的私人历史。

真实跨 App 输入、Space/全屏/多屏浮窗、首词延迟、权限异常及远场认人仍保留验证缺口。详见版本说明，不能用“本机安装成功”代替全部产品验收。
