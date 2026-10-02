/**
 * Shared browser client for server-verified scores (all three standalone games).
 *
 * The decision this module exists for: whether a finished run is worth
 * submitting at all. `/api/games/scores` already refuses anything that does not
 * beat the stored row, but a client that posts every run burns the per-IP rate
 * limit, writes a 202 the player learns nothing from, and — for an account —
 * answers a question the server can answer better. So the client asks
 * `/api/games/scores/my` first and only posts a run that `beatsBest` says wins.
 *
 * Two rules are load-bearing and easy to break:
 *
 *   1. `beatsBest` mirrors `insertValidatedScore`'s upsert comparison exactly
 *      (higher score wins; equal score needs a strictly better tie-break, with
 *      SQL's `COALESCE(tie_break, 1000000001)` ordering: a missing tie-break is
 *      the worst possible one). If the two ever disagree, a run is either
 *      submitted pointlessly or silently dropped.
 *   2. An UNREADABLE standing submits NOTHING. \"I could not check\" is not
 *      \"nothing to beat\": posting on a failed read is how a stale device
 *      overwrites... nothing, since the server re-checks — but it does burn the
 *      limiter and produces a duplicate claim. So a failed read is a skip, and
 *      the manual claim form stays the visible fallback.
 *
 * Idempotency keys are stable per RUN, not per attempt: a run that is claimed
 * by hand after a failed automatic submit reuses the same key, so the retry is
 * recognised as the same submission (`409 duplicate_submission` at worst)
 * instead of writing a second row.
 */

/** SQL orders `COALESCE(tie_break, ?)` ascending; a null tie-break is the worst value. */
export const UNRANKED_TIE_BREAK = 1_000_000_001;

export type BestScore = { score: number; tieBreak: number | null; achievedAt?: number };
export type Standing = { scope: 'account' | 'guest'; best: BestScore | null; rank: number | null; entries: number };

export type StandingResult = { ok: true; standing: Standing } | { ok: false; reason: 'unreachable' | 'rejected' | 'malformed' };
export type AccountState = { authenticated: boolean; displayName?: string; handle?: string | null };

/** Turn any tie-break value into the number the ordering actually compares. */
export function tieBreakRank(value: number | null | undefined): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : UNRANKED_TIE_BREAK;
}

/**
 * Would this run replace the stored best? Exactly the comparison in
 * `insertValidatedScore`'s `ON CONFLICT … WHERE` clause, over the best score
 * the caller's identity owns (`best === null` means nothing to beat).
 */
export function beatsBest(candidate: { score: number; tieBreak: number | null }, best: BestScore | null): boolean {
	if (!best) return true;
	if (candidate.score > best.score) return true;
	if (candidate.score < best.score) return false;
	return tieBreakRank(candidate.tieBreak) < tieBreakRank(best.tieBreak);
}

/** 22 URL-safe characters from 16 random bytes, short enough for `stk-`/`msw-`/`che-` prefixes. */
export function createRunToken(): string {
	const bytes = new Uint8Array(16);
	try { crypto.getRandomValues(bytes); }
	catch {
		for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
	}
	return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const base = typeof btoa === 'function'
		? btoa(binary)
		: (globalThis as unknown as { Buffer: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer.from(bytes).toString('base64');
	return base.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Stable key for one finished run. Prefix per game keeps a key collision across
 * games from being mistaken for an idempotency conflict (the server rejects a
 * reused key used for a different game/mode).
 */
export function idempotencyKey(prefix: 'stk' | 'msw' | 'che', token: string): string {
	return `${prefix}-${token}`;
}

export type SubmitOutcome =
	| { kind: 'stored'; score: number; tieBreak: number | null; message: string }
	| { kind: 'not-best' }
	| { kind: 'duplicate' }
	| { kind: 'rejected'; status: number; error: string; message: string }
	| { kind: 'unreachable' };

export type SubmitRun = {
	gameId: string;
	mode: string;
	score: number;
	tieBreak: number | null;
	proof: unknown;
	idempotencyKey: string;
	/**
	 * Claimed name. An account's row is credited to the account's own display
	 * name server-side (this value is discarded); a guest's row keeps it, which
	 * is why the automatic path refuses guests unless the caller has a name.
	 */
	displayName?: string;
};

function statusMessage(status: number, error: string, score: number): { message: string; kind: 'duplicate' | 'rejected' | 'unreachable' } {
	if (status === 409) return { message: 'This run was already submitted.', kind: 'duplicate' };
	if (status === 403) return { message: 'Score submissions must come from this page.', kind: 'rejected' };
	if (status === 429) return { message: 'Too many claims right now — try again shortly.', kind: 'rejected' };
	if (status === 422) return { message: 'The run could not be verified — replay it and claim again.', kind: 'rejected' };
	if (status === 401) return { message: 'Sign in again to claim this run.', kind: 'rejected' };
	if (status === 503) return { message: 'The leaderboard is briefly unavailable. Try again in a moment.', kind: 'unreachable' };
	return { message: `Could not submit score ${score.toLocaleString()} (${error || 'request_failed'}).`, kind: 'rejected' };
}

/**
 * POST one run to the score route. The callers keep their own claim flows; the
 * only shared knowledge is the exact body shape the route accepts.
 */
export async function submitRun(run: SubmitRun, fetchImpl: typeof fetch = fetch): Promise<SubmitOutcome> {
	let response: Response;
	try {
		response = await fetchImpl('/api/games/scores', {
			method: 'POST', credentials: 'same-origin', cache: 'no-store',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				gameId: run.gameId, mode: run.mode, score: run.score, tieBreak: run.tieBreak,
				displayName: run.displayName ?? 'public', idempotencyKey: run.idempotencyKey, proof: run.proof,
			}),
		});
	} catch {
		return { kind: 'unreachable' };
	}
	let body: { score?: number; tieBreak?: number | null; error?: string } = {};
	try { body = await response.json() as typeof body; } catch { /* status carries the meaning */ }
	if (response.status === 201 || response.status === 202) {
		if (response.status === 202) return { kind: 'not-best' };
		const score = Number(body.score ?? run.score);
		return { kind: 'stored', score, tieBreak: body.tieBreak ?? run.tieBreak, message: `Score recorded: ${score.toLocaleString()}.` };
	}
	const mapped = statusMessage(response.status, body.error ?? '', run.score);
	if (mapped.kind === 'duplicate') return { kind: 'duplicate' };
	if (mapped.kind === 'unreachable') return { kind: 'unreachable' };
	return { kind: 'rejected', status: response.status, error: body.error ?? '', message: mapped.message };
}

/* ------------------------------------------------------------------- reads */

const standingCache = new Map<string, Standing>();
let accountPromise: Promise<AccountState> | null = null;

/** Cached `/api/games/account` read; failures degrade to \"guest\", never throw. */
export function readAccount(fetchImpl: typeof fetch = fetch): Promise<AccountState> {
	accountPromise ??= fetchImpl('/api/games/account', { credentials: 'same-origin', cache: 'no-store' })
		.then((response) => (response.ok ? response.json() as Promise<AccountState> : { authenticated: false }))
		.catch(() => ({ authenticated: false }))
		.then((account) => (account && typeof account.authenticated === 'boolean' ? account : { authenticated: false }));
	return accountPromise;
}

/** A fresh read every time (the caller decides when to cache); `null` on any failure. */
export async function readStanding(gameId: string, mode: string, fetchImpl: typeof fetch = fetch): Promise<StandingResult> {
	let response: Response;
	try {
		response = await fetchImpl(`/api/games/scores/my?gameId=${encodeURIComponent(gameId)}&mode=${encodeURIComponent(mode)}`, {
			credentials: 'same-origin', cache: 'no-store',
		});
	} catch {
		return { ok: false, reason: 'unreachable' };
	}
	if (!response.ok) return { ok: false, reason: 'rejected' };
	let body: Partial<Standing> & { error?: string };
	try { body = await response.json() as Partial<Standing> & { error?: string }; }
	catch { return { ok: false, reason: 'malformed' }; }
	if (body.error || (body.scope !== 'account' && body.scope !== 'guest') || !Number.isSafeInteger(body.entries)) return { ok: false, reason: 'malformed' };
	const best = body.best && typeof body.best.score === 'number'
		? { score: body.best.score, tieBreak: typeof body.best.tieBreak === 'number' ? body.best.tieBreak : null, achievedAt: body.best.achievedAt }
		: null;
	const standing: Standing = { scope: body.scope, best, rank: typeof body.rank === 'number' ? body.rank : null, entries: Number(body.entries) };
	standingCache.set(`${gameId}:${mode}`, standing);
	return { ok: true, standing };
}

/**
 * Drop the memoised account read and standings. Used by tests and by an
 * embedding surface that signs a player in without a page load — the cache is
 * otherwise correct for the lifetime of a document.
 */
export function resetGameScoresCache(): void {
	standingCache.clear();
	accountPromise = null;
}

/** Last successfully read standing for a board, if any (used to render a rank without a request). */
export function cachedStanding(gameId: string, mode: string): Standing | null {
	return standingCache.get(`${gameId}:${mode}`) ?? null;
}

export type AutoSubmitOutcome =
	| { submitted: true; outcome: SubmitOutcome }
	| { submitted: false; reason: 'not_best' | 'standing_unreadable' | 'guest' };

/**
 * The automatic path: read the standing, and only post a run that beats it.
 *
 * Guests are NOT auto-submitted: the score route stores the display name sent
 * with the claim, and a guest has never typed one at game-over time. Their
 * claim form remains the way to enter the board (and it uses the run's key, so
 * a claim after an automatic attempt is still the same submission).
 */
export async function autoSubmitRun(
	run: SubmitRun,
	options: { fetchImpl?: typeof fetch; allowGuest?: boolean } = {},
): Promise<AutoSubmitOutcome> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const standing = await readStanding(run.gameId, run.mode, fetchImpl);
	if (!standing.ok) return { submitted: false, reason: 'standing_unreadable' };
	if (standing.standing.scope === 'guest' && !options.allowGuest) return { submitted: false, reason: 'guest' };
	// A signed-in player's name is already on the account; supplying it here keeps
	// the request honest for a hypothetical account-less caller with a name.
	if (!run.displayName) {
		const account = await readAccount(fetchImpl);
		if (account.authenticated && account.displayName) run = { ...run, displayName: account.displayName };
	}
	if (!beatsBest({ score: run.score, tieBreak: run.tieBreak }, standing.standing.best)) return { submitted: false, reason: 'not_best' };
	return { submitted: true, outcome: await submitRun(run, fetchImpl) };
}

/**
 * Attested-increment path (PvP wins): the server owns the number, so there is
 * nothing for the client to compare. Order matters — resolve the display name
 * the account will be credited under, POST the attested win, THEN refresh the
 * standing so a rank shown next is not pre-win.
 */
export async function submitAttestedWin(
	run: Omit<SubmitRun, 'score' | 'tieBreak'>,
	options: { fetchImpl?: typeof fetch } = {},
): Promise<{ name: string | null; outcome: SubmitOutcome; standing: StandingResult }> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const account = await readAccount(fetchImpl);
	const name = account.authenticated ? account.displayName ?? null : null;
	const outcome = await submitRun({ ...run, score: 0, tieBreak: null }, fetchImpl);
	const standing = await readStanding(run.gameId, run.mode, fetchImpl);
	return { name, outcome, standing };
}
