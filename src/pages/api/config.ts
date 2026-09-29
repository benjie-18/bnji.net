/**
 * BNJI.NET — public dynamic configuration endpoint.
 *
 *   GET /api/config
 *
 * Exposes active site configuration overrides from D1 (site_settings)
 * for dynamic client-side rehydration of branding, board limits, and DM status.
 */
import { getSiteSettings } from '../../server/site-settings-store';

export const prerender = false;

export async function GET(): Promise<Response> {
	const settings = await getSiteSettings();
	return new Response(JSON.stringify(settings), {
		status: 200,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'public, max-age=60, s-maxage=60',
		},
	});
}
