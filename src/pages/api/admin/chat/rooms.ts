/**
 * BNJI.NET — chat plan Phase C: admin chat dashboard.
 *
 *   GET /api/admin/chat/rooms  ->  200 { rooms, reports, log, bans, filter,
 *                                        dmMeta }
 *
 * `dmMeta` is the Phase-E deepened view: DM conversation METADATA
 * (participants as handles, counts, timestamps — owner answer D10) plus
 * aggregate health (accounts, messages, reports, friends counts, live
 * presence from the Presence DO). Friend lists are never listed.
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
import { dmHealthCounts, listConversationMetadata } from '../../../../server/dm-store';
import { friendHealthCounts } from '../../../../server/friend-store';
import { presenceAdminFetch } from '../../../../server/presence-gateway';
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

	const now = Date.now();
	const [rooms, reports, dmReports, log, bans, dmConversations, dm, friends, accounts, presence] = await Promise.all([
		listActiveRooms(db),
		listChatReports(db, { limit: 50 }),
		listDmReports(db, { limit: 50 }),
		listModerationLog(db, 50),
		listActiveChatBans(db),
		// D10 metadata only: handles, counts, timestamps — no bodies, no
		// player IDs (§12.3). Friend data is aggregate counts alone (§8.1).
		listConversationMetadata(db, 50),
		dmHealthCounts(db, now),
		friendHealthCounts(db),
		db.prepare(
			`SELECT COUNT(*) AS total,
			        SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS new7d
			 FROM game_players`,
		).bind(now - 7 * 86_400_000).first<{ total: number; new7d: number | null }>(),
		presenceAdminFetch(env, typeof env.ACCESS_SECRET === 'string' && env.ACCESS_SECRET ? env.ACCESS_SECRET : undefined),
	]);
	return json({
		rooms, reports, dmReports, log, bans,
		dmMeta: {
			conversations: dmConversations,
			health: {
				accounts: { total: Number(accounts?.total ?? 0), new7d: Number(accounts?.new7d ?? 0) },
				messages: { conversations: dm.conversations, sent24h: dm.sent24h },
				reports: { open: dm.reportsOpen, total: dm.reportsTotal },
				friends,
				presence,
			},
			note: 'Counts and metadata only: DM bodies stay on the report snapshots; friend rows are never listed (aggregate counts only).',
		},
		filter: { blocklist: CHAT_CONFIG.filter.blocklist, stripUrlsForAdmin: CHAT_CONFIG.filter.stripUrlsForAdmin, enabled: CHAT_CONFIG.enabled },
	});
}
