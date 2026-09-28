/**
 * BNJI.NET — admin playlist reordering.
 *
 *   PATCH /api/admin/playlist/order  { id, direction: 'up' | 'down' }
 *   PATCH /api/admin/playlist/order  { order: string[] }
 *          -> 200 { ok, items }
 *          -> 400 { error: 'invalid_order' | 'invalid_direction' }
 *          -> 404 { error: 'not_found' }
 *
 * Two shapes, one concern: where the queue goes next. A single move is what the
 * accessible move-up / move-down buttons send; a full order is what a
 * drag-and-drop (or a bulk reorder) sends. Both end in the same validated
 * position rewrite in src/server/music-store.ts.
 *
 * WHY A FULL ORDER IS VALIDATED AS A SET
 * --------------------------------------
 * A submitted list must contain exactly the stored ids — no duplicates, none
 * missing. A partial list is indistinguishable from "delete the items I left
 * out", and silently honouring it would let a stale panel drop tracks from the
 * queue. Refusing the request instead means the worst outcome is a rejected
 * reorder, which the panel can recover from by re-reading the list.
 *
 * Admin-only. Same guard as every other /api/admin route.
 */
import { getMusicPlaylistStore, type PlaylistMoveDirection } from '../../../../server/music-store';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../../server/admin';
import { serverEnvironment } from '../../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const MAX_ID_LENGTH = 64;
const MAX_ORDER_LENGTH = 500;
const DIRECTIONS: readonly PlaylistMoveDirection[] = ['up', 'down'];

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

function isIdList(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_ORDER_LENGTH &&
		value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_ID_LENGTH)
	);
}

export async function PATCH(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}

	const body = (payload ?? {}) as { id?: unknown; direction?: unknown; order?: unknown };
	const env = await serverEnvironment();
	const store = getMusicPlaylistStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	try {
		if (body.order !== undefined) {
			if (!isIdList(body.order)) return json({ error: 'invalid_order' }, 400);
			const changed = await store.reorder(body.order);
			// A refused reorder is a mismatch between the panel's view and the
			// stored one. Returning the stored order is the recovery path.
			if (!changed) return json({ error: 'invalid_order', items: await store.list() }, 409);
			return json({ ok: true, items: await store.list() });
		}

		if (typeof body.id !== 'string' || body.id.length === 0 || body.id.length > MAX_ID_LENGTH) {
			return json({ error: 'invalid_id' }, 400);
		}
		if (typeof body.direction !== 'string' || !DIRECTIONS.includes(body.direction as PlaylistMoveDirection)) {
			return json({ error: 'invalid_direction', allowed: DIRECTIONS }, 400);
		}

		const moved = await store.move(body.id, body.direction as PlaylistMoveDirection);
		if (!moved) return json({ error: 'not_found' }, 404);
		return json({ ok: true, items: await store.list() });
	} catch (error) {
		console.error('[bnji] admin playlist reorder failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}
