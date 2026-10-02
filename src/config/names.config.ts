/**
 * BNJI.NET — display-name and handle policy (Phase A of the chat plan).
 *
 * All values are PUBLIC: they are limits and reserved words, not secrets, and
 * the games UI imports them for input attributes. Every rule the server
 * enforces about names lives here — routes and the sanitizer in
 * `src/server/display-name.ts` only read these values.
 *
 * Replacing values: safe before deploy. Raising the display-name length above
 * 24 needs a matching migration only if you want the storage CHECK to match
 * (`game_players.display_name` allows 48 for historical reasons; the enforced
 * limit has always been 24 at the API edge).
 */
export type NamesConfig = {
	/** Display names are labels, not identity: 1–24 code points after sanitising. */
	displayName: {
		minLength: number;
		maxLength: number;
		/** Reserved so staff impersonation is harder; matched after NFKC + case-fold. */
		reserved: readonly string[];
	};
	/** One global handle per account — the first permanently public identifier. */
	handle: {
		minLength: number;
		maxLength: number;
		/** Exact-match discovery only: no directory, no suggestions, no prefix search. */
		changeCooldownDays: number;
	};
	/**
	 * The PUBLIC label every shared surface shows: `@handle · Display Name` when
	 * the account has claimed a handle, the display name alone otherwise. The
	 * cap is deliberately wider than a display name because it is a composition
	 * of two labels; it only ever bounds the composed string (leaderboards,
	 * room rosters, room chat) and is never written to a column with a CHECK.
	 */
	publicLabel: {
		/** Longest composed label that will render. 24 + separator + 21 is 48. */
		maxLength: number;
		/** Joiner between the handle and the display name. */
		separator: string;
	};
	guestProfiles: {
		/** Mirrors the bnji_ps session lifetime: a guest name is swept 30 days after its last change. */
		retentionDays: number;
	};
	limits: {
		/** POST /api/profile/name — KV fixed window, per IP (profile surfaces spend KV like the board). */
		nameChangeWindowMs: number;
		nameChangeMax: number;
		/** Handle claim + lookup — D1 fixed windows (game_auth_attempts), per hashed IP. */
		handleAttemptWindowMs: number;
		handleAttemptMax: number;
	};
};

export const NAMES_CONFIG: NamesConfig = {
	displayName: {
		minLength: 1,
		maxLength: 24,
		reserved: ['admin', 'moderator', 'bnji', 'system'],
	},
	handle: {
		minLength: 3,
		maxLength: 20,
		changeCooldownDays: 30,
	},
	publicLabel: {
		maxLength: 48,
		separator: ' · ',
	},
	guestProfiles: {
		retentionDays: 30,
	},
	limits: {
		nameChangeWindowMs: 600_000,
		nameChangeMax: 5,
		handleAttemptWindowMs: 900_000,
		handleAttemptMax: 8,
	},
};
