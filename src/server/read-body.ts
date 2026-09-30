/** Read a small JSON request without buffering an unbounded attacker-controlled body. */
export async function readBodyTextBounded(request: Request, maxBytes: number): Promise<string | null> {
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	const reader = request.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(result);
}
