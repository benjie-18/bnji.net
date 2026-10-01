/**
 * BNJI.NET — chat plan Phase D §7.4: image validation without decoding.
 *
 * Workers Free's 10 ms CPU budget is why ALL pixel decoding happens in the
 * browser (plan §7.4): the client normalises through <canvas> (bounds the
 * longest edge, re-encodes, and therefore strips EXIF incl. GPS before the
 * bytes leave the browser). The server's job here is deliberately dumb:
 *
 *   1. decode the base64 envelope (bounded — never allocate unbounded), and
 *   2. sniff the magic bytes: PNG / JPEG / RIFF-WebP only. The client's
 *      declared MIME type is never trusted, and SVG is refused outright
 *      (it is a script vector, not an image).
 *
 * Size is checked against DM_CONFIG.images.maxDecodedBytes (1.4 MB, the
 * board's documented D1 base64 ceiling — plan D6) on the DECODED length, so
 * base64 inflation cannot push a row past D1's 2 MB row limit.
 */
import { DM_CONFIG } from '../config/dm.config';

export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/webp';

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Magic-byte sniff: PNG / JPEG / WebP only. Never trust a declared type. */
export function sniffImageMime(bytes: Uint8Array): SniffedImageType | null {
	if (bytes.length >= 8 &&
		bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
		bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
		return 'image/png';
	}
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'image/jpeg';
	}
	if (bytes.length >= 12 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) { // WEBP
		return 'image/webp';
	}
	return null;
}

/**
 * Strict base64 decode with a decoded-size ceiling. `allowed` (from config)
 * is intersected with the sniff result — the caller only stores a mime the
 * sniffing AND the allowlist both accept.
 */
export function decodeImageBase64(value: string): { ok: true; bytes: Uint8Array } | { ok: false; error: 'invalid_base64' | 'image_too_large' } {
	const compact = value.trim();
	// Cheap size gate BEFORE decoding: ceil(n/4)*3 >= decoded length bound.
	const worstDecoded = Math.floor((compact.length * 3) / 4);
	if (worstDecoded > DM_CONFIG.images.maxDecodedBytes) return { ok: false, error: 'image_too_large' };
	if (!BASE64_PATTERN.test(compact) || compact.length % 4 !== 0) return { ok: false, error: 'invalid_base64' };
	let binary: string;
	try {
		binary = atob(compact);
	} catch {
		return { ok: false, error: 'invalid_base64' };
	}
	if (binary.length > DM_CONFIG.images.maxDecodedBytes) return { ok: false, error: 'image_too_large' };
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return { ok: true, bytes };
}

/** Full server-side validation: bounded decode + sniff + allowlist. */
export function validateImageUpload(value: string): { ok: true; bytes: Uint8Array; mime: SniffedImageType } | { ok: false; error: 'invalid_base64' | 'image_too_large' | 'unsupported_image_type' } {
	if (!DM_CONFIG.images.enabled) return { ok: false, error: 'unsupported_image_type' };
	const decoded = decodeImageBase64(value);
	if (!decoded.ok) return decoded;
	const sniffed = sniffImageMime(decoded.bytes);
	if (!sniffed || !(DM_CONFIG.images.allowedTypes as readonly string[]).includes(sniffed)) {
		return { ok: false, error: 'unsupported_image_type' };
	}
	return { ok: true, bytes: decoded.bytes, mime: sniffed };
}
