/**
 * BNJI.NET — the Settings "secret code" dispatcher.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * The Settings menu already has a masked code field, so codes can be typed in
 * before the effects they unlock exist. Keeping the dispatch here — rather than
 * in `SettingsOverlay.astro` or in the middle of `settings-overlay.ts` — means
 * the future work is ONE typed registry: add an entry to `CODE_HANDLERS` and the
 * overlay, the markup, the CSS and the tests need no edit at all. A handler is
 * also the only place a code is ever read, so "what did that code do?" has
 * exactly one answer, in one file.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not authentication, and it must never be allowed to become it.
 * Everything in this module runs in the visitor's own browser, so any list of
 * codes shipped to the client is readable by anyone who opens devtools: a
 * "secret" code here is a secret from nobody, and no amount of obfuscation
 * changes that. The registry is therefore a convenience for HARMLESS UI EFFECTS
 * ONLY — a handler may never grant access, reveal data, or change anything
 * another visitor can see. A feature that genuinely needs a secret code must
 * validate it server-side, behind `ACCESS_RULES` (see `src/config/access.config.ts`
 * and `docs/ADMIN.md`); nothing client-side can substitute for that.
 *
 * PRIVACY
 * -------
 * A submitted code is never written to the settings store, localStorage,
 * cookies, the URL or the console. It exists as a local variable for the length
 * of one dispatch and is dropped when `submitCode` returns; the caller clears
 * the input field at the same moment. No message below echoes the code back,
 * so a screenshot or a screen reader cannot leak it either.
 */

/** What a handler is handed. `code` is already trimmed; nothing keeps it. */
export type CodeSubmission = {
	code: string;
	/** The overlay root, so a handler can announce its own outcome in place. */
	overlay: HTMLElement;
};

/**
 * What a handler says. `unavailable` is the honest answer whenever no effect is
 * configured for a code — it must never read like the code was accepted.
 */
export type CodeOutcome =
	| { status: 'accepted'; message: string }
	| { status: 'rejected'; message: string }
	| { status: 'unavailable'; message: string };

/**
 * One future code effect. Return `null` for "not mine — try the next one";
 * return an outcome to own the submission. The first handler to accept wins,
 * so ordering is the only tie-break and a handler never sees a code another
 * handler already claimed.
 */
export type CodeHandler = (submission: CodeSubmission) => CodeOutcome | null;

/**
 * THE REGISTRY — deliberately empty.
 *
 * No codes exist yet, so there is nothing to dispatch. This is the only place
 * a real code ever belongs: add a `CodeHandler`, give it its own test, and the
 * Settings overlay picks it up without changing. Until then every submission
 * is answered with `CODE_UNAVAILABLE_MESSAGE`, which is the truth.
 */
import { armVerity } from './verity-balls';

export const handleVerityCode: CodeHandler = ({ code }) => {
	if (code === 'verity') {
		armVerity();
		return {
			status: 'accepted',
			message: 'Verity summoned! Close settings to drop the balls.',
		};
	}
	return null;
};

export const CODE_HANDLERS: readonly CodeHandler[] = [handleVerityCode];

/** Shown whenever nothing handled the code — which is every code today. */
export const CODE_UNAVAILABLE_MESSAGE = 'Code effects aren’t enabled yet.';

/** The idle hint on the status line, before anything has been submitted. */
export const CODE_IDLE_MESSAGE = 'Type a code and submit it.';

/** An empty submission is refused before any handler is reached. */
export const CODE_EMPTY_MESSAGE = 'Enter a code first.';

/**
 * Normalise before dispatching: trim the ends, collapse runs of inner
 * whitespace. Pure, so a future handler can be unit-tested against the exact
 * string it will receive.
 */
export function normalizeCode(raw: string): string {
	return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Run one submission through the registry. Handlers are only reached for a
 * non-empty code, and the first non-null outcome wins.
 */
export function submitCode(raw: string, overlay: HTMLElement): CodeOutcome {
	const code = normalizeCode(raw);
	if (code.length === 0) return { status: 'rejected', message: CODE_EMPTY_MESSAGE };
	for (const handler of CODE_HANDLERS) {
		const outcome = handler({ code, overlay });
		if (outcome) return outcome;
	}
	return { status: 'unavailable', message: CODE_UNAVAILABLE_MESSAGE };
}
