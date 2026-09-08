import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  ActionResult,
  AppSnapshot,
  CapturePhase,
  ExportFormat,
  PermissionState,
  PlaybackState,
  PrivacyPane,
  RealtimeStatus,
  SessionDetail,
  SessionSummary,
} from "../shared/types";
import { formatDurationLong, formatDurationShort, formatListWhen, formatStartTime, isSameDay } from "./format";
import { MicIcon, PlayIcon, PauseIcon, ScreenIcon } from "./icons";
import appIcon from "../../assets/earshot-icon.png";
import { anchorPopover } from "./popover";
import { sessionSideHint } from "./sessionSide";
import { TranscriptView, type ReadingPositions } from "./TranscriptView";
import { RecordingClock, RealtimeNotice, StopRecording } from "./RecordingControls";
import { NameEditor } from "./NameEditor";
import { SessionTitle } from "./SessionTitle";
import { ExportMenu } from "./ExportMenu";
import { PlaybackBar } from "./PlaybackBar";
import { DictationPermission, DictationSettings } from "./Dictation";
import { SessionRow, DeletionNotices } from "./SessionRow";
import { workBarMessage, workFeedback } from "./workBar";
import { voiceRegistrationMessage } from "./voice-status";
import { SearchPanel } from "./SearchPanel";
import { TranscriptEditor } from "./TranscriptEditor";
import { HotwordSettings } from "./HotwordSettings";
import { UsageSettings } from "./UsageSettings";
import type { TranscriptSearchHit } from "../shared/transcript-tools";

type ExportNotice = { text: string; saved?: { id: string; path: string } };
type NameUndo = { id: string; expiresAt: number; to: string; count: number; sessionId: string; anchor: HTMLElement | null };

type Asking = "mic" | "screen" | null;
type RightPane = "session" | "settings";

function hasUsableKey(snap: AppSnapshot, draft: string): boolean {
  return snap.hasApiKey;
}

function canStart(snap: AppSnapshot, draft: string): boolean {
  return (
    !snap.recording && !snap.audioImport &&
    !["preparing", "listening", "transcribing"].includes(snap.dictation?.phase ?? "idle") &&
    (!snap.capturePhase || snap.capturePhase === "idle") &&
    snap.permissions.microphone === "granted" &&
    snap.permissions.screen === "granted" &&
    hasUsableKey(snap, draft)
  );
}

function startWhy(snap: AppSnapshot, draft: string): string | null {
  if (snap.audioImport) return "请先完成或取消录音导入";
  if (["preparing", "listening", "transcribing"].includes(snap.dictation?.phase ?? "idle")) return "请先结束语音输入";
  if (snap.permissions.microphone !== "granted") return "请先允许麦克风访问";
  if (snap.permissions.screen !== "granted") return "请先允许屏幕录制，以录下系统声音";
  if (!hasUsableKey(snap, draft)) return "请先保存百炼 API 密钥";
  return null;
}

function startError(result: ActionResult): string {
  if (result.ok) return "";
  if (result.code === "no_key") return "请先保存百炼 API 密钥";
  if (result.code === "no_mic") return "请先允许麦克风访问";
  if (result.code === "no_screen") return "请先允许屏幕录制，以录下系统声音";
  return result.error;
}

type LibraryProps = {
  snap: AppSnapshot;
  refresh: () => Promise<void>;
};

export function Library({ snap, refresh }: LibraryProps) {
  const first = snap.sessions.length === 0;
  const [pane, setPane] = useState<RightPane>("session");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const keySaving = useRef(false);
  const [asking, setAsking] = useState<Asking>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const jobInFlight = useRef(new Set<string>());
  const [jobPending, setJobPending] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null);
  const exportBusy = useRef(false);
  const selectedForExport = useRef<string | null>(null);
  selectedForExport.current = snap.selected?.id ?? null;
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [renameAnchor, setRenameAnchor] = useState<DOMRect | null>(null);
  const renameAnchorEl = useRef<HTMLElement | null>(null);
  const renameAttempt = useRef(0);
  const renameSaving = useRef(false);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [nameUndo, setNameUndo] = useState<NameUndo | null>(null);
  const askedSelect = useRef<string | null>(null);
  const hadSessions = useRef(!first);
  const readingPositions = useRef<ReadingPositions>(new Map());
  const starting = useRef(false);
  const [startBusy, setStartBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const importing = useRef(false);
  const navigationRequest = useRef(0);
  const [pendingSearch, setPendingSearch] = useState<{ hit: TranscriptSearchHit; request: number } | null>(null);
  const [focusTurn, setFocusTurn] = useState<{ sessionId: string; turnId: string; request: number } | null>(null);
  const searchRefreshKey = JSON.stringify([snap.sessions, snap.selected?.turns.map(turn => [turn.id, turn.correction?.revision]), snap.selected?.transcriptToolsError]);
  function openPane(next: RightPane) { navigationRequest.current += 1; setPendingSearch(null); setFocusTurn(null); setPane(next); }
  function openSession(id: string) { openPane("session"); void window.earshot.selectSession(id); }
  async function searchSelect(hit: TranscriptSearchHit) {
    const request = ++navigationRequest.current;
    setPane("session"); setFocusTurn(null); setPendingSearch({ hit, request }); setActionError(null);
    try { await window.earshot.selectSession(hit.sessionId); await refresh(); }
    catch { if (request === navigationRequest.current) { setPendingSearch(null); setActionError("无法打开搜索结果，请重试"); } }
  }
  useEffect(() => {
    if (!pendingSearch || pendingSearch.request !== navigationRequest.current || snap.selected?.id !== pendingSearch.hit.sessionId || pane !== "session") return;
    const { hit, request } = pendingSearch;
    setPendingSearch(null);
    if (hit.turnId === null) return;
    const turn = snap.selected.turns.find(turn => turn.id === hit.turnId);
    if (!turn || (hit.revision && turn.correction?.revision !== hit.revision)) { setActionError("这条搜索结果的转写已更新，请重新搜索"); return; }
    setFocusTurn({ sessionId: hit.sessionId, turnId: turn.id, request });
    if (snap.selected.kind === "dictation" || snap.recording || snap.audioImport || (snap.capturePhase && snap.capturePhase !== "idle")) return;
    void window.earshot.seekPlayback({ sessionId: hit.sessionId, positionSec: turn.tStartMs / 1000, resume: true }).then(result => {
      if (!result.ok && navigationRequest.current === request) setActionError(result.error);
    }).catch(() => { if (navigationRequest.current === request) setActionError("已找到文字，回听暂时不可用"); });
  }, [pendingSearch, snap.selected, snap.recording, snap.audioImport, snap.capturePhase, pane]);
  async function importAudio() {
    if (importing.current) return;
    importing.current = true; setImportBusy(true); setActionError(null);
    try {
      const result = await window.earshot.importAudio();
      if (!result.ok) setActionError(result.error);
      else if (!result.canceled && result.sessionId) { openSession(result.sessionId); await refresh(); }
    } catch { setActionError("录音导入未完成，请重试"); }
    finally { importing.current = false; setImportBusy(false); }
  }

  useEffect(() => { if (snap.libraryRequest) openPane("session"); }, [snap.libraryRequest]);
  useEffect(() => { if (snap.settingsRequest) openPane("settings"); }, [snap.settingsRequest]);

  useEffect(() => {
    if (!hadSessions.current && !first) setPane("session");
    hadSessions.current = !first;
  }, [first]);

  useEffect(() => {
    if (first || pane === "settings") return;
    if (snap.selectedId || snap.selected) return;
    const firstSession = snap.sessions[0];
    if (!firstSession || askedSelect.current === firstSession.id) return;
    askedSelect.current = firstSession.id;
    void window.earshot.selectSession(firstSession.id);
  }, [first, pane, snap.selected, snap.selectedId, snap.sessions]);

  useEffect(() => {
    renameAttempt.current += 1;
    renameSaving.current = false;
    setRenameBusy(false); setRenameError(null);
    setRenameFrom(null);
    setRenameAnchor(null);
    setActionError(null);
    setExportNotice(null);
  }, [snap.selectedId, pane]);

  const selected = snap.selected;
  const selectedSummary =
    snap.sessions.find((row) => row.id === (snap.selectedId ?? selected?.id)) ?? selected;

  async function runJob(job?: "refined" | "speakers") {
    if (!selected || jobInFlight.current.has(selected.id)) return;
    const id = selected.id;
    jobInFlight.current.add(id);
    setJobPending(value => ({ ...value, [id]: job ? "提交中…" : "取消中…" }));
    setActionError(null);
    try {
      const result = job ? await window.earshot.retryJob({ sessionId: id, job }) : await window.earshot.cancelJob(id);
      if (!result.ok && selectedForExport.current === id) setActionError("操作未完成，请重试");
    } catch {
      if (selectedForExport.current === id) setActionError("操作未完成，请重试");
    } finally {
      jobInFlight.current.delete(id);
      setJobPending(value => { const next = { ...value }; delete next[id]; return next; });
    }
  }

  async function exportCurrent(format: ExportFormat): Promise<void> {
    if (!selected || exportBusy.current) return;
    const sessionId = selected.id;
    exportBusy.current = true;
    setExporting(format);
    setActionError(null);
    setExportNotice(null);
    try {
      const result = await window.earshot.exportTranscript({ sessionId, format });
      if (selectedForExport.current !== sessionId) return;
      if (!result.ok) setActionError(result.error);
      else if (!result.canceled) setExportNotice({ text: `${format.toUpperCase()} 已导出`, saved: result.saved });
    } catch {
      if (selectedForExport.current === sessionId) setActionError("导出未完成，请重试");
    } finally {
      exportBusy.current = false;
      setExporting(null);
    }
  }

  async function persistKey(): Promise<boolean> {
    const draft = keyDraft.trim();
    if (!draft || keySaving.current) return false;
    keySaving.current = true; setKeyBusy(true); setKeySaved(false); setKeyError(null);
    try {
      const result = await window.earshot.saveKey(draft);
      if (!result.ok) {
        setKeyError("密钥没保存，请重试");
        return false;
      }
    } catch (err) {
      setKeyError("密钥没保存，请重试");
      return false;
    } finally { keySaving.current = false; setKeyBusy(false); }
    setKeyDraft("");
    setKeyError(null); setKeySaved(true);
    await refresh();
    return true;
  }

  async function begin() {
    if (starting.current) return;
    starting.current = true;
    setStartBusy(true);
    setActionError(null);
    try {
      const result = await window.earshot.start();
      if (!result.ok) setActionError(startError(result));
    } catch (err) {
      if (err instanceof Error && err.message) setActionError(err.message);
    } finally {
      starting.current = false;
      setStartBusy(false);
    }
  }

  async function ask(kind: "mic" | "screen") {
    setAsking(kind);
    try {
      if (kind === "mic") {
        await window.earshot.requestMic();
        return;
      }
      // 屏幕录制走系统级申请（CGRequestScreenCaptureAccess），不用 getDisplayMedia：
      // 后者在 macOS 上会弹「共享屏幕」选择器，且成功也不代表拿到了 TCC 授权
      await window.earshot.requestScreen();
    } finally {
      setAsking(null);
      await refresh();
    }
  }

  const why = actionError ?? (first ? startWhy(snap, keyDraft) : null);
  const ready = canStart(snap, keyDraft) && !startBusy;
  const listBlockWhy = !first && !snap.recording && !ready && !actionError ? startWhy(snap, keyDraft) : null;
  // 受阻都给一个动作入口：密钥在设置页填，权限在设置页有「打开系统设置」
  const listBlockSettings = listBlockWhy !== null;
  const whyBad =
    Boolean(actionError) ||
    snap.permissions.microphone === "denied" ||
    snap.permissions.screen === "denied";
  const settingsOpen = pane === "settings";

  const handleRenameOpen = useCallback((speaker: string, anchor: HTMLElement) => {
    renameAttempt.current += 1;
    renameSaving.current = false;
    setRenameBusy(false); setRenameError(null);
    setActionError(null);
    renameAnchorEl.current = anchor;
    setRenameFrom(speaker);
    setRenameTo(speaker === "对方" || /^小\s?[A-Za-z]$/.test(speaker) ? "" : speaker);
    setRenameAnchor(anchor.getBoundingClientRect());
  }, []);

  const handleRenameClose = useCallback(() => {
    if (renameSaving.current) return;
    renameAttempt.current += 1;
    const anchor = renameAnchorEl.current;
    setRenameFrom(null);
    setRenameAnchor(null);
    renameAnchorEl.current = null;
    anchor?.focus();
  }, []);

  return (
    <div className={`window${snap.recording ? " recording" : ""}${snap.playback ? " has-playback" : ""}${nameUndo ? " has-name-undo" : ""}`}>
      <header className="titlebar">
        <span className="tb-title">Earshot</span>
        <div className="grow" />
        <button type="button" className="btn ghost import-audio-button" disabled={importBusy || Boolean(snap.audioImport) || Boolean(snap.recording) || Boolean(snap.capturePhase && snap.capturePhase !== "idle") || ["preparing", "listening", "transcribing"].includes(snap.dictation?.phase ?? "idle")}
          onClick={() => void importAudio()}>{importBusy ? "导入中…" : "导入录音"}</button>
        {snap.recording ? <>
          <RecordingClock recording={snap.recording} />
          {(settingsOpen || selected?.id !== snap.recording.sessionId) ? <button type="button" className="btn text"
            onClick={() => openSession(snap.recording!.sessionId)}>
            返回当前录制
          </button> : null}
          <button type="button" className="btn ghost" onClick={() => void window.earshot.showGlance()}>浮窗</button>
          <StopRecording recording={snap.recording} />
        </> : first ? (
          <button
            type="button"
            className={`btn ghost${settingsOpen ? " on" : ""}`}
            aria-pressed={settingsOpen}
            onClick={() => openPane(settingsOpen ? "session" : "settings")}
          >
            设置
          </button>
        ) : (
          <>
            {listBlockWhy ? (
              <span className="tb-block">
                <span
                  className={`tb-block-why${listBlockWhy && (snap.permissions.microphone === "denied" || snap.permissions.screen === "denied") ? " bad" : ""}`}
                >
                  {listBlockWhy}
                </span>
                {listBlockSettings ? (
                  <button type="button" className="btn text" onClick={() => openPane("settings")}>
                    设置
                  </button>
                ) : null}
              </span>
            ) : null}
            <button type="button" className="btn start" disabled={!ready} onClick={() => void begin()}>
              {startBusy || snap.capturePhase === "starting" ? "启动中…" : "开始录制"}
            </button>
          </>
        )}
      </header>
      {snap.audioImport ? <div className="audio-import-progress" role="status"><span>{snap.audioImport.message}</span>
        {snap.audioImport.percent !== undefined && <progress aria-label="录音导入进度" max={100} value={snap.audioImport.percent} />}
        <button type="button" className="btn text" onClick={() => void window.earshot.cancelAudioImport().catch(() => setActionError("取消导入未完成，请重试"))}>取消导入</button>
      </div> : null}
      {snap.recording ? <RealtimeNotice recording={snap.recording} /> : null}
      <div className={`body${first ? " solo" : ""}`}>
        {first ? null : (
          <SessionList
            sessions={snap.sessions}
            selectedId={pane === "session" ? snap.selectedId ?? selected?.id ?? null : null}
            settingsOn={settingsOpen}
            onSelect={openSession}
            onSearchSelect={hit => void searchSelect(hit)}
            searchRefreshKey={searchRefreshKey}
            onSettings={() => openPane("settings")}
          />
        )}
        {settingsOpen ? (
          <SettingsPane
            snap={snap}
            keyDraft={keyDraft}
            keyError={keyError}
            keyBusy={keyBusy}
            keySaved={keySaved}
            asking={asking}
            onKeyDraft={value => { setKeyDraft(value); setKeySaved(false); setKeyError(null); }}
            onKeySave={() => void persistKey()}
            onAsk={ask}
          />
        ) : first ? (
          <PrepBoard
            snap={snap}
            keyDraft={keyDraft}
            keyError={keyError}
            keyBusy={keyBusy}
            keySaved={keySaved}
            asking={asking}
            why={why}
            whyBad={whyBad}
            ready={ready}
            onKeyDraft={value => { setKeyDraft(value); setKeySaved(false); setKeyError(null); }}
            onKeySave={() => void persistKey()}
            onAsk={ask}
            onStart={() => void begin()}
          />
        ) : selected?.kind === "dictation" ? <DictationDetail key={selected.id} detail={selected} editingBlocked={Boolean(snap.audioImport)} actionError={actionError} /> : (
          <SessionPane
            summary={selectedSummary}
            detail={selected}
            playback={snap.playback ?? null}
            editingBlocked={Boolean(snap.audioImport)}
            bookmarkPositionMs={selected?.id === snap.recording?.sessionId ? Math.round((snap.recording?.elapsedSec ?? 0) * 1000) : snap.playback?.sessionId === selected?.id ? Math.round(snap.playback!.positionSec * 1000) : undefined}
            focusTurn={focusTurn && focusTurn.sessionId === selected?.id ? focusTurn : undefined}
            playbackBlocked={Boolean(snap.audioImport) || Boolean(snap.recording) || (snap.capturePhase !== undefined && snap.capturePhase !== "idle")}
            readingPositions={readingPositions.current}
            connection={selected?.id === snap.recording?.sessionId ? snap.recording?.connection : undefined}
            capturePhase={selected?.id === snap.recording?.sessionId ? snap.recording?.phase : undefined}
            renameFrom={renameFrom}
            renameTo={renameTo}
            renameAnchor={renameAnchor}
            renameBusy={renameBusy}
            renameError={renameError}
            actionError={actionError}
            jobPending={selected ? jobPending[selected.id] : undefined}
            exporting={exporting}
            exportNotice={exportNotice}
            onExport={(format) => void exportCurrent(format)}
            onPlay={async (id) => {
              setActionError(null);
              try {
                const result = await window.earshot.playSession(id);
                if (!result.ok) setActionError(result.error);
              } catch (err) {
                if (err instanceof Error && err.message) setActionError(err.message);
              }
            }}
            onPause={async () => {
              setActionError(null);
              try {
                const result = await window.earshot.pausePlayback(selected!.id);
                if (!result.ok) setActionError(result.error);
              } catch (err) {
                if (err instanceof Error && err.message) setActionError(err.message);
              }
            }}
            onSeek={async (positionMs) => {
              if (!selected) return;
              setActionError(null);
              const id = selected.id;
              try {
                const result = await window.earshot.seekPlayback({ sessionId: id, positionSec: positionMs / 1000, resume: true });
                if (!result.ok) setActionError(result.error);
              } catch { setActionError("无法回听，请重试"); }
            }}
            onRenameOpen={handleRenameOpen}
            onRenameTo={value => { setRenameTo(value); setRenameError(null); }}
            onRenameClose={handleRenameClose}
            onRenameSave={async () => {
              if (!selected || !renameFrom || renameSaving.current) return;
              const to = renameTo.trim();
              if (!to) return;
              const attempt = ++renameAttempt.current;
              const sessionId = selected.id;
              const anchor = renameAnchorEl.current;
              renameSaving.current = true;
              setRenameBusy(true);
              setRenameError(null);
              try {
                const result = await window.earshot.renameSpeaker({
                  sessionId,
                  from: renameFrom,
                  to,
                });
                if (renameAttempt.current !== attempt || selectedForExport.current !== sessionId) return;
                if (!result.ok) {
                  setRenameError(result.error);
                  return;
                }
                setRenameFrom(null);
                setRenameAnchor(null);
                renameAnchorEl.current = null;
                if (result.undoId && result.expiresAt) setNameUndo({ id: result.undoId, expiresAt: result.expiresAt,
                  to, count: result.changedTurns ?? 0, sessionId, anchor });
                await refresh();
                if (selectedForExport.current === sessionId) requestAnimationFrame(() => anchor?.isConnected && anchor.focus());
              } catch {
                if (renameAttempt.current === attempt) setRenameError("名字没能保存，请重试");
              } finally {
                if (renameAttempt.current === attempt) { renameSaving.current = false; setRenameBusy(false); }
              }
            }}
            onRetry={(job) => { void runJob(job); }}
            onCancel={() => { void runJob(); }}
          />
        )}
      </div>
      <DeletionNotices values={snap.deletions ?? []} />
      {nameUndo ? <NameUndoNotice key={nameUndo.id} value={nameUndo} onDismiss={() => setNameUndo(value => value?.id === nameUndo.id ? null : value)}
        onUndone={async () => { await refresh(); if (selectedForExport.current === nameUndo.sessionId) requestAnimationFrame(() => nameUndo.anchor?.isConnected && nameUndo.anchor.focus()); }} /> : null}
      {snap.playback ? <PlaybackBar playback={snap.playback}
        blocked={Boolean(snap.audioImport) || Boolean(snap.recording) || Boolean(snap.capturePhase && snap.capturePhase !== "idle")}
        onOpen={openSession} /> : null}
    </div>
  );
}

function SessionList({
  sessions,
  selectedId,
  settingsOn,
  onSelect,
  onSettings,
  onSearchSelect,
  searchRefreshKey,
}: {
  sessions: SessionSummary[];
  selectedId: string | null;
  settingsOn: boolean;
  onSelect: (id: string) => void;
  onSettings: () => void;
  onSearchSelect: (hit: TranscriptSearchHit) => void;
  searchRefreshKey: string;
}) {
  const [filter, setFilter] = useState("all");
  const visible = sessions.filter(row => filter === "all" || (row.kind ?? "recording") === filter);
  const now = new Date();
  const today = visible.filter((row) => isSameDay(row.startedAt, now));
  const earlier = visible.filter((row) => !isSameDay(row.startedAt, now));

  return (
    <aside className="slist">
      <SearchPanel search={window.earshot.searchTranscripts} onSelect={hit => { setFilter("all"); onSearchSelect(hit); }} refreshKey={searchRefreshKey} />
      <div className="session-filter" role="group" aria-label="筛选会话">{[['all', '全部'], ['recording', '录制'], ['dictation', '输入']].map(([value, label]) =>
        <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); const next = sessions.filter(row => value === 'all' || (row.kind ?? 'recording') === value); if (!next.some(row => row.id === selectedId) && next[0]) onSelect(next[0].id); }}>{label}</button>)}</div>
      <div className="sl-main" tabIndex={0} aria-label="会话列表">
        {!visible.length && <p className="why filter-empty">暂无此类会话</p>}
        <Group label="今天" rows={today} selectedId={selectedId} settingsOn={settingsOn} onSelect={onSelect} />
        <Group label="更早" rows={earlier} selectedId={selectedId} settingsOn={settingsOn} onSelect={onSelect} />
      </div>
      <div className="sl-foot">
        <button type="button" className={`sl-row${settingsOn ? " on" : ""}`} aria-current={settingsOn ? "page" : undefined} onClick={onSettings}>
          <span className="sl-title">设置</span>
        </button>
      </div>
    </aside>
  );
}

function Group({
  label,
  rows,
  selectedId,
  settingsOn,
  onSelect,
}: {
  label: string;
  rows: SessionSummary[];
  selectedId: string | null;
  settingsOn: boolean;
  onSelect: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <div className="sl-group">{label}</div>
      {rows.map(row => <SessionRow key={row.id} row={row} selected={!settingsOn && row.id === selectedId} onSelect={onSelect} />)}
    </>
  );
}

function PermissionRight({
  state,
  asking,
  pane,
  pendingLabel,
  onAllow,
}: {
  state: PermissionState;
  asking: boolean;
  pane: PrivacyPane;
  pendingLabel?: string;
  onAllow: () => void;
}) {
  if (asking) return <span className="st wait">请在系统提示中允许</span>;
  if (pendingLabel) return <span className="st pending">{pendingLabel}</span>;
  if (state === "granted") return <span className="st ok">已允许</span>;
  if (state === "denied") {
    return (
      <div className="g-side">
        <button type="button" className="btn ghost" onClick={() => void window.earshot.openPrivacy(pane)}>
          打开系统设置
        </button>
      </div>
    );
  }
  if (pane === "screen") {
    return (
      <div className="g-side">
        <button type="button" className="btn ghost" onClick={onAllow}>
          允许
        </button>
        <button type="button" className="btn ghost" onClick={() => void window.earshot.openPrivacy(pane)}>
          打开系统设置
        </button>
      </div>
    );
  }
  return (
    <div className="g-side">
      <button type="button" className="btn ghost" onClick={onAllow}>
        允许
      </button>
    </div>
  );
}

function KeyField({
  draft,
  hasKey,
  error,
  onDraft,
  onSave, busy, saved,
}: {
  draft: string;
  hasKey: boolean;
  error: string | null;
  onDraft: (value: string) => void;
  onSave: () => void;
  busy: boolean;
  saved: boolean;
}) {
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor="api-key">百炼 API 密钥</label>
        <button type="button" className="field-link" onClick={() => void window.earshot.openKeyPage()}>
          打开百炼控制台
        </button>
      </div>
      <input
        id="api-key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={hasKey ? "sk-········" : "sk-…"}
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        disabled={busy}
      />
      <div className="field-save"><button type="button" className="btn ghost" disabled={busy || draft.trim().length < 8} onClick={onSave}>{busy ? '保存中…' : hasKey ? '更换密钥' : '保存密钥'}</button>
      <span role="status">{saved ? '已保存，下次转写时验证连接' : hasKey ? '密钥已保存' : '填入密钥后即可使用云端转写'}</span></div>
      {error ? <p className="field-err" role="alert">{error}</p> : null}
    </div>
  );
}

function PrepBoard({
  snap,
  keyDraft,
  keyError, keyBusy, keySaved,
  asking,
  why,
  whyBad,
  ready,
  onKeyDraft,
  onKeySave,
  onAsk,
  onStart,
}: {
  snap: AppSnapshot;
  keyDraft: string;
  keyError: string | null;
  keyBusy: boolean;
  keySaved: boolean;
  asking: Asking;
  why: string | null;
  whyBad: boolean;
  ready: boolean;
  onKeyDraft: (value: string) => void;
  onKeySave: () => void;
  onAsk: (kind: "mic" | "screen") => void;
  onStart: () => void;
}) {
  const mic = snap.permissions.microphone;
  const screen = snap.permissions.screen;
  const micReady = mic === "granted" || asking === "mic";
  const screenPending = !micReady && screen === "undetermined";

  return (
    <div className="prep">
      <div className="prep-mark" aria-hidden>
        <img src={appIcon} alt="" className="app-icon" />
      </div>
      <h2>录下一场会</h2>
      <div className="board">
        <div className="grant">
          <div className="g-ico near">
            <MicIcon />
          </div>
          <div>
            <b>麦克风</b><p className="why">录下你的声音</p>
          </div>
          <PermissionRight
            state={mic}
            asking={asking === "mic"}
            pane="microphone"
            onAllow={() => onAsk("mic")}
          />
        </div>
        <div className={`grant${micReady ? "" : " grant-wait"}`}>
          <div className="g-ico far">
            <ScreenIcon />
          </div>
          <div>
            <b>屏幕录制</b><p className="why">录下会议的系统声音，不保存画面</p>
            {screen !== "granted" ? (
              <p className="why">在系统设置中允许 Earshot；如提示重新打开，请按提示操作。</p>
            ) : null}
          </div>
          <PermissionRight
            state={screen}
            asking={asking === "screen"}
            pane="screen"
            pendingLabel={screenPending ? "请先允许麦克风" : undefined}
            onAllow={() => onAsk("screen")}
          />
        </div>
        <div className="board-key">
          <KeyField
            draft={keyDraft}
            hasKey={snap.hasApiKey}
            error={keyError}
            onDraft={onKeyDraft}
            onSave={onKeySave}
            busy={keyBusy}
            saved={keySaved}
          />
        </div>
        <div className="board-foot">
          {why ? <p className={`why${whyBad ? " bad" : ""}`}>{why}</p> : <span />}
          <button type="button" className="btn primary" disabled={!ready} onClick={onStart}>
            开始录制
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsPane({
  snap,
  keyDraft,
  keyError, keyBusy, keySaved,
  asking,
  onKeyDraft,
  onKeySave,
  onAsk,
}: {
  snap: AppSnapshot;
  keyDraft: string;
  keyError: string | null;
  keyBusy: boolean;
  keySaved: boolean;
  asking: Asking;
  onKeyDraft: (value: string) => void;
  onKeySave: () => void;
  onAsk: (kind: "mic" | "screen") => void;
}) {
  return (
    <div className="pane">
      <div className="settings-content">
      <h2>设置</h2>
      <div className="set-stack">
        <DictationSettings status={snap.shortcuts} />
        <HotwordSettings subscribe={window.earshot.onChange} load={window.earshot.hotwordStatus} save={window.earshot.saveHotwords} sync={window.earshot.syncHotwords} />
        <section className="settings-section" aria-labelledby="recording-heading"><h3 id="recording-heading">录制</h3>
          <div className="set-card"><div className="set-row">
            <div>自动区分说话人<p className="why">停止录制后区分不同声音，从下一次录制生效。</p></div>
            <button type="button" className={`knob${snap.autoDiarize ? " on" : ""}`} role="switch" aria-checked={snap.autoDiarize}
              aria-label="自动区分说话人" onClick={() => void window.earshot.setAutoDiarize(!snap.autoDiarize)} />
          </div></div>
          <div className="set-card"><div className="set-row">
            <div>共用麦克风<p className="why">会议室多人使用同一支麦克风时开启。从下一次录制生效；自动区分开启时，也会区分现场声音。</p></div>
            <button type="button" className={`knob${snap.sharedMicrophone ? " on" : ""}`} role="switch" aria-checked={Boolean(snap.sharedMicrophone)}
              aria-label="共用麦克风" onClick={() => void window.earshot.setSharedMicrophone(!snap.sharedMicrophone)} />
          </div></div>
        </section>
        <section className="settings-section" aria-labelledby="cloud-heading"><h3 id="cloud-heading">云端服务</h3>
        <div className="set-card">
          <KeyField
            draft={keyDraft}
            hasKey={snap.hasApiKey}
            error={keyError}
            onDraft={onKeyDraft}
            onSave={onKeySave}
            busy={keyBusy}
            saved={keySaved}
          />
        </div>
        <p className="settings-caption">密钥仅保存在这台 Mac。转写直接连接百炼，使用你自己的账户额度。</p>
        </section>
        <UsageSettings load={window.earshot.usageSummary} openBilling={() => void window.earshot.openBilling()} />
        <section className="settings-section" aria-labelledby="permission-heading"><h3 id="permission-heading">系统权限</h3>
        <div className="set-card">
          <div className="set-row">
            <div>麦克风<p className="why">录下你的声音</p></div>
            <PermissionRight
              state={snap.permissions.microphone}
              asking={asking === "mic"}
              pane="microphone"
              onAllow={() => onAsk("mic")}
            />
          </div>
          <div className="set-row">
            <div>屏幕录制<p className="why">录下系统声音，不保存画面</p></div>
            <PermissionRight
              state={snap.permissions.screen}
              asking={asking === "screen"}
              pane="screen"
              onAllow={() => onAsk("screen")}
            />
          </div>
          <DictationPermission status={snap.shortcuts} />
        </div>
        </section>
      </div>
      </div>
    </div>
  );
}

function SessionPane({
  summary,
  detail,
  playback,
  playbackBlocked,
  editingBlocked,
  bookmarkPositionMs,
  focusTurn,
  readingPositions,
  connection,
  capturePhase,
  renameFrom,
  renameTo,
  renameAnchor,
  renameBusy,
  renameError,
  actionError,
  jobPending,
  exporting,
  exportNotice,
  onExport,
  onPlay,
  onPause,
  onSeek,
  onRenameOpen,
  onRenameTo,
  onRenameClose,
  onRenameSave,
  onRetry,
  onCancel,
}: {
  summary: SessionSummary | SessionDetail | null | undefined;
  detail: SessionDetail | null;
  playback: PlaybackState | null;
  playbackBlocked: boolean;
  editingBlocked: boolean;
  bookmarkPositionMs?: number;
  focusTurn?: { turnId: string; request: number };
  readingPositions: ReadingPositions;
  connection?: RealtimeStatus;
  capturePhase?: CapturePhase;
  renameFrom: string | null;
  renameTo: string;
  renameAnchor: DOMRect | null;
  renameBusy: boolean;
  renameError: string | null;
  actionError: string | null;
  jobPending?: string;
  exporting: ExportFormat | null;
  exportNotice: ExportNotice | null;
  onExport: (format: ExportFormat) => void;
  onPlay: (id: string) => void;
  onPause: () => void;
  onSeek: (positionMs: number) => void;
  onRenameOpen: (speaker: string, anchor: HTMLElement) => void;
  onRenameTo: (value: string) => void;
  onRenameClose: () => void;
  onRenameSave: () => void;
  onRetry: (job: "refined" | "speakers") => void;
  onCancel: () => void;
}) {
  if (!summary) return <div className="col" />;

  const jobs = detail?.jobs ?? summary.jobs;
  const working = jobs.refined === "running" || jobs.speakers === "running";
  const people = detail?.people ?? [];
  const currentPlayback = playback?.sessionId === summary.id ? playback : null;
  const playing = currentPlayback?.status === "playing";
  const hasExportText = Boolean(detail?.turns.some((turn) => !turn.partial && turn.text.trim()));
  const exportWhy = summary.status === "recording" ? "停止录音后即可导出"
    : !hasExportText ? "暂无可导出的文字"
      : working ? "导出当前文本，后续处理结果不会更新已导出的文件" : "导出当前文字";
  const captureOwned = capturePhase !== undefined && capturePhase !== "idle";
  const canExport = !captureOwned && summary.status !== "recording" && hasExportText;

  return (
    <div className="col">
      <div className="sess-head">
        <div className="grow">
          <SessionTitle key={summary.id} sessionId={summary.id} title={summary.title} disabled={captureOwned || summary.status === "recording"} />
          <p className="sess-meta">
            {formatListWhen(summary.startedAt)} {formatStartTime(summary.startedAt)} · {formatDurationLong(summary.durationSec)}
          </p>
        </div>
        <div className="sess-actions">
          <ExportMenu disabled={!canExport} reason={exportWhy} exporting={exporting} onExport={onExport} />
          <button
            type="button"
            className={`btn ghost play${playing ? " on" : ""}`}
            title={playbackBlocked ? "录制中无法回听，以免录入播放的声音" : playing ? "暂停回听" : "播放录音"}
            aria-label={playing ? "暂停回听" : "播放"}
            aria-pressed={playing}
            disabled={playbackBlocked || summary.status === "recording"}
            onClick={() => (playing ? onPause() : onPlay(summary.id))}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
        </div>
      </div>
      {exportNotice ? <p className="export-notice" role="status">{exportNotice.text}{exportNotice.saved ? <><span className="export-path">{exportNotice.saved.path}</span><button type="button" className="btn ghost" onClick={async () => {
        const result = await window.earshot.revealExport(exportNotice.saved!.id).catch(() => ({ ok: false as const, error: "无法打开文件位置" }));
        if (!result.ok) window.alert(result.error);
      }}>在访达中显示</button></> : null}</p> : null}
      {working && jobs.refined !== "canceling" && jobs.speakers !== "canceling" ? (
        <div className="work-bar" aria-live="polite">
          {workBarMessage(jobs)}
          <button type="button" className="btn text" disabled={Boolean(jobPending)} onClick={onCancel}>
            {jobPending ?? "取消"}
          </button>
        </div>
      ) : null}
      {workFeedback(jobs).map((notice, index) => <div key={index} className={notice.kind === 'failed' ? 'fail-bar' : 'work-bar'} role="status">
        <span>{notice.text}</span>
        {notice.retry ? <button type="button" className="btn text" disabled={Boolean(jobPending)} onClick={() => onRetry(notice.retry!)}>
          {jobPending ?? `${notice.kind === 'canceled' ? '继续' : '重试'}${notice.retry === 'speakers' ? '区分' : '处理'}`}
        </button> : null}
        <span className="fail-reassure">原始录音和已有文本都保留</span>
      </div>)}
      {actionError ? (
        <div className="fail-bar" aria-live="polite">
          {actionError}
        </div>
      ) : null}
      {detail ? <TranscriptView key={detail.id} detail={detail} positions={readingPositions}
        connection={connection} capturePhase={capturePhase}
        editable={!editingBlocked && !captureOwned && summary.status !== "recording"}
        bookmarkPositionMs={bookmarkPositionMs} focusTurn={focusTurn}
        onSeek={!playbackBlocked && summary.status !== "recording" ? onSeek : undefined}
        playbackPositionMs={currentPlayback ? currentPlayback.positionSec * 1000 : undefined}
        onRename={editingBlocked || captureOwned || summary.status === "recording" ? undefined : onRenameOpen} /> : <div className="scroll" />}
      {renameFrom && renameAnchor ? (
        <RenamePop
          from={renameFrom}
          anchor={renameAnchor}
          value={renameTo}
          busy={renameBusy}
          error={renameError}
          count={detail?.turns.filter(turn => !turn.correction?.speakerOverridden && turn.speaker !== "你" && turn.speaker === renameFrom).length ?? 0}
          people={people.filter((name) => name !== renameFrom)}
          voiceMessage={voiceRegistrationMessage(detail?.voiceRegistrations, renameFrom)}
          retryVoice={detail?.voiceRegistrations?.some(row => row.name === renameFrom && row.status === "unavailable") ?? false}
          onChange={onRenameTo}
          onClose={onRenameClose}
          onSave={onRenameSave}
        />
      ) : null}
    </div>
  );
}

function RenamePop({
  from,
  anchor,
  value,
  busy,
  count,
  people,
  voiceMessage,
  retryVoice,
  error,
  onChange,
  onClose,
  onSave,
}: {
  from: string;
  anchor: DOMRect;
  value: string;
  busy: boolean;
  count: number;
  people: string[];
  voiceMessage?: string;
  retryVoice: boolean;
  error?: string | null;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const { width, height } = box.getBoundingClientRect();
    setPoint(
      anchorPopover(
        anchor,
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor, from, people.length, value, voiceMessage, error, busy]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    function onPointer(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) onClose();
    }
    function dismiss() {
      onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("scroll", dismiss, { capture: true, once: true });
    window.addEventListener("resize", dismiss, { once: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("resize", dismiss);
    };
  }, [onClose]);

  return (
    <div
      className="pop"
      role="dialog"
      aria-modal="true"
      aria-label="给说话人起名"
      ref={boxRef}
      style={point ? { left: `${point.left}px`, top: `${point.top}px` } : undefined}
    >
      <NameEditor label="说话人姓名" value={value} original={from} maxLength={80} busy={busy} error={error}
        hint={`将修改本场「${from}」的 ${count} 段发言`} allowUnchanged={retryVoice}
        saveLabel={retryVoice && value.trim() === from ? "重试记住声音" : "保存"}
        onChange={onChange} onSave={onSave} onCancel={onClose}>
      {voiceMessage ? <p className="hint" role="status">{voiceMessage}</p> : null}
      {people.length > 0 ? (
        <div className="pop-people">
          {people.map((name) => (
            <button key={name} type="button" className="btn ghost" disabled={busy} onClick={() => onChange(name)}>
              {name}
            </button>
          ))}
        </div>
      ) : null}
      {value.trim() && people.includes(value.trim()) ? (
        <p className="hint">这 {count} 段发言将归到已有的「{value.trim()}」</p>
      ) : (
        <p className="hint">起名后会尝试记住清晰的声音片段，供以后的录音识别。</p>
      )}
      </NameEditor>
    </div>
  );
}

function NameUndoNotice({ value, onDismiss, onUndone }: { value: NameUndo; onDismiss: () => void; onUndone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false), active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const timer = setTimeout(onDismiss, Math.max(0, value.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [value.expiresAt, onDismiss]);
  async function undo() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await window.earshot.undoSpeakerRename(value.id);
      if (!active.current) return;
      if (!result.ok) { setError(result.error); return; }
      await onUndone(); onDismiss();
    } catch { if (active.current) setError("撤销未完成，请重试"); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  return <div className="name-undo"><p role="status">{error ?? `已将本场 ${value.count} 段发言命名为「${value.to}」`}</p>
    <button type="button" className="btn ghost" disabled={busy} onClick={() => void undo()}>{busy ? "撤销中…" : "撤销"}</button></div>;
}

function DictationDetail({ detail, editingBlocked, actionError }: { detail: SessionDetail; editingBlocked: boolean; actionError: string | null }) {
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const turn = detail.turns[0];
  const text = detail.dictation?.text ?? '';
  return <div className="col"><div className="sess-head"><div className="grow">
    <SessionTitle sessionId={detail.id} title={detail.title} />
    <p className="sess-meta">语音输入 · {formatListWhen(detail.startedAt)} {formatStartTime(detail.startedAt)} · {formatDurationShort(detail.durationSec)}</p>
  </div></div><div className="dictation-document">
    {actionError && <p className="tool-error" role="alert">{actionError}</p>}
    {detail.transcriptToolsError && <p className="tool-error" role="status">{detail.transcriptToolsError}</p>}
    <p className="dictation-copy">{text}</p>
    {editing && !editingBlocked && turn?.correction && <TranscriptEditor key={`${detail.id}:${turn.id}`} sessionId={detail.id} turn={turn}
      onSave={window.earshot.correctTurn} onUndo={window.earshot.undoTurnCorrection} onReset={window.earshot.resetTurnCorrection} onClose={() => setEditing(false)} />}
    <div className="document-tools"><button type="button" className="btn ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setMessage('已复制'); } catch { setMessage('复制未完成，请选中文字手动复制'); } }}>复制文字</button>
      {turn?.correction && <button type="button" className="btn ghost" disabled={editingBlocked} aria-expanded={editing} onClick={() => setEditing(value => !value)}>修改文字</button>}
      <span className="why">{turn?.correction?.edited ? '已手动修改' : detail.dictation?.polishModel ? '已整理' : '原始转写'}</span></div>
    {detail.dictation && (detail.dictation.polishModel || turn?.correction?.edited) && <details className="raw-text"><summary>查看原始转写</summary><p>{detail.dictation.rawText}</p></details>}
    {detail.dictation?.warning && <p className="why">{detail.dictation.warning}</p>}
    <p className="why" role="status">{message}</p><p className="document-foot">文字保存在本机</p>
  </div></div>;
}
