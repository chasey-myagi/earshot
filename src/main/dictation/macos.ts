import { createRequire } from 'node:module';
import { normalizeShortcut } from '../../shared/shortcuts';
import { protectInputTarget, validSelection, type Selection } from './input-target';
import type { DictationBridge } from './runtime';

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
  // Loading koffi also loads its platform binary. Keep that failure inside the optional bridge.
  try { return loadMacDictationBridge(); }
  catch { return undefined; }
}

function loadMacDictationBridge(): DictationBridge {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const ax = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const rangeType = koffi.struct({ location: 'long', length: 'long' });
  const keyState = cg.func('bool CGEventSourceKeyState(int stateID, uint16_t key)');
  const trusted = ax.func('bool AXIsProcessTrusted()');
  const systemWide = ax.func('void *AXUIElementCreateSystemWide()');
  const copy = ax.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)');
  const set = ax.func('int AXUIElementSetAttributeValue(void *element, void *attribute, void *value)');
  const settable = ax.func('int AXUIElementIsAttributeSettable(void *element, void *attribute, _Out_ uint8_t *value)');
  const timeout = ax.func('int AXUIElementSetMessagingTimeout(void *element, float seconds)');
  const valueType = ax.func('uint32_t AXValueGetType(void *value)');
  const getRange = ax.func('AXValueGetValue', 'bool', ['void *', 'uint32_t', koffi.out(koffi.pointer(rangeType))]);
  const createRange = ax.func('AXValueCreate', 'void *', ['uint32_t', koffi.pointer(rangeType)]);
  const release = cf.func('void CFRelease(void *value)');
  const equal = cf.func('bool CFEqual(void *left, void *right)');
  const typeID = cf.func('ulong CFGetTypeID(void *value)');
  const stringTypeID = cf.func('ulong CFStringGetTypeID()');
  const length = cf.func('long CFStringGetLength(void *value)');
  const chars = cf.func('CFStringGetCharacters', 'void', ['void *', rangeType, 'void *']);
  const makeString = cf.func('void *CFStringCreateWithCharacters(void *allocator, void *chars, long length)');
  const string = (text: string) => makeString(null, Buffer.from(text, 'utf16le'), text.length) as bigint;
  // Fixed process-lifetime constants, not target references or user text.
  const attributes = Object.fromEntries(['AXFocusedUIElement', 'AXRole', 'AXSubrole', 'AXValue', 'AXSelectedText', 'AXSelectedTextRange'].map(name => [name, string(name)]));
  function attribute(element: bigint, name: string): bigint | null {
    const output = [null];
    return copy(element, attributes[name], output) === 0 ? output[0] : null;
  }
  function readString(value: bigint | null): string | null {
    if (!value) return null;
    try {
      if (typeID(value) !== stringTypeID()) return null;
      const count = Number(length(value));
      if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) return null;
      const buffer = Buffer.alloc(count * 2);
      chars(value, { location: 0, length: count }, buffer);
      return buffer.toString('utf16le');
    } finally { release(value); }
  }
  function writable(element: bigint, name: string): boolean {
    const output = [0]; return settable(element, attributes[name], output) === 0 && output[0] === 1;
  }
  function focus(): bigint | null {
    const system = systemWide();
    try { timeout(system, 0.2); return attribute(system, 'AXFocusedUIElement'); }
    finally { release(system); }
  }
  return {
    held: key => shortcutHeld(key, code => keyState(1, code)),
    escape: () => keyState(1, 53),
    captureTarget() {
      if (!trusted()) return null;
      const element = focus();
      if (!element) return null;
      timeout(element, 0.2);
      const role = readString(attribute(element, 'AXRole'));
      const subrole = readString(attribute(element, 'AXSubrole'));
      if (!['AXTextField', 'AXTextArea'].includes(role ?? '') || subrole === 'AXSecureTextField') { release(element); return null; }
      const selectedWritable = writable(element, 'AXSelectedText');
      // Full AXValue replacement can strip rich formatting. Only use the selected-text setter.
      if (!selectedWritable) { release(element); return null; }
      return protectInputTarget({
        read() {
          const value = readString(attribute(element, 'AXValue'));
          const selected = attribute(element, 'AXSelectedTextRange');
          if (!selected) return null;
          const range: Selection = { location: 0, length: 0 };
          let valid = false;
          try { valid = valueType(selected) === 4 && getRange(selected, 4, range); }
          finally { release(selected); }
          return value !== null && valid && validSelection(value, range) ? { value, range } : null;
        },
        focused() {
          const current = focus();
          if (!current) return false;
          try { return equal(element, current); } finally { release(current); }
        },
        replace(before, text) {
          const replacement = string(text);
          let ok = false;
          try { ok = set(element, attributes.AXSelectedText, replacement) === 0; }
          finally { release(replacement); }
          if (ok && writable(element, 'AXSelectedTextRange')) {
            const caret = createRange(4, { location: before.range.location + text.length, length: 0 });
            if (caret) { try { set(element, attributes.AXSelectedTextRange, caret); } finally { release(caret); } }
          }
          return ok;
        },
        release: () => release(element),
      });
    },
  };
}
