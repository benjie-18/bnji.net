/**
 * BNJI.NET — chat plan Phase C: one room's live transcript.
 *
 *   GET /api/admin/chat/room?code=<22 chars>  ->  200 { code, registry, read }
 *
 * The registry proves the room exists and is unexpired; the transcript
 * itself comes from the DO's service-authenticated `/admin/read` (plan §6.2)
 * — messages with display-time URL stripping and blocklist flags, members
 * with principal hashes for ban actions, and the room-local host log.
 *
 * Admin-only. See src/server/admin.ts for the gate.
 */
import type { APIContext } from 'astro';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../../server/admin';
import { getRoomRegistryEntry } from '../../../../server/chat-moderation';
import { serverEnvironment } from '../../../../server/env';
import { roomServiceFetch } from '../../../../server/game-room-gateway';
import type { D1Database } from '../../../../server/game-store';

export const prerender = false;

const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const code = context.url.searchParams.get('code') ?? '';
	if (!ROOM_CODE_PATTERN.test(code)) return json({ error: 'invalid_room_code' }, 400);

	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unconfigured' }, 503);
	const registry = await getRoomRegistryEntry(db, code);
	// Registry rows exist only while the room should exist — an expired or
	// never-registered code is simply not found (best-effort insert at create).
	if (!registry) return json({ error: 'room_not_found' }, 404);

	try {
		const response = await roomServiceFetch(env, code, null, '/admin/read', { method: 'POST', body: '{}' });
		const body = await response.json().catch(() => ({ error: 'room_service_unavailable' }));
		if (!response.ok) return json(body, response.status);
		return json({ code, registry, read: body });
	} catch {
		return json({ error: 'room_service_unavailable' }, 503);
	}
}
