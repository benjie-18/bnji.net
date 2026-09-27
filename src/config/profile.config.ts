/**
 * BNJI.NET — profile analytics configuration.
 *
 * Policy values for profile views, reactions, and link-click tracking.
 * All values here are PUBLIC policy (limits, defaults). Storage and
 * infrastructure live in the existing D1/BOARD_DB binding.
 */

export const ALLOWED_REACTIONS = ['❤️', '🔥', '✨', '👀', '💀'] as const;

export type AllowedReaction = (typeof ALLOWED_REACTIONS)[number];

export const PROFILE_CONFIG = {
	/** Valid reaction emojis. Must match the keys in ALLOWED_REACTIONS. */
	allowedReactions: ALLOWED_REACTIONS as readonly string[],
	/** Cooldown between reactions of the same type from one session (ms). */
	reactionCooldownMs: 5 * 60 * 1000,
	/** Cookie name for the ephemeral session key. */
	sessionCookie: 'bnji_ps',
	/** Session cookie max-age in seconds (30 days). */
	sessionCookieMaxAge: 30 * 24 * 60 * 60,
	/** Session cookie attributes. */
	sessionCookieSameSite: 'Lax' as 'Lax' | 'Strict' | 'None',
} as const;