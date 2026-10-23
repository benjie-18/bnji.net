/** Central directory for games and game-like Lab entries. Stable IDs are persisted in D1; never rename a published ID. */
export type GameStatus = 'available' | 'planned' | 'in-development' | 'unavailable';
export type GameCapability = 'keyboard' | 'touch' | 'pointer' | 'gamepad' | 'canvas-2d' | 'webgl' | 'webgpu' | 'audio';

export type Game = {
	/** Immutable, globally stable persisted identifier: `bnji.<lowercase-kebab-slug>`. */
	id: `bnji.${string}`;
	title: string;
	description: string;
	status: GameStatus;
	/** A Lab link is a pointer only; gameplay remains owned by src/components/lab. */
	labHref?: `/projects/lab/#${string}`;
	/** Omit for unavailable and planned entries; never render a dead anchor. */
	href?: string;
	capabilities?: readonly GameCapability[];
	modes?: readonly string[];
};

const GAME_ID_PATTERN = /^bnji\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GAME_STATUSES = new Set<GameStatus>(['available', 'planned', 'in-development', 'unavailable']);
const GAME_CAPABILITIES = new Set<GameCapability>(['keyboard', 'touch', 'pointer', 'gamepad', 'canvas-2d', 'webgl', 'webgpu', 'audio']);

/** Validate catalog invariants before IDs enter lookups, API validation, or rendered links. */
export function defineGameCatalog<const T extends readonly Game[]>(games: T): T {
	const ids = new Set<string>();
	for (const [index, game] of games.entries()) {
		const location = `Games[${index}]`;
		if (!game || typeof game !== 'object') throw new Error(`${location} must be an object`);
		if (typeof game.id !== 'string' || !GAME_ID_PATTERN.test(game.id)) throw new Error(`${location} has an invalid stable game ID`);
		if (ids.has(game.id)) throw new Error(`Duplicate game ID: ${game.id}`);
		ids.add(game.id);
		if (typeof game.title !== 'string' || !game.title.trim()) throw new Error(`${game.id} needs a title`);
		if (typeof game.description !== 'string' || !game.description.trim()) throw new Error(`${game.id} needs a description`);
		if (game.description.trim().split(/\s+/u).length > 12) throw new Error(`${game.id} description must be 12 words or fewer`);
		if (!GAME_STATUSES.has(game.status)) throw new Error(`${game.id} has an invalid status`);
		const destinations = Number(game.href !== undefined) + Number(game.labHref !== undefined);
		if (game.status === 'available' && destinations !== 1) throw new Error(`${game.id} must have exactly one destination while available`);
		if (game.status !== 'available' && destinations !== 0) throw new Error(`${game.id} cannot have a playable destination while ${game.status}`);
		if (game.href !== undefined && (!game.href.startsWith('/') || game.href.startsWith('//'))) throw new Error(`${game.id} has an unsafe game route`);
		if (game.labHref !== undefined && !/^\/projects\/lab\/#[a-z0-9-]+$/.test(game.labHref)) throw new Error(`${game.id} has an invalid Lab link`);
		for (const [name, values, allowed] of [
			['capability', game.capabilities, GAME_CAPABILITIES],
			['mode', game.modes, undefined],
		] as const) {
			if (values === undefined) continue;
			if (!Array.isArray(values) || new Set(values).size !== values.length) throw new Error(`${game.id} has duplicate or invalid ${name}s`);
			for (const value of values) {
				if (typeof value !== 'string' || (allowed ? !allowed.has(value as GameCapability) : !isValidGameMode(value))) {
					throw new Error(`${game.id} has an invalid ${name}: ${String(value)}`);
				}
			}
		}
	}
	return games;
}

/** Existing Lab experiments surfaced by link only; no implementation is copied into Games. */
export const GAMES = defineGameCatalog([
	{
		id: 'bnji.glass-minesweeper',
		title: 'Minesweeper',
		description: 'A compact puzzle experiment, still maintained exclusively in the Lab.',
		status: 'available',
		labHref: '/projects/lab/#glass-minesweeper',
		capabilities: ['keyboard', 'touch', 'pointer'],
		modes: ['default'],
	},
	{
		id: 'bnji.memory-pairs',
		title: 'Memory Pairs',
		description: 'A memory-matching experiment hosted in the Lab.',
		status: 'available',
		labHref: '/projects/lab/#memory-pairs',
		capabilities: ['keyboard', 'touch', 'pointer'],
		modes: ['default'],
	},
	{
		id: 'bnji.bubble-pop',
		title: 'Bubble Pop',
		description: 'A quick, tactile popping game that stays entirely in the Lab.',
		status: 'available',
		labHref: '/projects/lab/#bubble-pop',
		capabilities: ['touch', 'pointer'],
		modes: ['default'],
	},
	{
		id: 'bnji.reaction-timer',
		title: 'Reaction Timer',
		description: 'A short reaction-time challenge hosted in the Lab.',
		status: 'available',
		labHref: '/projects/lab/#reaction-timer',
		capabilities: ['keyboard', 'touch', 'pointer'],
		modes: ['default'],
	},
	{
		id: 'bnji.isometric-stack',
		title: 'Isometric Stack',
		description: 'Drop alternating blocks, keep your combo, and chase the leaderboard.',
		status: 'available',
		href: '/projects/games/stack/',
		capabilities: ['keyboard', 'touch', 'pointer', 'canvas-2d'],
		modes: ['default'],
	},
	{
		id: 'bnji.chess',
		title: 'Chess',
		description: 'Play in private rooms or practice locally; fastest checkmate tops the board.',
		status: 'available',
		href: '/projects/games/chess/',
		capabilities: ['keyboard', 'pointer'],
		modes: ['fastest-mate'],
	},
	{
		id: 'bnji.pvp-minesweeper',
		title: 'PvP Minesweeper',
		description: "Vote a difficulty, plant mines on rivals' boards, then race to clear.",
		status: 'available',
		href: '/projects/games/pvp-minesweeper/',
		capabilities: ['keyboard', 'touch', 'pointer'],
		modes: ['quick', 'normal', 'hard'],
	},
] as const);

const CATALOG: readonly Game[] = GAMES;
const GAME_BY_ID = new Map<string, Game>(GAMES.map((game) => [game.id, game]));

export function getGame(id: string): Game | undefined {
	return GAME_BY_ID.get(id as Game['id']);
}

export function getGamesByStatus(status: GameStatus): Game[] {
	return GAMES.filter((game) => game.status === status);
}

/**
 * Games hosted on their own route — everything except the Lab entries, which
 * are pointers to `/projects/lab/#…` and have no server side at all.
 *
 * This is the set a private room can be created for: a Lab experiment has no
 * page, no verifier and no protocol adapter, so a room "for" it would be a
 * code in a menu that does nothing. A standalone game without a registered room
 * authority (Stack) still gets a real room: shared membership, chat and
 * moderation, with game-state frames refused by design.
 */
export function getStandaloneGames(): Game[] {
	return CATALOG.filter((game) => game.status === 'available' && !game.labHref && Boolean(game.href));
}

/** Strict score-mode identifier check shared by API validation and tests. */
export function isValidGameMode(mode: unknown): mode is string {
	return typeof mode === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(mode);
}
