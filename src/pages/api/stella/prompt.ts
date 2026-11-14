/**
 * BNJI.NET — Stella prompt text, served gated.
 *
 *   GET /api/stella/prompt?mode=<fable|opus>&phase=<id>&variant=<full|fix|phase>
 *     -> 200 { text }   (the composed prompt, verbatim apart from the
 *                        preamble's first line, set to the phase)
 *     -> 400 { error: 'invalid_selection' }
 *     -> 401 { error: 'unauthorized' }
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * The page at /projects/stella is gated by the admin credential, but gating
 * the page alone would be theatre: the prompt text used to ship in the
 * page's static client bundle, which the edge serves without running any
 * Worker code — anyone could read every prompt out of the JS chunk without
 * ever touching the page. So the client never imports the prompt data.
 * It fetches the composed text here, and this route is gated twice: the
 * middleware enforces the /api/stella access rule, and the handler itself
 * calls isAdminRequest, the same single guard every admin route uses.
 * Either check alone would suffice; both exist so removing one by accident
 * does not silently open the prompts.
 *
 * The response is never cached: it is credentialed content, and a cached
 * copy would outlive the session that authorised it.
 */
import type { APIRoute } from 'astro';
import {
	STELLA_MODES,
	STELLA_PHASES,
	composeStellaPrompt,
	type StellaModeId,
	type StellaVariantId,
} from '../../../data/stella-prompts';
import { isAdminRequest } from '../../../server/admin';

export const prerender = false;

const VARIANTS = ['full', 'fix', 'phase'] as const;

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export const GET: APIRoute = async (context) => {
	// Auth before validation: an unauthenticated caller learns nothing
	// about which selections are valid.
	if (!(await isAdminRequest(context))) return json({ error: 'unauthorized' }, 401);

	const params = context.url.searchParams;
	const mode = params.get('mode') ?? '';
	const phase = params.get('phase') ?? '';
	const variant = params.get('variant') ?? '';
	if (!(mode in STELLA_MODES) || !STELLA_PHASES.some((p) => p.id === phase) || !(VARIANTS as readonly string[]).includes(variant)) {
		return json({ error: 'invalid_selection' }, 400);
	}

	const text = composeStellaPrompt(mode as StellaModeId, phase, variant as StellaVariantId);
	return json({ text }, 200);
};
