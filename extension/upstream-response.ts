/** Bound bytes before parsing: the socket cap alone is too late for upstream JSON. */
export async function readUpstreamJson(response: Response, limit = 1024 * 1024): Promise<any> {
	const declared = response.headers.get("content-length");
	if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
		await response.body?.cancel();
		throw new Error("JevResponseTooLarge");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("JevInvalidDecision: empty upstream response");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new Error("JevResponseTooLarge");
			}
			chunks.push(value);
		}
		try {
			return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
		} catch {
			// Parser errors may contain upstream-reflected private request text.
			throw new Error("JevInvalidDecision: malformed upstream JSON");
		}
	} finally {
		reader.releaseLock();
	}
}
