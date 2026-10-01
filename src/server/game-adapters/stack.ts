/**
 * `bnji.stack` server adapters — leaderboard verification for the isometric
 * stack game (ported from the Lab experiment at one fixed speed).
 *
 * Score verifier: a claim is the full drop record of one run. The verifier
 * replays it with the same shared rules the renderer uses and recomputes the
 * score and tie-break server-side; anything that does not reconstruct into a
 * complete run (ending on a fatal miss) is rejected.
 *
 * Mode contract: `default` — score = combo-weighted total, tie-break =
 * 999 − layers (deeper runs win ties; stored ascending).
 */
import { registerScoreVerifier } from '../score-verifiers';
import { stackTieBreak, verifyStackRun } from '../../game/stack-rules';

export const STACK_GAME_ID = 'bnji.isometric-stack';
export const STACK_MODE_ID = 'default';

registerScoreVerifier(STACK_GAME_ID, async (claim) => {
	if (claim.modeId !== STACK_MODE_ID) return null;
	const verdict = verifyStackRun(claim.proof);
	if (!verdict) return null;
	return { score: verdict.score, tieBreak: stackTieBreak(verdict.layers) };
});
