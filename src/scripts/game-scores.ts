/**
 * Automatic leaderboard submission for one game.
 *
 * The rule: when a finished run beats the player's own stored best, it is
 * submitted without asking. "Own stored best" is read from the server, never
 * from this browser, because a leaderboard row and a localStorage number disagree
 * the moment a player opens a second device — and a wrong comparison either
 * spams the API with runs it will refuse, or silently keeps a real record off
 * the board.
 *
 * What stays fail-closed:
 *   - nothing is submitted for a guest who has never chosen a display name: the
 *     board would show a meaningless label, so the manual claim stays visible and
 *     says why;
 *   - the server still decides (its own personal-best upsert runs after the game
 *     verifier replays the proof), so a client that lies about `beats` cannot
 *     overwrite a better row;
 *   - a rejected, rate-limited or unreachable submission is surfaced, and the
 *     caller re-shows the manual claim with the same idempotency key — so a
 *     retry can never double-count an attested win.
 */

export type PersonalBest = { score: number; tieBreak: number | null; achievedAt?: number } | null;

export type ClaimCandidate = {
	mode: string;
	score: number;
	tieBreak: number | null;
	proof: unknown;
	/** Stable per-attempt key: retries reuse it, so a win is counted at most once. */
	idempotencyKey: string;
	/** Attested per-round wins: the server increments, so a personal-best test would be wrong. */
	attestedIncrement?: boolean;
};

export type ClaimOutcome =
	| { kind: 'recorded'; score: number }
	| { kind: 'not-best' }
	| { kind: 'duplicate' }
	| { kind: 'unnamed' }
	| { kind: 'unverifiable' }
	| { kind: 'rate-limited'; retryAfter: number }
	| { kind: 'unavailable' };

/** `null` standing means "could not be read", which is not the same as "no best yet". */
export type Standing = { best: PersonalBest; rank: number | null; entries: number } | null;

const UNRANKED_TIE_BREAK = 1_000_000_001;

/**
 * True when `candidate` would replace `best` under the SAME comparison the
 * `game_scores` upsert applies: a higher score, or an equal score with a
 * strictly lower (better) tie-break. Kept as a pure function so the route and
 * the client can be tested against one another.
 */
export function beatsBest(best: PersonalBest, candidate: { score: number; tieBreak: number | null }): boolean {
	if (!best) return candidate.score > 0;
	if (candidate.score !== best.score) return candidate.score > best.score;
	const next = candidate.tieBreak ?? UNRANKED_TIE_BREAK;
	const stored = best.tieBreak ?? UNRANKED_TIE_BREAK;
	return next < stored;
}

async function readJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> } | null> {
	try {
		const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		return { status: response.status, body };
	} catch {
		return null;
	}
}

/** A counter the API reports, or `null` when it is absent or not a number. */
function positiveNumber(value: unknown): number | null {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export type ScoreClaims = ReturnType<typeof createScoreClaims>;

export function createScoreClaims(gameId: string) {
	let namePromise: Promise<string | null> | null = null;
	let cachedName: string | null | undefined;
	const standings = new Map<string, Standing>();

	/** The label the player already owns: account name when signed in, guest name otherwise. */
	async function displayName(): Promise<string | null> {
		if (cachedName !== undefined) return cachedName;
		namePromise ??= (async () => {
			const result = await readJson('/api/profile/name');
			const value = result?.body.displayName;
			return typeof value === 'string' && value.trim() ? value.trim() : null;
		})();
		cachedName = await namePromise;
		return cachedName;
	}

	async function standing(mode: string, options: { refresh?: boolean } = {}): Promise<Standing> {
		if (!options.refresh && standings.has(mode)) return standings.get(mode) ?? null;
		const result = await readJson(`/api/games/scores/my?${new URLSearchParams({ gameId, mode }).toString()}`);
		const body = result?.status === 200 ? result.body : null;
		const raw = body?.best;
		const best = raw && typeof raw === 'object' ? (raw as { score?: unknown; tieBreak?: unknown }) : null;
		const value: Standing = best && Number.isFinite(Number(best.score))
			? {
					best: {
						score: Number(best.score),
						tieBreak: best.tieBreak === null || best.tieBreak === undefined ? null : Number(best.tieBreak),
					},
					rank: positiveNumber(body?.rank),
					entries: positiveNumber(body?.entries) ?? 0,
				}
				: body
					? { best: null, rank: null, entries: 0 }
					: null;
		standings.set(mode, value);
		return value;
	}

	/**
	 * Give the player a name, then submit. A guest with no stored name is the one
	 * case where a claim cannot be automatic — the board would otherwise print a
	 * label nobody chose — so a game that collects a name by hand can hand it
	 * back here: it becomes the profile name, and every later run submits itself.
	 */
	async function adoptName(name: string): Promise<boolean> {
		const trimmed = name.trim();
		if (!trimmed) return false;
		const result = await readJson('/api/profile/name', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ displayName: trimmed }),
		});
		if (!result || result.status >= 400) return false;
		const stored = result.body.displayName;
		if (typeof stored !== 'string' || !stored.trim()) return false;
		cachedName = stored.trim();
		return true;
	}

	/**
	 * One finished run, one decision, one request. Returns the outcome so the
	 * caller can say something true in its status line — including `unnamed`,
	 * which is the caller's cue to show the manual claim instead.
	 */
	async function submit(candidate: ClaimCandidate): Promise<ClaimOutcome> {
		const name = await displayName();
		if (!name) return { kind: 'unnamed' };
		if (!candidate.attestedIncrement) {
			const current = await standing(candidate.mode);
			// A standing we could not read must not become a silent "no best yet"
			// — submitting every run into a rate limit is the worse failure.
			if (!current) return { kind: 'unavailable' };
			if (!beatsBest(current.best, candidate)) return { kind: 'not-best' };
		}
		const result = await readJson('/api/games/scores', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				gameId,
				mode: candidate.mode,
				score: candidate.score,
				tieBreak: candidate.tieBreak,
				displayName: name,
				idempotencyKey: candidate.idempotencyKey,
				proof: candidate.proof,
			}),
		});
		if (!result) return { kind: 'unavailable' };
		if (result.status === 201) {
			void standing(candidate.mode, { refresh: true });
			return { kind: 'recorded', score: Number(result.body.score ?? candidate.score) };
		}
		if (result.status === 200 && result.body.duplicate === true) return { kind: 'duplicate' };
		if (result.status === 202) return { kind: 'not-best' };
		if (result.status === 429) return { kind: 'rate-limited', retryAfter: Number(result.body.retryAfter ?? 60) };
		if (result.status === 422) return { kind: 'unverifiable' };
		return { kind: 'unavailable' };
	}

	return { displayName, standing, submit, adoptName };
}

/**
 * Plain-language outcome copy, shared by every game that auto-submits.
 * `null` means "say nothing": a run that is not a personal best was never a
 * candidate the player asked about, and announcing it would be noise. The
 * recorded case is left to the caller, which knows the game's units.
 */
export function outcomeMessage(outcome: ClaimOutcome): string | null {
	switch (outcome.kind) {
		case 'recorded': return null;
		case 'not-best': return null;
		case 'duplicate': return 'Already on the board — this run was submitted before.';
		case 'unnamed': return 'Save a display name once and every new personal best is submitted automatically.';
		case 'unverifiable': return 'The server could not verify this run, so it was not submitted.';
		case 'rate-limited': return 'Too many submissions right now — claim it again in a minute.';
		default: return 'Could not reach the leaderboard. You can still claim this run by hand.';
	}
}
