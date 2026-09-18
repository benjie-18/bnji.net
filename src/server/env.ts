/**
 * BNJI.NET — server environment access (the ONLY place secrets are read).
 *
 * Secrets and bindings arrive through two sanctioned channels:
 *   1. `astro:env/server` getSecret() for string secrets declared in the
 *      env schema in astro.config.mjs (DISCORD_WEBHOOK_URL, NTFY_URL,
 *      BOARD_REST_URL/TOKEN, ACCESS_*);
 *   2. the Workers `env` object (cloudflare:workers) for bindings such as a
 *      BOARD_KV namespace. That import is dynamic and @vite-ignore'd so the
 *      Node prerender bundle keeps it as a runtime expression: on workerd it
 *      resolves, anywhere else it throws and we fall back to {} — which the
 *      stores interpret as "provider unavailable, use memory".
 *
 * Nothing here is ever imported by client code; the module only exists in
 * server bundles (middleware + /api/*).
 */
import { getSecret } from 'astro:env/server';

export type ServerEnv = Record<string, string | undefined>;

/** All declared string secrets, as a plain record. */
export function secretEnv(): ServerEnv {
	return {
		DISCORD_WEBHOOK_URL: getSecret('DISCORD_WEBHOOK_URL'),
		NTFY_URL: getSecret('NTFY_URL'),
		BOARD_REST_URL: getSecret('BOARD_REST_URL'),
		BOARD_REST_TOKEN: getSecret('BOARD_REST_TOKEN'),
		ACCESS_TOKEN: getSecret('ACCESS_TOKEN'),
		ACCESS_PASSWORD_SHA: getSecret('ACCESS_PASSWORD_SHA'),
		ACCESS_SECRET: getSecret('ACCESS_SECRET'),
	};
}

/** Worker bindings (KV namespaces etc.), or {} outside workerd. */
export async function workerBindings(): Promise<Record<string, unknown>> {
	try {
		const mod = (await import(/* @vite-ignore */ 'cloudflare:workers')) as unknown as {
			env?: Record<string, unknown>;
		};
		return mod.env ?? {};
	} catch {
		return {};
	}
}

/** Combined view: bindings first, secrets overlaid. */
export async function serverEnvironment(): Promise<Record<string, unknown>> {
	const bindings = await workerBindings();
	return { ...bindings, ...secretEnv() };
}
