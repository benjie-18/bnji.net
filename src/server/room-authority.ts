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

/* ------------------------------------------------------------------------- *
 * Game-action seam (multiplayer games): a validated, bounded client action
 * mutates room state through the DO without riding the 5s state-frame write
 * budget. The DO supplies trusted clock/membership context; the handler
 * returns the canonical next state, exactly like the state authority.
 * ------------------------------------------------------------------------- */
export type GameActionRequest = {
	gameId: string;
	actor: { principalHash: string; memberId: string; isHost: boolean };
	action: string;
	payload: Record<string, unknown>;
	currentState: Record<string, unknown>;
	now: number;
	members: Array<{ memberId: string; principalHash: string }>;
	hasHost: boolean;
};
export type GameActionDecision = { allowed: true; state: Record<string, unknown>; reply?: Record<string, unknown> } | { allowed: false; error?: string };
export type GameActionHandler = (request: GameActionRequest) => GameActionDecision | Promise<GameActionDecision>;

const actionHandlers = new Map<string, GameActionHandler>();

/** Register one server-only action handler per stable game ID. */
export function registerGameActionHandler(gameId: string, handler: GameActionHandler): () => void {
	if (!GAME_ID_PATTERN.test(gameId) || typeof handler !== 'function') throw new Error('invalid_game_action_handler');
	if (actionHandlers.has(gameId)) throw new Error('game_action_handler_already_registered');
	actionHandlers.set(gameId, handler);
	return () => { if (actionHandlers.get(gameId) === handler) actionHandlers.delete(gameId); };
}

/** Fail closed: no handler, a throwing handler, or a malformed response all deny. */
export async function authorizeGameAction(request: GameActionRequest): Promise<GameActionDecision> {
	const handler = actionHandlers.get(request.gameId);
	if (!handler) return { allowed: false, error: 'game_adapter_unavailable' };
	try {
		const decision = await handler(request);
		if (!decision || typeof decision !== 'object' || typeof decision.allowed !== 'boolean') return { allowed: false, error: 'game_adapter_invalid_response' };
		if (!decision.allowed) return { allowed: false, error: typeof decision.error === 'string' ? decision.error.slice(0, 64) : 'game_action_rejected' };
		const state = decision.state;
		if (!state || typeof state !== 'object' || Array.isArray(state)) return { allowed: false, error: 'game_adapter_invalid_state' };
		const reply = decision.reply;
		return {
			allowed: true,
			state,
			// Actor-only payload (e.g. a private minefield view): never broadcast.
			reply: reply && typeof reply === 'object' && !Array.isArray(reply) ? reply : undefined,
		};
	} catch {
		return { allowed: false, error: 'game_adapter_failed' };
	}
}

/* ------------------------------------------------------------------------- *
 * Broadcast redaction: the canonical room state can carry server-truth that
 * a game must never push to clients (PvP Minesweeper's `placements` — every
 * player's incoming minefield). Registered redactors run on EVERY outgoing
 * snapshot/state/action frame for that game; no registration = unchanged.
 * ------------------------------------------------------------------------- */
export type GameStateRedactor = (state: Record<string, unknown>) => Record<string, unknown>;
const stateRedactors = new Map<string, GameStateRedactor>();

export function registerGameStateRedactor(gameId: string, redactor: GameStateRedactor): () => void {
	if (!GAME_ID_PATTERN.test(gameId) || typeof redactor !== 'function') throw new Error('invalid_game_state_redactor');
	if (stateRedactors.has(gameId)) throw new Error('game_state_redactor_already_registered');
	stateRedactors.set(gameId, redactor);
	return () => { if (stateRedactors.get(gameId) === redactor) stateRedactors.delete(gameId); };
}

/** Fail closed: a throwing or malformed redactor broadcasts an empty state. */
export function redactGameState(gameId: string, state: Record<string, unknown>): Record<string, unknown> {
	const redactor = stateRedactors.get(gameId);
	if (!redactor) return state;
	try {
		const next = redactor(state);
		return next && typeof next === 'object' && !Array.isArray(next) ? next : {};
	} catch {
		return {};
	}
}

/* ------------------------------------------------------------------------- *
 * Round-win attestation: the score route asks the room DO whether a principal
 * really won a specific round. Missing verifiers fail closed (null).
 * ------------------------------------------------------------------------- */
export type RoundWinResult = { ok: true; mode: string } | { ok: false };
export type RoundWinVerifier = (state: Record<string, unknown>, request: { principalHash: string; round: number }) => RoundWinResult | null;

const roundWinVerifiers = new Map<string, RoundWinVerifier>();

export function registerRoundWinVerifier(gameId: string, verifier: RoundWinVerifier): () => void {
	if (!GAME_ID_PATTERN.test(gameId) || typeof verifier !== 'function') throw new Error('invalid_round_win_verifier');
	if (roundWinVerifiers.has(gameId)) throw new Error('round_win_verifier_already_registered');
	roundWinVerifiers.set(gameId, verifier);
	return () => { if (roundWinVerifiers.get(gameId) === verifier) roundWinVerifiers.delete(gameId); };
}

/** Fail closed on missing verifier or thrown errors; `null` means "cannot attest". */
export function verifyRoundWin(gameId: string, state: Record<string, unknown>, request: { principalHash: string; round: number }): RoundWinResult | null {
	const verifier = roundWinVerifiers.get(gameId);
	if (!verifier) return null;
	try {
		const result = verifier(state, request);
		if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') return null;
		if (result.ok && typeof result.mode !== 'string') return null;
		return result;
	} catch {
		return null;
	}
}
