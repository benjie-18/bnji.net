/**
 * Test support: the resolver hooks themselves.
 *
 * Kept separate from register.mjs because a `--import` file may not itself be
 * a hook module: it has to hand Node the file that exports the hooks.
 */
const STUBS = new Map([
	['astro:env/server', new URL('./stub-astro-env-server.mjs', import.meta.url).href],
	['cloudflare:workers', new URL('./stub-cloudflare-workers.mjs', import.meta.url).href],
]);

/** Extensions tried, in order, when a relative import omits one. */
const EXTENSIONS = ['.ts', '.mjs', '.js'];

export async function resolve(specifier, context, next) {
	const stub = STUBS.get(specifier);
	if (stub) return { url: stub, shortCircuit: true, format: 'module' };

	try {
		return await next(specifier, context);
	} catch (error) {
		// Only a relative import gets the extension treatment: a bare specifier
		// that failed to resolve is a package, and guessing at it would hide a
		// real missing dependency behind a confusing secondary error.
		if (!specifier.startsWith('.')) throw error;
		for (const extension of EXTENSIONS) {
			try {
				return await next(`${specifier}${extension}`, context);
			} catch {
				// Try the next candidate; the original error is rethrown below.
			}
		}
		// Directory imports (src/data/profiles → …/profiles/index.ts): Node's
		// ESM resolver rejects bare directories, but the source targets
		// bundler resolution where they are index files.
		for (const extension of EXTENSIONS) {
			try {
				return await next(`${specifier}/index${extension}`, context);
			} catch {
				// Last resort — rethrow the original resolution error below.
			}
		}
		throw error;
	}
}
