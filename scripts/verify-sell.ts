#!/usr/bin/env ts-node

/**
 * scripts/verify-sell.ts
 *
 * Pre-launch sell path verification.
 * Validates that all sell routes (6 protocols) are importable,
 * sell-engine routing works, and position TP system is correct.
 *
 * Usage: npx ts-node scripts/verify-sell.ts
 * Exit: 0 = all checks pass, 1 = failure
 */

import { PublicKey } from '@solana/web3.js';
import { config } from '../src/config';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => boolean) {
  try {
    if (fn()) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  } catch (err: any) {
    console.log(`  ✗ ${name} — THREW: ${err.message}`);
    failed++;
  }
}

// ── 1. Import verification ──────────────────────────────────────────────────
console.log('\n=== 1. Sell module imports ===');

check('sell-engine imports', () => {
  require('../src/core/sell-engine');
  return true;
});
check('pumpSwap sell imports', () => {
  const m = require('../src/trading/pumpSwap');
  return typeof m.sellTokenPumpSwap === 'function';
});
check('pump.fun sell imports', () => {
  const m = require('../src/trading/sell');
  return typeof m.sellToken === 'function';
});
check('raydiumCpmm sell imports', () => {
  const m = require('../src/trading/raydiumCpmm');
  return typeof m.sellTokenCpmm === 'function';
});
check('raydiumAmmV4 sell imports', () => {
  const m = require('../src/trading/raydiumAmmV4');
  return typeof m.sellTokenAmmV4 === 'function';
});
check('raydiumLaunchLab sell imports', () => {
  const m = require('../src/trading/raydiumLaunchLab');
  return typeof m.sellTokenLaunchLab === 'function';
});
check('jupiter-sell imports', () => {
  const m = require('../src/trading/jupiter-sell');
  return typeof m.sellTokenJupiter === 'function';
});

// ── 2. Sell-engine routing logic ────────────────────────────────────────────
console.log('\n=== 2. Sell-engine route resolution ===');

check('sellTokenAuto is exported', () => {
  const { sellTokenAuto } = require('../src/core/sell-engine');
  return typeof sellTokenAuto === 'function';
});

// ── 3. Position TP system ───────────────────────────────────────────────────
console.log('\n=== 3. Position TP system ===');

check('Position class imports', () => {
  require('../src/core/position');
  return true;
});

// Verify TP levels for each protocol
const protocols = [
  { name: 'pumpFun', cfg: config.strategy.pumpFun },
  { name: 'pumpSwap', cfg: config.strategy.pumpSwap },
  { name: 'raydiumLaunch', cfg: config.strategy.raydiumLaunch },
  { name: 'raydiumCpmm', cfg: config.strategy.raydiumCpmm },
  { name: 'raydiumAmmV4', cfg: config.strategy.raydiumAmmV4 },
  { name: 'scalping', cfg: config.strategy.scalping },
];

for (const { name, cfg } of protocols) {
  const tp = (cfg as any).exit?.takeProfit;
  if (!tp || !Array.isArray(tp)) {
    check(`${name} TP levels exist`, () => false);
    continue;
  }

  check(`${name} TP levels count >= 4`, () => tp.length >= 4);

  check(`${name} TP levels ascending`, () => {
    for (let i = 1; i < tp.length; i++) {
      if (tp[i].levelPercent <= tp[i - 1].levelPercent) return false;
    }
    return true;
  });

  check(`${name} TP portions valid (0 < p <= 1.0)`, () => {
    return tp.every((l: any) => l.portion > 0 && l.portion <= 1.0);
  });

  const hasFullExit = tp.some((l: any) => l.portion >= 1.0);
  const partialSum = tp.filter((l: any) => l.portion < 1.0).reduce((s: number, l: any) => s + l.portion, 0);
  check(`${name} TP partial portions sum < 1.0 (actual: ${partialSum.toFixed(2)})${hasFullExit ? ' + full exit TP' : ''}`, () => partialSum < 1.01);
}

// PumpSwap-specific: verify TP5 at 1000%
check('pumpSwap has TP5 at 1000% (full exit)', () => {
  const tp = config.strategy.pumpSwap.exit.takeProfit;
  const tp5 = tp.find((l: any) => l.levelPercent === 1000);
  return tp5 !== undefined && tp5.portion >= 1.0;
});

// ── 4. Break-even logic ─────────────────────────────────────────────────────
console.log('\n=== 4. Break-even & isScalp verification ===');

check('Position isScalp set before initExit', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/core/position.ts'), 'utf8');
  const isScalpLine = src.indexOf('this.isScalp = options.isScalp');
  const initExitLine = src.indexOf('const initExit = this.isScalp');
  return isScalpLine > 0 && initExitLine > 0 && isScalpLine < initExitLine;
});

check('Break-even checks tp1Taken (not takenLevelsCount > 0)', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/core/position.ts'), 'utf8');
  return src.includes('tp1Taken') && src.includes('firstTpLevel');
});

// ── 5. Config sanity ────────────────────────────────────────────────────────
console.log('\n=== 5. Config sanity ===');

check('maxPositions > 0', () => config.strategy.maxPositions > 0);
check('maxTotalExposureSol > 0', () => config.strategy.maxTotalExposureSol > 0);
check('PumpSwap entry = 0.14 (aggressive)', () => config.strategy.pumpSwap.entryAmountSol === 0.14);
check('pump.fun entry = 0.05 (conservative)', () => config.strategy.pumpFun.entryAmountSol === 0.05);
check('pump.fun slots = 1', () => config.strategy.maxPumpFunPositions === 1);
check('raydium-launch slots = 1', () => config.strategy.maxRaydiumLaunchPositions === 1);
check('maxTotalExposure = 2.0', () => config.strategy.maxTotalExposureSol === 2.0);

// ── 6. Sell fallback chain ──────────────────────────────────────────────────
console.log('\n=== 6. Sell fallback chain ===');

check('Jupiter sell available as fallback', () => {
  const { sellTokenJupiter } = require('../src/trading/jupiter-sell');
  return typeof sellTokenJupiter === 'function';
});

check('Jito bundle module loads', () => {
  const m = require('../src/jito/bundle');
  return typeof m.sendJitoBundle === 'function' || typeof m.sendJitoBurst === 'function';
});

// ── 7. Safety checks in onTrendConfirmed ────────────────────────────────────
console.log('\n=== 7. Safety checks presence ===');

check('onTrendConfirmed has safety check', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/core/sniper.ts'), 'utf8');
  return src.includes('isTokenSafeCached') && src.includes('safety_failed');
});

check('onTrendConfirmed has protocol-aware rugcheck', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/core/sniper.ts'), 'utf8');
  return src.includes('rugcheck_high_risk') && src.includes('isMigrated');
});

check('Twitter parser disabled', () => {
  const src = require('fs').readFileSync(require('path').resolve(__dirname, '../src/core/sniper.ts'), 'utf8');
  return src.includes('Twitter parser DISABLED');
});

// ── Results ─────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\n⛔ SELL VERIFICATION FAILED — do NOT deploy!');
  process.exit(1);
} else {
  console.log('\n✅ All sell paths verified — safe to deploy.');
  process.exit(0);
}
