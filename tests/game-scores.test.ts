/**
 * The shared score client (`src/scripts/game-scores.ts`).
 *
 * Two things here are load-bearing and easy to get subtly wrong:
 *   - `beatsBest` must mirror `insertValidatedScore`'s upsert comparison. If the
 *     two disagree, a run is either posted pointlessly (202) or silently never
 *     submitted.
 *   - an UNREADABLE standing must submit nothing. \"I could not check\" is not
 *     \"nothing to beat\".
 *
 * The rest of the file pins the request shape the route accepts and the
 * attested-increment ordering (name → POST → standing refresh) that PvP wins
 * depend on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	autoSubmitRun, beatsBest, createRunToken, idempotencyKey, readStanding, resetGameScoresCache,
	submitAttestedWin, submitRun, tieBreakRank, UNRANKED_TIE_BREAK,
} from '../src/scripts/game-scores';

type Call = { url: string; init: RequestInit | undefined };
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init });
		return handler(url, init);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}
const standingBody = (body: Record<string, unknown>) => ({ gameId: 'bnji.isometric-stack', mode: 'default', scope: 'account', best: null, rank: null, entries: 0, ...body });

test.beforeEach(() => resetGameScoresCache());

test('beatsBest mirrors the SQL upsert: the higher score always wins', () => {
	assert.equal(beatsBest({ score: 12, tieBreak: 400 }, { score: 11, tieBreak: 1 }), true);
	assert.equal(beatsBest({ score: 11, tieBreak: 1 }, { score: 12, tieBreak: 400 }), false);
	assert.equal(beatsBest({ score: 11, tieBreak: 1 }, null), true);
});

test('beatsBest needs a STRICTLY better tie-break on an equal score', () => {
	// The upsert's WHERE clause is `... < COALESCE(stored, ?)`: equal tie-breaks
	// do not replace the row, so an equal score with an equal tie-break is not a
	// winning run.
	assert.equal(beatsBest({ score: 40, tieBreak: 9 }, { score: 40, tieBreak: 9 }), false);
	assert.equal(beatsBest({ score: 40, tieBreak: 8 }, { score: 40, tieBreak: 9 }), true);
	assert.equal(beatsBest({ score: 40, tieBreak: 10 }, { score: 40, tieBreak: 9 }), false);
});

test('beatsBest treats a missing tie-break as SQL does: COALESCE(tie_break, 1000000001)', () => {
	assert.equal(UNRANKED_TIE_BREAK, 1_000_000_001);
	assert.equal(tieBreakRank(null), UNRANKED_TIE_BREAK);
	assert.equal(tieBreakRank(undefined), UNRANKED_TIE_BREAK);
	assert.equal(tieBreakRank(-1), UNRANKED_TIE_BREAK);
	assert.equal(tieBreakRank(0), 0);
	// A null tie-break is the worst possible value at that score: anything
	// numeric beats it, and it beats nothing.
	assert.equal(beatsBest({ score: 40, tieBreak: null }, { score: 40, tieBreak: null }), false);
	assert.equal(beatsBest({ score: 40, tieBreak: 7 }, { score: 40, tieBreak: null }), true);
	assert.equal(beatsBest({ score: 40, tieBreak: null }, { score: 40, tieBreak: 7 }), false);
});

test('run tokens and idempotency keys satisfy the route pattern and are stable per token', () => {
	const token = createRunToken();
	assert.match(token, /^[A-Za-z0-9_-]{16,64}$/);
	const first = idempotencyKey('stk', token);
	const second = idempotencyKey('stk', token);
	assert.equal(first, second, 'the same run substitutes to the same key');
	assert.match(first, /^[A-Za-z0-9_-]{16,64}$/);
	assert.notEqual(idempotencyKey('msw', token), first, 'prefixes keep games apart');
	assert.notEqual(createRunToken(), token);
});

test('submitRun posts exactly the body keys the route validates', async () => {
	const { fetchImpl, calls } = stubFetch(() => jsonResponse({ ok: true, score: 77, tieBreak: 3 }, 201));
	const outcome = await submitRun({ gameId: 'bnji.isometric-stack', mode: 'default', score: 77, tieBreak: 3, proof: { drops: [] }, idempotencyKey: 'stk-abcdefghijklmnop', displayName: 'Ada' }, fetchImpl);
	assert.equal(outcome.kind, 'stored');
	assert.equal(outcome.kind === 'stored' && outcome.score, 77);
	const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
	assert.deepEqual(Object.keys(body).sort(), ['displayName', 'gameId', 'idempotencyKey', 'mode', 'proof', 'score', 'tieBreak']);
	assert.equal(body.displayName, 'Ada');
	assert.equal(body.gameId, 'bnji.isometric-stack');
	assert.equal(calls[0]!.url, '/api/games/scores');
});

test('submitRun maps route statuses onto the claim copy', async () => {
	const cases: Array<[number, string, string]> = [
		[202, 'score_not_best', 'not-best'],
		[409, 'duplicate_submission', 'duplicate'],
		[422, 'score_rejected', 'rejected'],
		[403, 'origin_not_allowed', 'rejected'],
		[429, 'rate_limited', 'rejected'],
		[503, 'storage_unavailable', 'unreachable'],
	];
	for (const [status, error, kind] of cases) {
		const { fetchImpl } = stubFetch(() => jsonResponse({ error }, status));
		const outcome = await submitRun({ gameId: 'bnji.chess', mode: 'fastest-mate', score: 1, tieBreak: 4, proof: {}, idempotencyKey: 'che-abcdefghijklmnop' }, fetchImpl);
		assert.equal(outcome.kind, kind, `${status} ${error}`);
	}
});

test('submitRun reports an unreachable server instead of throwing', async () => {
	const fetchImpl = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
	const outcome = await submitRun({ gameId: 'bnji.chess', mode: 'fastest-mate', score: 1, tieBreak: 4, proof: {}, idempotencyKey: 'che-abcdefghijklmnop' }, fetchImpl);
	assert.equal(outcome.kind, 'unreachable');
});

test('readStanding returns null on any failure and never pretends a botched read was empty', async () => {
	const failing = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
	assert.deepEqual(await readStanding('bnji.chess', 'fastest-mate', failing), { ok: false, reason: 'unreachable' });
	const rejected = (async () => jsonResponse({ error: 'rate_limited' }, 429)) as unknown as typeof fetch;
	assert.deepEqual(await readStanding('bnji.chess', 'fastest-mate', rejected), { ok: false, reason: 'rejected' });
	const malformed = (async () => jsonResponse({ best: null })) as unknown as typeof fetch;
	assert.deepEqual(await readStanding('bnji.chess', 'fastest-mate', malformed), { ok: false, reason: 'malformed' });
});

test('autoSubmitRun submits a winning run and skips one that does not beat the standing', async () => {
	const winning = stubFetch((url) => url.startsWith('/api/games/scores/my')
		? jsonResponse(standingBody({ best: { score: 10, tieBreak: null, achievedAt: 1 }, rank: 4, entries: 9 }))
		: jsonResponse({ ok: true, score: 11, tieBreak: null }, 201));
	const posted = await autoSubmitRun({ gameId: 'bnji.isometric-stack', mode: 'default', score: 11, tieBreak: null, proof: {}, idempotencyKey: 'stk-aaaaaaaaaaaaaaaa', displayName: 'Ada' }, { fetchImpl: winning.fetchImpl });
	assert.equal(posted.submitted, true);
	assert.equal(posted.submitted && posted.outcome.kind, 'stored');
	assert.equal(winning.calls.filter((call) => call.url === '/api/games/scores').length, 1);

	resetGameScoresCache();
	const losing = stubFetch((url) => url.startsWith('/api/games/scores/my')
		? jsonResponse(standingBody({ best: { score: 40, tieBreak: null, achievedAt: 1 }, rank: 1, entries: 2 }))
		: jsonResponse({ ok: true }, 201));
	const skipped = await autoSubmitRun({ gameId: 'bnji.isometric-stack', mode: 'default', score: 12, tieBreak: null, proof: {}, idempotencyKey: 'stk-bbbbbbbbbbbbbbbb', displayName: 'Ada' }, { fetchImpl: losing.fetchImpl });
	assert.deepEqual(skipped, { submitted: false, reason: 'not_best' });
	assert.equal(losing.calls.filter((call) => call.url === '/api/games/scores').length, 0, 'a non-best run never reaches the submit route');
});

test('autoSubmitRun submits nothing when the standing cannot be read', async () => {
	const { fetchImpl, calls } = stubFetch(() => jsonResponse({ error: 'storage_unavailable' }, 503));
	const outcome = await autoSubmitRun({ gameId: 'bnji.isometric-stack', mode: 'default', score: 999, tieBreak: null, proof: {}, idempotencyKey: 'stk-cccccccccccccccc', displayName: 'Ada' }, { fetchImpl });
	assert.deepEqual(outcome, { submitted: false, reason: 'standing_unreadable' });
	assert.equal(calls.filter((call) => call.url === '/api/games/scores').length, 0);
});

test('autoSubmitRun leaves guest runs to the manual claim form', async () => {
	const { fetchImpl, calls } = stubFetch((url) => url.startsWith('/api/games/scores/my')
		? jsonResponse(standingBody({ scope: 'guest', best: null }))
		: jsonResponse({ ok: true, score: 5 }, 201));
	const outcome = await autoSubmitRun({ gameId: 'bnji.isometric-stack', mode: 'default', score: 5, tieBreak: null, proof: {}, idempotencyKey: 'stk-dddddddddddddddd' }, { fetchImpl });
	assert.deepEqual(outcome, { submitted: false, reason: 'guest' });
	assert.equal(calls.filter((call) => call.url === '/api/games/scores').length, 0);
});

test('autoSubmitRun fills the account display name when the caller has not supplied one', async () => {
	const { fetchImpl, calls } = stubFetch((url) => {
		if (url === '/api/games/account') return jsonResponse({ authenticated: true, displayName: 'Ada Lovelace' });
		if (url.startsWith('/api/games/scores/my')) return jsonResponse(standingBody({ best: null }));
		return jsonResponse({ ok: true, score: 3, tieBreak: null }, 201);
	});
	const outcome = await autoSubmitRun({ gameId: 'bnji.isometric-stack', mode: 'default', score: 3, tieBreak: null, proof: {}, idempotencyKey: 'stk-eeeeeeeeeeeeeeee' }, { fetchImpl });
	assert.equal(outcome.submitted, true);
	const body = JSON.parse(String(calls.find((call) => call.url === '/api/games/scores')!.init?.body)) as Record<string, unknown>;
	assert.equal(body.displayName, 'Ada Lovelace');
});

test('submitAttestedWin orders name → POST → standing refresh and never sends a client-computed score', async () => {
	const order: string[] = [];
	const { fetchImpl, calls } = stubFetch((url) => {
		if (url === '/api/games/account') { order.push('name'); return jsonResponse({ authenticated: true, displayName: 'Ada' }); }
		if (url.startsWith('/api/games/scores/my')) { order.push('standing'); return jsonResponse(standingBody({ scope: 'guest', best: null })); }
		order.push('post');
		return jsonResponse({ ok: true, score: 4, tieBreak: null }, 201);
	});
	const result = await submitAttestedWin({ gameId: 'bnji.pvp-minesweeper', mode: 'hard', proof: { roomCode: 'x'.repeat(22), round: 3 }, idempotencyKey: 'msw-ffffffffffffffff' }, { fetchImpl });
	assert.deepEqual(order, ['name', 'post', 'standing']);
	assert.equal(result.name, 'Ada');
	assert.equal(result.outcome.kind, 'stored');
	const body = JSON.parse(String(calls.find((call) => call.url === '/api/games/scores')!.init?.body)) as Record<string, unknown>;
	// The server increments the stored count for an attested win; a client total
	// would be a number the room never verified.
	assert.equal(body.score, 0);
	assert.equal(body.tieBreak, null);
	assert.deepEqual(body.proof, { roomCode: 'x'.repeat(22), round: 3 });
});
