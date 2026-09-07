import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShortcutSettings } from './shortcuts.ts';
import { DEFAULT_SHORTCUTS } from '../../shared/dictation.ts';

test('shortcut conflict retains saved configuration and old registrations, rolling back the other new key', t => {
  const root=mkdtempSync(join(tmpdir(),'earshot-keys-'));const keys=new Map();
  const settings=createShortcutSettings({root,register:(key,fn)=>{if(key==='Control+Alt+Space')return false;keys.set(key,fn);return true;},unregister:key=>keys.delete(key),meeting(){},dictation(){}});
  t.after(()=>{settings.close();rmSync(root,{recursive:true,force:true});});
  assert.equal(settings.start().ok,true);
  assert.equal(settings.save(DEFAULT_SHORTCUTS).ok,true);
  const original=readFileSync(join(root,'shortcuts.json'),'utf8');
  assert.equal(settings.save({...DEFAULT_SHORTCUTS,meeting:'Command+Shift+R',dictation:'Control+Alt+Space'}).ok,false);
  assert.deepEqual([...keys.keys()],['Control+Alt+R','Alt+Space']);
  assert.equal(readFileSync(join(root,'shortcuts.json'),'utf8'),original);
  assert.equal(statSync(join(root,'shortcuts.json')).mode&0o777,0o600);
});

test('disabling dictation releases only its shortcut and config survives restart', t => {
  const root=mkdtempSync(join(tmpdir(),'earshot-keys-'));const keys=new Set();
  const opts={root,register:key=>{keys.add(key);return true;},unregister:key=>keys.delete(key),meeting(){},dictation(){}};
  const first=createShortcutSettings(opts);t.after(()=>{first.close();rmSync(root,{recursive:true,force:true});});
  first.start();assert.equal(first.save({...DEFAULT_SHORTCUTS,enabled:false,delivery:'preview'}).ok,true);assert.deepEqual([...keys],['Control+Alt+R']);first.close();
  const second=createShortcutSettings(opts);assert.equal(second.start().ok,true);assert.equal(second.snapshot().prefs.enabled,false);assert.equal(second.snapshot().prefs.delivery,'preview');second.close();
  assert.equal(first.save({...DEFAULT_SHORTCUTS,dictation:'Command+Space'}).ok,true);
});

test('startup retains a valid recording shortcut when dictation is occupied', t => {
  const root=mkdtempSync(join(tmpdir(),'earshot-keys-')), keys=new Map();let recorded=0;
  const settings=createShortcutSettings({root,register:(key,fn)=>{if(key==='Alt+Space')return false;keys.set(key,fn);return true;},unregister:key=>keys.delete(key),meeting(){recorded++;},dictation(){}});
  t.after(()=>{settings.close();rmSync(root,{recursive:true,force:true});});
  assert.equal(settings.start().ok,false);assert.deepEqual([...keys.keys()],['Control+Alt+R']);keys.get('Control+Alt+R')();assert.equal(recorded,1);
  assert.match(settings.snapshot().error,/语音输入/);
});

test('custom keys persist, swapped keys invoke the new function, duplicate canonical keys are rejected', t => {
  const root=mkdtempSync(join(tmpdir(),'earshot-keys-')),keys=new Map(),actions=[];
  const settings=createShortcutSettings({root,register:(key,fn)=>{keys.set(key,fn);return true;},unregister:key=>keys.delete(key),meeting(){actions.push('meeting');},dictation(){actions.push('dictation');}});
  t.after(()=>{settings.close();rmSync(root,{recursive:true,force:true});});settings.start();
  assert.equal(settings.save({...DEFAULT_SHORTCUTS,meeting:'Alt+Space',dictation:'Alt+Control+R'}).ok,true);
  keys.get('Alt+Space')();keys.get('Control+Alt+R')();assert.deepEqual(actions,['meeting','dictation']);
  assert.equal(settings.save({...DEFAULT_SHORTCUTS,meeting:'Shift+Command+K',dictation:'F8'}).ok,true);
  assert.equal(settings.snapshot().prefs.meeting,'Command+Shift+K');
  assert.equal(settings.save({...DEFAULT_SHORTCUTS,meeting:'Alt+Control+Q',dictation:'Control+Alt+Q'}).ok,false);
  assert.equal(settings.save({...DEFAULT_SHORTCUTS,meeting:'Q'}).ok,false);
});
