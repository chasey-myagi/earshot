# Earshot 协作约定

本仓是独立的 Earshot MVP，不是 `agent-ears` 的分支。产品做减法，代码重写，技术方案按本仓的 implementation 重新拍，不搬旧仓实现。

## 范围

只做：录制、存储、实时转写、异步转写、自动云端识人、轻量声纹（起名留下，跨会还能用）、按住说话的语音输入及可选文字润色。全部 BYOK。授权一次，不要每场确认。

不做：纪要、Agent、灵动岛、桌面歌词、双形态、会议稿 Chat 清稿、VoiceProfileVault / 资格门 / daemon。

## 简单优先

能用一个 Electron 主进程解决的，不要再拆运行时。
录中浮窗是第二个 Electron 窗口，不是新的原生壳。
不要为假想的第二引擎预留接口。
DashScope 调用写在 `src/main/providers/`，UI 不得直连外网。

## 原生边界

不新增原生壳或采集 helper。双轨采集全在 Electron（Chromium loopback + getUserMedia），TCC 全挂在 Earshot.app。
已批准的原生依赖为 node-mac-permissions（权限）、sherpa-onnx-node（本机声纹）与 koffi（主进程内按键状态及 Accessibility 回填），不新增 daemon。
新增任何原生依赖前，先问：浏览器或 Electron 主进程是否已经能做。

## 验证

改动先定义怎么证明。能跑的检查要真的跑。
真机权限、系统音频、浮窗不在 headless 测试覆盖范围内，未跑就写「未验证」。

## 密钥

DashScope Key 只由用户在界面填写，写进 Application Support 下仅本人可读的文件。不进钥匙串、不写 `.env`、不进仓库、不进默认日志。
