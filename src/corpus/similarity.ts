/**
 * Token similarity.
 *
 * Drives two things: which product answers an instruction (pairing), and how
 * near a miss the hard tier is. The catalogue has 739 distinct brands across
 * 804 products, so "same brand, adjacent variant" is rarely available;
 * name-token similarity is the near-miss measure instead, and it is defined
 * for every product.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'to', 'i', 'am',
  'is', 'my', 'me', 'looking', 'need', 'want', 'would', 'like', 'get', 'buy',
  'that', 'are', 'be', 'it', 'this', 'some',
]);

export function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Jaccard overlap in [0, 1]. 0 when either side has no usable tokens. */
export function similarity(a: string, b: string): number {
  const A = new Set(tokenise(a));
  const B = new Set(tokenise(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
