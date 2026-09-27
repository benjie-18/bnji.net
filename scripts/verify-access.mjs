/**
 * Build-time assertion: every route covered by an ACCESS_RULES pattern must
 * actually run Worker code.
 *
 * THE HAZARD
 * -----------
 * Astro prerenders pages by default. A prerendered page is emitted as a
 * static file under dist/client/ and served by the edge WITHOUT running the
 * Worker — which means src/middleware.ts never runs and the matching
 * ACCESS_RULES entry is never evaluated. The access rule is not "weakened",
 * it is simply absent, and nothing errors.
 *
 * This is easy to hit and very hard to see. A page can carry the comment
 * "NOT prerendered" in its docstring, be covered by a rule, and still be
 * prerendered because nobody wrote `export const prerender = false`. The
 * build succeeds. The page returns 200 to anyone. It happened here once
 * already: /admin was documented as gated, covered by a rule, and shipped as
 * a static file.
 *
 * WHAT THIS CHECKS
 * ----------------
 * Three independent passes, because each catches a different mistake:
 *
 *   1. BUILD OUTPUT  — no static HTML file exists for a protected URL. This
 *      is what the edge would actually serve, so it is the load-bearing
 *      check; it catches the build deciding to prerender regardless of what
 *      the source says.
 *   2. PAGE SOURCE   — every .astro page under a protected prefix literally
 *      contains `export const prerender = false`. This catches the mistake
 *      at the moment it is made, and names the file to fix.
 *   3. COOKIE SCOPE  — a page rule and the API rule that backs it must agree
 *      on the pattern their session cookie is signed for. See below.
 *
 * PASS 3, AND WHY IT IS NOT HYPERSPECULATIVE
 * -------------------------------------------
 * A session cookie is bound to exactly one pattern and verification compares
 * that pattern, so a cookie minted by one rule cannot open another rule. A
 * surface whose page lives at '/admin' and whose data lives at '/api/admin' is
 * two rules with two different default patterns — so the browser loads the
 * page, then gets 401 on every fetch the page makes. That is not a crash and
 * not a 500: the dashboard renders and then silently shows nothing.
 *
 * Two rules are treated as one surface when they share a leaf segment
 * ('/admin' and '/api/admin', '/blog' and '/api/blog'). That is a heuristic,
 * but it errs toward reporting: the remedy — an explicit `sessionPattern` —
 * is a one-line declaration of intent, and requiring it for any two
 * same-named surfaces is cheaper than a dashboard that quietly 401s.
 *
 * WHY IT IMPORTS THE BUILT BUNDLE
 * -------------------------------
 * The rules are read from the build's own compiled access.config chunk, not
 * re-parsed from TypeScript with a regex. A hand-written parser is a second
 * implementation of the config format, and it fails silently and wrongly:
 * a naive scan picked up the `[]` in `RouteAccessRule[]` as the array, then
 * truncated every rule at the `]` inside its own `exclude: [...]`. Importing
 * the built module means this check reads the exact values the running site
 * will use, and a config shape it does not understand fails LOUDLY here
 * rather than quietly verifying nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIST_CLIENT = join(ROOT, 'dist', 'client');
const DIST_SERVER = join(ROOT, 'dist', 'server', 'chunks');
const PAGES_DIR = join(ROOT, 'src', 'pages');

/** Every file under dir, recursively. */
function walk(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

/**
 * Load ACCESS_RULES from the build's compiled output.
 *
 * The rules are NOT at a predictable path. The bundler names chunks after
 * whatever it happened to emit — and whether src/config/access.config.ts
 * survives as its own chunk at all depends on what imports it. It used to be
 * access.config_<hash>.mjs; the moment the admin gate imported ACCESS_RULES,
 * the bundler inlined it and that file stopped existing. A check that keys on
 * a filename starts failing the next time the bundler's chunking shifts, and
 * the worst version of that failure is "no rules found, nothing to verify".
 *
 * So: scan the chunks, keep the ones that look like they contain rule
 * literals, import those, and take the exported array of rule-shaped
 * objects. If several chunks carry a copy they must agree, and if none is
 * found the check exits 1 — it never passes because it looked in the wrong
 * place.
 */
function looksLikeRulesSource(text) {
	// Rule literals survive compilation: a string `pattern`, a string `auth`,
	// and at least one path-ish string.
	return (
		/pattern:\s*['"`]/.test(text) &&
		/auth:\s*['"`]/.test(text) &&
		/exclude:\s*\[/.test(text)
	);
}

function pickRules(values) {
	return values.find(
		(v) =>
			Array.isArray(v) &&
			v.length > 0 &&
			v.every((r) => r && typeof r === 'object' && typeof r.pattern === 'string' && typeof r.auth === 'string'),
	);
}

async function readAccessRules() {
	if (!existsSync(DIST_SERVER)) {
		console.error('[verify-access] dist/server/chunks is missing — run the build first.');
		process.exit(1);
	}
	const files = readdirSync(DIST_SERVER).filter((f) => f.endsWith('.mjs'));
	const candidates = files.filter((f) => looksLikeRulesSource(readFileSync(join(DIST_SERVER, f), 'utf8')));

	const found = [];
	for (const file of candidates) {
		try {
			const mod = await import(pathToFileURL(join(DIST_SERVER, file)).href);
			const rules = pickRules(Object.values(mod));
			if (rules) found.push({ file, rules });
		} catch {
			// A chunk that will not import on its own simply holds no rules.
		}
	}

	if (found.length === 0) {
		console.error(
			`[verify-access] could not locate ACCESS_RULES in ${candidates.length} candidate chunk(s) of ${files.length}.`,
		);
		console.error('[verify-access] refusing to pass a security check it could not actually perform.');
		process.exit(1);
	}

	// Every copy must be the same rules. If the bundler emitted two
	// divergent versions, the site is not running what the config says.
	const first = JSON.stringify(found[0].rules.map((r) => r.pattern));
	for (const { file, rules } of found) {
		if (JSON.stringify(rules.map((r) => r.pattern)) !== first) {
			console.error(`[verify-access] compiled chunks disagree about the access rules (${found[0].file} vs ${file}).`);
			process.exit(1);
		}
	}

	return found[0].rules.map((rule) => ({
		pattern: rule.pattern,
		// Defaults to the rule's own pattern, exactly as sessionPatternOf()
		// does at runtime — the two must not disagree.
		sessionPattern: typeof rule.sessionPattern === 'string' ? rule.sessionPattern : rule.pattern,
		auth: rule.auth,
		excluded: Array.isArray(rule.exclude) ? rule.exclude : [],
	}));
}

/** Map a built file back to the URL the edge serves it at. */
function urlForFile(file) {
	const rel = relative(DIST_CLIENT, file).split(sep).join('/');
	if (rel === 'index.html') return '/';
	if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
	return `/${rel}`;
}

function isProtected(url, rules) {
	const normalized = url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
	return rules.filter(
		(rule) =>
			normalized.startsWith(rule.pattern) &&
			!rule.excluded.includes(normalized) &&
			!rule.excluded.includes(url),
	);
}

const rules = await readAccessRules();
if (rules.length === 0) {
	console.log('[verify-access] no access rules declared — nothing to verify.');
	process.exit(0);
}

/* --- pass 1: the build output the edge would serve ------------------------ */

const builtFiles = walk(DIST_CLIENT).filter((f) => f.endsWith('.html'));
const builtViolations = [];
for (const file of builtFiles) {
	const url = urlForFile(file);
	const matched = isProtected(url, rules);
	if (matched.length > 0) {
		builtViolations.push({ url, rule: matched[0].pattern, file: relative(ROOT, file) });
	}
}

/* --- pass 2: page source missing the explicit opt-out --------------------- */

const sourceViolations = [];
for (const file of walk(PAGES_DIR)) {
	if (!file.endsWith('.astro')) continue;
	const rel = '/' + relative(PAGES_DIR, file).split(sep).join('/');
	const url = rel.replace(/\/index\.astro$/, '/').replace(/\.astro$/, '');
	if (isProtected(url, rules).length === 0) continue;
	const content = readFileSync(file, 'utf8');
	if (!/export\s+const\s+prerender\s*=\s*false/.test(content)) {
		sourceViolations.push({ url, file: relative(ROOT, file) });
	}
}

/* --- pass 3: cookie scope must cover the whole surface -------------------- */

// Leaf segment: '/api/admin' -> 'admin'. Two rules sharing one are almost
// always a page and the API that feeds it.
function leaf(pattern) {
	const parts = pattern.split('/').filter(Boolean);
	return parts.length === 0 ? '' : parts[parts.length - 1];
}

const scopeViolations = [];
for (let i = 0; i < rules.length; i++) {
	for (let j = i + 1; j < rules.length; j++) {
		const a = rules[i];
		const b = rules[j];
		if (a.pattern === b.pattern) continue;
		const shared = leaf(a.pattern);
		if (shared === '' || shared !== leaf(b.pattern)) continue;
		if (a.auth !== b.auth) continue; // genuinely different guards
		// One surface, but each rule signs a different cookie. Report it.
		if (a.sessionPattern === b.sessionPattern) continue; // already agreed
		scopeViolations.push({ a, b });
	}
}

let failed = false;

if (scopeViolations.length > 0) {
	failed = true;
	console.error('\n[verify-access] FAIL — one surface, two different session cookie scopes.\n');
	for (const { a, b } of scopeViolations) {
		console.error(`  '${a.pattern}' and '${b.pattern}' share the leaf '${leaf(a.pattern)}', so they are one surface.`);
		console.error(`  But their sessions are bound to '${a.sessionPattern}' and '${b.sessionPattern}'.`);
		console.error('  A cookie minted by one will 401 on the other — the page would load and then');
		console.error('  every fetch it makes would fail, with no error to point at the cause.');
		console.error(`  Fix: give both rules the same explicit sessionPattern.`);
	}
	console.error('');
}

if (builtViolations.length > 0) {
	failed = true;
	console.error('\n[verify-access] FAIL — protected routes were built as static files.\n');
	for (const v of builtViolations) {
		console.error(`  ${v.url} is covered by ACCESS_RULES '${v.rule}'`);
		console.error(`  but ${v.file} exists — the edge would serve it without running the Worker,`);
		console.error(`  so the middleware would never evaluate the rule.`);
	}
	console.error('');
}

if (sourceViolations.length > 0) {
	failed = true;
	console.error('\n[verify-access] FAIL — protected pages missing `export const prerender = false`.\n');
	for (const v of sourceViolations) {
		console.error(`  ${v.file} serves ${v.url}, which is protected.`);
		console.error('  Add `export const prerender = false;` so the middleware can run.');
	}
	console.error('');
}

if (failed) {
	console.error('[verify-access] A protected route would be served without authentication,\n');
	console.error('or a valid session would be rejected by part of its own surface.\n');
	process.exit(1);
}

console.log(
	`[verify-access] OK — ${rules.length} rule(s), ${builtFiles.length} built page(s), ` +
		`${walk(PAGES_DIR).filter((f) => f.endsWith('.astro')).length} source page(s), no protected route served statically.`,
);
