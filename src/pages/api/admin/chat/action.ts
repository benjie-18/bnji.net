/**
 * BNJI.NET — chat plan Phase C: moderation actions.
 *
 *   POST /api/admin/chat/action
 *     { action: 'delete_message', code, n }
 *     { action: 'close_room',      code }
 *     { action: 'ban',             principalHash, minutes?, reason?, code? }
 *     { action: 'unban',           principalHash }
 *     { action: 'report_resolve' | 'report_dismiss', id, note? }
 *     { action: 'report_escalate', id, minutes?, note? }
 *
 * Room-touching actions go through the DO's service-authenticated
 * `/admin/action` (delete tombstones as `admin` and broadcasts; close shares
 * the alarm teardown; kick removes membership + closes 4003). D1-side effects
 * (ban rows, report status, the audit log) happen here — the DO never writes
 * D1 (plan §6.2 boundary). Every successful action lands in
 * `chat_moderation_log`.
 *
 * Admin-only. See src/server/admin.ts for the gate.
 */
import type { APIContext } from 'astro';
import { CHAT_CONFIG } from '../../../../config/chat.config';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../../server/admin';
import {
	addModerationLog, clearChatBan, deleteRoomRegistryEntry, getChatReport, setChatBan, setChatReportStatus,
} from '../../../../server/chat-moderation';
import { getDmReport, setDmReportStatus } from '../../../../server/dm-reports';
import { serverEnvironment } from '../../../../server/env';
import { roomServiceFetch } from '../../../../server/game-room-gateway';
import { readBodyTextBounded } from '../../../../server/read-body';
import type { D1Database } from '../../../../server/game-store';

export const prerender = false;

const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_NOTE_LENGTH = 500;
const MAX_REASON_LENGTH = 200;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

function boundedString(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length <= maxLength ? trimmed : null;
}

function banMinutes(value: unknown): number {
	const fallback = CHAT_CONFIG.moderation.defaultBanMinutes;
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(CHAT_CONFIG.moderation.maxBanMinutes, Math.max(1, Number(value)));
}

export async function POST(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unconfigured' }, 503);

	const text = await readBodyTextBounded(context.request, 1_024);
	if (text === null) return json({ error: 'payload_too_large' }, 413);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return json({ error: 'invalid_json' }, 400); }
	const payload = body as Record<string, unknown>;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.action !== 'string') {
		return json({ error: 'invalid_payload' }, 400);
	}
	const action = payload.action;
	const keys = Object.keys(payload);
	const hasOnly = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key));

	const now = Date.now();

	// ------------------------------------------------------------- rooms
	if (action === 'delete_message') {
		if (!hasOnly('action', 'code', 'n') || typeof payload.code !== 'string' || !ROOM_CODE_PATTERN.test(payload.code) ||
			!Number.isSafeInteger(payload.n) || Number(payload.n) < 1) return json({ error: 'invalid_payload' }, 400);
		try {
			const response = await roomServiceFetch(env, payload.code, null, '/admin/action', {
				method: 'POST', body: JSON.stringify({ type: 'delete_message', n: Number(payload.n) }),
			});
			const result = await response.json().catch(() => ({ error: 'room_service_unavailable' }));
			if (!response.ok) return json(result, response.status);
			await addModerationLog(db, { action: 'delete_message', roomCode: payload.code, messageN: Number(payload.n), now });
			return json({ ok: true });
		} catch { return json({ error: 'room_service_unavailable' }, 503); }
	}

	if (action === 'close_room') {
		if (!hasOnly('action', 'code') || typeof payload.code !== 'string' || !ROOM_CODE_PATTERN.test(payload.code)) {
			return json({ error: 'invalid_payload' }, 400);
		}
		const code = payload.code;
		try {
			const response = await roomServiceFetch(env, code, null, '/admin/action', {
				method: 'POST', body: JSON.stringify({ type: 'close_room' }),
			});
			// Room already gone (expired under us): converge the registry anyway.
			await deleteRoomRegistryEntry(db, code);
			if (!response.ok && response.status !== 404) {
				const result = await response.json().catch(() => ({ error: 'room_service_unavailable' }));
				return json(result, response.status);
			}
			await addModerationLog(db, { action: 'close_room', roomCode: code, now });
			return json({ ok: true, roomGone: !response.ok });
		} catch { return json({ error: 'room_service_unavailable' }, 503); }
	}

	// -------------------------------------------------------------- bans
	if (action === 'ban') {
		const principalHash = payload.principalHash;
		if (!hasOnly('action', 'principalHash', 'minutes', 'reason', 'code') ||
			typeof principalHash !== 'string' || !HASH_PATTERN.test(principalHash)) return json({ error: 'invalid_payload' }, 400);
		const reason = boundedString(payload.reason, MAX_REASON_LENGTH);
		if (payload.reason !== undefined && reason === null) return json({ error: 'invalid_payload' }, 400);
		const code = payload.code;
		if (code !== undefined && (typeof code !== 'string' || !ROOM_CODE_PATTERN.test(code))) return json({ error: 'invalid_payload' }, 400);
		const minutes = banMinutes(payload.minutes);
		const expiresAt = now + minutes * 60_000;
		await setChatBan(db, { principalHash, reason, now, expiresAt });
		let kicked = false;
		if (code) {
			try {
				const response = await roomServiceFetch(env, code, null, '/admin/action', {
					method: 'POST', body: JSON.stringify({ type: 'kick', principalHash }),
				});
				const result = await response.json().catch(() => ({})) as { kicked?: boolean };
				kicked = Boolean(response.ok && result.kicked);
			} catch { /* the ban still holds even if the room is unreachable */ }
		}
		await addModerationLog(db, { action: 'ban', roomCode: typeof code === 'string' ? code : null, targetHash: principalHash, detail: `${minutes}m${reason ? ` · ${reason}` : ''}`, now });
		return json({ ok: true, expiresAt, kicked });
	}

	if (action === 'kick') {
		if (!hasOnly('action', 'principalHash', 'code') ||
			typeof payload.principalHash !== 'string' || !HASH_PATTERN.test(payload.principalHash) ||
			typeof payload.code !== 'string' || !ROOM_CODE_PATTERN.test(payload.code)) return json({ error: 'invalid_payload' }, 400);
		try {
			const response = await roomServiceFetch(env, payload.code, null, '/admin/action', {
				method: 'POST', body: JSON.stringify({ type: 'kick', principalHash: payload.principalHash }),
			});
			const result = await response.json().catch(() => ({ error: 'room_service_unavailable' }));
			if (!response.ok && response.status !== 404) return json(result, response.status);
			await addModerationLog(db, { action: 'kick', roomCode: payload.code, targetHash: payload.principalHash, now });
			return json({ ok: true, roomGone: !response.ok, kicked: response.ok });
		} catch { return json({ error: 'room_service_unavailable' }, 503); }
	}

	if (action === 'unban') {
		if (!hasOnly('action', 'principalHash') || typeof payload.principalHash !== 'string' || !HASH_PATTERN.test(payload.principalHash)) {
			return json({ error: 'invalid_payload' }, 400);
		}
		await clearChatBan(db, payload.principalHash);
		await addModerationLog(db, { action: 'unban', targetHash: payload.principalHash, now });
		return json({ ok: true });
	}

	// ------------------------------------------------------------ reports
	// Phase D: DM reports are keyed (convId, messageN) instead of a numeric id
	// and never touch a room DO — status changes + the shared audit log only.
	// Escalate writes a chat_bans row, which blocks BOTH room joins and every
	// DM route (owner answer 2026-09-30: the ban path covers messaging).
	if ((action === 'report_resolve' || action === 'report_dismiss' || action === 'report_escalate') && payload.kind === 'dm') {
		if (!hasOnly('action', 'kind', 'convId', 'messageN', 'note', 'minutes') ||
			typeof payload.convId !== 'string' || !/^[a-f0-9]{64}$/.test(payload.convId) ||
			!Number.isSafeInteger(payload.messageN) || Number(payload.messageN) < 1) return json({ error: 'invalid_payload' }, 400);
		const note = boundedString(payload.note, MAX_NOTE_LENGTH);
		if (payload.note !== undefined && note === null) return json({ error: 'invalid_payload' }, 400);
		const report = await getDmReport(db, payload.convId, Number(payload.messageN));
		if (!report) return json({ error: 'report_not_found' }, 404);
		const logBase = { roomCode: `dm:${report.convId}`, messageN: report.messageN, targetHash: report.authorHash, detail: note, now };
		if (action === 'report_escalate') {
			const minutes = banMinutes(payload.minutes);
			const expiresAt = now + minutes * 60_000;
			await setChatBan(db, { principalHash: report.authorHash, reason: boundedString(note, MAX_REASON_LENGTH) ?? 'reported direct message', now, expiresAt });
			await setDmReportStatus(db, { convId: report.convId, messageN: report.messageN, status: 'resolved', note: note ?? `escalated: ${minutes}m ban`, now });
			await addModerationLog(db, { action: 'report_escalate', ...logBase, detail: note ?? `escalated: ${minutes}m ban` });
			return json({ ok: true, status: 'resolved', expiresAt });
		}
		const status = action === 'report_resolve' ? 'resolved' : 'dismissed';
		await setDmReportStatus(db, { convId: report.convId, messageN: report.messageN, status, note, now });
		await addModerationLog(db, { action, ...logBase });
		return json({ ok: true, status });
	}
	if (action === 'report_resolve' || action === 'report_dismiss') {
		if (!hasOnly('action', 'id', 'note') ||
			!Number.isSafeInteger(payload.id) || Number(payload.id) < 1) return json({ error: 'invalid_payload' }, 400);
		const note = boundedString(payload.note, MAX_NOTE_LENGTH);
		if (payload.note !== undefined && note === null) return json({ error: 'invalid_payload' }, 400);
		const report = await getChatReport(db, Number(payload.id));
		if (!report) return json({ error: 'report_not_found' }, 404);
		const status = action === 'report_resolve' ? 'resolved' : 'dismissed';
		await setChatReportStatus(db, { id: report.id, status, note, now });
		await addModerationLog(db, { action, roomCode: report.roomCode, messageN: report.messageN, targetHash: report.authorHash, detail: note, now });
		return json({ ok: true, status });
	}

	if (action === 'report_escalate') {
		if (!hasOnly('action', 'id', 'minutes', 'note') ||
			!Number.isSafeInteger(payload.id) || Number(payload.id) < 1) return json({ error: 'invalid_payload' }, 400);
		const note = boundedString(payload.note, MAX_NOTE_LENGTH);
		if (payload.note !== undefined && note === null) return json({ error: 'invalid_payload' }, 400);
		const report = await getChatReport(db, Number(payload.id));
		if (!report) return json({ error: 'report_not_found' }, 404);
		const minutes = banMinutes(payload.minutes);
		const expiresAt = now + minutes * 60_000;
		await setChatBan(db, { principalHash: report.authorHash, reason: boundedString(note, MAX_REASON_LENGTH) ?? 'reported message', now, expiresAt });
		let kicked = false;
		try {
			const response = await roomServiceFetch(env, report.roomCode, null, '/admin/action', {
				method: 'POST', body: JSON.stringify({ type: 'kick', principalHash: report.authorHash }),
			});
			const result = await response.json().catch(() => ({})) as { kicked?: boolean };
			kicked = Boolean(response.ok && result.kicked);
		} catch { /* room may already be gone; the ban stands */ }
		await setChatReportStatus(db, { id: report.id, status: 'resolved', note: note ?? `escalated: ${minutes}m ban`, now });
		await addModerationLog(db, {
			action: 'report_escalate', roomCode: report.roomCode, messageN: report.messageN,
			targetHash: report.authorHash, detail: `${minutes}m ban${kicked ? ' · kicked' : ''}${note ? ` · ${note}` : ''}`, now,
		});
		return json({ ok: true, expiresAt, kicked });
	}

	return json({ error: 'invalid_action' }, 400);
}
