/** Minimal asynchronous IndexedDB test double for the save client contract. */
export function createFakeIndexedDB() {
	const stores = new Map();
	const database = {
		objectStoreNames: { contains: (name) => stores.has(name) },
		createObjectStore(name, options = {}) {
			stores.set(name, { keyPath: options.keyPath ?? 'key', rows: new Map() });
		},
		transaction(name) {
			const store = stores.get(name);
			if (!store) throw new Error(`unknown_object_store:${name}`);
			const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
			const finish = () => setTimeout(() => tx.oncomplete?.({ target: tx }), 0);
			const run = (operation) => {
				const request = { result: undefined, error: null, onsuccess: null, onerror: null };
				queueMicrotask(() => {
					try {
						request.result = operation();
						request.onsuccess?.({ target: request });
					} catch (error) {
						request.error = error;
						request.onerror?.({ target: request });
						tx.error = error;
						tx.onerror?.({ target: tx });
					}
					finish();
				});
				return request;
			};
			tx.objectStore = () => ({
				get: (key) => run(() => store.rows.get(key)),
				getAll: () => run(() => [...store.rows.values()]),
				put: (value) => run(() => { store.rows.set(value[store.keyPath], structuredClone(value)); return value[store.keyPath]; }),
				delete: (key) => run(() => store.rows.delete(key)),
			});
			return tx;
		},
	};
	return {
		open() {
			const request = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
			queueMicrotask(() => {
				request.result = database;
				request.onupgradeneeded?.({ target: request });
				queueMicrotask(() => request.onsuccess?.({ target: request }));
			});
			return request;
		},
	};
}
