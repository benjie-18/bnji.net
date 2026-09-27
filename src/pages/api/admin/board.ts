/**
 * BNJI.NET — admin message board moderation.
 *
 *   GET    /api/admin/board?status=&minReports=&search=&limit=&cursor=
 *          -> 200 { messages, nextCursor, summary }
 *   POST   /api/admin/board  { id, status, note? }
 *          -> 200 { message }
 *
 * The one place where moderation state is visible and changeable. Everything
 * the public API deliberately hides — the status column, report counts,
 * moderator notes — is exactly what this returns.
 *
 * Read it alongside /api/admin/security: a message id here joins to
 * target_id there, so "this message is spam" becomes "these IPs, these device
 * fingerprints, this timezone posted it" in one step.
 *
 * Admin-only. See src/server/admin.ts for the gate.
 */
import {
	MESSAGE_STATUSES,
	decodeCursor,
	getBoardStore,
	type MessageStatus,
} from '../../../server/board-store';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../server/admin';
import { serverEnvironment } from '../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const MAX_LIMIT = 200;
const MAX_ID_LENGTH = 64;
const MAX_NOTE_LENGTH = 500;
const MAX_SEARCH_LENGTH = 100;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

function isMessageStatus(value: unknown): value is MessageStatus {
	return typeof value === 'string' && (MESSAGE_STATUSES as readonly string[]).includes(value);
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();
	const store = getBoardStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	const params = context.url.searchParams;

	const statusParam = params.get('status');
	if (statusParam && !isMessageStatus(statusParam)) {
		return json({ error: 'invalid_status', allowed: MESSAGE_STATUSES }, 400);
	}

	const searchParam = params.get('search');
	const search = searchParam ? searchParam.slice(0, MAX_SEARCH_LENGTH).trim() : undefined;

	const minReportsRaw = params.get('minReports');
	const minReports = minReportsRaw === null ? undefined : Number(minReportsRaw);
	if (minReports !== undefined && (!Number.isFinite(minReports) || minReports < 0)) {
		return json({ error: 'invalid_min_reports' }, 400);
	}

	const limit = Math.min(
		Math.max(1, Number(params.get('limit')) || 50),
		MAX_LIMIT,
	);

	const cursorParam = params.get('cursor');
	let cursor: string | undefined;
	if (cursorParam) {
		if (!decodeCursor(cursorParam)) return json({ error: 'invalid_cursor' }, 400);
		cursor = cursorParam;
	}

	try {
		// Sequential for the same reason as the security list: listForAdmin
		// triggers the report retention purge, so a parallel summary would
		// report pre-purge numbers.
		const page = await store.listForAdmin({
			limit,
			cursor,
			...(statusParam && isMessageStatus(statusParam) ? { status: statusParam } : {}),
			...(minReports !== undefined ? { minReports } : {}),
			...(search ? { search } : {}),
		});
		const summary = await store.summarize();
		return json({
			messages: page.messages,
			nextCursor: page.nextCursor,
			summary,
			provider: store.kind,
			// Echo the filters that were actually applied, so a client can tell
			// "no matches" apart from "filter silently dropped".
			filters: {
				status: statusParam ?? null,
				minReports: minReports ?? null,
				search: search ?? null,
			},
		});
	} catch (error) {
		console.error('[bnji] admin board list failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}

export async function POST(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}

	const body = (payload ?? {}) as { id?: unknown; status?: unknown; note?: unknown };
	const { id, status } = body;

	if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
		return json({ error: 'invalid_id' }, 400);
	}
	if (!isMessageStatus(status)) {
		return json({ error: 'invalid_status', allowed: MESSAGE_STATUSES }, 400);
	}
	const note =
		typeof body.note === 'string' && body.note.trim().length > 0
			? body.note.trim().slice(0, MAX_NOTE_LENGTH)
			: undefined;

	const env = await serverEnvironment();
	const store = getBoardStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	try {
		const changed = await store.setStatus(id, status, note);
		if (!changed) return json({ error: 'not_found' }, 404);

		// Return the updated row so the caller can update its view without a
		// second round trip, and without a list call that would be filtered
		// by whatever view the operator happens to be looking at.
		const updated = await store.getMessage(id);
		return json({ ok: true, message: updated ?? null });
	} catch (error) {
		console.error('[bnji] admin board moderate failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}
