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

test("manual reconnect retains this recording timeline and repeated sentence ids cannot replace earlier text", () => {
  const server = socketServer();
  const buffer = createLiveBuffer();
  const states = [];
  const transcriber = createLiveTranscriber({ apiKey: "fixture", connect: server.connect,
    onSentence: (track, sentence) => buffer.apply(track, sentence),
    onStatus: status => states.push(status),
  });
  transcriber.sendPcm("you", Buffer.alloc(32000));
  server.sockets.forEach(socket => socket.ready());
  server.sockets[0].sentence("before loss");
  server.sockets[0].lose();
  transcriber.sendPcm("you", Buffer.alloc(32000 * 5));
  assert.equal(transcriber.retry(), true);
  assert.equal(transcriber.retry(), false);
  transcriber.sendPcm("you", Buffer.alloc(32000));
  server.sockets.slice(2).forEach(socket => socket.ready());
  server.sockets[0].sentence("stale");
  server.sockets[1].lose();
  server.sockets[2].sentence("after reconnect");
  assert.deepEqual(buffer.turns().map(row => [row.text, row.tStartMs]), [["before loss", 0], ["after reconnect", 6000]]);
  assert.equal(new Set(buffer.turns().map(row => row.id)).size, 2);
  assert.deepEqual(states, ["connecting", "connected", "disconnected", "reconnecting", "connected"]);
  transcriber.stop();
});

test("failed reconnect can retry again, and stopping during reconnect releases both sockets", () => {
  const server = socketServer();
  const rows = [];
  const states = [];
  let refuse = false;
  const transcriber = createLiveTranscriber({ apiKey: "fixture",
    connect: (...args) => { if (refuse) throw new Error("offline"); return server.connect(...args); },
    onSentence: (_track, row) => rows.push(row), onStatus: status => states.push(status),
  });
  server.sockets.forEach(socket => socket.ready());
  server.sockets[1].lose();
  refuse = true;
  transcriber.retry();
  assert.equal(states.at(-1), "disconnected");
  refuse = false;
  assert.equal(transcriber.retry(), true);
  transcriber.stop();
  const prior = [...states];
  server.sockets.slice(2).forEach(socket => { socket.ready(); socket.sentence("late"); socket.lose(); });
  assert.deepEqual(states, prior);
  assert.deepEqual(rows, []);
  assert.ok(server.sockets.every(socket => socket.closed));
  assert.equal(transcriber.retry(), false);
});

test("both tracks must become ready and reconnect retains each track's actual sample clock", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const server = socketServer(), buffer = createLiveBuffer(), states = [];
  const transcriber = createLiveTranscriber({ apiKey: "fixture", connect: server.connect,
    onSentence: (track, sentence) => buffer.apply(track, sentence), onStatus: state => states.push(state) });
  t.after(() => transcriber.stop());
  server.sockets[0].ready(); server.sockets[0].ready();
  assert.deepEqual(states, ["connecting"]);
  server.sockets[1].ready();
  assert.equal(states.at(-1), "connected");
  t.mock.timers.tick(15001);
  assert.equal(states.at(-1), "connected"); // Silence is not disconnection.
  transcriber.sendPcm("you", Buffer.alloc(32000));
  transcriber.sendPcm("other", Buffer.alloc(64000));
  server.sockets[0].sentence("mic before"); server.sockets[1].sentence("system before");
  server.sockets[0].lose();
  transcriber.sendPcm("you", Buffer.alloc(96000));
  transcriber.sendPcm("other", Buffer.alloc(160000));
  transcriber.retry();
  transcriber.sendPcm("you", Buffer.alloc(32000));
  transcriber.sendPcm("other", Buffer.alloc(32000));
  server.sockets[3].ready();
  assert.equal(states.at(-1), "reconnecting");
  server.sockets[2].ready();
  server.sockets[3].sentence("system after"); server.sockets[2].sentence("mic after");
  assert.deepEqual(buffer.turns().map(t => [t.track, t.tStartMs, t.text]), [
    ["you", 0, "mic before"], ["other", 0, "system before"],
    ["you", 4000, "mic after"], ["other", 7000, "system after"],
  ]);
  assert.equal(new Set(buffer.turns().map(t => t.id)).size, 4);
});

test("second socket construction failure closes the first and permits a clean retry", () => {
  const server = socketServer(), states = [];
  let attempts = 0;
  const transcriber = createLiveTranscriber({ apiKey: "fixture",
    connect: () => { if (++attempts === 2) throw Error("second connection refused"); return server.connect(); },
    onSentence() {}, onStatus: s => states.push(s) });
  assert.equal(server.sockets[0].closed, true);
  assert.deepEqual(states, ["connecting", "disconnected"]);
  transcriber.retry();
  server.sockets.slice(1).forEach(s => s.ready());
  assert.equal(states.at(-1), "connected");
  transcriber.stop();
  assert.ok(server.sockets.every(s => s.closed));
});
