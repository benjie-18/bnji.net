/**
 * Server-only verifier registry. A game registers a game-specific validator here;
 * absent validators fail closed and cannot create a score row.
 */
import type { PlayerContext } from './player-context';
import type { GameRoomNamespace } from './game-room-gateway';

export type ScoreClaim = {
	gameId: string;
	modeId: string;
	score: number;
	tieBreak: number | null;
	displayName: string;
	idempotencyKey: string;
	proof: unknown;
};
/**
 * `increment: true` marks an attested per-round win: the route recomputes
 * `score` as (current stored best for this player/game/mode) + 1 instead of
 * trusting a client-supplied total. The verifier still decides eligibility.
 */
export type VerifiedScore = { score: number; tieBreak: number | null; increment?: true };
/** Optional runtime the route passes (room namespace for DO attestations); absent in unit tests. */
export type ScoreRuntime = { GAME_ROOMS?: GameRoomNamespace };
export type ScoreVerifier = (claim: ScoreClaim, player: Pick<PlayerContext, 'sessionId' | 'playerId'>, runtime?: ScoreRuntime) => Promise<VerifiedScore | null>;

const verifiers = new Map<string, ScoreVerifier>();

/** Register a pure game-specific validation adapter. Never expose this module in a client bundle. */
export function registerScoreVerifier(gameId: string, verifier: ScoreVerifier): () => void {
	if (verifiers.has(gameId)) throw new Error(`score verifier already registered for ${gameId}`);
	verifiers.set(gameId, verifier);
	return () => { if (verifiers.get(gameId) === verifier) verifiers.delete(gameId); };
}

export function getScoreVerifier(gameId: string): ScoreVerifier | undefined {
	return verifiers.get(gameId);
}
