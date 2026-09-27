/** Admin-only list of shared Paint publish summaries (never artwork or pointer events). */
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../server/admin';
import { listPaintActivity } from '../../../server/paint-activity-store';
import { serverEnvironment } from '../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();
	const db = env.BOARD_DB as Parameters<typeof listPaintActivity>[0] | undefined;
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unavailable' }, 503);

	const requested = Number(context.url.searchParams.get('limit')) || 50;
	try {
		return json(await listPaintActivity(db, requested));
	} catch (error) {
		console.warn('[bnji] admin Paint activity query failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}
