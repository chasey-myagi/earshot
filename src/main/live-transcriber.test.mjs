import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveTranscriber } from "./live-transcriber.ts";
import { createLiveBuffer } from "./live.ts";

function socketServer() {
  const sockets = [];
  const connect = () => {
    const handlers = {};
    const socket = { sent: [], closed: false,
      send(data) { this.sent.push(data); }, close() { this.closed = true; },
      onOpen(fn) { handlers.open = fn; }, onMessage(fn) { handlers.message = fn; },
      onError(fn) { handlers.error = fn; }, onClose(fn) { handlers.close = fn; },
      ready() { handlers.message(JSON.stringify({ header: { event: "task-started" } })); },
      lose() { handlers.close(); },
      sentence(text, id = 1, start = 0) { handlers.message(JSON.stringify({ header: { event: "result-generated" },
        payload: { output: { sentence: { text, sentence_id: id, begin_time: start, sentence_end: true } } },
      })); },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, connect };
}

test("automatic reconnect retains this recording timeline and repeated sentence ids cannot replace earlier text", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = socketServer(), buffer = createLiveBuffer(), states = [];
  const transcriber = createLiveTranscriber({ apiKey: "fixture", connect: server.connect,
    onSentence: (track, sentence) => buffer.apply(track, sentence), onStatus: status => states.push(status) });
  t.after(() => transcriber.stop());
  transcriber.sendPcm("you", Buffer.alloc(32000)); server.sockets.forEach(socket => socket.ready());
  server.sockets[0].sentence("before loss"); server.sockets[0].lose();
  transcriber.sendPcm("you", Buffer.alloc(32000 * 5)); t.mock.timers.tick(1000);
  transcriber.sendPcm("you", Buffer.alloc(32000)); server.sockets[2].ready();
  server.sockets[0].sentence("stale"); server.sockets[2].sentence("after reconnect");
  assert.deepEqual(buffer.turns().map(row => [row.text, row.tStartMs]), [["before loss", 0], ["after reconnect", 6000]]);
  assert.equal(new Set(buffer.turns().map(row => row.id)).size, 2);
  assert.equal(states.at(-1), "connected"); assert.equal(server.sockets[1].closed, false);
});

test("stopping during reconnect releases healthy and connecting sockets and ignores late events", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = socketServer(), rows = [], states = [];
  const transcriber = createLiveTranscriber({ apiKey: "fixture", connect: server.connect,
    onSentence: (_track, row) => rows.push(row), onStatus: status => states.push(status) });
  server.sockets.forEach(socket => socket.ready()); server.sockets[1].lose(); t.mock.timers.tick(1000);
  transcriber.stop(); const prior = [...states];
  server.sockets.forEach(socket => { socket.ready(); socket.sentence("late"); socket.lose(); });
  t.mock.timers.tick(120000); assert.deepEqual(states, prior); assert.deepEqual(rows, []);
  assert.ok(server.sockets.every(socket => socket.closed)); assert.equal(transcriber.retry(), false);
});

test("both tracks must become ready; independent reconnect retains each actual sample clock", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = socketServer(), buffer = createLiveBuffer(), states = [];
  const transcriber = createLiveTranscriber({ apiKey: "fixture", connect: server.connect,
    onSentence: (track, sentence) => buffer.apply(track, sentence), onStatus: state => states.push(state) });
  t.after(() => transcriber.stop()); server.sockets[0].ready(); server.sockets[0].ready();
  assert.equal(states.at(-1), "connecting"); server.sockets[1].ready(); t.mock.timers.tick(15001);
  assert.equal(states.at(-1), "connected"); // Silence itself is not a client-side timeout.
  transcriber.sendPcm("you", Buffer.alloc(32000)); transcriber.sendPcm("other", Buffer.alloc(64000));
  server.sockets[0].sentence("mic before"); server.sockets[1].sentence("system before");
  server.sockets[0].lose(); server.sockets[1].lose();
  transcriber.sendPcm("you", Buffer.alloc(96000)); transcriber.sendPcm("other", Buffer.alloc(160000));
  t.mock.timers.tick(1000); transcriber.sendPcm("you", Buffer.alloc(32000)); transcriber.sendPcm("other", Buffer.alloc(32000));
  server.sockets[3].ready(); assert.equal(states.at(-1), "reconnecting"); server.sockets[2].ready();
  server.sockets[3].sentence("system after"); server.sockets[2].sentence("mic after");
  assert.deepEqual(buffer.turns().map(row => [row.track, row.tStartMs, row.text]), [
    ["you", 0, "mic before"], ["other", 0, "system before"], ["you", 4000, "mic after"], ["other", 7000, "system after"]]);
});

test("second socket construction failure preserves the first and retries only the second", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = socketServer(), states = []; let attempts = 0;
  const transcriber = createLiveTranscriber({ apiKey: "fixture", connect: () => {
    if (++attempts === 2) throw Error("second connection refused"); return server.connect();
  }, onSentence() {}, onStatus: state => states.push(state) });
  t.after(() => transcriber.stop()); assert.equal(server.sockets[0].closed, false); server.sockets[0].ready();
  assert.equal(states.at(-1), "reconnecting"); t.mock.timers.tick(1000); server.sockets[1].ready();
  assert.equal(states.at(-1), "connected"); assert.equal(server.sockets.length, 2);
});

// Fixed recovery contracts: do not change these to accommodate implementation.
function recoveryFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets=[], states=[], rows=[], events=[];
  const transcriber=createLiveTranscriber({apiKey:'synthetic',onSentence:(track,row)=>rows.push({track,...row}),
    onStatus:(status,detail)=>states.push({status,detail}),onEvent:event=>events.push(event),connect:()=>{
      const h={};const socket={closed:false,sent:[],send(data){this.sent.push(data)},close(){this.closed=true},
        onOpen:fn=>h.open=fn,onMessage:fn=>h.message=fn,onError:fn=>h.error=fn,onClose:fn=>h.close=fn,
        ready(){h.open();h.message(JSON.stringify({header:{event:'task-started'}}))},
        lose(){h.close()},fail(code,message='synthetic diagnostic'){h.message(JSON.stringify({header:{event:'task-failed',error_code:code,error_message:message}}))},
        finish(){h.message(JSON.stringify({header:{event:'task-finished'}}))},
        sentence(){h.message(JSON.stringify({header:{event:'result-generated'},payload:{output:{sentence:{sentence_id:1,text:'fixture',begin_time:0,sentence_end:true}}}}))}};
      sockets.push(socket);return socket;}});
  t.after(()=>transcriber.stop());
  sockets.forEach(s=>s.ready());
  return {sockets,states,rows,events,transcriber};
}
test('recovery contract: transport loss retries only failed track after 1 second while healthy track keeps transcribing',t=>{
  const h=recoveryFixture(t);h.sockets[0].lose();
  assert.equal(h.sockets[1].closed,false);h.sockets[1].sentence();assert.equal(h.rows.at(-1).track,'other');
  assert.equal(h.states.at(-1).status,'reconnecting');t.mock.timers.tick(999);assert.equal(h.sockets.length,2);
  t.mock.timers.tick(1);assert.equal(h.sockets.length,3);h.sockets[2].ready();assert.equal(h.states.at(-1).status,'connected');
});
test('recovery contract: unexpected task-finished recovers and stop cancels waiting retries and late callbacks',t=>{
  const h=recoveryFixture(t);h.sockets[0].finish();assert.equal(h.states.at(-1).status,'reconnecting');
  t.mock.timers.tick(1000);assert.equal(h.sockets.length,3);h.sockets[2].ready();h.sockets[2].lose();
  h.transcriber.stop();const count=h.states.length;t.mock.timers.tick(120000);h.sockets[1].sentence();h.sockets[2].ready();
  assert.equal(h.sockets.length,3);assert.equal(h.states.length,count);assert.equal(h.rows.length,0);assert.ok(h.sockets.every(s=>s.closed));
});
test('recovery contract: auth never auto retries and manual retry resets only failed track',t=>{
  const h=recoveryFixture(t);h.sockets[0].fail('InvalidApiKey');assert.equal(h.sockets[1].closed,false);
  assert.equal(h.states.at(-1).status,'disconnected');t.mock.timers.tick(120000);assert.equal(h.sockets.length,2);
  assert.equal(h.transcriber.retry(),true);assert.equal(h.sockets.length,3);assert.equal(h.sockets[1].closed,false);
  assert.equal(h.transcriber.retry(),false);h.sockets[2].ready();assert.equal(h.states.at(-1).status,'connected');
});
test('recovery contract: ready flapping spends a finite 1 2 4 8 16 second budget and preserves sample timeline',t=>{
  const h=recoveryFixture(t);h.transcriber.sendPcm('you',Buffer.alloc(32000));h.sockets[0].sentence();
  let failed=h.sockets[0];
  for(const [index,delay] of [1000,2000,4000,8000,16000].entries()){
    failed.lose();h.transcriber.sendPcm('you',Buffer.alloc(32000));
    t.mock.timers.tick(delay-1);assert.equal(h.sockets.length,index+2);t.mock.timers.tick(1);
    failed=h.sockets.at(-1);failed.ready();h.transcriber.sendPcm('you',Buffer.alloc(32000));failed.sentence();
  }
  failed.lose();t.mock.timers.tick(120000);assert.equal(h.sockets.length,7);assert.equal(h.states.at(-1).status,'disconnected');
  assert.equal(new Set(h.rows.map(r=>r.sentenceId)).size,6);assert.deepEqual(h.rows.map(r=>r.tStartMs),[0,2000,4000,6000,8000,10000]);
  assert.equal(h.sockets[1].closed,false);
});
test('recovery contract: thirty seconds of stable readiness resets the retry budget',t=>{
  const h=recoveryFixture(t);h.sockets[0].lose();t.mock.timers.tick(1000);h.sockets[2].ready();
  t.mock.timers.tick(30000);h.sockets[2].lose();t.mock.timers.tick(999);assert.equal(h.sockets.length,3);
  t.mock.timers.tick(1);assert.equal(h.sockets.length,4);
});

test('recovery diagnostics contain safe categories and own UUIDs while health and capture survive a broken event sink', t => {
  const h=recoveryFixture(t);
  h.sockets[0].fail('RequestTimeout','sensitive text sk-private https://private.example');
  const failure=h.events.find(e=>e.event==='failed');
  assert.equal(failure.category,'provider-timeout');assert.equal(failure.providerCode,'RequestTimeout');
  assert.match(failure.taskId,/^[a-f0-9-]{36}$/);assert.equal(failure.track,'you');
  assert.equal(JSON.stringify(h.events).includes('sensitive'),false);
  assert.equal(JSON.stringify(h.events).includes('sk-private'),false);
  assert.equal(h.states.at(-1).detail.tracks.other.status,'connected');
  assert.equal(h.states.at(-1).detail.tracks.you.retryDelayMs,1000);
  const server=socketServer();const second=createLiveTranscriber({apiKey:'fixture',connect:server.connect,
    onEvent(){throw Error('disk full')},onStatus(){},onSentence(){}});
  t.after(()=>second.stop());assert.doesNotThrow(()=>server.sockets[0].lose());
  assert.doesNotThrow(()=>second.sendPcm('you',Buffer.alloc(32000)));
});

test('readiness timeout recovers a stuck track without interrupting the ready track', t => {
  t.mock.timers.enable({apis:['setTimeout']});const server=socketServer(),states=[];
  const live=createLiveTranscriber({apiKey:'fixture',connect:server.connect,onSentence(){},onStatus:s=>states.push(s)});
  t.after(()=>live.stop());server.sockets[1].ready();t.mock.timers.tick(15000);
  assert.equal(server.sockets[1].closed,false);assert.equal(states.at(-1),'reconnecting');
  t.mock.timers.tick(1000);assert.equal(server.sockets.length,3);server.sockets[2].ready();assert.equal(states.at(-1),'connected');
});

for (const [code, message] of [
  ['Throttling.RateQuota', 'Too many requests'],
  ['Throttling', 'Request rate quota exceeded temporarily'],
]) test(`C1 contract: ${code} schedules a one-second retry only for the throttled track`, t => {
  const h = recoveryFixture(t);
  h.sockets[0].fail(code, message);
  assert.equal(h.states.at(-1).status, 'reconnecting');
  assert.equal(h.states.at(-1).detail.tracks.you.category, 'rate-limit');
  assert.equal(h.states.at(-1).detail.tracks.you.attempt, 1);
  assert.equal(h.sockets[1].closed, false);
  h.sockets[1].sentence(); assert.equal(h.rows.at(-1).track, 'other');
  const scheduled = h.events.filter(event => event.event === 'retry-scheduled');
  assert.equal(scheduled.length, 1); assert.equal(scheduled[0].retryDelayMs, 1000);
  t.mock.timers.tick(999); assert.equal(h.sockets.length, 2);
  t.mock.timers.tick(1); assert.equal(h.sockets.length, 3);
  h.sockets[2].ready(); assert.equal(h.states.at(-1).status, 'connected');
  assert.equal(h.sockets[1].closed, false);
});

test('C1 contract: insufficient balance with ambiguous rate words does not automatically retry', t => {
  const h = recoveryFixture(t);
  h.sockets[0].fail('InsufficientBalance', 'Account quota exhausted; rate limit request rejected');
  assert.equal(h.states.at(-1).status, 'disconnected');
  assert.equal(h.states.at(-1).detail.tracks.you.category, 'quota');
  assert.equal(h.states.at(-1).detail.tracks.you.attempt, 0);
  t.mock.timers.tick(120000); assert.equal(h.sockets.length, 2);
  assert.equal(h.events.some(event => event.event === 'retry-scheduled'), false);
  assert.equal(h.sockets[1].closed, false);
});

test('review contract: readiness lasting 29999 ms retains the next retry tier across the abandoned stability deadline', t => {
  const h = recoveryFixture(t);
  h.sockets[0].lose(); t.mock.timers.tick(1000); h.sockets[2].ready();
  t.mock.timers.tick(29999); h.sockets[2].lose();
  assert.equal(h.states.at(-1).detail.tracks.you.attempt, 2);
  assert.equal(h.states.at(-1).detail.tracks.you.retryDelayMs, 2000);
  // The old stability deadline is just one millisecond away; it must be canceled.
  t.mock.timers.tick(1); assert.equal(h.sockets.length, 3);
  t.mock.timers.tick(1998); assert.equal(h.sockets.length, 3);
  t.mock.timers.tick(1); assert.equal(h.sockets.length, 4);
  h.sockets[3].ready(); h.sockets[3].lose();
  assert.equal(h.states.at(-1).detail.tracks.you.attempt, 3);
  assert.equal(h.states.at(-1).detail.tracks.you.retryDelayMs, 4000);
  t.mock.timers.tick(3999); assert.equal(h.sockets.length, 4);
  t.mock.timers.tick(1); assert.equal(h.sockets.length, 5);
  assert.equal(h.sockets[1].closed, false);
});

test('review contract: staggered track budgets reset independently and manual recovery preserves another queued retry', t => {
  const h = recoveryFixture(t);
  h.sockets[0].lose(); t.mock.timers.tick(1000); h.sockets[2].ready();
  h.sockets[2].lose(); t.mock.timers.tick(2000); h.sockets[3].ready();
  h.sockets[3].lose(); // You now waits four seconds; other has never retried.
  h.sockets[1].lose();
  assert.equal(h.states.at(-1).detail.tracks.you.retryDelayMs, 4000);
  assert.equal(h.states.at(-1).detail.tracks.other.retryDelayMs, 1000);
  t.mock.timers.tick(999); assert.equal(h.sockets.length, 4);
  t.mock.timers.tick(1); assert.equal(h.sockets.length, 5); h.sockets[4].ready();
  // Other becomes stable at t=34s while you uses its remaining retry tiers.
  t.mock.timers.tick(3000); h.sockets[5].ready(); h.sockets[5].lose();
  assert.equal(h.states.at(-1).detail.tracks.you.retryDelayMs, 8000);
  t.mock.timers.tick(8000); h.sockets[6].ready(); h.sockets[6].lose();
  assert.equal(h.states.at(-1).detail.tracks.you.retryDelayMs, 16000);
  t.mock.timers.tick(16000); h.sockets[7].ready();
  t.mock.timers.tick(3000); // Other's full 30 seconds elapsed; you has only 3 seconds.
  assert.equal(h.states.at(-1).detail.tracks.other.attempt, 0);
  assert.equal(h.states.at(-1).detail.tracks.you.attempt, 5);
  h.sockets[7].lose(); assert.equal(h.states.at(-1).detail.tracks.you.status, 'disconnected');
  h.sockets[4].lose(); assert.equal(h.states.at(-1).detail.tracks.other.retryDelayMs, 1000);
  assert.equal(h.transcriber.retry(), true); assert.equal(h.sockets.length, 9);
  assert.equal(h.states.at(-1).detail.tracks.you.attempt, 0);
  assert.equal(h.states.at(-1).detail.tracks.other.attempt, 1);
  assert.equal(h.states.at(-1).detail.tracks.other.retryDelayMs, 1000);
  h.sockets[8].ready(); // Manual retry didn't cancel or accelerate the other track's wait.
  t.mock.timers.tick(999); assert.equal(h.sockets.length, 9);
  t.mock.timers.tick(1); assert.equal(h.sockets.length, 10); h.sockets[9].ready();
  assert.equal(h.states.at(-1).status, 'connected');
  h.sockets[8].lose(); assert.equal(h.states.at(-1).detail.tracks.you.retryDelayMs, 1000);
  assert.equal(h.sockets[9].closed, false);
  t.mock.timers.tick(999); assert.equal(h.sockets.length, 10);
  t.mock.timers.tick(1); assert.equal(h.sockets.length, 11);
});
