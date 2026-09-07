import assert from "node:assert/strict";
import { test } from "node:test";
import { MATCH_THRESHOLD, assignClusters, cosine } from "./match.ts";

function vec(...values) {
  return new Float32Array(values);
}

test("cosine is 1 for the same vector and 0 for orthogonal vectors", () => {
  assert.equal(cosine(vec(1, 0), vec(1, 0)), 1);
  assert.equal(cosine(vec(1, 0), vec(0, 1)), 0);
});

test("assignClusters names a cluster only when cosine meets the threshold", () => {
  const named = assignClusters({
    clusters: [
      { id: "小 A", embedding: vec(1, 0, 0) },
      { id: "小 B", embedding: vec(0.4, 0.9165, 0) },
    ],
    people: [{ name: "王明", embeddings: [vec(1, 0, 0)] }],
  });
  assert.equal(MATCH_THRESHOLD, 0.55);
  assert.deepEqual(
    named.map((row) => row.cluster),
    ["小 A"],
  );
  assert.equal(named[0].name, "王明");
  assert.ok(named[0].score > MATCH_THRESHOLD);
});

test("assignClusters gives a contested person to the higher-scoring cluster", () => {
  const named = assignClusters({
    clusters: [
      { id: "小 A", embedding: vec(0.9, 0.1, 0) },
      { id: "小 B", embedding: vec(1, 0, 0) },
    ],
    people: [{ name: "王明", embeddings: [vec(1, 0, 0)] }],
  });
  assert.deepEqual(named, [{ cluster: "小 B", name: "王明", score: 1 }]);
});

test("assignClusters names nothing when people is empty or the vector is zero", () => {
  assert.deepEqual(
    assignClusters({
      clusters: [{ id: "小 A", embedding: vec(1, 0, 0) }],
      people: [],
    }),
    [],
  );
  assert.deepEqual(
    assignClusters({
      clusters: [{ id: "小 A", embedding: vec(0, 0, 0) }],
      people: [{ name: "王明", embeddings: [vec(1, 0, 0)] }],
    }),
    [],
  );
});

test("cosine truncates to the shorter vector", () => {
  assert.equal(cosine(vec(1, 0, 99), vec(1, 0)), 1);
});

test("assignClusters uses the best of a person's embeddings", () => {
  const named = assignClusters({
    clusters: [{ id: "小 A", embedding: vec(0, 1, 0) }],
    people: [
      {
        name: "王明",
        embeddings: [vec(1, 0, 0), vec(0, 1, 0)],
      },
    ],
  });
  assert.equal(named[0].name, "王明");
  assert.equal(named[0].score, 1);
});
