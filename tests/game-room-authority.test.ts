import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeRoomStateTransition, registerRoomStateAuthority, type RoomStateTransition } from '../src/server/room-authority';

const transition: RoomStateTransition = {
	gameId: 'bnji.glass-minesweeper',
	actor: { principalHash: 'a'.repeat(64), memberId: 'b'.repeat(24), isHost: true },
	baseRevision: 2,
	currentRevision: 2,
	currentState: { turn: 2 },
	proposedState: { turn: 3 },
};

test('room state authority refuses unregistered games and never turns verifier failures into approval', async () => {
	assert.deepEqual(await authorizeRoomStateTransition(transition), { allowed: false, error: 'game_adapter_unavailable' });
	const remove = registerRoomStateAuthority(transition.gameId, () => { throw new Error('secret verifier detail'); });
	try {
		assert.deepEqual(await authorizeRoomStateTransition(transition), { allowed: false, error: 'game_adapter_failed' });
	} finally { remove(); }
	const invalidResponse = registerRoomStateAuthority(transition.gameId, () => null as never);
	try {
		assert.deepEqual(await authorizeRoomStateTransition(transition), { allowed: false, error: 'game_adapter_invalid_response' });
	} finally { invalidResponse(); }
});

test('room verifier rejection is respected and accepted state can only come from the registered game adapter', async () => {
	const denied = registerRoomStateAuthority(transition.gameId, () => ({ allowed: false, error: 'wrong_turn' }));
	try {
		assert.deepEqual(await authorizeRoomStateTransition(transition), { allowed: false, error: 'wrong_turn' });
	} finally { denied(); }
	const accepted = registerRoomStateAuthority(transition.gameId, (input) => ({ allowed: true, state: { turn: input.currentRevision + 1, source: 'server-rule-adapter' } }));
	try {
		assert.deepEqual(await authorizeRoomStateTransition(transition), { allowed: true, state: { turn: 3, source: 'server-rule-adapter' } });
	} finally { accepted(); }
});

test('room authority registration rejects invalid IDs and duplicate adapters', () => {
	assert.throws(() => registerRoomStateAuthority('../game', () => ({ allowed: true })), /invalid_room_authority/);
	const remove = registerRoomStateAuthority(transition.gameId, () => ({ allowed: true }));
	try { assert.throws(() => registerRoomStateAuthority(transition.gameId, () => ({ allowed: true })), /room_authority_already_registered/); }
	finally { remove(); }
});
