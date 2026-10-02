/**
 * `bnji.pvp-minesweeper` browser client.
 *
 * Server-authoritative race: every move is a game action (never a raw state
 * proposal), and the room socket is the source of truth. The client renders
 * only what the server broadcasts plus its own actor-only `action_result`
 * replies — the field view (`numbers`) is private per racer and must never
 * be derived from the broadcast state, whose `placements` the DO redacts.
 *
 * Flow: vote (5s) → simultaneous mine placement on the opponents' boards →
 * race to clear your own received board → 5s results (minefields revealed).
 * A mine click is a deny (`hit_mine`); the client reports itself out with
 * `ms_die`, scoring the kill for whoever designed the field.
 */
import {
	MS_DIFFICULTY_ORDER,
	MS_PLACE_MS,
	MS_RESULTS_MS,
	MS_VOTE_MS,
	msContributorBudget,
	msDecodeBitset,
	msDifficulty,
	msEncodeBitset,
	msGetMine,
	msSetMine,
	msSpec,
	type MinesweeperDifficulty,
} from '../../game/minesweeper-rules';
import type { GameModule } from '../game-runtime';
import type { RoomNotice } from '../game-rooms';
import { setGameShellState } from '../game-shell';
import { createRunToken, idempotencyKey, submitAttestedWin, submitRun } from '../game-scores';

const MS_GAME_ID = 'bnji.pvp-minesweeper';

type MsPhase = 'lobby' | 'vote' | 'place' | 'race' | 'results';
type MsResults = {
	round: number;
	difficulty: MinesweeperDifficulty;
	winner: string | null;
	winnerHash: string | null;
	reason: 'clear' | 'elimination' | 'draw';
	mineCells?: Record<string, string>;
};
type MsView = {
	phase: MsPhase;
	phaseAt: number;
	round: number;
	votes: Record<string, MinesweeperDifficulty>;
	difficulty: MinesweeperDifficulty | null;
	roster: string[];
	ready: string[];
	alive: string[];
	clicks: Record<string, number[]>;
	wins: Record<string, number>;
	results: MsResults | null;
};

function normalizeView(raw: unknown): MsView | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	const phase = value.phase;
	if (phase !== 'lobby' && phase !== 'vote' && phase !== 'place' && phase !== 'race' && phase !== 'results') return null;
	const votes: Record<string, MinesweeperDifficulty> = {};
	if (value.votes && typeof value.votes === 'object' && !Array.isArray(value.votes)) {
		for (const [member, choice] of Object.entries(value.votes as Record<string, unknown>)) {
			const parsed = msDifficulty(choice);
			if (parsed) votes[member] = parsed;
		}
	}
	const difficulty = msDifficulty(value.difficulty);
	const roster = Array.isArray(value.roster) ? value.roster.filter((member): member is string => typeof member === 'string') : [];
	const ready = Array.isArray(value.ready) ? value.ready.filter((member): member is string => typeof member === 'string') : [];
	const alive = Array.isArray(value.alive) ? value.alive.filter((member): member is string => typeof member === 'string') : [];
	const clicks: Record<string, number[]> = {};
	if (value.clicks && typeof value.clicks === 'object' && !Array.isArray(value.clicks)) {
		for (const [member, cells] of Object.entries(value.clicks as Record<string, unknown>)) {
			if (Array.isArray(cells)) clicks[member] = cells.filter((cell): cell is number => typeof cell === 'number' && Number.isSafeInteger(cell));
		}
	}
	const wins: Record<string, number> = {};
	if (value.wins && typeof value.wins === 'object' && !Array.isArray(value.wins)) {
		for (const [member, count] of Object.entries(value.wins as Record<string, unknown>)) {
			if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) wins[member] = count;
		}
	}
	let results: MsResults | null = null;
	if (value.results && typeof value.results === 'object' && !Array.isArray(value.results)) {
		const rawResults = value.results as Record<string, unknown>;
		const resultDifficulty = msDifficulty(rawResults.difficulty);
		if (resultDifficulty) {
			results = {
				round: typeof rawResults.round === 'number' ? rawResults.round : 0,
				difficulty: resultDifficulty,
				winner: typeof rawResults.winner === 'string' ? rawResults.winner : null,
				winnerHash: typeof rawResults.winnerHash === 'string' ? rawResults.winnerHash : null,
				reason: rawResults.reason === 'elimination' || rawResults.reason === 'draw' ? rawResults.reason : 'clear',
			};
			if (rawResults.mineCells && typeof rawResults.mineCells === 'object' && !Array.isArray(rawResults.mineCells)) {
				const mineCells: Record<string, string> = {};
				for (const [target, bitset] of Object.entries(rawResults.mineCells as Record<string, unknown>)) {
					if (typeof bitset === 'string') mineCells[target] = bitset;
				}
				results.mineCells = mineCells;
			}
		}
	}
	return {
		phase,
		phaseAt: typeof value.phaseAt === 'number' ? value.phaseAt : 0,
		round: typeof value.round === 'number' ? value.round : 0,
		votes,
		difficulty,
		roster,
		ready,
		alive,
		clicks,
		wins,
		results,
	};
}

/* Score claims go through the shared client (`../game-scores`): a win is
 * attested-increment, so the server owns the number and the client only needs
 * a stable key so a retry is not a second claim. */

export type PvpMinesweeperGame = ReturnType<typeof createPvpMinesweeperGame>;

export function createPvpMinesweeperGame() {
	// ------------------------------------------------------------- page refs
	const statusEl = document.querySelector<HTMLElement>('[data-ms-status]');
	const phaseEl = document.querySelector<HTMLElement>('[data-ms-phase]');
	const boardEl = document.querySelector<HTMLElement>('[data-ms-board]');
	const startButton = document.querySelector<HTMLButtonElement>('[data-ms-start]');
	const voteButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ms-vote]'));
	const winsEl = document.querySelector<HTMLElement>('[data-ms-wins]');
	const placeCountEl = document.querySelector<HTMLElement>('[data-ms-place-count]');
	const placeSubmit = document.querySelector<HTMLButtonElement>('[data-ms-place-submit]');
	const targetsEl = document.querySelector<HTMLElement>('[data-ms-targets]');
	const countdownEls = Array.from(document.querySelectorAll<HTMLElement>('[data-ms-countdown]'));
	const raceNoteEl = document.querySelector<HTMLElement>('[data-ms-race-note]');
	const resultNote = document.querySelector<HTMLElement>('[data-ms-result-note]');
	const claimForm = document.querySelector<HTMLFormElement>('[data-ms-claim]');
	const claimNote = document.querySelector<HTMLElement>('[data-ms-claim-note]');
	const claimStatus = document.querySelector<HTMLElement>('[data-ms-claim-status]');
	const claimName = claimForm?.querySelector<HTMLInputElement>('[name="displayName"]') ?? null;
	const claimBack = document.querySelector<HTMLButtonElement>('[data-ms-results-back]');
	const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-ms-panel]'));

	// ------------------------------------------------------------- game state
	let view: MsView | null = null;
	let roomRevision = 0;
	let activeGameId: string | null = null;
	let socket: WebSocket | null = null;
	let myMemberId: string | null = null;
	let myIsHost = false;
	let memberLabels = new Map<string, string>();
	let inputLocked = false;
	let claimDone = false;
	/** Per-WIN token; regenerated each time a new results phase is announced to this member. */
	let runToken = createRunToken();
	let autoClaimKey = '';
	let resultsAcknowledged = false;
	let lastResultsRound = -1;
	// Private field view (actor-only replies): adjacency digits + revealed cells.
	let fieldNumbers: number[] | null = null;
	let fieldRevealed = new Set<number>();
	let myClicks: number[] = [];
	let pendingCell: number | null = null;
	let boomCell: number | null = null;
	let spectator = false;
	// Placement editor state (my authored boards).
	let placementTarget = 0;
	let placementSelection = new Map<number, Set<number>>();
	let placementSubmitted = false;
	// Countdown bookkeeping: one auto-sync per phase window.
	let syncKey: string | null = null;
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	let destroyed = false;

	function say(message: string): void { if (statusEl) statusEl.textContent = message; }
	function phaseSay(message: string): void { if (phaseEl) phaseEl.textContent = message; }
	function showShell(state: 'ready' | 'results'): void {
		const shell = document.querySelector<HTMLElement>('[data-game-shell]');
		if (shell && shell.dataset.gameState !== state) setGameShellState(shell, state);
	}
	function labelOf(memberId: string): string {
		if (memberId === myMemberId) return 'you';
		return memberLabels.get(memberId) ?? 'opponent';
	}
	function sendAction(action: string, payload: Record<string, unknown> = {}): void {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			say('The room connection is not ready yet — join or create a room below.');
			return;
		}
		socket.send(JSON.stringify({ v: 1, type: 'action', action, payload }));
	}
	function spec() {
		return msSpec(view?.difficulty ?? 'normal');
	}
	function phaseWindow(): number {
		switch (view?.phase) {
			case 'vote': return MS_VOTE_MS;
			case 'place': return MS_PLACE_MS;
			case 'results': return MS_RESULTS_MS;
			default: return 0;
		}
	}

	// ------------------------------------------------------------- placement
	function authoredTargets(): number[] {
		if (!view || !myMemberId) return [];
		const ownIdx = view.roster.indexOf(myMemberId);
		if (ownIdx < 0) return [];
		return view.roster.map((_, index) => index).filter((index) => index !== ownIdx);
	}
	function authorIndexOf(target: number): number {
		if (!myMemberId || !view) return 0;
		const ownIdx = view.roster.indexOf(myMemberId);
		return target < ownIdx ? ownIdx - 1 : ownIdx;
	}
	function budgetForTarget(target: number): number {
		if (!view?.difficulty) return 0;
		return msContributorBudget(msSpec(view.difficulty).mines, authorIndexOf(target), Math.max(1, view.roster.length - 1));
	}
	function selectionFor(target: number): Set<number> {
		let selection = placementSelection.get(target);
		if (!selection) {
			selection = new Set();
			placementSelection.set(target, selection);
		}
		return selection;
	}

	// ---------------------------------------------------------------- render
	function setPanel(phase: MsPhase): void {
		for (const panel of panels) panel.hidden = panel.dataset.msPanel !== phase;
	}
	function renderBoard(): void {
		if (!boardEl) return;
		const size = view?.difficulty ? spec().size : 6;
		boardEl.style.setProperty('--ms-size', String(size));
		const cellCount = size * size;
		const phase = view?.phase ?? 'lobby';
		const mineIdx = view && myMemberId ? view.roster.indexOf(myMemberId) : -1;
		const raceMode = phase === 'race' && !spectator && view?.alive.includes(myMemberId ?? '');
		const resultMines = phase === 'results' && view?.results?.mineCells && mineIdx >= 0
			? msDecodeBitset(view.results.mineCells[String(mineIdx)] ?? '', cellCount)
			: null;

		const existing = boardEl.childElementCount === cellCount ? Array.from(boardEl.children) : [];
		if (existing.length !== cellCount) {
			const frag = document.createDocumentFragment();
			for (let cell = 0; cell < cellCount; cell += 1) {
				const button = document.createElement('button');
				button.type = 'button';
				button.className = 'ms-cell';
				button.dataset.cell = String(cell);
				button.addEventListener('click', () => onCell(cell));
				frag.appendChild(button);
			}
			boardEl.replaceChildren(frag);
		}
		const cells = Array.from(boardEl.children) as HTMLButtonElement[];
		const size_ = size;
		for (let cell = 0; cell < cellCount; cell += 1) {
			const button = cells[cell];
			if (!button) continue;
			const row = Math.floor(cell / size_);
			const col = cell % size_;
			button.textContent = '';
			button.removeAttribute('data-value');
			button.classList.remove('is-revealed', 'is-hidden', 'is-mine', 'is-boom', 'is-pending', 'is-armed');
			button.setAttribute('aria-label', `Row ${row + 1}, column ${col + 1}`);

			if (phase === 'place' && view?.difficulty) {
				// Placement editor: I am designing the opponent's field here.
				const selection = selectionFor(placementTarget);
				button.classList.add('is-hidden', 'is-editor');
				if (selection.has(cell)) {
					button.classList.add('is-armed');
					button.textContent = '✸';
					button.setAttribute('aria-label', `Row ${row + 1}, column ${col + 1}, mine`);
				}
				continue;
			}
			if (raceMode && fieldNumbers) {
				const revealed = fieldRevealed.has(cell);
				if (revealed) {
					const digit = fieldNumbers[cell] ?? -1;
					button.classList.add('is-revealed');
					if (digit > 0) {
						button.textContent = String(digit);
						button.dataset.value = String(digit);
					}
				} else if (pendingCell === cell) {
					button.classList.add('is-hidden', 'is-pending');
				} else {
					button.classList.add('is-hidden');
				}
				if (boomCell === cell) {
					button.classList.add('is-boom');
					button.textContent = '✸';
				}
				continue;
			}
			if (resultMines && msGetMine(resultMines, cell)) {
				button.classList.add('is-mine');
				button.textContent = '✸';
				if (boomCell === cell) button.classList.add('is-boom');
				continue;
			}
			if (boomCell === cell) {
				button.classList.add('is-boom');
				button.textContent = '✸';
				continue;
			}
			button.classList.add('is-hidden');
		}
	}
	function renderWins(): void {
		if (!winsEl || !view) return;
		const entries = Object.entries(view.wins).sort((a, b) => b[1] - a[1]);
		if (entries.length === 0) {
			winsEl.textContent = 'Wins this room: none yet — the leaderboard counts server-attested wins per difficulty.';
			return;
		}
		winsEl.textContent = `Wins this room: ${entries.map(([member, count]) => `${labelOf(member)} ${count}`).join(' · ')}`;
	}
	function renderCountdown(): void {
		const window_ = phaseWindow();
		const text = !view || !window_ ? '' : `${(Math.max(0, view.phaseAt + window_ - Date.now()) / 1000).toFixed(1)}s`;
		for (const element of countdownEls) element.textContent = text;
	}
	function renderTargets(): void {
		if (!targetsEl) return;
		const targets = authoredTargets();
		targetsEl.replaceChildren();
		for (const target of targets) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'ms-target';
			button.textContent = `Board: ${labelOf(view?.roster[target] ?? '')}`;
			button.dataset.target = String(target);
			button.classList.toggle('is-active', target === placementTarget);
			button.addEventListener('click', () => { placementTarget = target; render(); });
			targetsEl.appendChild(button);
		}
	}
	function renderPlaceMeta(): void {
		if (!placeCountEl || !view?.difficulty) return;
		const budget = budgetForTarget(placementTarget);
		const placed = selectionFor(placementTarget).size;
		placeCountEl.textContent = `Mines placed: ${placed} / ${budget}`;
		if (placeSubmit) {
			const allMet = authoredTargets().every((target) => selectionFor(target).size === budgetForTarget(target));
			placeSubmit.disabled = !allMet || placementSubmitted;
			placeSubmit.textContent = placementSubmitted ? 'Waiting for the other players…' : 'Lock in my minefields';
		}
	}
	function render(): void {
		if (!view) {
			setPanel('lobby');
			renderBoard();
			return;
		}
		setPanel(view.phase);
		phaseSay(
			view.phase === 'lobby' ? `Lobby — round ${view.round + 1} next · host starts`
			: view.phase === 'vote' ? `Vote the difficulty (5 seconds) · round ${view.round}`
			: view.phase === 'place' ? `Place your mines on the opponents' boards (60 seconds) · ${view.difficulty ?? ''}`
			: view.phase === 'race' ? `Race — clear your board first · ${view.difficulty ?? ''}`
			: `Results — round ${view.round}`,
		);
		if (startButton) startButton.hidden = !(view.phase === 'lobby' && myIsHost);
		for (const button of voteButtons) {
			const choice = msDifficulty(button.dataset.msVote);
			const voted = Boolean(myMemberId && view.votes[myMemberId]);
			button.disabled = voted || view.phase !== 'vote';
			button.classList.toggle('is-voted', Boolean(choice && myMemberId && view.votes[myMemberId] === choice));
		}
		if (targetsEl) targetsEl.hidden = view.phase !== 'place';
		if (placeCountEl) placeCountEl.hidden = view.phase !== 'place';
		if (placeSubmit) placeSubmit.hidden = view.phase !== 'place';
		if (raceNoteEl) {
			const mineTotal = view.difficulty ? msSpec(view.difficulty).mines : 0;
			const revealedSafe = fieldRevealed.size;
			const remaining = Math.max(0, spec().size * spec().size - mineTotal - revealedSafe);
			raceNoteEl.textContent = view.phase === 'race'
				? spectator || !view.alive.includes(myMemberId ?? '')
					? 'You are out of this round — watching the finish.'
					: `${remaining} safe cells left · click to reveal (floods open automatically).`
				: '';
		}
		if (view.phase === 'results' && view.results && resultNote) {
			const results = view.results;
			const winnerText = results.winner
				? results.winner === myMemberId ? 'You won' : `${labelOf(results.winner)} won`
				: 'Draw';
			const reasonText = results.reason === 'clear' ? 'cleared the board' : results.reason === 'elimination' ? 'last one standing' : 'no winner';
			resultNote.textContent = `${winnerText} (${reasonText}) · round ${results.round} on ${results.difficulty}. Minefields are revealed below.`;
		}
		// Claim panel: only my own attested win can be submitted.
		if (claimForm) {
			const claimable = Boolean(!claimDone && view.results && view.results.winner && view.results.winner === myMemberId);
			claimForm.hidden = !claimable;
			if (claimable && view.results) {
				const winsSoFar = (myMemberId ? view.wins[myMemberId] ?? 0 : 0);
				if (claimNote) claimNote.textContent = `${view.results.difficulty} · this would record win ${winsSoFar + 1} for you on this difficulty. The server asks the room whether you really won.`;
				// An attested win has nothing for the client to compare: the server
				// increments the stored count. Order is name → POST → standing
				// refresh, and the key is per results phase so a re-render is one claim.
				const key = `ms-${view.results.round}:${view.results.difficulty}`;
				if (autoClaimKey !== key) {
					autoClaimKey = key;
					runToken = createRunToken();
					void maybeAutoClaimWin(view.results.round, view.results.difficulty);
				}
			}
		}
		renderWins();
		renderTargets();
		renderPlaceMeta();
		renderCountdown();
		renderBoard();
	}

	// ------------------------------------------------------------ interaction
	function onCell(cell: number): void {
		if (inputLocked || !view || !socket || socket.readyState !== WebSocket.OPEN) return;
		if (view.phase === 'place') {
			if (placementSubmitted) return;
			const selection = selectionFor(placementTarget);
			if (selection.has(cell)) selection.delete(cell);
			else selection.add(cell);
			render();
			return;
		}
		if (view.phase !== 'race') return;
		if (spectator || !view.alive.includes(myMemberId ?? '') || !fieldNumbers) return;
		if (fieldRevealed.has(cell) || pendingCell !== null) return;
		if (myClicks.includes(cell)) return;
		myClicks = [...myClicks, cell];
		pendingCell = cell;
		sendAction('ms_finish', { c: [...myClicks] });
		renderBoard();
	}
	function submitPlacements(): void {
		if (!view?.difficulty || !myMemberId) return;
		const payload: Record<string, string> = {};
		const cellCount = spec().size * spec().size;
		for (const target of authoredTargets()) {
			const budget = budgetForTarget(target);
			const selection = selectionFor(target);
			if (selection.size !== budget) {
				say(`Board ${labelOf(view.roster[target] ?? '')}: place exactly ${budget} mines first.`);
				return;
			}
			const field = new Uint8Array(Math.ceil(cellCount / 8));
			for (const cell of selection) msSetMine(field, cell);
			payload[String(target)] = msEncodeBitset(field);
		}
		placementSubmitted = true;
		sendAction('ms_place', { c: payload, r: 1 });
		say('Minefields locked in — waiting for the others…');
		render();
	}
	function resetRoundUi(): void {
		myClicks = [];
		pendingCell = null;
		boomCell = null;
		spectator = false;
		fieldNumbers = null;
		fieldRevealed = new Set();
		placementSelection = new Map();
		placementSubmitted = false;
		syncKey = null;
	}

	// ----------------------------------------------------------- room frames
	function adoptState(raw: unknown, revision: number | undefined): void {
		const next = normalizeView(raw);
		if (!next) return;
		const previousPhase = view?.phase;
		const previousRound = view?.round;
		view = next;
		if (typeof revision === 'number') roomRevision = revision;
		if (previousRound !== null && previousRound !== undefined && previousRound !== next.round) resetRoundUi();
		if (previousPhase !== next.phase) {
			if (next.phase === 'race') {
				// Field digits arrive only on my own sync reply (actor-only channel).
				if (!fieldNumbers) sendAction('ms_sync');
			}
			if (next.phase === 'results' && next.round !== lastResultsRound) {
				lastResultsRound = next.round;
				resultsAcknowledged = false;
				if (document.querySelector<HTMLElement>('[data-game-shell]')?.dataset.gameState === 'ready') showShell('results');
			}
			if (next.phase === 'lobby' && previousPhase === 'results') {
				claimDone = false;
				autoClaimKey = '';
				if (claimStatus) claimStatus.textContent = '';
				if (!resultsAcknowledged) showShell('ready');
			}
		}
		if (next.phase === 'place') {
			const targets = authoredTargets();
			if (!targets.includes(placementTarget)) placementTarget = targets[0] ?? 0;
		}
		if (next.phase === 'race' && myMemberId && !next.alive.includes(myMemberId)) spectator = true;
		render();
	}
	function onFrame(message: RoomNotice): void {
		if (message.type === 'members' && Array.isArray(message.members)) {
			memberLabels = new Map(message.members.map((member) => [member.memberId, member.label]));
			const self = message.members.find((member) => member.isSelf);
			myMemberId = self ? self.memberId : null;
			myIsHost = Boolean(self?.isHost);
			render();
			return;
		}
		if (message.type === 'snapshot') {
			activeGameId = typeof message.gameId === 'string' && message.gameId ? message.gameId : null;
			if (activeGameId !== MS_GAME_ID) {
				view = null;
				phaseSay(socket ? 'Connected room is running a different game.' : 'Connected (no game).');
				if (activeGameId) say('That room is not a PvP Minesweeper room — start one below.');
				render();
				return;
			}
			phaseSay('Room mode — the server runs the phases.');
			adoptState(message.state, message.revision);
			return;
		}
		if (activeGameId !== MS_GAME_ID) return;
		if (message.type === 'state' || message.type === 'conflict' || message.type === 'action') {
			adoptState(message.state, message.revision);
			if (message.type === 'action' && message.action === 'ms_die' && view && myMemberId && !view.alive.includes(myMemberId)) {
				spectator = true;
				say('You hit a mine — eliminated. Watching the rest of the round.');
			}
			if (message.type === 'action' && message.action === 'ms_place' && view && myMemberId && view.ready.includes(myMemberId)) {
				placementSubmitted = true;
			}
			return;
		}
		if (message.type === 'action_result') {
			const reply = message.reply as { size?: number; numbers?: number[]; revealed?: number[] } | undefined;
			if (reply && Array.isArray(reply.numbers)) {
				fieldNumbers = reply.numbers;
				fieldRevealed = new Set(Array.isArray(reply.revealed) ? reply.revealed : []);
				pendingCell = null;
				renderBoard();
			}
			return;
		}
		if (message.type === 'action_rejected') {
			const error = message.error ?? '';
			if (error === 'hit_mine') {
				boomCell = pendingCell;
				pendingCell = null;
				spectator = true;
				say('Boom — that cell was a mine. The designer of that field scores the kill.');
				sendAction('ms_die');
				renderBoard();
				return;
			}
			if (error === 'bad_mine_count') {
				placementSubmitted = false;
				say('The mine count was wrong — adjust and lock in again.');
				render();
				return;
			}
			if (error === 'rate_limited') { say('Slow down a moment — the room paces actions.'); return; }
			if (error === 'not_in_round') { say('You are not in this round.'); return; }
			if (error === 'state_corrupt') { say('Room state needs a refresh — rejoin the room.'); return; }
			if (error === 'host_only') { say('Only the room host can start a round.'); return; }
			if (error === 'wrong_phase') { sendAction('ms_sync'); return; }
			say(`The server refused that action (${error || 'unknown'}).`);
		}
	}
	function onSocket(next: WebSocket | null): void {
		socket = next;
		if (next) {
			phaseSay('Room mode — join confirmed, syncing…');
		} else {
			activeGameId = null;
			view = null;
			myMemberId = null;
			myIsHost = false;
			resetRoundUi();
			phaseSay('Not connected — create or join a room below to play.');
			say('PvP Minesweeper needs a room with at least one other player.');
			render();
		}
	}

	// -------------------------------------------------------------- countdown
	function tick(): void {
		if (destroyed || !view || !socket || socket.readyState !== WebSocket.OPEN) return;
		renderCountdown();
		const window_ = phaseWindow();
		if (!window_) return;
		const key = `${view.phase}:${view.phaseAt}`;
		if (Date.now() >= view.phaseAt + window_) {
			if (syncKey !== key) {
				syncKey = key;
				sendAction('ms_sync');
			}
		} else {
			syncKey = null;
		}
	}

	// ---------------------------------------------------------------- claim
	/**
	 * Attested-increment auto-submit. The room must still be alive to attest the
	 * round, so this runs as soon as the results phase is announced rather than
	 * waiting for the player to type a name. Guests keep the manual form.
	 */
	async function maybeAutoClaimWin(round: number, difficulty: string): Promise<void> {
		const rooms = document.querySelector<HTMLElement>('[data-room-tools]');
		const roomCode = rooms?.dataset.roomCode ?? '';
		if (!/^[A-Za-z0-9_-]{22}$/.test(roomCode)) return;
		const result = await submitAttestedWin({
			gameId: MS_GAME_ID, mode: difficulty, proof: { roomCode, round },
			idempotencyKey: idempotencyKey('msw', runToken),
		});
		if (result.outcome.kind === 'stored') {
			claimDone = true;
			if (claimForm) claimForm.hidden = true;
			if (claimStatus) claimStatus.textContent = `Win recorded: ${result.outcome.score.toLocaleString()} on ${difficulty}.`;
			renderWins();
		} else if (result.outcome.kind === 'duplicate') {
			claimDone = true;
			if (claimForm) claimForm.hidden = true;
		} else if (result.outcome.kind === 'not-best') {
			// Attested increments are never "not best" — the server increments.
		} else if (result.outcome.kind === 'unreachable') {
			if (claimStatus) claimStatus.textContent = 'Could not reach the leaderboard. Type a name below to claim this win.';
		} else if (result.outcome.kind === 'rejected') {
			if (claimStatus) claimStatus.textContent = result.outcome.message;
		}
	}

	async function submitClaim(): Promise<void> {
		if (!view?.results || !myMemberId || claimDone || !claimForm) return;
		const rooms = document.querySelector<HTMLElement>('[data-room-tools]');
		const roomCode = rooms?.dataset.roomCode ?? '';
		if (!/^[A-Za-z0-9_-]{22}$/.test(roomCode)) {
			if (claimStatus) claimStatus.textContent = 'Room code unavailable — reconnect the room and try again.';
			return;
		}
		const displayName = claimName?.value.trim() ?? '';
		if (!displayName) { if (claimStatus) claimStatus.textContent = 'Enter a display name (1–24 characters).'; return; }
		if (claimStatus) claimStatus.textContent = 'Asking the room…';
		const submit = claimForm.querySelector<HTMLButtonElement>('button[type="submit"]');
		if (submit) submit.disabled = true;
		if (claimName) claimName.disabled = true;
		try {
			// Same stable key as the automatic attempt: this win is one claim.
			const outcome = await submitRun({
				gameId: MS_GAME_ID, mode: view.results.difficulty, score: 0, tieBreak: null,
				displayName, idempotencyKey: idempotencyKey('msw', runToken), proof: { roomCode, round: view.results.round },
			});
			if (outcome.kind === 'stored') {
				claimDone = true;
				if (claimStatus) claimStatus.textContent = `Win recorded: ${outcome.score.toLocaleString()} on ${view.results.difficulty}. The leaderboard is on the Games page.`;
				claimForm.hidden = true;
				return;
			}
			if (claimStatus) {
				claimStatus.textContent = outcome.kind === 'duplicate' ? 'This win was already submitted.'
					: outcome.kind === 'not-best' ? 'The room attested the win, but the board kept your stronger count.'
					: outcome.kind === 'unreachable' ? 'Could not reach the server. Try again when online.'
					: outcome.message;
			}
		} catch {
			if (claimStatus) claimStatus.textContent = 'Could not reach the server. Try again when online.';
		} finally {
			if (claimName) claimName.disabled = false;
			if (submit) submit.disabled = false;
		}
	}

	// ------------------------------------------------------------------ wire
	startButton?.addEventListener('click', () => sendAction('ms_start'));
	for (const button of voteButtons) {
		button.addEventListener('click', () => {
			const choice = msDifficulty(button.dataset.msVote);
			if (choice) sendAction('ms_vote', { v: choice });
		});
	}
	placeSubmit?.addEventListener('click', submitPlacements);
	claimForm?.addEventListener('submit', (event) => { event.preventDefault(); void submitClaim(); });
	claimBack?.addEventListener('click', () => { resultsAcknowledged = true; showShell('ready'); render(); });
	phaseSay('Not connected — create or join a room below to play.');
	say('PvP Minesweeper needs a room with at least one other player.');
	render();
	tickTimer = setInterval(tick, 250);

	const module: GameModule = {
		init(root: HTMLElement) {
			root.dataset.msReady = 'true';
			const lock = (locked: boolean): void => { inputLocked = locked; render(); };
			return {
				pause: () => lock(true),
				resume: () => lock(false),
				destroy: () => {
					destroyed = true;
					if (tickTimer) clearInterval(tickTimer);
				},
			};
		},
	};

	return { module, onFrame, onSocket };
}
