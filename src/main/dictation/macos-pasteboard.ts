import { createRequire } from 'node:module';

export type PasteboardItem = { type: string; data: Uint8Array }[];
export type PasteboardSnapshot = { changeCount: number; items: PasteboardItem[] };
export const PASTE_MARKER = 'app.earshot.dictation-session';
export class PasteboardWriteError extends Error {
  constructor(public readonly clearCount: number) { super('剪贴板写入失败'); }
}
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 64;
const MAX_TYPES = 64;

/** Own one NSPasteboard on one thread. No Electron clipboard calls share this object.
 * Data providers can block inside AppKit, so production runs this in a main-process
 * worker thread, with a cancellation flag checked before every mutation. */
export function createMacPasteboard(name?: string) {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const getClass = objc.func('void *objc_getClass(const char *name)');
  const sel = objc.func('void *sel_registerName(const char *name)');
  const object = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const objectArg = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'void *']);
  const at = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'ulong']);
  const count = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
  const put = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *', 'void *']);
  const write = objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *']);
  const add = objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']);
  const action = objc.func('objc_msgSend', 'void', ['void *', 'void *']);
  const makeString = cf.func('void *CFStringCreateWithCharacters(void *allocator, void *chars, long length)');
  const stringLength = cf.func('long CFStringGetLength(void *string)');
  const range = koffi.struct({ location: 'long', length: 'long' });
  const stringChars = cf.func('CFStringGetCharacters', 'void', ['void *', range, 'void *']);
  const makeData = cf.func('void *CFDataCreate(void *allocator, void *bytes, long length)');
  const dataLength = cf.func('long CFDataGetLength(void *data)');
  const copyData = cf.func('CFDataGetBytes', 'void', ['void *', range, 'void *']);
  const retain = cf.func('void *CFRetain(void *value)');
  const release = cf.func('void CFRelease(void *value)');
  const selectors = Object.fromEntries(['alloc', 'init', 'drain', 'generalPasteboard', 'pasteboardWithName:', 'pasteboardItems', 'types',
    'count', 'objectAtIndex:', 'dataForType:', 'changeCount', 'clearContents', 'writeObjects:', 'setData:forType:', 'addObject:', 'releaseGlobally'].map(key => [key, sel(key)]));
  const classes = Object.fromEntries(['NSAutoreleasePool', 'NSPasteboard', 'NSPasteboardItem', 'NSMutableArray'].map(key => [key, getClass(key)]));
  const string = (value: string) => makeString(null, Buffer.from(value, 'utf16le'), value.length);
  function pooled<T>(fn: () => T): T {
    const pool = object(object(classes.NSAutoreleasePool, selectors.alloc), selectors.init);
    try { return fn(); } finally { action(pool, selectors.drain); }
  }
  const board = pooled(() => {
    if (!name) { const value = object(classes.NSPasteboard, selectors.generalPasteboard); return value ? retain(value) : null; }
    const value = string(name);
    try { const board = objectArg(classes.NSPasteboard, selectors['pasteboardWithName:'], value); return board ? retain(board) : null; }
    finally { release(value); }
  });
  if (!board) throw new Error('剪贴板暂不可用');
  let closed = false;
  const version = () => Number(count(board, selectors.changeCount));
  function text(value: unknown): string {
    const size = Number(stringLength(value));
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024) throw new Error('剪贴板格式无法安全保存');
    const bytes = Buffer.alloc(size * 2);
    stringChars(value, { location: 0, length: size }, bytes);
    return bytes.toString('utf16le');
  }
  function boundedCount(value: unknown, limit: number) {
    const size = value ? Number(count(value, selectors.count)) : 0;
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('剪贴板内容过多，请复制识别文字');
    return size;
  }
  function check(cancelled: () => boolean) {
    if (closed || cancelled()) throw new Error('剪贴板操作已取消');
  }
  function snapshot(cancelled: () => boolean = () => false): PasteboardSnapshot {
    return pooled(() => {
      check(cancelled);
      const changeCount = version(), items: PasteboardItem[] = [];
      let bytes = 0;
      try {
        const nativeItems = object(board, selectors.pasteboardItems);
        for (let index = 0, size = boundedCount(nativeItems, MAX_ITEMS); index < size; index++) {
          check(cancelled);
          const item = at(nativeItems, selectors['objectAtIndex:'], index);
          const types = object(item, selectors.types), entries: PasteboardItem = [];
          items.push(entries);
          for (let t = 0, n = boundedCount(types, MAX_TYPES); t < n; t++) {
            check(cancelled);
            const type = at(types, selectors['objectAtIndex:'], t), typeName = text(type);
            // File promises cannot be restored merely by copying their advertised bytes.
            if (/promise|promised|filecontents/i.test(typeName)) throw new Error('剪贴板含延迟文件，请复制识别文字');
            const data = objectArg(item, selectors['dataForType:'], type);
            check(cancelled);
            if (!data) throw new Error('剪贴板有尚不可读取的内容，请复制识别文字');
            const length = Number(dataLength(data));
            if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BYTES - bytes) throw new Error('剪贴板内容过大，请复制识别文字');
            bytes += length;
            // Electron disables external ArrayBuffers. Copy into JS-owned storage;
            // native bytes must also outlive the autorelease pool only as a copy.
            const bytesCopy = Buffer.alloc(length);
            if (length) copyData(data, { location: 0, length }, bytesCopy);
            entries.push({ type: typeName, data: bytesCopy });
          }
          if (!entries.length) throw new Error('剪贴板格式无法安全保存');
        }
        if (version() !== changeCount) throw new Error('剪贴板刚刚变化，请复制识别文字');
        return { changeCount, items };
      } catch (error) { erasePasteboard(items); throw error; }
    });
  }
  /** Prepare all immutable native data before clearing. A version change aborts
   * the write; AppKit has no atomic compare-and-swap with other processes. */
  function replace(items: PasteboardItem[], expected: number, cancelled: () => boolean = () => false): number | null {
    return pooled(() => {
      check(cancelled);
      const array = object(object(classes.NSMutableArray, selectors.alloc), selectors.init);
      try {
        for (const entries of items) {
          const item = object(object(classes.NSPasteboardItem, selectors.alloc), selectors.init);
          try {
            for (const entry of entries) {
              check(cancelled);
              const type = string(entry.type), data = makeData(null, Buffer.from(entry.data), entry.data.byteLength);
              try { if (!data || !put(item, selectors['setData:forType:'], data, type)) throw new Error('剪贴板写入准备失败'); }
              finally { if (data) release(data); release(type); }
            }
            add(array, selectors['addObject:'], item);
          } finally { release(item); }
        }
        check(cancelled);
        if (version() !== expected) return null;
        const cleared = Number(count(board, selectors.clearContents));
        // Do not overwrite a copy that arrived between clearContents and writeObjects.
        if (version() !== cleared) return null;
        if (items.length && !write(board, selectors['writeObjects:'], array)) throw new PasteboardWriteError(cleared);
        return version();
      } finally { release(array); }
    });
  }
  function owns(changeCount: number, marker: string): boolean {
    return pooled(() => {
      if (closed || version() !== changeCount) return false;
      const key = string(PASTE_MARKER);
      try {
        const data = objectArg(board, selectors['dataForType:'], key);
        if (!data || Number(dataLength(data)) !== Buffer.byteLength(marker)) return false;
        const bytes = Buffer.alloc(Buffer.byteLength(marker));
        copyData(data, { location: 0, length: bytes.length }, bytes);
        return bytes.toString('utf8') === marker && version() === changeCount;
      } finally { release(key); }
    });
  }
  return {
    snapshot, replace, owns, changeCount: version,
    close() { if (closed) return; closed = true; pooled(() => { if (name) action(board, selectors.releaseGlobally); release(board); }); },
  };
}

export function erasePasteboard(items: PasteboardItem[]) {
  for (const item of items) for (const entry of item) entry.data.fill(0);
  items.length = 0;
}
