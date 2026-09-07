// 0.55 is the cosine gate for CAM++ 192-d embeddings.
// Calibrated 2026-08-19 on sherpa sr-data 3d-speaker Chinese wavs
// (speaker1_a vs speaker1_b ≈ 0.59, speaker1_a vs speaker2_a ≈ -0.08).
// Official sherpa examples often use 0.6; that would miss this same-speaker pair.
export const MATCH_THRESHOLD = 0.55;

export type ClusterEmbedding = { id: string; embedding: Float32Array };
export type PersonEmbeddings = { name: string; embeddings: Float32Array[] };
export type ClusterAssignment = { cluster: string; name: string; score: number };

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

export function assignClusters(opts: {
  clusters: ClusterEmbedding[];
  people: PersonEmbeddings[];
  threshold?: number;
}): ClusterAssignment[] {
  const threshold = opts.threshold ?? MATCH_THRESHOLD;
  const candidates: ClusterAssignment[] = [];
  for (const cluster of opts.clusters) {
    let best: ClusterAssignment | null = null;
    for (const person of opts.people) {
      let score = 0;
      for (const embedding of person.embeddings) {
        score = Math.max(score, cosine(cluster.embedding, embedding));
      }
      if (score >= threshold && (!best || score > best.score)) {
        best = { cluster: cluster.id, name: person.name, score };
      }
    }
    if (best) candidates.push(best);
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedCluster = new Set<string>();
  const usedName = new Set<string>();
  const out: ClusterAssignment[] = [];
  for (const row of candidates) {
    if (usedCluster.has(row.cluster) || usedName.has(row.name)) continue;
    usedCluster.add(row.cluster);
    usedName.add(row.name);
    out.push(row);
  }
  return out;
}
