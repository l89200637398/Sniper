// src/runtime-layout.ts
import fs from 'fs';
import path from 'path';

const layoutPath = path.resolve(__dirname, './autogen/runtime-layout.json');

export interface RuntimeLayout {
  generatedAt: string;
  global: { offset: number; key: string | null };
  bondingCurve: { tokenReserveOffset: number; solReserveOffset: number } | null;
  pumpSwapPool: { wsolOffset: number; baseMintOffset: number } | null;
}

let cached: RuntimeLayout | null = null;

export function getRuntimeLayout(): RuntimeLayout {
  if (cached) return cached;

  try {
    if (fs.existsSync(layoutPath)) {
      const raw = fs.readFileSync(layoutPath, 'utf8');
      cached = JSON.parse(raw) as RuntimeLayout;
    } else {
      console.warn('⚠️ runtime-layout.json not found, using fallback values');
      cached = {
        generatedAt: new Date().toISOString(),
        global: { offset: 40, key: null },
        bondingCurve: { tokenReserveOffset: 8, solReserveOffset: 16 },
        pumpSwapPool: null,
      };
    }
  } catch (err) {
    console.warn('⚠️ Failed to load runtime layout, using fallback', err);
    cached = {
      generatedAt: new Date().toISOString(),
      global: { offset: 40, key: null },
      bondingCurve: { tokenReserveOffset: 8, solReserveOffset: 16 },
      pumpSwapPool: null,
    };
  }
  return cached;
}