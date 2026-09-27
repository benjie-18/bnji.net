/**
 * BNJI.NET — profile analytics configuration.
 *
 * Policy values for profile views, reactions, and link-click tracking.
 * All values here are PUBLIC policy (limits, defaults). Storage and
 * infrastructure live in the existing D1/BOARD_DB binding.
 *
 * The session cookie is NOT declared here: it is site-wide (the board needs
 * the same key for its own security correlation), so its single definition
 * lives in SESSION_CONFIG. The fields below are re-exported from it for the
 * admin config surface, which reports every public knob from one place.
 */
import { SESSION_CONFIG } from './session.config';

export const ALLOWED_REACTIONS = ['❤️', '🔥', '✨', '👀', '💀'] as const;

export type AllowedReaction = (typeof ALLOWED_REACTIONS)[number];

export const PROFILE_CONFIG = {
	/** Valid reaction emojis. Must match the keys in ALLOWED_REACTIONS. */
	allowedReactions: ALLOWED_REACTIONS as readonly string[],
	/** Cooldown between reactions of the same type from one session (ms). */
	reactionCooldownMs: 5 * 60 * 1000,
	/** Cookie name for the ephemeral session key (from SESSION_CONFIG). */
	sessionCookie: SESSION_CONFIG.cookie,
	/** Session cookie max-age in seconds (from SESSION_CONFIG). */
	sessionCookieMaxAge: SESSION_CONFIG.maxAgeSeconds,
	/** Session cookie SameSite attribute (from SESSION_CONFIG). */
	sessionCookieSameSite: SESSION_CONFIG.sameSite,
} as const;