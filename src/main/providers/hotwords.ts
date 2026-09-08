import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { normalizeHotwords, type HotwordStatus } from '../../shared/hotwords.ts';
import { writeJson } from '../store/json.ts';
import { HTTP_BASE } from './models.ts';

const MODELS = ['fun-asr', 'fun-asr-realtime'] as const;
type CloudEntry = { id: string; digest: string; account: string; ready: boolean };
type Saved = { words: string[]; updatedAt: number | null; cloud: Partial<Record<typeof MODELS[number], CloudEntry>> };
export type HotwordParameters = { vocabulary_id?: string; vocabulary?: Record<string, number> };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function createHotwordStore(path: string, getApiKey: () => string | null, fetchImpl: typeof fetch = fetch) {
  let saved: Saved = { words: [], updatedAt: null, cloud: {} };
  let failure: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(raw.words) || !raw.words.every((word: unknown) => typeof word === 'string')) throw new Error();
      const words = normalizeHotwords(raw.words.join('\n'));
      saved = { words, updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null, cloud: {} };
      for (const model of MODELS) {
        const entry = raw.cloud?.[model];
        if (entry && /^vocab-[a-zA-Z0-9-]{1,150}$/.test(entry.id) && /^[a-f0-9]{64}$/.test(entry.digest)
          && /^[a-f0-9]{64}$/.test(entry.account)) saved.cloud[model] = { id: entry.id, digest: entry.digest, account: entry.account, ready: entry.ready === true };
      }
    } catch { failure = '热词文件无法读取，请重新保存热词'; }
  }
  const wordDigest = () => digest(JSON.stringify(saved.words));
  const isReady = (model: typeof MODELS[number], requestKey: string | null = getApiKey()) => {
    const entry = saved.cloud[model];
    return Boolean(entry?.ready && entry.digest === wordDigest() && entry.account === (requestKey ? digest(requestKey) : ''));
  };
  function status(): HotwordStatus {
    const allReady = MODELS.every(model => isReady(model));
    return {
      words: [...saved.words], updatedAt: saved.updatedAt,
      sync: failure ? 'error' : !saved.words.length ? 'empty' : allReady ? 'ready' : 'pending',
      ...(failure ? { message: failure } : {}),
      models: [
        { model: 'qwen-audio-3.0-asr-flash-streaming', label: 'Qwen Audio 3.0 语音输入', supported: true, ready: true },
        { model: 'fun-asr', label: '录音文件转写', supported: true, ready: !saved.words.length || isReady('fun-asr') },
        { model: 'fun-asr-realtime', label: '录中实时转写', supported: true, ready: !saved.words.length || isReady('fun-asr-realtime') },
        { model: 'qwen3-asr-flash-realtime', label: 'Qwen3 ASR 语音输入', supported: false, ready: false },
      ],
    };
  }
  async function call(input: Record<string, unknown>, key: string): Promise<Record<string, unknown>> {
    try {
      const response = await fetchImpl(`${HTTP_BASE}/api/v1/services/audio/asr/customization`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'speech-biasing', input }),
      });
      if (!response.ok) throw new Error();
      const body = await response.json() as { output?: Record<string, unknown>; code?: unknown };
      if (body.code || !body.output || typeof body.output !== 'object') throw new Error();
      return body.output;
    } catch { throw new Error('云端热词同步失败，请检查密钥、网络或百炼热词列表额度后重试'); }
  }
  async function syncNow(): Promise<HotwordStatus> {
    if (!saved.words.length) return status();
    const key = getApiKey();
    if (!key) { failure = '热词已保存；填写密钥后可同步录音热词'; return status(); }
    failure = undefined;
    for (const model of MODELS) {
      if (isReady(model)) continue;
      try {
        const currentDigest = wordDigest(), currentAccount = digest(key);
        const previous = saved.cloud[model];
        let id: string;
        const vocabulary = saved.words.map(text => ({ text, weight: 4 }));
        if (previous?.account === currentAccount && previous.digest === currentDigest) {
          id = previous.id;
        } else {
          // Requests freeze this ID before upload/connection. Updating or deleting
          // it would silently change a still-running task's recorded vocabulary.
          // Changed terms get a new cloud list; retries of the same version reuse it.
          const output = await call({ action: 'create_vocabulary', target_model: model, prefix: 'earshot', vocabulary }, key);
          if (typeof output.vocabulary_id !== 'string' || !/^vocab-[a-zA-Z0-9-]{1,150}$/.test(output.vocabulary_id) || output.vocabulary_id.includes(key)) throw new Error();
          id = output.vocabulary_id;
        }
        // Persist the ID before querying readiness: a query retry must not create another list.
        saved.cloud[model] = { id, digest: currentDigest, account: currentAccount, ready: false };
        writeJson(path, saved);
        const deployed = await call({ action: 'query_vocabulary', vocabulary_id: id }, key);
        if (deployed.status !== 'OK' || deployed.target_model !== model) throw new Error();
        saved.cloud[model]!.ready = true;
        writeJson(path, saved);
      } catch { failure = '热词已保存在本机，录音热词尚未全部同步；可重试同步。Qwen Audio 3.0 仍可使用本机词表。'; }
    }
    return status();
  }
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const work = tail.then(fn, fn); tail = work.catch(() => {}); return work;
  }
  return {
    status,
    save(text: unknown): Promise<HotwordStatus> {
      const words = normalizeHotwords(text);
      return enqueue(async () => {
        const next = { ...saved, words, updatedAt: Date.now() };
        writeJson(path, next); saved = next; failure = undefined;
        return syncNow();
      });
    },
    sync: () => enqueue(syncNow),
    parameters(model: string, requestKey: string | null = getApiKey()): HotwordParameters {
      if (!saved.words.length) return {};
      if (model === 'qwen-audio-3.0-asr-flash-streaming') return { vocabulary: Object.fromEntries(saved.words.map(word => [word, 4])) };
      if (MODELS.includes(model as typeof MODELS[number]) && isReady(model as typeof MODELS[number], requestKey)) return { vocabulary_id: saved.cloud[model as typeof MODELS[number]]!.id };
      return {};
    },
    revision: () => wordDigest(),
  };
}
let current: ReturnType<typeof createHotwordStore> | undefined;
export function configureHotwords(path: string, getApiKey: () => string | null, fetchImpl: typeof fetch = fetch): void { current = createHotwordStore(path, getApiKey, fetchImpl); }
export function getHotwordStatus(): HotwordStatus { return current?.status() ?? { words: [], updatedAt: null, sync: 'empty', models: [] }; }
export async function saveHotwords(text: unknown): Promise<HotwordStatus> { if (!current) throw new Error('热词服务尚未就绪'); return current.save(text); }
export async function syncHotwords(): Promise<HotwordStatus> { if (!current) throw new Error('热词服务尚未就绪'); return current.sync(); }
export function hotwordParameters(model: string, requestKey: string): HotwordParameters { return current?.parameters(model, requestKey) ?? {}; }
export function hotwordRevision(): string | undefined { return current?.revision(); }
