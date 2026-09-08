import type {
  ActionResult,
  AppSnapshot,
  EarshotApi,
  RecordingLive,
  SessionDetail,
  SessionJobs,
  SessionSummary,
  TranscriptTurn,
} from "../shared/types";
import { normalizeHotwords, type HotwordStatus } from "../shared/hotwords";
import type { CorrectTurnInput, TurnCorrectionInput, TranscriptSearchHit } from "../shared/transcript-tools";

/**
 * 仅 DEV + 无 preload 时注入,便于 Vite 浏览器预览。
 * 场景经 ?mock= 切换:first | denied | nokey | ready(默认) | working | failed | recording | usage
 * recording 场景配合 #glance 使用,双轨 partial 持续流式更新。
 */
export function installDevMock(): void {
  if (!import.meta.env.DEV || typeof window.earshot !== "undefined") return;

  const scenario = new URLSearchParams(location.search).get("mock") ?? "ready";
  const voiceStatus = new URLSearchParams(location.search).get("voice");
  const voiceStates = ["pending", "running", "remembered", "insufficient", "conflicting", "unavailable", "stale"] as const;
  const registrationStatus = voiceStates.find(status => status === voiceStatus);
  const dayMs = 86_400_000;
  const at = (offsetDays: number, h: number, m: number): string => {
    const d = new Date(Date.now() - offsetDays * dayMs);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };

  const jobsDone: SessionJobs = { live: "done", refined: "done", speakers: "done" };
  const named = scenario !== "failed";
  const spk = (key: "wm" | "a" | "b"): string =>
    named ? { wm: "王明", a: "小 A", b: "小 B" }[key] : "对方";

  // [分, 秒, 说话人, 文本]
  const script: Array<[number, number, "you" | "wm" | "a" | "b", string]> = [
    [0, 12, "you", "先对齐今天的三件事：上周的留存数据、新版录音库的进度，还有下周演示要不要带真实数据。"],
    [0, 41, "wm", "留存我这边有结论了。七日留存从百分之三十一涨到三十六，主要贡献是回看提醒，不是新引导。"],
    [1, 8, "you", "回看提醒是指停录之后那条通知？"],
    [1, 15, "wm", "对，点通知直接落到那场会的稿子上，路径短了很多。"],
    [1, 52, "a", "我补一个反例，有两个受访用户说通知来得太快，会还没散就提醒回看，显得有点急。"],
    [2, 20, "you", "这个好办，延迟到检测不到声音再发。记一下，下个迭代做。"],
    [2, 48, "b", "新版录音库的进度说一下。列表和详情已经合到一个窗口，起名浮层做完了，剩播放器的进度条。"],
    [3, 15, "you", "进度条别做花，一条线加一个时间就够。"],
    [3, 30, "b", "明白，周四能提测。"],
    [4, 2, "wm", "演示的事我有倾向，带真实数据。上次用假会议记录，客户第一个问题就是「这是真的吗」，反而减分。"],
    [4, 40, "a", "同意，但要把人名先改掉，上次差点把候选人名字投出去。"],
    [5, 5, "you", "那就定了：带真实数据，演示前一天我过一遍稿子，把名字都换掉。"],
    [5, 38, "b", "对了，静山咖啡那场访谈的稿子我发你们了吗？里面有两段关于价格的话很值得听原声。"],
    [6, 4, "you", "发过了，我听了。第二段那句「不是贵，是不知道为什么贵」可以直接放进演示。"],
    [6, 30, "wm", "这句好。放结尾，比我们自己总结有说服力。"],
    [7, 1, "a", "我这边还有个小事，权限页那句提示文案改了之后，新用户卡在屏幕录制这步的少了差不多一半。"],
    [7, 33, "you", "数据从哪看的？"],
    [7, 40, "a", "激活漏斗，上周四切的版本，样本量三百多，够看趋势了。"],
    [8, 12, "b", "那句文案是改成什么了？"],
    [8, 20, "a", "就一句「打开名单里的 Earshot，系统会提示退出并重新打开」，把系统行为提前说了，用户就不慌。"],
    [9, 0, "you", "好，这类文案以后都走同一个原则：说清系统会做什么，不解释我们为什么要。"],
    [9, 35, "wm", "下周排期我拉个草稿，今天先不占时间。"],
    [10, 2, "you", "行。最后一件，下周三我不在，周会移到周四早上，有冲突的现在说。"],
    [10, 28, "b", "我周四要陪提测，早上十点前可以。"],
    [10, 44, "a", "没冲突。"],
    [11, 0, "wm", "可以。"],
    [11, 20, "you", "那就周四九点半。今天就到这，散会。"],
  ];

  const turns: TranscriptTurn[] = script.map(([m, s, who, text], i) => ({
    id: `t${i + 1}`,
    track: who === "you" ? "you" : "other",
    speaker: who === "you" ? "你" : spk(who),
    tStartMs: (m * 60 + s) * 1000,
    text,
  }));

  const jobsByScenario: SessionJobs =
    scenario === "working"
      ? { live: "done", refined: "running", speakers: "running" }
      : scenario === "failed"
        ? { live: "done", refined: "failed", speakers: "failed" }
        : jobsDone;

  const weekly: SessionDetail = {
    id: "s-weekly",
    title: "产品周会",
    startedAt: at(0, 9, 30),
    endedAt: at(0, 10, 17),
    durationSec: 2832,
    status: "complete",
    jobs: jobsByScenario,
    turns,
    people: named ? ["王明", "林晓"] : [],
    ...(registrationStatus ? { voiceRegistrations: [{ name: "王明", status: registrationStatus }] } : {}),
  };

  const others: SessionSummary[] = [
    { id: "s-11", title: "和林晓一对一", startedAt: at(0, 14, 0), durationSec: 1567, status: "complete", jobs: jobsDone },
    { id: "s-interview", title: "客户访谈 · 静山咖啡", startedAt: at(1, 16, 20), durationSec: 3488, status: "complete", jobs: jobsDone },
    { id: "s-review", title: "评审：录音库改版", startedAt: at(5, 11, 0), durationSec: 2460, status: "complete", jobs: jobsDone },
    { id: "s-sync", title: "临时同步", startedAt: at(7, 18, 40), durationSec: 542, status: "incomplete", jobs: { live: "done", refined: "idle", speakers: "idle" } },
  ];

  const dictationFixture: SessionDetail = { id: 's-dictation', kind: 'dictation', title: '明天下午三点半开评审', startedAt: at(0, 15, 15), endedAt: at(0, 15, 15), durationSec: 12, status: 'complete', jobs: { live: 'done', refined: 'idle', speakers: 'idle' }, turns: [], people: [],
    dictation: { text: '明天下午三点半开评审，请小王把第二版文档发给我。', rawText: '嗯，明天下午两点，不对，改成三点半开评审，请小王把第二版文档发给我。', asrModel: 'qwen-audio-3.0-asr-flash-streaming', polishModel: 'qwen3.7-flash' } };
  const previewDetails = new Map<string, SessionDetail>([
    [weekly.id, weekly], [dictationFixture.id, dictationFixture],
    ...others.map(row => [row.id, { ...row, endedAt: row.startedAt, turns: structuredClone(turns.slice(0, 8)), people: [...weekly.people] }] as [string, SessionDetail]),
  ]);
  for (const detail of previewDetails.values()) {
    detail.bookmarks = detail.id === weekly.id ? [{ id: "10000000-0000-4000-8000-000000000001", tStartMs: 242000, label: "演示数据" }] : [];
    if (detail.kind === 'dictation' && detail.dictation) detail.turns = [{ id: 'dictation', track: 'you', speaker: '你', text: detail.dictation.text, tStartMs: 0 }];
    else for (const turn of detail.turns) turn.correction = { revision: '0'.repeat(64), originalText: turn.text,
      originalSpeaker: turn.speaker, edited: false, speakerOverridden: false, canUndo: false };
  }
  const empty = scenario === "first" || scenario === "denied";
  const state: AppSnapshot = {
    hasApiKey: !(scenario === "first" || scenario === "nokey"),
    autoDiarize: true,
    permissions:
      scenario === "first"
        ? { microphone: "undetermined", screen: "undetermined" }
        : scenario === "denied" || scenario === "deniedlist"
          ? { microphone: "granted", screen: "denied" }
          : { microphone: "granted", screen: "granted" },
    recording: null,
    playingSessionId: null,
    sessions: empty ? [] : [...(scenario === "dictation" ? [dictationFixture] : []), summaryOf(weekly), ...others],
    selectedId: empty ? null : scenario === "dictation" ? dictationFixture.id : weekly.id,
    selected: empty ? null : scenario === "dictation" ? dictationFixture : weekly,
  };

  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const fn of listeners) fn();
  };
  const ok = { ok: true as const };
  let liveDetail: SessionDetail | null = null;
  let streamTimer: number | undefined;
  let playbackRate = 1;
  let editRevision = 0;
  const editHistory = new Map<string, { text: string; speaker: string }[]>();
  const detailFor = (id: string) => id === liveDetail?.id ? liveDetail : previewDetails.get(id);
  const previewOnly = (feature: string): ActionResult => ({ ok: false, error: `浏览器预览不支持${feature}，请在 Earshot 应用中操作` });
  let hotwords: HotwordStatus = {
    words: empty ? [] : ['矩阵起源', 'MatrixOne', 'Earshot'], updatedAt: null, sync: empty ? 'empty' : 'pending',
    message: '仅为界面预览，未读取本机词表或连接百炼。',
    models: [
      { model: 'qwen-audio-3.0-asr-flash-streaming', label: 'Qwen Audio 3.0 语音输入', supported: true, ready: false },
      { model: 'fun-asr', label: '录音文件转写', supported: true, ready: false },
      { model: 'fun-asr-realtime', label: '录中实时转写', supported: true, ready: false },
      { model: 'qwen3-asr-flash-realtime', label: 'Qwen3 ASR 语音输入', supported: false, ready: false },
    ],
  };
  function editTurn(input: TurnCorrectionInput | CorrectTurnInput, action: 'correct' | 'undo' | 'reset'): ActionResult {
    const detail = detailFor(input.sessionId), turn = detail?.turns.find(row => row.id === input.turnId);
    if (!detail || detail.status === 'recording' || !turn?.correction || turn.partial) return { ok: false, error: '这段暂时无法编辑' };
    if (input.revision !== turn.correction.revision) return { ok: false, error: '这段转写已更新，请重新打开编辑' };
    const key = `${input.sessionId}:${input.turnId}`, history = editHistory.get(key) ?? [];
    let value: { text: string; speaker: string };
    if (action === 'undo') {
      if (!history.length) return { ok: false, error: '没有可撤销的修改' };
      value = history.pop()!;
    } else {
      if (action === 'correct') {
        const draft = input as CorrectTurnInput;
        if (!draft.text.trim() || draft.text.length > 20000 || !draft.speaker.trim() || draft.speaker.length > 80 || /[\u0000-\u001f\u007f]/.test(draft.speaker)) return { ok: false, error: '正文不能为空且最多 20000 字；说话人最多 80 字' };
        value = { text: draft.text, speaker: draft.speaker.trim() };
      } else value = { text: turn.correction.originalText, speaker: turn.correction.originalSpeaker };
      if (value.text === turn.text && value.speaker === turn.speaker) return ok;
      history.push({ text: turn.text, speaker: turn.speaker });
    }
    editHistory.set(key, history.slice(-20));
    Object.assign(turn, value);
    turn.correction = { ...turn.correction, revision: (++editRevision).toString(16).padStart(64, '0'),
      edited: value.text !== turn.correction.originalText || value.speaker !== turn.correction.originalSpeaker,
      speakerOverridden: value.speaker !== turn.correction.originalSpeaker, canUndo: history.length > 0 };
    emit(); return ok;
  }
  let connection: RecordingLive["connection"] = scenario === "lost" ? "disconnected" : "connected";
  const select = (id: string): void => {
    state.selectedId = id;
    state.selected = detailFor(id) ?? null;
  };

  // ── recording 场景:双轨流式 partial ──
  const liveLines: Array<["you" | "other", string]> = [
    ["you", "我先说结论，这版方案可以进评审，但价格那页要重写。"],
    ["other", "重写的意思是换说法，还是整个结构都动？"],
    ["you", "结构不动，把「按月付费」挪到最上面，试用期那句放大。"],
    ["other", "好，那我今天下午改完发你。对了，数据页的图例颜色反了。"],
    ["you", "反了？我看看。确实，红绿标反了，这个我顺手改掉。"],
    ["other", "还有一件事，客户问能不能导出带说话人的稿子，这个在计划里吗？"],
    ["you", "在，下个月的切片里，先不承诺具体日期。"],
  ];

  function startLiveStream(): void {
    if (streamTimer) window.clearInterval(streamTimer);
    const t0 = Date.now();
    const baseSec = scenario === "long" ? 5400 : 768;
    const seed = scenario === "long" ? Array.from({ length: 2000 }, (_, i) => ({
      ...turns[i % turns.length], id: `long-${i}`, tStartMs: i * 2700,
    })) : turns.slice(0, 20);
    const finals: TranscriptTurn[] = seed.map((row) => ({
      ...row,
      id: `live-pre-${row.id}`,
      speaker: row.track === "you" ? "你" : "对方",
    }));
    let lineIdx = 0;
    let charIdx = 0;
    let liveSeq = 0;

    const rec = (): RecordingLive => {
      const [track, full] = liveLines[lineIdx % liveLines.length];
      const partial: TranscriptTurn = {
        id: `live-${track}-${liveSeq}`,
        track,
        speaker: track === "you" ? "你" : "对方",
        tStartMs: baseSec * 1000 + lineIdx * 6000,
        text: full.slice(0, charIdx),
        partial: true,
      };
      return {
        sessionId: "s-live",
        elapsedSec: Math.floor((Date.now() - t0) / 1000) + baseSec,
        glanceVisible: location.hash === "#glance",
        connection,
        phase: "recording",
        turns: charIdx > 0 ? [...finals, partial] : [...finals],
      };
    };

    state.recording = rec();
    state.capturePhase = "recording";
    liveDetail = { id: "s-live", title: "正在录制的产品周会", startedAt: new Date(t0 - baseSec * 1000).toISOString(),
      endedAt: null, durationSec: baseSec, status: "recording", jobs: { live: "running", refined: "idle", speakers: "idle" },
      turns: state.recording.turns, people: [],
    };
    state.sessions = [summaryOf(liveDetail), ...state.sessions.filter(row => row.id !== liveDetail!.id)];
    select(liveDetail.id);
    streamTimer = window.setInterval(() => {
      if (connection !== "connected") { state.recording = rec(); emit(); return; }
      const [track, full] = liveLines[lineIdx % liveLines.length];
      charIdx += 2 + Math.floor(Math.random() * 4);
      if (charIdx >= full.length) {
        finals.push({
          id: `live-${track}-${liveSeq}`,
          track,
          speaker: track === "you" ? "你" : "对方",
          tStartMs: baseSec * 1000 + lineIdx * 6000,
          text: full,
        });
        lineIdx += 1;
        liveSeq += 1;
        charIdx = 0;
      }
      state.recording = rec();
      if (liveDetail) liveDetail.turns = state.recording.turns;
      emit();
    }, 450);
  }

  const api: EarshotApi = {
    searchTranscripts: async ({ query, limit = 50 }) => {
      if (query.length > 200 || /[\u0000-\u001f\u007f]/.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, error: '搜索最多 200 字，结果上限为 100 条' };
      const terms = [...new Set(query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
      if (!terms.length) return { ok: true, hits: [], truncated: false };
      const hits: TranscriptSearchHit[] = [];
      for (const summary of state.sessions) {
        const detail = detailFor(summary.id); if (!detail) continue;
        const titleMatches = terms.every(term => detail.title.toLocaleLowerCase().includes(term));
        if (titleMatches) hits.push({ sessionId: detail.id, sessionTitle: detail.title, turnId: null, tStartMs: null, snippet: detail.title });
        for (const turn of detail.turns) {
          const text = `${turn.speaker}\n${turn.text}`.toLocaleLowerCase(), content = `${detail.title}\n${text}`.toLocaleLowerCase();
          if (!terms.every(term => content.includes(term)) || (titleMatches && !terms.some(term => text.includes(term)))) continue;
          hits.push({ sessionId: detail.id, sessionTitle: detail.title, turnId: turn.id, tStartMs: turn.tStartMs,
            snippet: turn.text.slice(0, 180), speaker: turn.speaker, revision: turn.correction?.revision });
        }
      }
      return { ok: true, hits: hits.slice(0, limit), truncated: hits.length > limit };
    },
    correctTurn: async input => editTurn(input, 'correct'),
    undoTurnCorrection: async input => editTurn(input, 'undo'),
    resetTurnCorrection: async input => editTurn(input, 'reset'),
    addBookmark: async ({ sessionId, tStartMs, label = '' }) => {
      const detail = detailFor(sessionId), maxMs = state.recording?.sessionId === sessionId ? state.recording.elapsedSec * 1000 : (detail?.durationSec ?? 0) * 1000;
      if (!detail || detail.kind === 'dictation' || !Number.isSafeInteger(tStartMs) || tStartMs < 0 || tStartMs > maxMs || label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) return { ok: false, error: '标记时间须在录音内，名称最多 80 字' };
      if ((detail.bookmarks?.length ?? 0) >= 10000) return { ok: false, error: '这场录音的标记已达上限' };
      detail.bookmarks = [...(detail.bookmarks ?? []), { id: crypto.randomUUID(), tStartMs, label: label.trim() }].sort((a, b) => a.tStartMs - b.tStartMs);
      emit(); return ok;
    },
    deleteBookmark: async ({ sessionId, bookmarkId }) => {
      const detail = detailFor(sessionId);
      if (!detail?.bookmarks?.some(row => row.id === bookmarkId)) return { ok: false, error: '标记已删除，请刷新' };
      detail.bookmarks = detail.bookmarks.filter(row => row.id !== bookmarkId); emit(); return ok;
    },
    hotwordStatus: async () => structuredClone(hotwords),
    saveHotwords: async text => {
      hotwords = { ...hotwords, words: normalizeHotwords(text), updatedAt: null, sync: 'pending', message: '仅更新本页示例，未写入本机或同步到百炼；刷新页面后恢复。' };
      if (!hotwords.words.length) hotwords.sync = 'empty';
      return structuredClone(hotwords);
    },
    syncHotwords: async () => ({ ...structuredClone(hotwords), sync: 'error', message: '浏览器预览无法同步云端热词，请在 Earshot 应用中操作。' }),
    usageSummary: async (period = 'month') => {
      const now = Date.now(), sample = scenario === 'usage';
      return { period, since: now - dayMs * (period === 'today' ? 1 : 30), updatedAt: now, trackingSince: now - dayMs * 30,
        requests: sample ? 12 : 0, audioSeconds: sample ? 3600 : 0, inputTokens: 0, outputTokens: 0,
        estimatedCny: sample ? 1.19 : 0, unpricedRequests: 0, localMeasuredRequests: 0, unconfirmedRequests: 0,
        rows: sample ? [{ model: 'qwen-audio-3.0-asr-flash-streaming', requests: 12, audioSeconds: 3600, inputTokens: 0, outputTokens: 0, estimatedCny: 1.19, unpricedRequests: 0 }] : [],
        actualBilling: 'unavailable', balanceCny: null,
        billingReason: sample ? '界面预览：以上为虚构示例数据，不是实际用量、费用或账户余额。请在 Earshot 应用中查看本机记录。' : '浏览器预览未读取任何真实用量或账户余额；请在 Earshot 应用中查看本机记录。',
        pricingDate: '预览示例', retentionDays: 366, capped: false };
    },
    openBilling: async () => { window.alert('请在 Earshot 应用中打开百炼账单；浏览器预览未连接账户。'); },
    importAudio: async () => ({ ok: false, error: '浏览器预览无法导入真实文件，请在 Earshot 应用中操作。' }),
    cancelAudioImport: async () => { delete state.audioImport; emit(); },
    setPlaybackRate: async rate => {
      if (!state.playback || state.recording || ![0.75, 1, 1.25, 1.5, 2].includes(rate)) return { ok: false, error: '请选择有效的播放速度，并先打开一段录音' };
      playbackRate = rate; state.playback.rate = rate; emit(); return ok;
    },
    snapshot: async () => structuredClone(state),
    saveKey: async () => {
      state.hasApiKey = true;
      emit();
      return ok;
    },
    requestMic: async () => ok,
    requestScreen: async () => ok,
    openPrivacy: async () => undefined,
    openKeyPage: async () => undefined,
    start: async () => {
      if (state.recording) return { ok: false, error: "已有正在进行的录音", code: "busy" };
      state.playingSessionId = null;
      state.playback = null;
      startLiveStream();
      location.hash = "glance";
      emit();
      return ok;
    },
    stop: async () => {
      if (!state.recording || !liveDetail) return { ok: false, error: "没有正在进行的录音" };
      window.clearInterval(streamTimer);
      state.capturePhase = "stopping";
      state.recording.phase = "stopping";
      emit();
      await new Promise(resolve => setTimeout(resolve, 250));
      liveDetail.status = "complete";
      liveDetail.durationSec = state.recording.elapsedSec;
      liveDetail.turns = liveDetail.turns.filter(row => !row.partial);
      for (const turn of liveDetail.turns) turn.correction = { revision: '0'.repeat(64), originalText: turn.text,
        originalSpeaker: turn.speaker, edited: false, speakerOverridden: false, canUndo: false };
      liveDetail.jobs.live = "done";
      state.sessions = state.sessions.map(row => row.id === liveDetail!.id ? summaryOf(liveDetail!) : row);
      state.recording = null;
      state.capturePhase = "idle";
      select(liveDetail.id);
      state.libraryRequest = (state.libraryRequest ?? 0) + 1;
      location.hash = "";
      emit();
      return ok;
    },
    selectSession: async (id: string) => {
      select(id);
      emit();
    },
    setAutoDiarize: async (on: boolean) => {
      state.autoDiarize = on;
      emit();
    },
    setSharedMicrophone: async (on: boolean) => { state.sharedMicrophone = on; emit(); },
    renameSession: async ({sessionId,title}) => {
      const target = state.sessions.find(row => row.id === sessionId);
      const name = title.trim();
      if(!target || !name || Array.from(name).length > 80) return {ok:false,error:"名称不能为空，且最多 80 个字符"};
      target.title=name;
      const preview = detailFor(sessionId); if (preview) preview.title = name;
      if (weekly.id === sessionId) weekly.title = name;
      const older = others.find(row => row.id === sessionId);
      if (older) older.title = name;
      if (state.playback?.sessionId === sessionId) state.playback.title = name;
      if(state.selected?.id === sessionId) state.selected.title=name;
      emit(); return ok;
    },
    renameSpeaker: async ({ from, to }) => {
      weekly.turns = weekly.turns.map((row) => (row.speaker === from ? { ...row, speaker: to } : row));
      if (!weekly.people.includes(to)) weekly.people = [...weekly.people, to];
      if (state.selected?.id === weekly.id) state.selected = weekly;
      emit();
      return ok;
    },
    undoSpeakerRename: async () => ({ ok: false, error: "该演示没有待撤销的改名" }),
    retryJob: async ({ job }) => {
      weekly.jobs = { ...weekly.jobs, [job]: "running" };
      emit();
      return ok;
    },
    cancelJob: async () => {
      // Cancellation is a neutral persisted result, with a continuation action.
      weekly.jobs = {
        ...weekly.jobs,
        refined: "canceled",
        speakers: "canceled",
        failedReason: undefined,
        speakersFailReason: undefined,
      };
      emit();
      return ok;
    },
    hideGlance: async () => undefined,
    showGlance: async () => { location.hash = "glance"; },
    showLibrary: async () => {
      if (state.recording) select(state.recording.sessionId);
      state.libraryRequest = (state.libraryRequest ?? 0) + 1;
      location.hash = "";
      emit();
    },
    retryRealtime: async () => {
      if (!state.recording || connection !== "disconnected") return { ok: false, error: "当前不需要重连" };
      connection = "reconnecting";
      state.recording.connection = connection;
      emit();
      window.setTimeout(() => {
        connection = "connected";
        if (state.recording) { state.recording.connection = connection; emit(); }
      }, 1200);
      return ok;
    },
    playSession: async (id: string) => {
      if (state.recording) return { ok: false, error: "录音中不能回听，避免把播放录入本场", code: "busy" };
      const session = state.sessions.find(row => row.id === id);
      if (!session) return { ok: false, error: "Unknown session" };
      if (state.playback?.sessionId === id && ['paused', 'playing'].includes(state.playback.status)) {
        state.playback.status = 'playing'; emit(); return ok;
      }
      state.playingSessionId = id;
      state.playback = { sessionId: id, title: session.title, status: "playing", positionSec: 0, durationSec: session.durationSec, rate: playbackRate };
      emit();
      return ok;
    },
    pausePlayback: async () => { if (state.playback) state.playback.status = "paused"; emit(); return ok; },
    resumePlayback: async () => { if (state.playback) { if (state.playback.status === "ended") state.playback.positionSec = 0; state.playback.status = "playing"; } emit(); return ok; },
    seekPlayback: async ({ sessionId, positionSec, resume }) => {
      if (state.recording) return { ok: false, error: "Recording in progress" };
      const target = state.sessions.find(row => row.id === sessionId);
      if (!target || !Number.isFinite(positionSec) || positionSec < 0 || positionSec > target.durationSec) return { ok: false, error: '无效的回听位置' };
      if (state.playback?.sessionId !== sessionId) { const loaded = await api.playSession(sessionId); if (!loaded.ok) return loaded; }
      if (state.playback) { state.playback.positionSec = positionSec; if (resume) state.playback.status = "playing"; }
      emit(); return ok;
    },
    playbackHost: async () => {}, reportPlayback: () => {}, onPlaybackCommand: () => () => {},
    stopPlayback: async () => {
      state.playingSessionId = null;
      state.playback = null;
      emit();
      return ok;
    },
    dictationSnapshot: async () => ({phase:'idle',text:'',message:'',startedAt:null,level:0,retryable:false}),
    onDictation: () => () => {}, beginDictation: async () => ({ok:true}), endDictation: async () => {}, cancelDictation: async () => {},
    retryDictation: async () => ({ok:true}), insertDictation: async () => ({ok:true}), copyDictation: async () => ({ok:true}),
    setShortcutCapture: async () => ({ok:true}),
    saveShortcuts: async () => ({ok:false,error:'请在 Earshot 应用中设置系统快捷键'}), requestAccessibility: async () => {},
    deleteSession: async () => ({ ok: false, error: "请在 Earshot 应用中管理真实会话" }),
    undoDeleteSession: async () => ({ ok: false, error: "没有待撤销的删除" }),
    revealSession: async () => previewOnly("打开本机录音目录"),
    revealExport: async () => previewOnly("显示导出文件"),
    exportTranscript: async () => ({ ok: false, error: "请在 Earshot 应用中导出" }),
    onChange: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  window.setInterval(() => {
    if (state.playback?.status !== "playing") return;
    state.playback.positionSec = Math.min(state.playback.durationSec, state.playback.positionSec + 0.25 * state.playback.rate);
    if (state.playback.positionSec >= state.playback.durationSec) state.playback.status = "ended";
    emit();
  }, 250);
  window.earshot = api;

  if (["recording", "lost", "long"].includes(scenario)) startLiveStream();
}

function summaryOf(detail: SessionDetail): SessionSummary {
  return {
    id: detail.id,
    title: detail.title,
    startedAt: detail.startedAt,
    durationSec: detail.durationSec,
    status: detail.status,
    jobs: detail.jobs,
  };
}
