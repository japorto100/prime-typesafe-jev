/** Bounded explicit approval. Errors, cancellation and malformed replies deny. */
export async function requestConfirmation(
	confirm: (options: { signal: AbortSignal; timeout: number }) => unknown,
	parentSignal?: AbortSignal,
	timeoutMs = 30000,
): Promise<boolean> {
	if (parentSignal?.aborted || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
	const controller = new AbortController();
	let deny!: (value: boolean) => void;
	const cancelled = new Promise<boolean>((resolve) => {
		deny = resolve;
	});
	const abort = () => {
		deny(false);
		controller.abort();
	};
	const timer = setTimeout(abort, timeoutMs);
	parentSignal?.addEventListener("abort", abort, { once: true });
	try {
		const answer = Promise.resolve()
			.then(() => {
				if (controller.signal.aborted) return false;
				return confirm({ signal: controller.signal, timeout: timeoutMs });
			})
			.then(
				(value) => value === true && !controller.signal.aborted,
				() => false,
			);
		return await Promise.race([answer, cancelled]);
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", abort);
		controller.abort();
	}
}
