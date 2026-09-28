/**
 * Test support: register the module resolution hooks.
 *
 * Two jobs, both about making the repo's own source loadable under plain Node:
 *
 *   1. Stub the two runtime-only modules the server code imports —
 *      `astro:env/server` (secrets) and `cloudflare:workers` (bindings). Both
 *      exist only inside a Worker, so a test process must supply them, and it
 *      does so by reading two well-known globals that the tests set.
 *   2. Resolve the extensionless relative imports the source uses. The repo
 *      targets `moduleResolution: "Bundler"`, where `../config/music.config`
 *      resolves fine; Node's ESM resolver wants the file extension. Rewriting
 *      every import in src/ to suit the test runner would be the tail wagging
 *      the dog, so the hook adds the extension instead.
 */
import { register } from 'node:module';

register('./stub-hooks.mjs', import.meta.url);
