import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {sourceLoader} from '../../../scripts/test-source-loader.mjs';

export function nativeFixture(patch={}) {
 const state={pid:66932,windowId:44,focus:'input',trusted:true,role:'AXTextArea',subrole:null,value:'前🙂选区后',range:{location:3,length:2},held:new Set(),secure:false,delivery:'complete',...patch};
 const refs=new Map(),events=[],reads=[];let next=0n,allocations=0,clipText='',claims=0,finishes=0;
 const ref=(kind,payload)=>{const id=++next;refs.set(id,{kind,payload});return id;};
 const get=id=>{assert.ok(refs.has(id),'live native reference');return refs.get(id).payload;};
 const calls={
 CGEventSourceKeyState:(_source,code)=>state.held.has(code),
 objc_getClass:name=>({class:name}),sel_registerName:name=>name,
 objc_msgSend:(receiver,selector)=>selector==='sharedWorkspace'?{workspace:true}:selector==='frontmostApplication'?{pid:state.pid}:selector==='processIdentifier'?receiver.pid:null,
 AXIsProcessTrusted:()=>state.trusted, IsSecureEventInputEnabled:()=>Number(state.secure),
 AXUIElementCreateApplication:pid=>ref('app',{pid}),AXUIElementCreateSystemWide:()=>ref('system',{}),AXUIElementSetMessagingTimeout:()=>0,
 AXUIElementGetPid:(_element,output)=>{output[0]=state.elementPid??state.pid;return 0;},
 AXUIElementCopyAttributeValue(element,attribute,output){
  const name=get(attribute);get(element);reads.push(name);state.onRead?.(name);
  if(name==='AXFocusedUIElement'){if(!state.focus)return -25204;output[0]=ref('element',{id:state.focus});return 0;}
  if(name==='AXFocusedWindow'){if(state.axWindow===false)return -25204;output[0]=ref('window',{id:state.windowId});return 0;}
  const value={AXRole:state.role,AXSubrole:state.subrole,AXValue:state.value,AXSelectedTextRange:state.range}[name];
  if(value===null||value===undefined||name===state.failAttribute)return -25205;
  output[0]=ref(name==='AXSelectedTextRange'?'range':'string',typeof value==='object'?{...value}:value);return 0;
 },
 AXValueGetType:()=>4,AXValueGetValue:(id,_type,output)=>{Object.assign(output,get(id));return true;},
 CFRelease:id=>assert.ok(refs.delete(id),'release exactly once'),CFEqual:(a,b)=>get(a).id===get(b).id,
 CFGetTypeID:id=>refs.get(id)?.kind==='string'?7:8,CFStringGetTypeID:()=>7,
 CFStringCreateWithCharacters:(_allocator,bytes,count)=>ref('string',bytes.toString('utf16le',0,count*2)),
 CFStringGetLength:id=>get(id).length,CFStringGetCharacters:(id,range,buffer)=>Buffer.from(get(id).slice(range.location,range.location+range.length),'utf16le').copy(buffer),
 CGWindowListCopyWindowInfo:()=>ref('array',state.noWindow?[]:[{kCGWindowOwnerPID:state.pid,kCGWindowNumber:state.windowId,kCGWindowLayer:0,kCGWindowBounds:{X:100,Y:100,Width:800,Height:600}}]),
 CFArrayGetCount:id=>get(id).length,CFArrayGetValueAtIndex:(id,index)=>get(id)[index],
 CFDictionaryGetValue:(dict,key)=>{const value=dict[get(key)];return typeof value==='number'?{number:value}:value??null;},
 CFNumberGetValue:(value,_type,output)=>{output[0]=value.number;return true;},
 CGEventCreateKeyboardEvent:(_source,key,down)=>{if(++allocations===state.createFailAt)return null;return ref('event',{key,down});},
 CGEventSetFlags:(event,flags)=>{get(event).flags=flags;state.onFlags?.();},
 CGEventPost:(tap,event)=>{
  const value={tap,...get(event)};events.push(value);assert.ok([55,9].includes(value.key),'only Cmd+V, never Return');
  if(value.down&&value.key===9){
   if(state.postThrow)throw Error('native dispatch interrupted');
   if(state.delivery!=='noop'){
    const text=state.delivery==='partial'?clipText.slice(0,1):clipText;
    const deliver=()=>{state.value=state.value.slice(0,state.range.location)+text+state.value.slice(state.range.location+state.range.length);state.range={location:state.range.location+text.length,length:0};};
    if(state.delay)setTimeout(deliver,state.delay);else deliver();
   }
  }
  state.onPost?.(value);
 },
 };
 const ffi={struct:x=>x,out:x=>x,pointer:x=>x,load:()=>({func(signature){const name=signature.includes('(')?signature.match(/(\w+)\(/)[1]:signature;assert.ok(calls[name],`native function ${name}`);return calls[name];}})};
 const clipboard={claim:async text=>{claims++;clipText=text;await state.onClaim?.();return 'lease';},owned:async()=>state.clipOwned!==false,finish:async()=>{finishes++;},copy:async()=>{},close:async()=>{}};
 const bridge=sourceLoader(resolve('src/main/dictation/macos.ts'),{'node:module':{createRequire:()=>()=>ffi},'./pasteboard-client':{createPasteboardClient:()=>clipboard}})('./macos').createMacDictationBridge();
 assert.ok(bridge);const baseline=refs.size;
 return {bridge,state,events,reads,counts:()=>({claims,finishes}),capture(){const target=bridge.captureTarget();target?.prepare?.();return target;},
 checkReleased(){assert.equal(refs.size,baseline,'only process-lifetime attribute constants remain');}};
}
