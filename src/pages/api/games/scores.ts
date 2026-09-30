/** Fail-closed score submission contract. Scores are persisted only after a registered server verifier accepts a run. */
import type { APIContext } from 'astro';
import { getGame, isValidGameMode } from '../../../data/games';
import { clientIp } from '../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import { readBodyTextBounded } from '../../../server/read-body';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext, type PlayerContext } from '../../../server/player-context';
import { insertValidatedScore, type D1Database } from '../../../server/game-store';
import { getScoreVerifier } from '../../../server/score-verifiers';
import { serverEnvironment } from '../../../server/env';

export const prerender = false;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 8;
const SCORE_FIELDS = new Set(['gameId', 'mode', 'score', 'tieBreak', 'displayName', 'idempotencyKey', 'proof']);
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}

function json(data: unknown, status: number, player?: PlayerContext): Response {
	const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	if (player) appendPlayerCookies(headers, player);
	return new Response(JSON.stringify(data), { status, headers });
}

function validInteger(value: unknown, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export async function POST(context: APIContext): Promise<Response> {
	if (!sameOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	let player: PlayerContext;
	try { player = await resolvePlayerContext(context.request, db); }
	catch (error) { return json({ error: error instanceof PlayerContextStorageError ? 'storage_unavailable' : 'storage_unavailable' }, 503); }
	const text = await readBodyTextBounded(context.request, 2048);
	if (text === null) return json({ error: 'payload_too_large' }, 413, player);
	let parsed: unknown;
	try { parsed = JSON.parse(text || '{}'); } catch { return json({ error: 'invalid_json' }, 400, player); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'invalid_payload' }, 400, player);
	const body = parsed as Record<string, unknown>;
	if (Object.keys(body).length !== SCORE_FIELDS.size || Object.keys(body).some((key) => !SCORE_FIELDS.has(key))) return json({ error: 'invalid_payload' }, 400, player);
	const gameId = typeof body.gameId === 'string' ? body.gameId : '';
	const modeId = body.mode;
	const game = getGame(gameId);
	if (!game || game.status !== 'available') return json({ error: 'unknown_game' }, 404, player);
	if (!isValidGameMode(modeId) || !(game.modes ?? ['default']).includes(modeId)) return json({ error: 'invalid_mode' }, 400, player);
	if (!validInteger(body.score, 1_000_000_000) || (body.tieBreak !== null && !validInteger(body.tieBreak, 1_000_000_000))) {
		return json({ error: 'invalid_score' }, 400, player);
	}
	let displayName = typeof body.displayName === 'string' ? body.displayName.trim().replace(/\s+/gu, ' ') : '';
	if (!displayName || [...displayName].length > 24 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
		return json({ error: 'invalid_display_name' }, 400, player);
	}
	if (player.playerId && db) {
		try {
			const identity = await db.prepare('SELECT display_name FROM game_players WHERE id = ?1 LIMIT 1').bind(player.playerId).first<{ display_name: string }>();
			if (!identity) return json({ error: 'authentication_required' }, 401, player);
			displayName = identity.display_name;
		} catch { return json({ error: 'storage_unavailable' }, 503, player); }
	}
	const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(idempotencyKey)) return json({ error: 'invalid_idempotency_key' }, 400, player);

	const rate = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `game-score:${clientIp(context.request)}`, RATE_WINDOW_MS, RATE_MAX_HITS);
	if (!rate.allowed) return json({ error: 'rate_limited', retryAfter: rate.retryAfter }, 429, player);

	const verifier = getScoreVerifier(gameId);
	if (!verifier) return json({ error: 'verifier_unavailable' }, 503, player);
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unavailable' }, 503, player);

	const claim = {
		gameId,
		modeId,
		score: body.score,
		tieBreak: body.tieBreak as number | null,
		displayName,
		idempotencyKey,
		proof: body.proof,
	};
	try {
		const verified = await verifier(claim, { sessionId: player.sessionId, playerId: player.playerId });
		if (!verified || !validInteger(verified.score, 1_000_000_000) || (verified.tieBreak !== null && !validInteger(verified.tieBreak, 1_000_000_000))) {
			return json({ error: 'score_rejected' }, 422, player);
		}
		const outcome = await insertValidatedScore(db, {
			gameId,
			modeId,
			score: verified.score,
			tieBreak: verified.tieBreak,
			achievedAt: Date.now(),
			sessionId: player.sessionId,
			playerId: player.playerId,
			displayName,
			idempotencyKey,
		});
		if (outcome === 'duplicate') return json({ ok: true, duplicate: true }, 200, player);
		if (outcome === 'not-best') return json({ ok: true, leaderboardEligible: false, reason: 'not_a_personal_or_top_500_best' }, 202, player);
		return json({ ok: true, score: verified.score, tieBreak: verified.tieBreak }, 201, player);
	} catch (error) {
		const message = error instanceof Error ? error.message : '';
		if (message === 'idempotency_key_conflict' || message.includes('UNIQUE constraint failed: game_scores.session_id, game_scores.idempotency_key')) {
			return json({ error: 'duplicate_submission' }, 409, player);
		}
		return json({ error: 'storage_unavailable' }, 503, player);
	}
}
