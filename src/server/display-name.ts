/**
 * BNJI.NET — the single display-name / handle validator.
 *
 * Display names and handles are LABELS, not identity (chat plan §4): they
 * carry no privileges and grant no access. Every server surface that accepts
 * a name — account create, rename, guest profile naming — goes through this
 * module so the rules can never drift between routes.
 *
 * Pipeline for display names:
 *   1. NFKC               — folds compatibility forms (fullwidth ａ, ligature ﬁ)
 *                           into canonical shapes, so reserved-name and
 *                           character checks see the real text.
 *   2. Strip \p{Cc}+\p{Cf} — control and format characters: bidi overrides
 *                           (U+202E), ZWJ, BOM, zero-width anything. Whitespace
 *                           controls (\t \n) become spaces first so they
 *                           collapse instead of vanishing between words.
 *   3. Collapse whitespace — runs become a single space, then trim.
 *   4. Length              — 1–24 CODE POINTS (emoji count as 2 for surrogates
 *                           only when split; [...str] counts real code points).
 *   5. Charset             — letters, marks (combining accents), numbers,
 *                           space, underscore, hyphen, period. No emoji, no
 *                           @, no punctuation beyond the list.
 *   6. Reserved            — exact match after case-fold, so "Admin",
 *                           "ADMIN" and fullwidth "ａｄｍｉｎ" (NFKC→admin)
 *                           are all refused.
 *
 * Handles are the stricter, permanently-public form: ^[a-z0-9_]{3,20}$.
 * The reserved list applies to handles too (deliberate tightening of plan §4
 * whose stated purpose is "staff impersonation is harder" — an @admin handle
 * would defeat a reserved admin display name).
 */
import { NAMES_CONFIG } from '../config/names.config';

export type DisplayNameResult =
	| { ok: true; name: string }
	| { ok: false; error: 'invalid_display_name' | 'display_name_too_long' | 'display_name_reserved' };

export type PlainTextResult = { ok: true; value: string } | { ok: false; error: 'empty' | 'too_long' };

/**
 * The shared NFKC → strip control/format → collapse → trim pipeline, used by
 * display names AND room-chat message text (plan §12.2). Length is counted in
 * code points. No charset restriction — chat text may be any printable
 * Unicode; rendering stays `textContent`-only so that is safe.
 */
export function sanitizePlainText(value: unknown, maxLength: number): PlainTextResult {
	if (typeof value !== 'string') return { ok: false, error: 'empty' };
	const text = value.normalize('NFKC')
		// Whitespace controls (\t \n \r) become a space; every other control or
		// format character (NUL, RLO, ZWJ, BOM) is deleted outright.
		.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (/\s/u.test(char) ? ' ' : ''))
		.replace(/\s+/gu, ' ')
		.trim();
	if (!text) return { ok: false, error: 'empty' };
	if ([...text].length > maxLength) return { ok: false, error: 'too_long' };
	return { ok: true, value: text };
}

export function sanitizeDisplayName(value: unknown): DisplayNameResult {
	// Sanitise without a length cap first: charset is checked before length so
	// a 30-emoji string reports the honest "invalid", never "too long".
	const base = sanitizePlainText(value, Number.MAX_SAFE_INTEGER);
	if (!base.ok) return { ok: false, error: 'invalid_display_name' };
	const name = base.value;
	// Charset: letters, marks (combining accents), numbers, space, underscore,
	// hyphen, period. No emoji, no @, no punctuation beyond the list.
	if (!/^[\p{L}\p{M}\p{N} _\-.]+$/u.test(name)) return { ok: false, error: 'invalid_display_name' };
	// Count code points, not UTF-16 units: one astral CJK character = 1.
	if ([...name].length > NAMES_CONFIG.displayName.maxLength) return { ok: false, error: 'display_name_too_long' };
	// Reserved after case-fold — matches "Admin", "ADMIN", fullwidth "ａｄｍｉｎ".
	if ((NAMES_CONFIG.displayName.reserved as readonly string[]).includes(name.toLowerCase())) {
		return { ok: false, error: 'display_name_reserved' };
	}
	return { ok: true, name };
}

export function isValidHandle(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const { minLength, maxLength } = NAMES_CONFIG.handle;
	if (!new RegExp(`^[a-z0-9_]{${minLength},${maxLength}}$`).test(value)) return false;
	return !(NAMES_CONFIG.displayName.reserved as readonly string[]).includes(value);
}
