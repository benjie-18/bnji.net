/**
 * BNJI.NET — route guard middleware.
 *
 * Enforces src/config/access.config.ts (ACCESS_RULES) on every request that
 * runs Worker code. Honest scope, repeated here because it matters:
 *
 *   - Prerendered (static) pages are served by the edge WITHOUT running this
 *     middleware. They cannot be protected. Any route listed in ACCESS_RULES
 *     must set `export const prerender = false;` in its page file.
 *   - With the default empty rule list this middleware is a pure pass-through:
 *     all current public pages stay public.
 *   - This is a boundary, not decoration: it never "hides" content client-side
 *     and never pretends to protect static assets.
 */
import { defineMiddleware } from 'astro:middleware';
import { ACCESS_RULES } from './config/access.config';
import { isAuthorized } from './server/access';
import { secretEnv } from './server/env';

export const onRequest = defineMiddleware(async (context, next) => {
	const rule = ACCESS_RULES.find((r) => context.url.pathname.startsWith(r.pattern));
	if (!rule) return next();

	const env = secretEnv();
	const authorized = await isAuthorized(
		{ request: context.request, cookies: context.cookies },
		rule,
		env,
	);
	if (authorized) return next();

	if (rule.redirectTo) return context.redirect(rule.redirectTo);
	return new Response(JSON.stringify({ error: 'unauthorized' }), {
		status: 401,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
});
