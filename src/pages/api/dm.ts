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
import { getSiteSettings } from '../../server/site-settings-store';
import { rateLimit, type KvRateLimitStore } from '../../server/ratelimit';
import { getSecurityStore } from '../../server/security-store';
import { buildSecurityEvent } from '../../server/security-helpers';
import { readSessionKey } from '../../config/session.config';
import { serverEnvironment } from '../../server/env';
import { clientIp } from '../../server/security-helpers';
import type { APIContext } from 'astro';

export const prerender = false;

const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export async function GET(): Promise<Response> {
	const settings = await getSiteSettings();
	return json({
		enabled: settings.dmProvider !== 'none',
		provider: settings.dmProvider,
		maxLength: settings.dmMaxLength,
	});
}

export async function POST(context: APIContext): Promise<Response> {
	const settings = await getSiteSettings();
	if (settings.dmProvider === 'none') {
		return json({ state: 'not_configured' }, 503);
	}

	const env = await serverEnvironment();
	const secrets = env as Record<string, string | undefined>;
	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const key = clientIp(context.request);

	// KV-backed windows: consistent across Worker isolates.
	const cooldown = await rateLimit(
		kv,
		`dm:post:${key}`,
		settings.dmCooldownSeconds * 1000,
		1,
	);
	if (!cooldown.allowed) {
		return json({ state: 'rate_limited', retryAfter: cooldown.retryAfter }, 429);
	}
	const hourly = await rateLimit(kv, `dm:hour:${key}`, 3_600_000, 10);
	if (!hourly.allowed) {
		return json({ state: 'rate_limited', retryAfter: hourly.retryAfter }, 429);
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
	if (message.length === 0 || message.length > settings.dmMaxLength) {
		return json({ state: 'invalid', maxLength: settings.dmMaxLength }, 422);
	}
	const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, 320) : '';

	/* Security logging, surface='dm'.
	   Fires once when the message is ACCEPTED for delivery, not once per
	   upstream attempt: the abuse-relevant fact is "this client submitted a
	   private message", and the provider branch below may fail in ways that
	   would otherwise multiply one submission into several events.

	   Deliberately does NOT store the message text or the contact string.
	   A private message is the most sensitive thing anyone sends this site,
	   and abuse response needs to know who sent it and from where — not what
	   it said. The content lives only in the operator's chosen provider
	   (Discord/ntfy), which is where the operator asked for it to go. */
	const logAccepted = (): void => {
		const secStore = getSecurityStore(env);
		if (!secStore) return;
		/* Uses an EXISTING session key when the visitor already has one, so a
		   DM can be tied to the same person as their board/profile activity
		   earlier in the visit. It deliberately does not mint a new one or set
		   a cookie: the DM form has no page load or follow-up beacon to
		   enrich, so a cookie issued here would earn nothing and set a
		   tracking cookie on a page whose whole purpose is to be private. */
		void buildSecurityEvent(context.request, {
			surface: 'dm',
			endpoint: 'dm-post',
			sessionKey: readSessionKey(context.request) ?? undefined,
		})
			.then((event) => secStore.recordEvent(event))
			.catch(() => {});
	};

	try {
		if (settings.dmProvider === 'discord') {
			const webhook = secrets.DISCORD_WEBHOOK_URL;
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
			logAccepted();
			return json({ state: 'sent' });
		}

		if (settings.dmProvider === 'ntfy') {
			const topic = secrets.NTFY_URL;
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
			logAccepted();
			return json({ state: 'sent' });
		}
	} catch (error) {
		console.error('[bnji] dm delivery failed:', error);
		return json({ state: 'upstream_error' }, 502);
	}

	return json({ state: 'not_configured' }, 503);
}
