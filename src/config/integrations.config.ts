/**
 * Private direct-message integration — CONFIGURATION (public part).
 *
 * Visitors can send a private message to the site owner from /me/contact/.
 * The message is delivered server-side by `src/pages/api/dm.ts`, which reads
 * ALL credentials from environment variables. Nothing secret lives here.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  CHOOSE A PROVIDER HERE, then set its secret in the environment.     │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 *   provider: 'none'   — the contact form renders an explained disabled state.
 *   provider: 'discord'— POSTs an embed to a Discord webhook.
 *        SECRET env: DISCORD_WEBHOOK_URL   (full webhook URL, includes token)
 *        Set with:   npx wrangler secret put DISCORD_WEBHOOK_URL
 *        Locally:    .dev.vars  (git-ignored)
 *   provider: 'ntfy'   — pushes a desktop/mobile notification via an ntfy.sh
 *                        topic (self-hostable).
 *        SECRET env: NTFY_URL   (e.g. https://ntfy.sh/your-private-topic, or
 *                                a self-hosted topic URL with access token)
 *        Set with:   npx wrangler secret put NTFY_URL
 *
 * Rate limits and payload validation live in BOARD/DM server code, not here.
 * PUBLIC vs SECRET: `provider` is public (the client needs to know whether the
 * form is enabled). Every URL/token is SECRET and environment-only.
 */
export type DmIntegrationConfig = {
	provider: 'none' | 'discord' | 'ntfy';
	/** Max characters accepted per message (server enforces the same). */
	maxLength: number;
	/** Cooldown between accepted messages from one client, in seconds. */
	cooldownSeconds: number;
};

export const DM_INTEGRATION: DmIntegrationConfig = {
	// ▼▼▼ CONFIGURE HERE ▼▼▼
	provider: 'none',
	// ▲▲▲ CONFIGURE HERE ▲▲▲
	maxLength: 1000,
	cooldownSeconds: 30,
};
