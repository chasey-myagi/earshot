# 架构

> 当前结构 · 2026-09-09

Electron 主进程拥有文件、密钥、云请求与业务状态。React 渲染进程通过受限 preload API 操作主进程；设置输入框会短暂接触用户输入的密钥，保存后清空，快照仅暴露是否已配置。

```text
会库 / 录中浮窗 / 语音输入浮窗
             │ preload IPC
             ▼
Electron Main
  ├─ SessionStore / key / preferences
  ├─ recording lifecycle / playback / deferred deletion
  ├─ DashScope realtime + file ASR + dictation + optional polish
  ├─ hidden capture renderers → PCM → WAV / ASR stream
  ├─ short-lived utility process → sherpa-onnx CAM++ embeddings
  ├─ one clipboard Worker thread → AppKit pasteboard snapshot / restore
  └─ koffi → macOS key-state / Accessibility / keyboard events
```

## 采集与处理

录会隐藏窗口通过 `getUserMedia` 采麦克风，通过 Chromium desktop loopback 采系统音频。PCM 经 IPC 交给主进程落 WAV 并推送实时 ASR。语音输入使用单独的隐藏麦克风窗口，音频只临时保留用于本次识别和重试。

停录先完成音频收尾，再排队文件转写与说话人分离。任务取消、失败和重跑不应破坏原音。云端返回稿件是派生结果，写入前核对会话与任务版本。实时转写和本地落盘状态分开。

## 原生依赖边界

仓库没有自编译的原生壳或采集 helper。`node-mac-permissions` 查询和请求系统权限；`koffi` 在主进程内连接 CoreGraphics 和 Accessibility，支持物理按键松开检测、输入目标核验和一次粘贴键盘事件；主进程内的单个 Worker 线程通过 AppKit 管理剪贴板快照与恢复；`sherpa-onnx-node` 在短生命周期 utility process 中执行声纹推理。它们都是原生依赖，不能称整个应用“没有原生代码”。

语音输入桥接初始化失败只禁用该桥接。输入目标的可读性不再是录音资格门；可读取时核对原文、UTF-16 选区和结果，拒绝已知目标变化与安全输入。自动填入派发一次全局 Cmd+V，不发送 Enter；无法确认结果时保留文字，不补发。目标核验不是操作系统级原子绑定。

剪贴板 Worker 保存原 item/type/data 到内存，隔离同步数据 provider 等待。恢复只覆盖仍属于本轮的临时内容；超时不创建竞争 Worker，取消和退出等待清理，无法确认时传递告警。崩溃无法保证恢复，详见隐私文档。

## 存储与网络

数据根目录为 Electron `appData` 下的 `Earshot` 子目录，正式应用通常为 `~/Library/Application Support/Earshot/`。密钥是权限 `0600` 的明文文件，不使用 Keychain 或 `safeStorage`。会话及人物数据没有应用层加密。

Provider 代码集中在 `src/main/providers/`。实时音频和语音输入发送到 DashScope WebSocket，文件 ASR 通过服务商上传策略传 WAV，再提交和轮询任务。可选语音输入润色通过兼容 Chat API 发送文本。详见 [隐私文档](privacy.md)。

窗口不载入远程产品 UI；导航保护和 IPC 发送者校验限制调用来源。开发夹具和 QA 页面不是生产服务。

实现入口、磁盘文件及验证方式见 [implementation.md](implementation.md)。
