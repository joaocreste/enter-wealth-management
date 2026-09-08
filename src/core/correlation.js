/**
 * Pairwise correlation of daily returns.
 *
 * Pearson correlation of log returns, pairwise-complete: each pair is measured
 * over the dates both series observed, so one series' holiday gap does not
 * shorten every other pair. The observation count travels with every
 * coefficient, because a correlation without its sample size is not information.
 * A pair with too few common observations is null — unavailable, never zero.
 */

/** Daily log returns keyed by date, from a series of { date, close } points. */
export function logReturns(points) {
  const out = new Map();
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1].close;
    const b = points[i].close;
    if (a > 0 && b > 0) out.set(points[i].date, Math.log(b / a));
  }
  return out;
}

/** Pearson correlation of two equal-length samples; null when undefined. */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  let sx = 0; let sy = 0;
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n; const my = sy / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx; const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/**
 * @param {Array<{ key: string, returns: Map<string, number> }>} series
 * @returns {{ matrix: (number|null)[][], observations: number[][] }}
 */
export function correlationMatrix(series, { minObservations = 20 } = {}) {
  const n = series.length;
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  const observations = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    matrix[i][i] = 1;
    observations[i][i] = series[i].returns.size;
    for (let j = i + 1; j < n; j += 1) {
      const xs = []; const ys = [];
      for (const [date, x] of series[i].returns) {
        const y = series[j].returns.get(date);
        if (y != null) { xs.push(x); ys.push(y); }
      }
      const r = xs.length >= minObservations ? pearson(xs, ys) : null;
      matrix[i][j] = r; matrix[j][i] = r;
      observations[i][j] = xs.length; observations[j][i] = xs.length;
    }
  }
  return { matrix, observations };
}
