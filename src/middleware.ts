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
import { ADMIN_PATTERN, isAdminRequest } from './server/admin';
import { secretEnv } from './server/env';

/**
 * A login redirect that remembers where the request was going.
 *
 * The login page only honours same-site relative paths (see
 * safePostLoginRedirect in src/scripts/admin.ts), so a crafted value cannot
 * bounce the operator elsewhere — and redirectTo itself is a static config
 * value, never request input. The hash is not sent to the server, so a deep
 * link loses its selection; the page still loads on its default.
 */
function loginRedirect(redirectTo: string, context: { url: URL }): string {
	const next = `${context.url.pathname}${context.url.search}`;
	const separator = redirectTo.includes('?') ? '&' : '?';
	return `${redirectTo}${separator}next=${encodeURIComponent(next)}`;
}

export const onRequest = defineMiddleware(async (context, next) => {
	const pathname = context.url.pathname;
	const rule = ACCESS_RULES.find((r) => {
		if (!pathname.startsWith(r.pattern)) return false;
		// An excluded exact path is not protected by this rule. Compared with
		// a trailing slash normalised away, so '/admin/login/' and
		// '/admin/login' are the same exclusion — a request cannot smuggle
		// past the rule by varying the slash.
		if (r.exclude?.length) {
			const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
			if (r.exclude.includes(normalized) || r.exclude.includes(pathname)) return false;
		}
		return true;
	});
	if (!rule) return next();

	const gate = { request: context.request, cookies: context.cookies };

	// Admin rules delegate to the ONE admin guard rather than the generic
	// env-var check. Two implementations of "is this an admin" would be two
	// things to keep in step, and the admin credential now lives in the
	// database rather than ACCESS_TOKEN — so the generic path would answer
	// from a stale source and disagree with every admin route.
	if (rule.sessionPattern === ADMIN_PATTERN) {
		if (await isAdminRequest(gate)) return next();
		if (rule.redirectTo) return context.redirect(loginRedirect(rule.redirectTo, context));
		return new Response(JSON.stringify({ error: 'unauthorized' }), {
			status: 401,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
		});
	}

	const env = secretEnv();
	const authorized = await isAuthorized(gate, rule, env);
	if (authorized) return next();

	if (rule.redirectTo) {
		return context.redirect(loginRedirect(rule.redirectTo, context));
	}
	return new Response(JSON.stringify({ error: 'unauthorized' }), {
		status: 401,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
});
