/**
 * Test stub for `astro:env/server`.
 *
 * The real module reads Worker secrets. This one reads a plain object off the
 * global, which is all a test needs: it can put a token hash, a session secret
 * or a provider credential where the code under test expects to find it.
 *
 * Values are read at CALL time, not import time, so a test can change what is
 * "in the environment" between two requests.
 */
const SECRETS_KEY = '__BNJI_TEST_SECRETS__';

export function getSecret(name) {
	const secrets = globalThis[SECRETS_KEY] ?? {};
	return secrets[name];
}

export default { getSecret };
