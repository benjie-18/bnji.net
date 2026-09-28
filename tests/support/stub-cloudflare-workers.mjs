/**
 * Test stub for `cloudflare:workers`.
 *
 * The real module exposes the Worker's `env` — bindings such as BOARD_DB. This
 * one proxies to a global, and it proxies LIVE rather than snapshotting: the
 * code under test spreads the object (`{ ...bindings }`), so a snapshot taken
 * at import time would freeze whatever happened to be set first and every
 * later change would be invisible.
 */
const BINDINGS_KEY = '__BNJI_TEST_BINDINGS__';

const current = () => globalThis[BINDINGS_KEY] ?? {};

export const env = new Proxy(Object.create(null), {
	get: (_target, property) => current()[property],
	has: (_target, property) => property in current(),
	ownKeys: () => Reflect.ownKeys(current()),
	getOwnPropertyDescriptor: (_target, property) => ({
		configurable: true,
		enumerable: true,
		value: current()[property],
	}),
});

export default { env };
