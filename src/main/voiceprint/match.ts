// 0.55 is the cosine gate for CAM++ 192-d embeddings.
// Calibrated 2026-08-19 on sherpa sr-data 3d-speaker Chinese wavs
// (speaker1_a vs speaker1_b ≈ 0.59, speaker1_a vs speaker2_a ≈ -0.08).
// Official sherpa examples often use 0.6; that would miss this same-speaker pair.
export const MATCH_THRESHOLD = 0.55;

export type ClusterEmbedding = { id: string; embedding: Float32Array; samples?: Float32Array[] };
export type PersonEmbeddings = { id?: string; name: string; embeddings: Float32Array[] };
export type ClusterAssignment = { cluster: string; name: string; personId?: string; score: number };

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  const n = a.length;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
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
  margin?: number;
}): ClusterAssignment[] {
  const threshold = opts.threshold ?? MATCH_THRESHOLD;
  const out: ClusterAssignment[] = [];
  for (const cluster of opts.clusters) {
    const samples = cluster.samples ?? [cluster.embedding];
    if (!samples.length) continue;
    const votes = samples.map(sample => {
      const candidates = opts.people.map(person => ({ person,
        score: Math.max(0, ...person.embeddings.map(template => cosine(sample, template))),
      })).sort((a, b) => b.score - a.score);
      const best = candidates[0];
      // Conservative initial margin; tune only on held-out meeting recordings.
      if (!best || best.score < threshold || best.score - (candidates[1]?.score ?? 0) < (opts.margin ?? 0.1)) return null;
      return best;
    });
    const first = votes[0];
    if (!first || votes.some(vote => !vote || vote.person !== first.person)) continue;
    if (out.some(row => row.cluster === cluster.id)) continue;
    out.push({ cluster: cluster.id, name: first.person.name,
      ...(first.person.id ? { personId: first.person.id } : {}),
      score: Math.min(...votes.map(vote => vote!.score)) });
  }
  return out.sort((a, b) => b.score - a.score);
}
