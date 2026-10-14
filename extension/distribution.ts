// Observed jev-1.13.0 wire values are rounded to two decimal places. Keep the
// returned values intact; validate existence of a normalized distribution within
// their rounding intervals rather than demanding exact equality of rounded data.
const EPS = 1e-9;
function interval(value: number): [number, number] {
	const roundedHundredth = Math.abs(value * 100 - Math.round(value * 100)) < EPS;
	const radius = roundedHundredth ? 0.005 : EPS;
	return [Math.max(0, value - radius), Math.min(1, value + radius)];
}

export function distributionBounds(values: number[]): { minMean: number; maxMean: number } | null {
	if (!values.length || !values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1))
		return null;
	const intervals = values.map(interval);
	const lowSum = intervals.reduce((sum, [low]) => sum + low, 0);
	const highSum = intervals.reduce((sum, [, high]) => sum + high, 0);
	if (lowSum > 1 + EPS || highSum < 1 - EPS) return null;
	function extreme(reverse: boolean): number {
		let remaining = Math.max(0, 1 - lowSum);
		let mean = intervals.reduce((sum, [low], index) => sum + low * index, 0);
		const indices = intervals.map((_, index) => index);
		if (reverse) indices.reverse();
		for (const index of indices) {
			const [low, high] = intervals[index];
			const allocation = Math.min(remaining, high - low);
			mean += allocation * index;
			remaining -= allocation;
		}
		return mean;
	}
	return { minMean: extreme(false), maxMean: extreme(true) };
}

export function scoreFits(score: number, probabilities: number[]): boolean {
	const bounds = distributionBounds(probabilities);
	// The scalar score is also observed rounded to hundredths on the wire.
	return (
		!!bounds &&
		Number.isFinite(score) &&
		score >= 0 &&
		score <= probabilities.length - 1 &&
		score + 0.005 + EPS >= bounds.minMean &&
		score - 0.005 - EPS <= bounds.maxMean
	);
}

/**
 * J03: a reported choice is consistent when it can be the (tied) maximum within the
 * hundredth-rounding intervals of the reported distribution. Reject only when even the
 * most favorable rounding cannot reach the best other option's interval — no blanket
 * ±0.01 tolerance, so a clearly smaller probability never passes (R3).
 */
export function choiceFits(choice: string, probabilities: Record<string, number>): boolean {
	const entries = Object.entries(probabilities);
	if (
		!entries.length ||
		!entries.every(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
	)
		return false;
	const mine = entries.find(([key]) => key === choice);
	if (!mine) return false;
	const mineHigh = interval(mine[1])[1];
	let bestOtherLow = 0;
	let bestOtherHigh = -1;
	for (const [key, value] of entries) {
		if (key === choice) continue;
		const [low, high] = interval(value);
		if (high > bestOtherHigh) {
			bestOtherHigh = high;
			bestOtherLow = low;
		}
	}
	if (bestOtherHigh < 0) return true; // single option
	return mineHigh + EPS >= bestOtherLow;
}
