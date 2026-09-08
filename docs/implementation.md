# 实现指南

> 当前实现索引 · 2026-09-09

产品承诺见 [PRODUCT.md](../PRODUCT.md)，进程与信任边界见 [architecture.md](architecture.md)。这里记录源码入口与维护规则。

## 代码地图

| 位置 | 职责 |
| --- | --- |
| `src/main/index.ts` | 应用生命周期、IPC、窗口和模块装配 |
| `src/main/menubar.ts` | 模板图标、常驻菜单和显式退出入口 |
| `src/main/import-audio*.ts` | 私有导入暂存、隔离 Chromium 解码与原子提交 |
| `src/main/windows/` | 会库、录中浮窗、语音输入浮窗及导航保护 |
| `src/main/capture/` | 隐藏采集窗口、PCM 和 WAV 收尾 |
| `src/main/recording-actions.ts` | 录制开始/停止互斥与失败收尾 |
| `src/main/live*.ts` | 现场稿、实时连接和重连 |
| `src/main/providers/` | DashScope 实时、文件、语音输入与润色 |
| `src/main/jobs/` | 异步转写、分离、取消、恢复与失败归类 |
| `src/main/store/` | 会话、密钥、稿件及磁盘格式 |
| `src/main/voiceprint/` | 片段筛选、CAM++、登记与匹配 |
| `src/main/dictation/` | 状态机、快捷键、设置、macOS 输入目标与剪贴板事务 |
| `src/main/playback*.ts` | 全局回听、媒体路由与确认 |
| `src/main/export.ts` | TXT / JSON 快照导出 |
| `src/preload/`, `src/shared/` | 受限 IPC API、DTO、模型和快捷键选项 |
| `src/renderer/` | React 主界面、浮窗、采集和播放宿主 |
| `scripts/` | 开发包、生产包、图标与模型下载 |

## 磁盘结构

```text
appData/Earshot/
  key                    本机明文 API key，0600
  prefs.json             自动区分、共用麦克风设置
  shortcuts.json         快捷键、交付方式及语音输入模型
  hotwords.json          本机词表及按账户/模型绑定的云词表状态
  usage.json             去重用量、计量来源与不确定完成记录
  people.json            已记住的名字
  people-voice.json       本机声纹向量、模型版本及来源
  sessions/<id>/
    session.json         会话状态、任务版本；语音输入另存原稿/结果字段
    mic.wav              录会麦克风原音
    system.wav           录会系统原音
    original.ext         导入音频的原始副本；只规范化 system.wav
    corrections.json     绑定原始段落/稿件的修正及撤销历史
    bookmarks.json       时间标记
    live.jsonl           现场稿
    refined-vN.json      文件转写派生稿
    speakers-vN.json     说话人分离派生稿
    names.json           绑定稿件/分组版本的本场起名映射
    asr-*.json           每轨任务 checkpoint、已完成结果与安全诊断
    voice-registration.json  用户命名登记意图、状态、次数及撤销截止时间
```

旧版本文件由存储层兼容读取，不应手工批量重写用户目录。语音输入记录没有两条 WAV；其正文及原稿在 `session.json`。删除会话不清空全局人物和声纹。

## 录制与恢复

开始前检查 Key、系统权限、回听停止确认及语音输入占用。录制状态包含 starting、recording、stopping 与 finalize_failed。停录失败必须留下可重试入口；退出不能把尚未完成的音频收尾当成成功。

实时请求设置 `heartbeat:true`。连接失败时继续录音，每轨独立按 1/2/4/8/16 秒退避，最多连续五次；稳定连接满 30 秒才重置该轨预算。鉴权、余额或明确参数错误停止自动重试，限流可重试；手动只恢复终止失败的轨。恢复接收后续 PCM，不回放断线期间缓存。停止清理连接和计时器，generation 隔离迟到事件。会话内 `realtime-events.json` 最多保留 200 条安全分类事件，权限 0600，写失败不影响录制，不保存原始错误信息或正文。

停录后精修与分离使用任务版本，忽略取消或被后续任务替代的结果。个人麦克风模式单独重跑分离复用已有麦克风稿；共用麦克风模式两轨均需分人。共用麦克风设置在开始录制时冻结，实时显示“现场”，会后显示可起名的“现场 A/B”。

起名先改变本场显示，先持久化登记意图，8 秒撤销期结束后才登记声纹。退出保留 pending/running 任务，下次启动验证姓名与稿件版本后恢复；最多自动尝试 3 次，仍可在起名弹层人工重试。异步结果再次验证操作所有权、名字、稿件和会话有效性。声纹不可用时保留人工名字。

## 转写任务与身份数据

`providers/asr-checkpoint.ts` 以音频内容、模型、分人参数的 SHA-256 绑定每轨任务。已完成结果从本机读取；有 task ID 的任务只续查。GET 对网络失败、超时与 429/部分 5xx 最多共请求 4 次，退避等待最多 30 秒；单次网络请求含响应体上限 120 秒。POST 不自动重试，提交响应未知会明确提示人工重试可能再次计费。服务端已过期任务进入失败态，再次人工重试才新建。恢复不是跨服务端的 exactly-once 保证。

最多同时处理两场录音。两轨分别保留成功结果，失败轨可复用现场稿或上一次稿件。发布新文字时，旧的人名与分组不能套用到新簇；只有音频来源与匿名发言均相同才携带人工姓名。不完整分组清除旧分组引用。历史人工映射另存，便于追查。

`voiceprint/evidence.ts` 至少需要两个不重叠片段，总计至少 6 秒；每段 2–4 秒，最多 3 段，分散选取。按候选自身的相对 AC-RMS 筛选活动帧，保留量化底线与削波拒绝，近恒定能量的候选另做噪声否决；排除已知同轨说话人重叠范围。返回原始 PCM，不做增益修改。没有明确结束时间的发言不用于声纹。此筛选不是 VAD，也不能证明云端分组绝对纯净。片段 embedding 必须相互一致，且每段独立支持同一人物、达到阈值并超过第二候选分差；否则保持匿名。当前匹配门槛未根据本轮真实会议测试调参；[公共会议评测](voiceprint-benchmark.md)显示低增益筛选已改善，但跨通道远场拒识仍多，不能保证每个人都能自动认回。

`people-voice.json` schema 2 保存稳定人物 ID、模型标识和每个样本的音频来源、音轨、片段范围。每人最多 3 个模板；用户纠正姓名时按稳定音频来源退休旧名模板，即使稿件版本因重试而变化。自动匹配只更新本场名字，不增加模板。已有旧格式可读并在下一次登记时迁移，不批量修改用户目录。Electron worker 中使用 `compute(stream, false)`，避免原生 external ArrayBuffer 被 Electron 拒绝。

## 本地稿件工具、导入和设置

单段修正采用独立 `corrections.json`，版本绑定会话、稿件、原始段落与名字；原稿换版时不把旧修正套到新文字。搜索按当前会话详情扫描，不上传全文，也不维护容易残留已删除内容的第二索引。录中快照只读取轻量缓存书签，不反复解析增长中的现场 JSONL。

导入只接受主进程原生文件选择器给出的路径，源文件以只读且不跟随符号链接的描述符读取。复制到私有暂存目录，Chromium 在独立、无网络的隐藏窗口解码为 16 kHz 单声道 PCM；64 MiB/30 分钟上限限制内存。WAV 完成后目录原子重命名，再提交会话并排队；取消或失败清理本次未提交文件。导入音轨标记为仅系统轨，不补造麦克风轨或实时稿。

回听速度和 seek 都经过同一主进程序列与 renderer ACK；回执报告实际速率，不能仅以发送命令判为完成。热词参数与请求 Key 同时冻结，切换账户不能向旧请求混入新账户词表。修改热词创建新云词表，旧 ID 的内容不原地更新或自动删除；相同账户、相同内容的 readiness 重试复用既有 ID。已有付费任务继续使用 checkpoint，编辑热词不能触发自动重新提交。

用量记录优先读取服务商计量，否则记录发送音频时长并标记本机测量。未知完成与缺少 Token 不写成零费用。固定已知模型价格仅作参考估算；单个 DashScope Key 不提供阿里云账户余额或实际财务账单。

## 语音输入

启用语音输入时预加载一个隐藏采集页面；页面只注册开始回调，不在空闲时请求麦克风。开始指令到达后才创建音频流；第一个有效 PCM 使采集启动完成，控制器也保留等待启动 Promise 返回期间的音频。结束后销毁本次采集页并重新准备空闲页，退出或关闭语音输入时清理预加载页。

默认按住 `Alt+Space`，录会默认 `Control+Alt+R`，由 `src/shared/dictation.ts` 定义。设置持久化与快捷键注册失败需要回滚，录制快捷键可独立于语音输入启用状态存在。

识别选项以 `src/shared/model-settings.ts` 为准。默认 Qwen Audio 3.0 ASR 流式识别，润色关闭。ASR、润色、存储及插入失败应保留可恢复的文字；取消后不能让迟到结果写入其他目标。

`macos.ts` 用现有 koffi 延迟加载系统框架，读取指定按键状态、捕获目标并发送一次 Cmd+V。`input-target.ts` 在可读取时核对原文、选区和实际结果；已知目标变化时拒写，不可核验时保留结果供用户检查。

`clipboard.ts` 管理完整剪贴板租约，`macos-pasteboard.ts` 负责 AppKit 读写，`pasteboard-client.ts` 与 `pasteboard-worker.ts` 把同步 provider 等待隔离在主进程内单个 Worker 线程。原内容只在内存，恢复验证版本与会话标记。超时不创建第二个 Worker；恢复失败或未确认通过交付层传到 HUD。退出等待活动清理，已死亡 Worker 不阻止正常退出。原生库缺失不阻止录会应用启动。

## 构建和依赖

用 `npm ci` 安装锁定依赖。`npm run build` 编译 main、preload、renderer 和独立声纹 worker 及剪贴板 Worker 入口。`npm run package` 复制 Electron.app，设置稳定 bundle ID `app.earshot`，加入源码构建结果、运行时依赖闭包、图标与可选模型，然后签名。

`npm run install:app` 会重建并替换 `/Applications/Earshot.app`。模型下载和依赖安装需要联网；开发/生产应用包和模型不入 Git。签名并不等于 Apple 公证。GitHub 发布准备、版本追溯和安装包兼容性检查见 [release.md](release.md)。

## 验证

`npm run typecheck`、`npm test`、`npm run build` 是基础检查。测试的 OS / 云端替身只证明程序行为；真实采集、权限、按住/松开、跨 App 回填、浮窗全屏行为需要人工或真机证据。[validation.md](validation.md)记录当前边界。
