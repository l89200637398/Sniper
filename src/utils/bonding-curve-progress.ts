export interface CurveProgress {
  progressPct: number;
  isTooEarly: boolean;
  isTooLate: boolean;
  reason?: string;
}

const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
const GRADUATION_SOL_THRESHOLD = 85;

export function analyzeBondingCurveProgress(
  virtualTokenReserves: bigint,
  virtualSolReserves: bigint,
  realSolReserves: bigint,
  opts: { minProgressPct?: number; maxProgressPct?: number } = {},
): CurveProgress {
  const minPct = opts.minProgressPct ?? 2;
  const maxPct = opts.maxProgressPct ?? 85;

  const realSol = Number(realSolReserves) / 1e9;
  const progressPct = Math.min(100, (realSol / GRADUATION_SOL_THRESHOLD) * 100);

  if (progressPct < minPct) {
    return {
      progressPct,
      isTooEarly: true,
      isTooLate: false,
      reason: `curve_too_early_${progressPct.toFixed(1)}pct`,
    };
  }

  if (progressPct > maxPct) {
    return {
      progressPct,
      isTooEarly: false,
      isTooLate: true,
      reason: `curve_too_late_${progressPct.toFixed(1)}pct`,
    };
  }

  return { progressPct, isTooEarly: false, isTooLate: false };
}
