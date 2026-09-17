/**
 * BNJI.NET — message board storage providers.
 *
 * The API route (src/pages/api/board.ts) talks only to this module; the UI
 * talks only to the API. That is the whole boundary: swapping persistence
 * never touches a component.
 *
 * Providers
 * ---------
 *  memory — module-scope array. Lives as long as the Worker isolate does, so
 *           messages are shared by visitors served by the same isolate and
 *           survive between requests, but not across isolates/deployments.
 *           Zero configuration; this is the default and the honest demo grade.
 *  kv     — Cloudflare KV, true persistence. Auto-detected: if the Worker
 *           environment exposes a BOARD_KV namespace binding, this provider is
 *           used automatically. Enable it with:
 *             npx wrangler kv namespace create board
 *           then add a binding named BOARD_KV in wrangler.json
 *           (see docs/CONFIGURATION.md). No code changes needed.
 *  rest   — external JSON API (GET/POST {messages}) for teams that already
 *           run a backend. Configured via BOARD_REST_URL / BOARD_REST_TOKEN
 *           environment variables (secret; never in this file).
 *
 * Data model (deliberately tiny and serialisable):
 *   { id, text, image?, hue, createdAt }
 * `image` is stored ONLY as a validated data: URL of an allowed MIME type and
 * size (validated again server-side on write). `hue` is a stable 0-359 tint
 * seed so each bubble/star gets its own colour without storing one.
 */
import { BOARD_CONFIG } from '../config/board.config';

export type BoardMessage = {
	id: string;
	text: string;
	/** Validated data: URL, or undefined. Never an arbitrary remote URL. */
	image?: string;
	/** Stable tint seed 0-359. */
	hue: number;
	/** Epoch ms. */
	createdAt: number;
};

export interface BoardStore {
	/** Newest first. `limit` caps the result; `all` bypasses the default cap. */
	list(limit: number): Promise<BoardMessage[]>;
	add(message: BoardMessage): Promise<void>;
	readonly kind: 'memory' | 'kv' | 'rest';
}

/* --- memory provider ------------------------------------------------------ */

const memory: BoardMessage[] = [];

const memoryStore: BoardStore = {
	kind: 'memory',
	async list(limit) {
		return memory
			.slice()
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit);
	},
	async add(message) {
		memory.push(message);
		// Hard cap so a long-lived isolate cannot grow without bound.
		if (memory.length > 500) memory.splice(0, memory.length - 500);
	},
};

/* --- kv provider ----------------------------------------------------------- */

type KvNamespace = {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
};

function createKvStore(kv: KvNamespace): BoardStore {
	const INDEX = 'board:index';
	return {
		kind: 'kv',
		async list(limit) {
			const rawIndex = await kv.get(INDEX);
			const ids: string[] = rawIndex ? (JSON.parse(rawIndex) as string[]) : [];
			const messages: BoardMessage[] = [];
			for (const id of ids.slice(0, limit)) {
				const raw = await kv.get(`board:msg:${id}`);
				if (raw) messages.push(JSON.parse(raw) as BoardMessage);
			}
			return messages;
		},
		async add(message) {
			await kv.put(`board:msg:${message.id}`, JSON.stringify(message));
			const rawIndex = await kv.get(INDEX);
			const ids: string[] = rawIndex ? (JSON.parse(rawIndex) as string[]) : [];
			ids.unshift(message.id);
			await kv.put(INDEX, JSON.stringify(ids.slice(0, 500)));
		},
	};
}

/* --- rest provider ---------------------------------------------------------- */

function createRestStore(url: string, token?: string): BoardStore {
	const headers = (): Record<string, string> => ({
		'content-type': 'application/json',
		...(token ? { authorization: `Bearer ${token}` } : {}),
	});
	return {
		kind: 'rest',
		async list(limit) {
			const response = await fetch(`${url}?limit=${limit}`, { headers: headers() });
			if (!response.ok) throw new Error(`board rest list failed: ${response.status}`);
			const data = (await response.json()) as { messages: BoardMessage[] };
			return data.messages;
		},
		async add(message) {
			const response = await fetch(url, {
				method: 'POST',
				headers: headers(),
				body: JSON.stringify(message),
			});
			if (!response.ok) throw new Error(`board rest add failed: ${response.status}`);
		},
	};
}

/* --- selection -------------------------------------------------------------- */

/**
 * Resolve the active store for one request. `env` is the Worker environment
 * (Astro.locals.runtime.env); bindings and secrets arrive there and nowhere
 * else. Falls back to memory when the configured provider is unavailable, so
 * the board UI always works.
 */
export function getBoardStore(env: Record<string, unknown> | undefined): BoardStore {
	const configured = BOARD_CONFIG.provider;
	if (configured === 'kv' || configured === 'memory') {
		const kv = env?.BOARD_KV as KvNamespace | undefined;
		if (kv && typeof kv.get === 'function') return createKvStore(kv);
	}
	if (configured === 'rest') {
		const url = env?.BOARD_REST_URL as string | undefined;
		if (url) return createRestStore(url, env?.BOARD_REST_TOKEN as string | undefined);
	}
	return memoryStore;
}
