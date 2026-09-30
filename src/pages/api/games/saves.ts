/** Authenticated, revisioned game-agnostic save blobs. */
import type { APIContext } from 'astro';
import { getGame } from '../../../data/games';
import { serverEnvironment } from '../../../server/env';
import type { D1Database } from '../../../server/game-store';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext } from '../../../server/player-context';
import { deletePlayerSave, PLAYER_SAVE_MAX_SCHEMA_VERSION, PLAYER_SAVE_MAX_SLOTS, PLAYER_SAVE_MAX_BYTES, readPlayerSaves, validateSaveData, writePlayerSave } from '../../../server/player-store';
import { readBodyTextBounded } from '../../../server/read-body';

export const prerender = false;
const BODY_LIMIT = PLAYER_SAVE_MAX_BYTES + 2048;
function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function allowedOrigin(request: Request): boolean {
	return request.headers.get('origin') === new URL(request.url).origin;
}
function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function dbBinding(value: unknown): D1Database | null {
	return value && typeof (value as D1Database).prepare === 'function' ? value as D1Database : null;
}
function withPlayer(response: Response, player: Awaited<ReturnType<typeof resolvePlayerContext>>): Response {
	appendPlayerCookies(response.headers, player);
	return response;
}
async function context(request: Request): Promise<{ db: D1Database; player: Awaited<ReturnType<typeof resolvePlayerContext>> } | Response> {
	const env = await serverEnvironment();
	const db = dbBinding(env.BOARD_DB);
	if (!db) return json({ error: 'storage_unavailable' }, 503);
	try { return { db, player: await resolvePlayerContext(request, db) }; }
	catch (error) {
		return json({ error: error instanceof PlayerContextStorageError ? 'storage_unavailable' : 'storage_unavailable' }, 503);
	}
}
function publicSave(row: { game_id: string; slot_id: string; schema_version: number; revision: number; data_json: string; updated_at: number }) {
	return {
		gameId: row.game_id, slotId: row.slot_id, schemaVersion: Number(row.schema_version), revision: Number(row.revision),
		data: JSON.parse(row.data_json), updatedAt: Number(row.updated_at),
	};
}

export async function GET(contextApi: APIContext): Promise<Response> {
	const resolved = await context(contextApi.request);
	if (resolved instanceof Response) return resolved;
	const { db, player } = resolved;
	if (!player.playerId) return withPlayer(json({ error: 'authentication_required' }, 401), player);
	try {
		const rows = await readPlayerSaves(db, player.playerId);
		return withPlayer(json({ maxSlots: PLAYER_SAVE_MAX_SLOTS, maxBlobBytes: PLAYER_SAVE_MAX_BYTES, saves: rows.map(publicSave) }), player);
	} catch { return withPlayer(json({ error: 'storage_unavailable' }, 503), player); }
}

export async function PUT(contextApi: APIContext): Promise<Response> {
	if (!allowedOrigin(contextApi.request)) return json({ error: 'origin_not_allowed' }, 403);
	const resolved = await context(contextApi.request);
	if (resolved instanceof Response) return resolved;
	const { db, player } = resolved;
	if (!player.playerId) return withPlayer(json({ error: 'authentication_required' }, 401), player);
	const text = await readBodyTextBounded(contextApi.request, BODY_LIMIT);
	if (text === null) return withPlayer(json({ error: 'payload_too_large' }, 413), player);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return withPlayer(json({ error: 'invalid_json' }, 400), player); }
	if (!record(body) || !hasOnlyKeys(body, ['gameId', 'slotId', 'schemaVersion', 'data', 'expectedRevision'])) return withPlayer(json({ error: 'invalid_payload' }, 400), player);
	const gameId = typeof body.gameId === 'string' ? body.gameId : '';
	const game = getGame(gameId);
	if (!game) return withPlayer(json({ error: 'unknown_game' }, 404), player);
	const slotId = typeof body.slotId === 'string' ? body.slotId : '';
	if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(slotId)) return withPlayer(json({ error: 'invalid_slot' }, 400), player);
	if (!Number.isSafeInteger(body.schemaVersion) || Number(body.schemaVersion) < 1 || Number(body.schemaVersion) > PLAYER_SAVE_MAX_SCHEMA_VERSION) {
		return withPlayer(json({ error: 'invalid_schema_version' }, 400), player);
	}
	if (body.expectedRevision !== null && (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1)) {
		return withPlayer(json({ error: 'invalid_expected_revision' }, 400), player);
	}
	const validation = validateSaveData(body.data);
	if (!validation.ok) return withPlayer(json({ error: validation.error }, 400), player);
	try {
		const outcome = await writePlayerSave(db, {
			playerId: player.playerId, gameId, slotId, schemaVersion: Number(body.schemaVersion), dataJson: validation.json,
			expectedRevision: body.expectedRevision as number | null, now: Date.now(),
		});
		if (outcome.kind === 'limit') return withPlayer(json({ error: 'save_slot_limit', maxSlots: PLAYER_SAVE_MAX_SLOTS }, 409), player);
		if (outcome.kind === 'conflict') return withPlayer(json({ error: 'save_conflict', current: outcome.current ? publicSave(outcome.current) : null }, 409), player);
		return withPlayer(json({ ok: true, revision: outcome.revision, updatedAt: outcome.updatedAt }), player);
	} catch { return withPlayer(json({ error: 'storage_unavailable' }, 503), player); }
}

export async function DELETE(contextApi: APIContext): Promise<Response> {
	if (!allowedOrigin(contextApi.request)) return json({ error: 'origin_not_allowed' }, 403);
	const resolved = await context(contextApi.request);
	if (resolved instanceof Response) return resolved;
	const { db, player } = resolved;
	if (!player.playerId) return withPlayer(json({ error: 'authentication_required' }, 401), player);
	const text = await readBodyTextBounded(contextApi.request, 2048);
	if (text === null) return withPlayer(json({ error: 'payload_too_large' }, 413), player);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return withPlayer(json({ error: 'invalid_json' }, 400), player); }
	if (!record(body) || !hasOnlyKeys(body, ['gameId', 'slotId', 'expectedRevision']) || typeof body.gameId !== 'string' || !getGame(body.gameId) || typeof body.slotId !== 'string' ||
		!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(body.slotId) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
		return withPlayer(json({ error: 'invalid_payload' }, 400), player);
	}
	try {
		const deleted = await deletePlayerSave(db, { playerId: player.playerId, gameId: body.gameId, slotId: body.slotId, expectedRevision: Number(body.expectedRevision) });
		if (!deleted) return withPlayer(json({ error: 'save_conflict' }, 409), player);
		return withPlayer(json({ deleted: true }), player);
	} catch { return withPlayer(json({ error: 'storage_unavailable' }, 503), player); }
}
