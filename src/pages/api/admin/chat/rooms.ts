/**
 * BNJI.NET — chat plan Phase C: admin chat dashboard.
 *
 *   GET /api/admin/chat/rooms  ->  200 { rooms, reports, log, bans, filter }
 *
 * One read powers every Chat-tab panel (plan §6.2): active rooms from
 * `room_registry`, the reports queue from `chat_reports`, the audit trail
 * from `chat_moderation_log`, active `chat_bans`, and the §6.3 filter
 * config so the UI can show what the triage aid is doing.
 *
 * Admin-only. See src/server/admin.ts for the gate.
 */
import type { APIContext } from 'astro';
import { CHAT_CONFIG } from '../../../../config/chat.config';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../../server/admin';
import { listActiveChatBans, listActiveRooms, listChatReports, listModerationLog } from '../../../../server/chat-moderation';
import { listDmReports } from '../../../../server/dm-reports';
import { serverEnvironment } from '../../../../server/env';
import type { D1Database } from '../../../../server/game-store';

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unconfigured' }, 503);

	const [rooms, reports, dmReports, log, bans] = await Promise.all([
		listActiveRooms(db),
		listChatReports(db, { limit: 50 }),
		listDmReports(db, { limit: 50 }),
		listModerationLog(db, 50),
		listActiveChatBans(db),
	]);
	return json({
		rooms, reports, dmReports, log, bans,
		filter: { blocklist: CHAT_CONFIG.filter.blocklist, stripUrlsForAdmin: CHAT_CONFIG.filter.stripUrlsForAdmin, enabled: CHAT_CONFIG.enabled },
	});
}
