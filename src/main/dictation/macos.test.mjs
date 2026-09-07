import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';
const { shortcutHeld } = sourceLoader(resolve('src/main/index.ts'), {})('./dictation/macos');
test('missing native module and failed framework initialization disable only the dictation bridge', {skip:process.platform!=='darwin'}, () => {
  for (const requireNative of [() => { throw new Error('native binary missing'); }, () => ({load() { throw new Error('framework unavailable'); }})]) {
    const load = sourceLoader(resolve('src/main/index.ts'), {'node:module': {createRequire: () => requireNative}, koffi: {default: {load() { throw new Error('framework unavailable'); }}}});
    assert.doesNotThrow(() => assert.equal(load('./dictation/macos').createMacDictationBridge(), undefined));
  }
});
test('native hold checks accept either modifier side and detect release of the main key or modifier', () => {
  let down = new Set([61,49]);
  const check = code => down.has(code);
  assert.equal(shortcutHeld('Alt+Space', check), true);
  down.delete(49); assert.equal(shortcutHeld('Alt+Space', check), false);
  down = new Set([49]); assert.equal(shortcutHeld('Alt+Space', check), false);
  down = new Set([54,62,56,0]); assert.equal(shortcutHeld('Command+Control+Shift+A', check), true);
  assert.equal(shortcutHeld('F20', code => code === 90), true);
  assert.equal(shortcutHeld('F21', () => true), false);
});

// Execute the production factory and its CF/AX ownership code; replace only the C ABI boundary.
function nativeFixture(patch = {}) {
  const state = { trusted:true, focus:'target', role:'AXTextArea', subrole:null, value:'前🙂中后',
    range:{location:3,length:1}, writable:true, errorAttribute:null, writeError:0, ...patch };
  const refs = new Map(), setters = [], reads = []; let next = 0n;
  const ref = (kind, value) => { const id = ++next; refs.set(id,{kind,value}); return id; };
  const value = id => { assert.ok(refs.has(id),'no use after release'); return refs.get(id).value; };
  const calls = {
    CGEventSourceKeyState:()=>false, AXIsProcessTrusted:()=>state.trusted,
    AXUIElementCreateSystemWide:()=>ref('system',null), AXUIElementSetMessagingTimeout:()=>0,
    AXUIElementCopyAttributeValue(element, attribute, out) {
      const name = value(attribute); reads.push(name);
      if (name === state.errorAttribute) return -25204;
      if (name === 'AXFocusedUIElement') { if (!state.focus) return -25204; out[0]=ref('element',state.focus); return 0; }
      value(element);
      const content = {AXRole:state.role,AXSubrole:state.subrole,AXValue:state.value,AXSelectedTextRange:state.range}[name];
      if (content === null || content === undefined) return -25205;
      out[0]=ref(name === 'AXSelectedTextRange' ? 'range' : 'string', typeof content === 'object' ? {...content} : content); return 0;
    },
    AXUIElementIsAttributeSettable(element,attribute,out) { value(element); out[0]=Number(state.writable); return 0; },
    AXValueGetType:()=>4, AXValueGetValue(id,type,out) {Object.assign(out,value(id));return true;},
    AXValueCreate:(type,range)=>ref('range',{...range}),
    CFRelease(id) { assert.ok(refs.delete(id),'no double release'); }, CFEqual:(a,b)=>value(a)===value(b),
    CFGetTypeID:id=>refs.get(id)?.kind === 'string' ? 7 : 8, CFStringGetTypeID:()=>7,
    CFStringGetLength:id=>value(id).length,
    CFStringGetCharacters(id,range,buffer) {Buffer.from(value(id).slice(range.location,range.location+range.length),'utf16le').copy(buffer);},
    CFStringCreateWithCharacters:(allocator,buffer,count)=>ref('string',buffer.toString('utf16le',0,count*2)),
    AXUIElementSetAttributeValue(element,attribute,replacement) {
      value(element); const name=value(attribute), text=value(replacement); setters.push(name);
      if (state.writeError) return state.writeError;
      if(name==='AXSelectedText') state.value=state.value.slice(0,state.range.location)+text+state.value.slice(state.range.location+state.range.length);
      else if(name==='AXSelectedTextRange') state.range={...text};
      else assert.fail('must not replace the full document');
      return 0;
    },
  };
  const ffi = {struct:value=>value,pointer:value=>value,out:value=>value,load:()=>({func(signature){
    const name=signature.includes('(') ? signature.match(/(\w+)\(/)[1] : signature;
    assert.ok(calls[name],`unexpected native function ${name}`); return calls[name];
  }})};
  const bridge = sourceLoader(resolve('src/main/index.ts'), {'node:module':{createRequire:()=>name=>{assert.equal(name,'koffi');return ffi;}}})('./dictation/macos').createMacDictationBridge();
  const constants=refs.size;
  return {bridge,state,setters,reads,checkReleased:()=>assert.equal(refs.size,constants,'only process-lifetime attribute constants remain')};
}

test('native AX bridge replaces only the selected text and places the caret using UTF-16 offsets', {skip:process.platform!=='darwin'}, () => {
  const h=nativeFixture(), target=h.bridge.captureTarget();
  assert.ok(target); assert.equal(target.insert('插入😀'),true);
  assert.equal(h.state.value,'前🙂插入😀后'); assert.deepEqual(h.state.range,{location:7,length:0});
  assert.deepEqual(h.setters,['AXSelectedText','AXSelectedTextRange']);
  target.release(); target.release(); h.checkReleased();
});

test('native AX bridge rejects secure, unsupported, unreadable and non-writable targets and releases references', {skip:process.platform!=='darwin'}, () => {
  for(const patch of [{trusted:false},{focus:null},{role:'AXWebArea'},{role:'AXTextField',subrole:'AXSecureTextField'},
    {writable:false},{errorAttribute:'AXValue'},{errorAttribute:'AXSelectedTextRange'},{range:{location:100,length:0}}]) {
    const h=nativeFixture(patch); assert.equal(h.bridge.captureTarget(),null); assert.deepEqual(h.setters,[]);h.checkReleased();
    if(patch.subrole) assert.equal(h.reads.includes('AXValue'),false,'never read password values');
  }
});

test('native AX bridge preserves text after target changes or AX write errors, without leaking references', {skip:process.platform!=='darwin'}, () => {
  for(const patch of [{focus:'another-input'}, {focus:null}, {value:'用户已经修改'}, {range:{location:0,length:0}}, {writeError:-25204}]) {
    const h=nativeFixture(), target=h.bridge.captureTarget(); assert.ok(target);
    Object.assign(h.state,patch); const before=h.state.value;
    assert.equal(target.insert('不应写入'),false); assert.equal(h.state.value,before);
    target.release();h.checkReleased();
  }
});
