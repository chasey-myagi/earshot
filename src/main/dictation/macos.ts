import { createRequire } from 'node:module';
import { normalizeShortcut } from '../../shared/shortcuts';
import { createPasteTarget, validSelection, type EditableSnapshot, type Selection } from './input-target';
import { createPasteboardClient } from './pasteboard-client';
import type { DictationBridge } from './runtime';
import type { InputTarget } from './controller';
import type { PasteClipboard } from './clipboard';

// Apple virtual key codes (HIToolbox/Events.h). Poll only the active shortcut, never collect events.
const KEYS: Record<string, number> = {
  A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11,
  Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17, '1': 18, '2': 19, '3': 20,
  '4': 21, '6': 22, '5': 23, Equal: 24, '9': 25, '7': 26, Minus: 27, '8': 28,
  '0': 29, BracketRight: 30, O: 31, U: 32, BracketLeft: 33, I: 34, P: 35,
  Enter: 36, L: 37, J: 38, Quote: 39, K: 40, Semicolon: 41, Backslash: 42,
  Comma: 43, Slash: 44, N: 45, M: 46, Period: 47, Tab: 48, Space: 49,
  Backquote: 50, Backspace: 51, F17: 64, F18: 79, F19: 80, F20: 90,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F13: 105,
  F16: 106, F14: 107, F10: 109, F12: 111, F15: 113, Home: 115, PageUp: 116,
  Delete: 117, F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
  Left: 123, Right: 124, Down: 125, Up: 126,
};
const MODIFIERS: Record<string, number[]> = { Command: [55, 54], Control: [59, 62], Alt: [58, 61], Shift: [56, 60] };

export function shortcutHeld(key: string, down: (code: number) => boolean): boolean {
  const normalized = normalizeShortcut(key);
  if (!normalized) return false;
  const parts = normalized.split('+'), code = KEYS[parts.pop()!];
  return code !== undefined && down(code) && parts.every(modifier => MODIFIERS[modifier].some(down));
}

export function createMacDictationBridge(): DictationBridge | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const keyState = cg.func('bool CGEventSourceKeyState(int stateID, uint16_t key)');
    const clipboard = createPasteboardClient();
    let targets: ReturnType<typeof createNativeTargets> | undefined, failure: string | null = null;
    // Target/clipboard initialization failures must not disable physical key-release detection.
    try { targets = createNativeTargets(koffi, cg, code => keyState(1, code), clipboard); }
    catch { failure = '自动填入暂不可用，识别后可复制文字'; }
    return {
      held: key => shortcutHeld(key, code => keyState(1, code)), escape: () => keyState(1, 53),
      failureReason: () => failure,
      captureTarget() {
        try { return targets?.capture() ?? null; }
        catch { failure = '无法确认当前输入位置，识别后可复制文字'; return null; }
      },
      copy: text => clipboard.copy(text), close: () => clipboard.close(),
    };
  } catch { return undefined; }
}

function createNativeTargets(koffi: typeof import('koffi'), cg: import('koffi').LibraryHandle, down: (code: number) => boolean, clipboard: PasteClipboard) {
  koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const carbon = koffi.load('/System/Library/Frameworks/Carbon.framework/Carbon');
  const getClass = objc.func('void *objc_getClass(const char *name)');
  const selector = objc.func('void *sel_registerName(const char *name)');
  const object = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const integer = objc.func('objc_msgSend', 'int', ['void *', 'void *']);
  const workspace = object(getClass('NSWorkspace'), selector('sharedWorkspace'));
  const frontSelector = selector('frontmostApplication'), pidSelector = selector('processIdentifier');
  const trusted = ax.func('bool AXIsProcessTrusted()');
  const application = ax.func('void *AXUIElementCreateApplication(int pid)');
  const systemWide = ax.func('void *AXUIElementCreateSystemWide()');
  const copy = ax.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)');
  const elementPid = ax.func('int AXUIElementGetPid(void *element, _Out_ int *pid)');
  const timeout = ax.func('int AXUIElementSetMessagingTimeout(void *element, float seconds)');
  const valueType = ax.func('uint32_t AXValueGetType(void *value)');
  const rangeType = koffi.struct({ location: 'long', length: 'long' });
  const getRange = ax.func('AXValueGetValue', 'bool', ['void *', 'uint32_t', koffi.out(koffi.pointer(rangeType))]);
  const release = cf.func('void CFRelease(void *value)');
  const equal = cf.func('bool CFEqual(void *a, void *b)');
  const typeID = cf.func('ulong CFGetTypeID(void *value)');
  const stringTypeID = cf.func('ulong CFStringGetTypeID()');
  const length = cf.func('long CFStringGetLength(void *value)');
  const chars = cf.func('CFStringGetCharacters', 'void', ['void *', rangeType, 'void *']);
  const makeString = cf.func('void *CFStringCreateWithCharacters(void *allocator, void *chars, long length)');
  const attributes = Object.fromEntries(['AXFocusedUIElement','AXFocusedWindow','AXRole','AXSubrole','AXValue','AXSelectedTextRange',
    'kCGWindowOwnerPID','kCGWindowNumber','kCGWindowLayer','kCGWindowBounds','X','Y','Width','Height'].map(value => [value, makeString(null, Buffer.from(value, 'utf16le'), value.length)]));
  const windows = cg.func('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)');
  const arrayCount = cf.func('long CFArrayGetCount(void *value)');
  const arrayAt = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
  const dictAt = cf.func('void *CFDictionaryGetValue(void *dictionary, void *key)');
  const getNumber = cf.func('bool CFNumberGetValue(void *number, int type, _Out_ double *value)');
  const secureInput = carbon.func('uint8_t IsSecureEventInputEnabled()');
  const keyEvent = cg.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t key, bool down)');
  const setFlags = cg.func('void CGEventSetFlags(void *event, uint64_t flags)');
  const post = cg.func('void CGEventPost(uint32_t tap, void *event)');
  const frontPid = () => { const app = object(workspace, frontSelector); return app ? Number(integer(app, pidSelector)) : 0; };
  function number(dict: unknown, name: string): number | null {
    if (!dict) return null;
    const value = dictAt(dict, attributes[name]), output = [0];
    return value && getNumber(value, 13, output) && Number.isFinite(output[0]) ? output[0] : null;
  }
  function frontWindow(pid: number): { id: number; point: { x: number; y: number } } | null {
    // Window IDs/bounds only. Never read window titles or screenshot contents.
    const list = windows(17, 0);
    if (!list) return null;
    try {
      const count = Math.min(Number(arrayCount(list)), 2048);
      for (let i = 0; i < count; i++) {
        const info = arrayAt(list, i);
        if (number(info, 'kCGWindowOwnerPID') !== pid || number(info, 'kCGWindowLayer') !== 0) continue;
        const id = number(info, 'kCGWindowNumber'), bounds = dictAt(info, attributes.kCGWindowBounds);
        const x = number(bounds, 'X'), y = number(bounds, 'Y'), width = number(bounds, 'Width'), height = number(bounds, 'Height');
        if (id !== null && x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0) return { id, point: { x: x + width / 2, y: y + height / 2 } };
      }
      return null;
    } finally { release(list); }
  }
  function attribute(element: unknown, name: string): bigint | null {
    if (!element) return null;
    const output = [null]; return copy(element, attributes[name], output) === 0 ? output[0] : null;
  }
  function readString(value: bigint | null): string | null {
    if (!value) return null;
    try {
      if (typeID(value) !== stringTypeID()) return null;
      const size = Number(length(value));
      if (!Number.isSafeInteger(size) || size < 0 || size > 1_000_000) return null;
      const buffer = Buffer.alloc(size * 2); chars(value, { location: 0, length: size }, buffer);
      return buffer.toString('utf16le');
    } finally { release(value); }
  }
  function focus(app: bigint, pid: number): bigint | null {
    let focused = attribute(app, 'AXFocusedUIElement');
    if (!focused) {
      const system = systemWide();
      try { timeout(system, .025); focused = attribute(system, 'AXFocusedUIElement'); }
      finally { release(system); }
    }
    if (focused) {
      const owner = [0];
      if (elementPid(focused, owner) !== 0 || owner[0] !== pid) { release(focused); return null; }
      timeout(focused, .025);
    }
    return focused;
  }
  function editable(element: bigint | null): EditableSnapshot | null {
    if (!element) return null;
    const role = readString(attribute(element, 'AXRole'));
    const subrole = readString(attribute(element, 'AXSubrole'));
    // Never read the value of a secure field.
    if (subrole === 'AXSecureTextField' || !['AXTextField', 'AXTextArea'].includes(role ?? '')) return null;
    const value = readString(attribute(element, 'AXValue')), selected = attribute(element, 'AXSelectedTextRange');
    if (!selected) return null;
    const range: Selection = { location: 0, length: 0 };
    try { return value !== null && valueType(selected) === 4 && getRange(selected, 4, range) && validSelection(value, range) ? { value, range } : null; }
    finally { release(selected); }
  }
  function capture(): InputTarget | null {
    const pid = frontPid();
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const window = frontWindow(pid);
    // No cross-process AX messages on the wake/HUD critical path.
    let app: bigint | null = null, element: bigint | null = null, originalWindow: bigint | null = null, disposed = false;
    const target = createPasteTarget({
      prepare() {
        if (!trusted() || frontPid() !== pid) return;
        app = application(pid); if (!app) return;
        timeout(app, .025);
        element = focus(app, pid); originalWindow = attribute(app, 'AXFocusedWindow');
      },
      read() {
        const context = { sameContext: false, secure: Boolean(secureInput()), keysReleased: false, editable: null as EditableSnapshot | null };
        if (disposed) return context;
        if (!trusted()) return { ...context, reason: '允许辅助功能后可自动填入，本次可先复制文字' };
        if (context.secure) return { ...context, reason: '安全输入状态不支持自动填入，请复制文字' };
        if (!window) return { ...context, reason: '当前没有输入位置，请复制文字' };
        if (frontPid() !== pid || frontWindow(pid)?.id !== window.id || !app) return { ...context, reason: '你已切换应用或窗口，请复制文字' };
        const current = focus(app, pid), focusedWindow = attribute(app, 'AXFocusedWindow');
        try {
          const subrole = current ? readString(attribute(current, 'AXSubrole')) : null;
          if (subrole === 'AXSecureTextField') return { ...context, secure: true, reason: '密码输入框不支持自动填入' };
          const sameContext = (!element || (!!current && equal(element, current)))
            && (!originalWindow || (!!focusedWindow && equal(originalWindow, focusedWindow))) && frontPid() === pid;
          return { sameContext, secure: false, keysReleased: Array.from({ length: 128 }, (_, code) => code).every(code => !down(code)), editable: sameContext ? editable(current) : null };
        } finally { if (current) release(current); if (focusedWindow) release(focusedWindow); }
      },
      paste(allowed) {
        const events: bigint[] = []; let attempted = false;
        try {
          for (const [key, pressed, flags] of [[55, true, 1n << 20n], [9, true, 1n << 20n], [9, false, 1n << 20n], [55, false, 0n]] as const) {
            const event = keyEvent(null, key, pressed); if (!event) return 'not-posted';
            events.push(event); setFlags(event, flags);
          }
          if (!trusted() || secureInput() || frontPid() !== pid || !allowed()) return 'not-posted';
          attempted = true;
          try { post(1, events[0]); post(1, events[1]); }
          finally { try { post(1, events[2]); } finally { post(1, events[3]); } }
          return 'posted';
        } catch { return attempted ? 'uncertain' : 'not-posted'; }
        finally { for (const event of events) release(event); }
      },
      release() { if (disposed) return; disposed = true; if (element) release(element); if (originalWindow) release(originalWindow); if (app) release(app); },
    }, clipboard);
    target.screenPoint = window?.point;
    return target;
  }
  return { capture };
}
