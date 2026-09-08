import {createPasteTarget} from './input-target.ts';
export function pasteFixture(patch={}) {
 const state={sameContext:true,secure:false,keysReleased:true,editable:{value:'前｜选区｜后',range:{location:2,length:2}},...patch};
 let text='',released=0,attempts=0,claims=0,finishes=0,prepared=0,clipOwned=true;
 const events=[]; let onPaste, onClaim, onRead;
 const port={prepare(){prepared++;},read(){onRead?.();return {...state,editable:state.editable?{value:state.editable.value,range:{...state.editable.range}}:null};},
 paste(allowed){if(!allowed())return 'not-posted';attempts++;events.push('paste');return onPaste?onPaste(text,state):'posted';},release(){released++;}};
 const clipboard={claim:async value=>{claims++;text=value;events.push('claim');await onClaim?.();return 'lease';},owned:async()=>clipOwned,
 finish:async()=>{finishes++;events.push('finish');},copy:async()=>{},close:async()=>{}};
 const target=createPasteTarget(port,clipboard,{releaseMs:60,verifyMs:100,verifiedRestoreMs:1,opaqueRestoreMs:1});
 target.prepare();
 return {target,state,events,signal:new AbortController(),clipboard,
 counts:()=>({released,attempts,claims,finishes,prepared}),onPaste(fn){onPaste=fn;},onClaim(fn){onClaim=fn;},onRead(fn){onRead=fn;},copyChanged(){clipOwned=false;},
 deliver(value=text){const before=state.editable;state.editable={value:before.value.slice(0,before.range.location)+value+before.value.slice(before.range.location+before.range.length),range:{location:before.range.location+value.length,length:0}};},
 insert(value='识别文字'){return target.insert(value,this.signal.signal);},};
}
