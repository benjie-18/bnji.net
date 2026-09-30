/** The one identity/session seam used by game tracking, scores, saves, and rooms. */
import { generateSessionKey, readSessionKey, sessionCookieHeader } from '../config/session.config';
import { clearPlayerSessionCookie, PLAYER_SESSION_COOKIE, readPlayerBySessionHash, sha256Hex, validPlayerSessionToken } from './player-store';
import type { D1Database } from './game-store';

export type PlayerContext = {
	/** Anonymous correlation key; never serialize it. */
	sessionId: string;
	/** Validated global player key; never serialize it. */
	playerId: string | null;
	/** Internal digest used only for revocation/rotation. */
	authSessionHash: string | null;
	setCookies: string[];
};

export class PlayerContextStorageError extends Error {
	constructor() { super('player_context_storage_unavailable'); }
}

const GUEST_SESSION_PATTERN = /^[a-f0-9]{32}$/;

function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get('cookie') ?? '';
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const match = header.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
	return match?.[1]?.trim() || null;
}

export function isPlayerSessionCookiePresent(request: Request): boolean {
	return readCookie(request, PLAYER_SESSION_COOKIE) !== null;
}

export async function resolvePlayerContext(request: Request, db?: D1Database, now = Date.now()): Promise<PlayerContext> {
	const setCookies: string[] = [];
	const candidate = readSessionKey(request);
	let sessionId: string;
	if (candidate && GUEST_SESSION_PATTERN.test(candidate)) sessionId = candidate;
	else {
		sessionId = generateSessionKey();
		setCookies.push(sessionCookieHeader(sessionId));
	}

	const sessionToken = readCookie(request, PLAYER_SESSION_COOKIE);
	if (!sessionToken) return { sessionId, playerId: null, authSessionHash: null, setCookies };
	if (!validPlayerSessionToken(sessionToken)) {
		setCookies.push(clearPlayerSessionCookie());
		return { sessionId, playerId: null, authSessionHash: null, setCookies };
	}
	if (!db || typeof db.prepare !== 'function') throw new PlayerContextStorageError();
	try {
		const tokenHash = await sha256Hex(sessionToken);
		const player = await readPlayerBySessionHash(db, tokenHash, now);
		if (!player) {
			setCookies.push(clearPlayerSessionCookie());
			return { sessionId, playerId: null, authSessionHash: null, setCookies };
		}
		return { sessionId, playerId: player.id, authSessionHash: tokenHash, setCookies };
	} catch {
		throw new PlayerContextStorageError();
	}
}

/** Append the resolver's guest/auth cookie changes without losing other response headers. */
export function appendPlayerCookies(headers: Headers, player: PlayerContext): void {
	for (const cookie of player.setCookies) headers.append('set-cookie', cookie);
}
