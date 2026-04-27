export interface ShadowProfile {
  name: string;
  label: string;
  startBalanceSol: number;
  entryAmountSol: number;
  copyTradeEntrySol: number;
  maxPositions: number;
  maxExposureSol: number;
}

export const PROFILES: ShadowProfile[] = [
  {
    name: 'conservative',
    label: 'Conservative (0.05 SOL)',
    startBalanceSol: 10.0,
    entryAmountSol: 0.05,
    copyTradeEntrySol: 0.03,
    maxPositions: 6,
    maxExposureSol: 6.0,
  },
  {
    name: 'balanced',
    label: 'Balanced (0.10 SOL)',
    startBalanceSol: 20.0,
    entryAmountSol: 0.10,
    copyTradeEntrySol: 0.06,
    maxPositions: 8,
    maxExposureSol: 15.0,
  },
  {
    name: 'aggressive',
    label: 'Aggressive (0.20 SOL)',
    startBalanceSol: 40.0,
    entryAmountSol: 0.20,
    copyTradeEntrySol: 0.10,
    maxPositions: 8,
    maxExposureSol: 30.0,
  },
];
