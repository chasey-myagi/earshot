# 实现指南

> 当前实现索引 · 2026-09-07

产品承诺见 [PRODUCT.md](../PRODUCT.md)，进程与信任边界见 [architecture.md](architecture.md)。这里记录源码入口与维护规则。

## 代码地图

| 位置 | 职责 |
| --- | --- |
| `src/main/index.ts` | 应用生命周期、IPC、窗口和模块装配 |
| `src/main/windows/` | 会库、录中浮窗、语音输入浮窗及导航保护 |
| `src/main/capture/` | 隐藏采集窗口、PCM 和 WAV 收尾 |
| `src/main/recording-actions.ts` | 录制开始/停止互斥与失败收尾 |
| `src/main/live*.ts` | 现场稿、实时连接和重连 |
| `src/main/providers/` | DashScope 实时、文件、语音输入与润色 |
| `src/main/jobs/` | 异步转写、分离、取消、恢复与失败归类 |
| `src/main/store/` | 会话、密钥、稿件及磁盘格式 |
| `src/main/voiceprint/` | 片段筛选、CAM++、登记与匹配 |
| `src/main/dictation/` | 状态机、快捷键、设置、macOS 输入目标 |
| `src/main/playback*.ts` | 全局回听、媒体路由与确认 |
| `src/main/export.ts` | TXT / JSON 快照导出 |
| `src/preload/`, `src/shared/` | 受限 IPC API、DTO、模型和快捷键选项 |
| `src/renderer/` | React 主界面、浮窗、采集和播放宿主 |
| `scripts/` | 开发包、生产包、图标与模型下载 |

## 磁盘结构

```text
userData/
  key                    本机明文 API key，0600
  prefs.json             自动区分设置
  shortcuts.json         快捷键、交付方式及语音输入模型
  people.json            已记住的名字
  people-voice.json       本机声纹向量
  sessions/<id>/
    session.json         会话状态、任务版本；语音输入另存原稿/结果字段
    mic.wav              录会麦克风原音
    system.wav           录会系统原音
    live.jsonl           现场稿
    refined-vN.json      文件转写派生稿
    speakers-vN.json     说话人分离派生稿
    names.json           本场起名映射
```

旧版本文件由存储层兼容读取，不应手工批量重写用户目录。语音输入记录没有两条 WAV；其正文及原稿在 `session.json`。删除会话不清空全局人物和声纹。

## 录制与恢复

开始前检查 Key、系统权限、回听停止确认及语音输入占用。录制状态包含 starting、recording、stopping 与 finalize_failed。停录失败必须留下可重试入口；退出不能把尚未完成的音频收尾当成成功。

实时连接失败时继续录音。手动重连接收后续 PCM，不回放断线期间缓存。停录后精修与分离使用任务版本，忽略取消或被后续任务替代的结果。单独重跑分离不应重做麦克风转写。

起名先改变本场显示，短暂撤销期结束后才写入全局人物并安排声纹登记。异步登记再次验证名字、稿件和会话有效性。声纹不可用时保留人工名字。

## 语音输入

默认按住 `Alt+Space`，录会默认 `Control+Alt+R`，由 `src/shared/dictation.ts` 定义。设置持久化与快捷键注册失败需要回滚，录制快捷键可独立于语音输入启用状态存在。

识别选项以 `src/shared/model-settings.ts` 为准。默认 Qwen Audio 3.0 ASR 流式识别，润色关闭。ASR、润色、存储及插入失败应保留可恢复的文字；取消后不能让迟到结果写入其他目标。

`macos.ts` 用 koffi 延迟加载系统框架，不引入新进程。它读取指定按键状态并通过 AX 替换选区；前台目标变化时拒写。原生库缺失不阻止录会应用启动，打包则在替换旧产物前检查必须的 koffi 二进制。

## 构建和依赖

用 `npm ci` 安装锁定依赖。`npm run build` 编译 main、preload、renderer 和独立声纹 worker。`npm run package` 复制 Electron.app，设置稳定 bundle ID `app.earshot`，加入源码构建结果、运行时依赖闭包、图标与可选模型，然后签名。

`npm run install:app` 会重建并替换 `/Applications/Earshot.app`。模型下载和依赖安装需要联网；开发/生产应用包和模型不入 Git。签名并不等于 Apple 公证。

## 验证

`npm run typecheck`、`npm test`、`npm run build` 是基础检查。测试的 OS / 云端替身只证明程序行为；真实采集、权限、按住/松开、跨 App 回填、浮窗全屏行为需要人工或真机证据。[validation.md](validation.md)记录当前边界。
