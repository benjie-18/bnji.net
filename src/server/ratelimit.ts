/**
 * BNJI.NET — tiny in-isolate rate limiter.
 *
 * A sliding-window counter per client key (IP). Lives in module scope, so it
 * is per-Worker-isolate: good enough to stop casual abuse and runaway loops,
 * and honest about being so. For strict global limits, put a Cloudflare
 * rate-limiting rule in front of /api/* — that is an edge configuration, not
 * application code.
 *
 * No secrets, no credentials: keys are hashed client addresses only, and the
 * map is capped and pruned so it cannot grow without bound.
 */
type Bucket = { stamps: number[] };

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 2000;

/**
 * @param key      client identity (e.g. Astro.clientAddress)
 * @param windowMs sliding window size
 * @param maxHits  allowed hits inside the window
 * @returns true when the hit is allowed (and recorded)
 */
export function rateLimit(key: string, windowMs: number, maxHits: number): boolean {
	const now = Date.now();
	let bucket = buckets.get(key);
	if (!bucket) {
		if (buckets.size > MAX_KEYS) {
			// Prune stale keys instead of unbounded growth.
			for (const [k, b] of buckets) {
				if (b.stamps.length === 0 || now - b.stamps[b.stamps.length - 1] > windowMs) {
					buckets.delete(k);
				}
			}
		}
		bucket = { stamps: [] };
		buckets.set(key, bucket);
	}
	bucket.stamps = bucket.stamps.filter((t) => now - t < windowMs);
	if (bucket.stamps.length >= maxHits) return false;
	bucket.stamps.push(now);
	return true;
}

/** Seconds until the oldest stamp in the window expires (for Retry-After). */
export function retryAfterSeconds(key: string, windowMs: number): number {
	const bucket = buckets.get(key);
	if (!bucket || bucket.stamps.length === 0) return 0;
	const oldest = bucket.stamps[0];
	return Math.max(1, Math.ceil((windowMs - (Date.now() - oldest)) / 1000));
}
