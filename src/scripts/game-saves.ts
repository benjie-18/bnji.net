/** Offline-first generic save contract. It stores opaque progress only; it is not a game-rule or score verifier. */
export type GameSave = {
	gameId: string;
	slotId: string;
	schemaVersion: number;
	revision: number | null;
	data: unknown;
	updatedAt: number;
	dirty: boolean;
	conflict?: { revision: number; schemaVersion: number; data: unknown; updatedAt: number; deleted?: boolean };
};
export type SaveMigration = (data: unknown) => unknown;
const DB_NAME = 'bnji-game-saves-v1';
const DB_VERSION = 1;
const MAX_BYTES = 16 * 1024;
const MAX_SLOTS = 25;
const migrations = new Map<string, Map<number, SaveMigration>>();
let openPromise: Promise<IDBDatabase> | null = null;
let accountReady = false;
let onlineHandlerAttached = false;

function key(gameId: string, slotId: string): string { return `${gameId}\u0000${slotId}`; }
function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error ?? new Error('indexeddb_request_failed'));
	});
}
function openDb(): Promise<IDBDatabase> {
	if (openPromise) return openPromise;
	openPromise = new Promise((resolve, reject) => {
		if (!('indexedDB' in globalThis)) return reject(new Error('indexeddb_unavailable'));
		const opening = indexedDB.open(DB_NAME, DB_VERSION);
		opening.onupgradeneeded = () => {
			const db = opening.result;
			if (!db.objectStoreNames.contains('saves')) db.createObjectStore('saves', { keyPath: 'key' });
		};
		opening.onsuccess = () => resolve(opening.result);
		opening.onerror = () => reject(opening.error ?? new Error('indexeddb_open_failed'));
	});
	return openPromise;
}
async function allRecords(): Promise<Array<GameSave & { key: string }>> {
	const db = await openDb();
	const tx = db.transaction('saves', 'readonly');
	return request(tx.objectStore('saves').getAll()) as Promise<Array<GameSave & { key: string }>>;
}
async function readRecord(gameId: string, slotId: string): Promise<GameSave | null> {
	const db = await openDb();
	const value = await request(db.transaction('saves', 'readonly').objectStore('saves').get(key(gameId, slotId))) as (GameSave & { key: string }) | undefined;
	if (!value) return null;
	const { key: _key, ...save } = value;
	return save;
}
async function putRecord(save: GameSave): Promise<void> {
	const db = await openDb();
	const tx = db.transaction('saves', 'readwrite');
	tx.objectStore('saves').put({ ...save, key: key(save.gameId, save.slotId) });
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('indexeddb_write_failed'));
		tx.onabort = () => reject(tx.error ?? new Error('indexeddb_write_aborted'));
	});
}
export async function removeLocalSave(gameId: string, slotId: string): Promise<void> {
	const db = await openDb();
	const tx = db.transaction('saves', 'readwrite');
	tx.objectStore('saves').delete(key(gameId, slotId));
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error('indexeddb_delete_failed'));
		tx.onabort = () => reject(tx.error ?? new Error('indexeddb_delete_aborted'));
	});
}

function validPayload(data: unknown): boolean {
	try {
		const json = JSON.stringify(data);
		return json !== undefined && new TextEncoder().encode(json).byteLength <= MAX_BYTES;
	} catch { return false; }
}
export async function saveLocalProgress(gameId: string, slotId: string, schemaVersion: number, data: unknown): Promise<void> {
	if (!/^bnji\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameId) || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(slotId) ||
		!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 10_000 || !validPayload(data)) return;
	const current = await readRecord(gameId, slotId);
	const records = await allRecords();
	if (!current && records.length >= MAX_SLOTS) return;
	await putRecord({ gameId, slotId, schemaVersion, revision: current?.revision ?? null, data, updatedAt: Date.now(), dirty: true, ...(current?.conflict ? { conflict: current.conflict } : {}) });
}
export async function listLocalSaves(): Promise<GameSave[]> {
	return (await allRecords()).map(({ key: _key, ...save }) => save).sort((a, b) => b.updatedAt - a.updatedAt);
}
export function registerGameSaveMigration(gameId: string, fromVersion: number, migrate: SaveMigration): void {
	if (!/^bnji\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameId) || !Number.isSafeInteger(fromVersion) || fromVersion < 1 || typeof migrate !== 'function') {
		throw new Error('invalid_game_save_migration');
	}
	const gameMigrations = migrations.get(gameId) ?? new Map<number, SaveMigration>();
	if (gameMigrations.has(fromVersion)) throw new Error('duplicate_game_save_migration');
	gameMigrations.set(fromVersion, migrate);
	migrations.set(gameId, gameMigrations);
}
export function migrateSave(gameId: string, version: number, data: unknown, targetVersion: number): { schemaVersion: number; data: unknown } | null {
	if (!Number.isSafeInteger(version) || !Number.isSafeInteger(targetVersion) || version < 1 || targetVersion < version) return null;
	let current = data;
	let nextVersion = version;
	while (nextVersion < targetVersion) {
		const migrate = migrations.get(gameId)?.get(nextVersion);
		if (!migrate) return null;
		try { current = migrate(current); } catch { return null; }
		nextVersion += 1;
	}
	return validPayload(current) ? { schemaVersion: nextVersion, data: current } : null;
}

/** Bridge the two existing Lab personal-best stores without deleting or treating them as verified scores. */
export async function captureLegacyLocalProgress(): Promise<void> {
	try {
		const stack = Number(localStorage.getItem('bnji-stack-best') ?? 0);
		if (Number.isSafeInteger(stack) && stack > 0 && stack <= 1_000_000_000) {
			const existing = await readRecord('bnji.isometric-stack', 'local-progress');
			const current = (existing?.data as { bestScore?: unknown } | undefined)?.bestScore;
			if (!Number.isSafeInteger(current) || stack > Number(current)) {
				await saveLocalProgress('bnji.isometric-stack', 'local-progress', 1, { bestScore: stack });
			}
		}
		const bestMoves: Record<string, number> = {};
		for (let pairs = 4; pairs <= 12; pairs += 1) {
			const value = Number(sessionStorage.getItem(`bnji-mem-best-${pairs}`) ?? 0);
			if (Number.isSafeInteger(value) && value > 0 && value <= 10_000) bestMoves[String(pairs)] = value;
		}
		if (Object.keys(bestMoves).length) {
			const existing = await readRecord('bnji.memory-pairs', 'local-progress');
			const old = (existing?.data as { bestMoves?: Record<string, unknown> } | undefined)?.bestMoves ?? {};
			const merged = { ...old } as Record<string, number>;
			for (const [pairs, moves] of Object.entries(bestMoves)) {
				const previous = merged[pairs];
				if (!Number.isSafeInteger(previous) || moves < previous) merged[pairs] = moves;
			}
			if (JSON.stringify(merged) !== JSON.stringify(old)) await saveLocalProgress('bnji.memory-pairs', 'local-progress', 1, { bestMoves: merged });
		}
	} catch {
		// IndexedDB can be disabled; the original localStorage/sessionStorage values remain untouched.
	}
}
export function applyLegacyLocalProgress(save: GameSave): void {
	try {
		const value = save.data as Record<string, unknown>;
		if (save.gameId === 'bnji.isometric-stack' && typeof value?.bestScore === 'number' && Number.isSafeInteger(value.bestScore)) {
			const current = Number(localStorage.getItem('bnji-stack-best') ?? 0);
			if (value.bestScore > current) localStorage.setItem('bnji-stack-best', String(value.bestScore));
		}
		if (save.gameId === 'bnji.memory-pairs' && value?.bestMoves && typeof value.bestMoves === 'object') {
			for (const [pairs, moves] of Object.entries(value.bestMoves as Record<string, unknown>)) {
				const count = Number(pairs);
				if (!Number.isInteger(count) || count < 4 || count > 12 || !Number.isSafeInteger(moves) || Number(moves) < 1) continue;
				const key = `bnji-mem-best-${count}`;
				const current = Number(sessionStorage.getItem(key) ?? 0);
				if (!current || Number(moves) < current) sessionStorage.setItem(key, String(moves));
			}
		}
	} catch { /* Restricted storage leaves server/IndexedDB data intact. */ }
}

function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export async function requestSaveWithRetry(url: string, init: RequestInit): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' });
			if (response.status < 500 || attempt === 2) return response;
			lastError = new Error(`temporary_http_${response.status}`);
		} catch (error) { lastError = error; }
		if (attempt < 2) await wait(250 * (2 ** attempt) + Math.floor(Math.random() * 100));
	}
	throw lastError instanceof Error ? lastError : new Error('save_sync_failed');
}
async function remoteSaves(): Promise<GameSave[]> {
	const response = await requestSaveWithRetry('/api/games/saves', { method: 'GET' });
	if (!response.ok) throw new Error(response.status === 401 ? 'sign_in_required' : `save_read_${response.status}`);
	const payload = await response.json() as { saves?: GameSave[] };
	return Array.isArray(payload.saves) ? payload.saves : [];
}
export function isSameSaveContent(local: Pick<GameSave, 'schemaVersion' | 'data'>, cloud: Pick<GameSave, 'schemaVersion' | 'data'> | null): boolean {
	if (!cloud || local.schemaVersion !== cloud.schemaVersion) return false;
	try { return JSON.stringify(local.data) === JSON.stringify(cloud.data); } catch { return false; }
}

async function upload(save: GameSave): Promise<'saved' | 'conflict' | 'error'> {
	try {
		const response = await requestSaveWithRetry('/api/games/saves', {
			method: 'PUT', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ gameId: save.gameId, slotId: save.slotId, schemaVersion: save.schemaVersion, data: save.data, expectedRevision: save.revision }),
		});
		if (response.status === 409) {
			const result = await response.json() as { current?: GameSave | null };
			if (isSameSaveContent(save, result.current ?? null)) {
				await putRecord({ ...save, revision: result.current!.revision!, updatedAt: result.current!.updatedAt, dirty: false, conflict: undefined });
				return 'saved';
			}
			const conflict = result.current
				? { revision: result.current.revision!, schemaVersion: result.current.schemaVersion, data: result.current.data, updatedAt: result.current.updatedAt }
				: { revision: 0, schemaVersion: save.schemaVersion, data: null, updatedAt: 0, deleted: true };
			await putRecord({ ...save, conflict });
			return 'conflict';
		}
		if (!response.ok) return 'error';
		const result = await response.json() as { revision?: number; updatedAt?: number };
		await putRecord({ ...save, revision: Number(result.revision), updatedAt: Number(result.updatedAt), dirty: false, conflict: undefined });
		return 'saved';
	} catch { return 'error'; }
}

/** Reconcile local and cloud revisions. No side silently overwrites a changed revision. */
export async function syncPlayerSaves(): Promise<{ uploaded: number; conflicts: number; pending: number; error?: string }> {
	let cloud: GameSave[];
	try { cloud = await remoteSaves(); }
	catch (error) {
		return { uploaded: 0, conflicts: 0, pending: (await listLocalSaves().catch(() => [])).filter((save) => save.dirty).length, error: error instanceof Error ? error.message : 'save_read_failed' };
	}
	const remote = new Map(cloud.map((save) => [key(save.gameId, save.slotId), save]));
	const locals = await listLocalSaves();
	let uploaded = 0;
	let conflicts = 0;
	for (const save of locals) {
		const cloudSave = remote.get(key(save.gameId, save.slotId));
		if (!cloudSave) {
			if (save.dirty) {
				const result = await upload(save);
				if (result === 'saved') uploaded += 1;
				else if (result === 'conflict') conflicts += 1;
			} else if (save.revision !== null) {
				await putRecord({ ...save, conflict: { revision: 0, schemaVersion: save.schemaVersion, data: null, updatedAt: 0, deleted: true } });
				conflicts += 1;
			}
			continue;
		}
		remote.delete(key(save.gameId, save.slotId));
		if (save.revision !== cloudSave.revision && save.dirty) {
			await putRecord({ ...save, conflict: { revision: cloudSave.revision!, schemaVersion: cloudSave.schemaVersion, data: cloudSave.data, updatedAt: cloudSave.updatedAt } });
			conflicts += 1;
		} else if (save.dirty) {
			const result = await upload({ ...save, revision: cloudSave.revision! });
			if (result === 'saved') uploaded += 1;
			else if (result === 'conflict') conflicts += 1;
		} else if (cloudSave.revision! >= (save.revision ?? 0)) {
			const adopted = { ...cloudSave, dirty: false };
			await putRecord(adopted);
			applyLegacyLocalProgress(adopted);
		}
	}
	for (const save of remote.values()) {
		const adopted = { ...save, dirty: false };
		await putRecord(adopted);
		applyLegacyLocalProgress(adopted);
	}
	const after = await listLocalSaves();
	return { uploaded, conflicts, pending: after.filter((save) => save.dirty).length };
}

export async function chooseCloudVersion(gameId: string, slotId: string): Promise<void> {
	const local = await readRecord(gameId, slotId);
	if (!local?.conflict) return;
	const conflict = local.conflict;
	if (conflict.deleted) {
		await removeLocalSave(gameId, slotId);
		return;
	}
	const adopted: GameSave = { ...local, schemaVersion: conflict.schemaVersion, revision: conflict.revision, data: conflict.data, updatedAt: conflict.updatedAt, dirty: false, conflict: undefined };
	await putRecord(adopted);
	applyLegacyLocalProgress(adopted);
}
export async function chooseLocalVersion(gameId: string, slotId: string): Promise<'saved' | 'conflict' | 'error'> {
	const local = await readRecord(gameId, slotId);
	if (!local?.conflict) return 'error';
	const next = { ...local, revision: local.conflict.deleted ? null : local.conflict.revision, conflict: undefined, dirty: true };
	await putRecord(next);
	return upload(next);
}

export function setSaveAccountAvailable(available: boolean): void {
	accountReady = available;
	if (!onlineHandlerAttached && 'addEventListener' in globalThis) {
		onlineHandlerAttached = true;
		globalThis.addEventListener('online', () => {
			if (accountReady) void syncPlayerSaves();
		});
	}
}
