/** Game-specific authority seam for room state. No adapter means client state is rejected. */
import type { RoomStateMessage } from './game-room-protocol';

export type RoomStateTransition = {
	gameId: string;
	actor: { principalHash: string; memberId: string; isHost: boolean };
	baseRevision: number;
	currentRevision: number;
	currentState: Record<string, unknown>;
	proposedState: Record<string, unknown>;
};
export type RoomAuthorityDecision =
	| { allowed: true; state?: Record<string, unknown> }
	| { allowed: false; error?: string };
export type RoomStateAuthority = (transition: RoomStateTransition) => RoomAuthorityDecision | Promise<RoomAuthorityDecision>;

const GAME_ID_PATTERN = /^bnji\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const authorities = new Map<string, RoomStateAuthority>();

/** Register one server-only verifier per stable game ID. */
export function registerRoomStateAuthority(gameId: string, authority: RoomStateAuthority): () => void {
	if (!GAME_ID_PATTERN.test(gameId) || typeof authority !== 'function') throw new Error('invalid_room_authority');
	if (authorities.has(gameId)) throw new Error('room_authority_already_registered');
	authorities.set(gameId, authority);
	return () => { if (authorities.get(gameId) === authority) authorities.delete(gameId); };
}

/** Fail closed for games without a rule/turn verifier; exceptions are denials, never implicit approval. */
export async function authorizeRoomStateTransition(transition: RoomStateTransition): Promise<RoomAuthorityDecision> {
	const authority = authorities.get(transition.gameId);
	if (!authority) return { allowed: false, error: 'game_adapter_unavailable' };
	try {
		const decision = await authority(transition);
		if (!decision || typeof decision !== 'object' || typeof decision.allowed !== 'boolean') return { allowed: false, error: 'game_adapter_invalid_response' };
		if (!decision.allowed) return { allowed: false, error: typeof decision.error === 'string' ? decision.error.slice(0, 64) : 'game_action_rejected' };
		const state = decision.state ?? transition.proposedState;
		if (!state || typeof state !== 'object' || Array.isArray(state)) return { allowed: false, error: 'game_adapter_invalid_state' };
		return { allowed: true, state };
	} catch {
		return { allowed: false, error: 'game_adapter_failed' };
	}
}

/** Keep an explicit type reference here so verifier implementations share the parsed v1 contract. */
export type AuthorizedRoomState = RoomStateMessage['state'];
