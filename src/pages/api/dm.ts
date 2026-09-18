/**
 * BNJI.NET — private direct-message API boundary.
 *
 *   GET  /api/dm   { enabled, provider, maxLength }   (safe, public info)
 *   POST /api/dm   { message, contact? }              -> delivery attempt
 *
 * NOT prerendered: delivery credentials are read from the Worker environment
 * on every request and never reach the browser:
 *
 *   DISCORD_WEBHOOK_URL   Discord webhook (includes its token) — provider 'discord'
 *   NTFY_URL              ntfy.sh / self-hosted topic URL     — provider 'ntfy'
 *
 * Set them with `npx wrangler secret put <NAME>` (or `.dev.vars` locally,
 * which is git-ignored). The provider choice itself is public configuration
 * in src/config/integrations.config.ts.
 *
 * States returned to the client (the form renders each one):
 *   200 sent · 422 invalid · 429 rate_limited · 503 not_configured ·
 *   502 upstream_error
 */
import { DM_INTEGRATION } from '../../config/integrations.config';
import { rateLimit, retryAfterSeconds } from '../../server/ratelimit';
import { serverEnvironment } from '../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function clientKey(request: Request): string {
	const cf = (request as Request & { cf?: { connectingIp?: string } }).cf;
	return cf?.connectingIp ?? request.headers.get('cf-connecting-ip') ?? 'unknown';
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export function GET(): Response {
	return json({
		enabled: DM_INTEGRATION.provider !== 'none',
		provider: DM_INTEGRATION.provider,
		maxLength: DM_INTEGRATION.maxLength,
	});
}

export async function POST(context: APIContext): Promise<Response> {
	if (DM_INTEGRATION.provider === 'none') {
		return json({ state: 'not_configured' }, 503);
	}

	const key = clientKey(context.request);
	if (!rateLimit(`dm:post:${key}`, DM_INTEGRATION.cooldownSeconds * 1000, 1)) {
		return json(
			{
				state: 'rate_limited',
				retryAfter: retryAfterSeconds(`dm:post:${key}`, DM_INTEGRATION.cooldownSeconds * 1000),
			},
			429,
		);
	}
	if (!rateLimit(`dm:hour:${key}`, 3_600_000, 10)) {
		return json({ state: 'rate_limited', retryAfter: 60 }, 429);
	}

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return json({ state: 'invalid' }, 400);
	}
	const body = (payload ?? {}) as { message?: unknown; contact?: unknown };
	const message =
		typeof body.message === 'string' ? body.message.replace(CONTROL_CHARS, '').trim() : '';
	if (message.length === 0 || message.length > DM_INTEGRATION.maxLength) {
		return json({ state: 'invalid', maxLength: DM_INTEGRATION.maxLength }, 422);
	}
	const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, 320) : '';

	const env = (await serverEnvironment()) as Record<string, string | undefined>;

	try {
		if (DM_INTEGRATION.provider === 'discord') {
			const webhook = env.DISCORD_WEBHOOK_URL;
			if (!webhook) return json({ state: 'not_configured' }, 503);
			const response = await fetch(webhook, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					username: 'BNJI.NET contact form',
					embeds: [
						{
							title: 'New private message',
							description: message,
							...(contact ? { footer: { text: `reply to: ${contact}` } } : {}),
							timestamp: new Date().toISOString(),
						},
					],
				}),
			});
			if (!response.ok) return json({ state: 'upstream_error' }, 502);
			return json({ state: 'sent' });
		}

		if (DM_INTEGRATION.provider === 'ntfy') {
			const topic = env.NTFY_URL;
			if (!topic) return json({ state: 'not_configured' }, 503);
			const response = await fetch(topic, {
				method: 'POST',
				headers: {
					title: 'BNJI.NET private message',
					...(contact ? { tags: 'incoming_envelope' } : {}),
				},
				body: contact ? `${message}\n\n— reply to: ${contact}` : message,
			});
			if (!response.ok) return json({ state: 'upstream_error' }, 502);
			return json({ state: 'sent' });
		}
	} catch (error) {
		console.error('[bnji] dm delivery failed:', error);
		return json({ state: 'upstream_error' }, 502);
	}

	return json({ state: 'not_configured' }, 503);
}
