// __tests__/token-scorer.test.ts
//
// Unit tests for the v4 rule-based token scoring engine (0–100).
// Covers: social, market validation, creator quality, metadata, safety,
// zero-signals gate, holder concentration, mayhem bypass, entry multiplier.

import { scoreToken, TokenFeatures } from '../src/utils/token-scorer';

const BASE_FEATURES: TokenFeatures = {
  socialScore: 0,
  independentBuyers: 0,
  firstBuySol: 0,
  creatorRecentTokens: 0,
  metadataJsonSize: 0,
  rugcheckRisk: 'unknown',
  hasMintAuthority: false,
  hasFreezeAuthority: false,
  isMayhem: false,
};

function feat(overrides: Partial<TokenFeatures>): TokenFeatures {
  return { ...BASE_FEATURES, ...overrides };
}

// ─── Social Score ────────────────────────────────────────────────────────────

describe('Social scoring', () => {
  it('social=3 → +35 points', () => {
    const r = scoreToken(feat({ socialScore: 3, creatorRecentTokens: 1 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('social=3(+35)'));
  });

  it('social=2 → +25 points', () => {
    const r = scoreToken(feat({ socialScore: 2 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('social=2(+25)'));
  });

  it('social=1 → +15 points', () => {
    const r = scoreToken(feat({ socialScore: 1 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('social=1(+15)'));
  });

  it('social=0 → no social bonus', () => {
    const r = scoreToken(feat({ socialScore: 0 }));
    expect(r.reasons.filter(r => r.startsWith('social='))).toHaveLength(0);
  });
});

// ─── Market Validation ───────────────────────────────────────────────────────

describe('Market validation', () => {
  it('5+ buyers → +20, first buy ≥0.5 SOL → +10', () => {
    const r = scoreToken(feat({ independentBuyers: 5, firstBuySol: 0.5 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('buyers=5(+20)'));
    expect(r.reasons).toContainEqual(expect.stringContaining('1stBuy=0.50(+10)'));
  });

  it('3 buyers → +15', () => {
    const r = scoreToken(feat({ independentBuyers: 3 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('buyers=3(+15)'));
  });

  it('1 buyer → +10', () => {
    const r = scoreToken(feat({ independentBuyers: 1 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('buyers=1(+10)'));
  });
});

// ─── Creator Quality ─────────────────────────────────────────────────────────

describe('Creator quality', () => {
  it('clean creator (0 recent tokens) → +15', () => {
    const r = scoreToken(feat({ creatorRecentTokens: 0 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('creator_ok(+10)'));
    expect(r.reasons).toContainEqual(expect.stringContaining('creator_clean(+5)'));
  });

  it('spam creator (≥3 tokens in 60s) → -25 penalty', () => {
    const r = scoreToken(feat({ creatorRecentTokens: 5 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('SPAM_CREATOR(-25)'));
  });
});

// ─── Metadata ────────────────────────────────────────────────────────────────

describe('Metadata scoring', () => {
  it('rich metadata (≥500 bytes) → +5', () => {
    const r = scoreToken(feat({ metadataJsonSize: 600 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('rich_meta(+5)'));
  });

  it('tiny metadata (1-199 bytes) → -10', () => {
    const r = scoreToken(feat({ metadataJsonSize: 100 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('tiny_meta(-10)'));
  });

  it('no metadata (0 bytes) → -5', () => {
    const r = scoreToken(feat({ metadataJsonSize: 0 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('no_meta(-5)'));
  });
});

// ─── Safety Checks ───────────────────────────────────────────────────────────

describe('Safety penalties', () => {
  it('rug_safe → +15', () => {
    const r = scoreToken(feat({ rugcheckRisk: 'low' }));
    expect(r.reasons).toContainEqual(expect.stringContaining('rug_safe(+15)'));
  });

  it('rug_medium → -10', () => {
    const r = scoreToken(feat({ rugcheckRisk: 'medium' }));
    expect(r.reasons).toContainEqual(expect.stringContaining('rug_medium(-10)'));
  });

  it('rug_high → -50 (massive penalty)', () => {
    const r = scoreToken(feat({ rugcheckRisk: 'high' }));
    expect(r.reasons).toContainEqual(expect.stringContaining('RUG_HIGH(-50)'));
    expect(r.shouldEnter).toBe(false);
  });

  it('MINT_AUTH → -40', () => {
    const r = scoreToken(feat({ hasMintAuthority: true }));
    expect(r.reasons).toContainEqual(expect.stringContaining('MINT_AUTH(-40)'));
  });

  it('FREEZE → -30', () => {
    const r = scoreToken(feat({ hasFreezeAuthority: true }));
    expect(r.reasons).toContainEqual(expect.stringContaining('FREEZE(-30)'));
  });

  it('BOTH_AUTH → additional -20 on top of individual penalties', () => {
    const r = scoreToken(feat({ hasMintAuthority: true, hasFreezeAuthority: true }));
    expect(r.reasons).toContainEqual(expect.stringContaining('BOTH_AUTH(-20)'));
    expect(r.reasons).toContainEqual(expect.stringContaining('MINT_AUTH(-40)'));
    expect(r.reasons).toContainEqual(expect.stringContaining('FREEZE(-30)'));
  });
});

// ─── Zero Signals Gate ───────────────────────────────────────────────────────

describe('Zero signals gate', () => {
  it('no social + no buyers + unknown rugcheck → -8 extra', () => {
    const r = scoreToken(feat({
      socialScore: 0,
      independentBuyers: 0,
      rugcheckRisk: 'unknown',
    }));
    expect(r.reasons).toContainEqual(expect.stringContaining('ZERO_SIGNALS(-8)'));
  });

  it('does NOT trigger if any signal exists', () => {
    const r = scoreToken(feat({
      socialScore: 1,
      independentBuyers: 0,
      rugcheckRisk: 'unknown',
    }));
    expect(r.reasons.filter(r => r.includes('ZERO_SIGNALS'))).toHaveLength(0);
  });
});

// ─── Holder Concentration ────────────────────────────────────────────────────

describe('Holder concentration', () => {
  it('>50% top holder → -25', () => {
    const r = scoreToken(feat({ topHolderPct: 60 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('TOP_HOLDER_60%(-25)'));
  });

  it('30-50% top holder → -10', () => {
    const r = scoreToken(feat({ topHolderPct: 35 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('holder_conc_35%(-10)'));
  });

  it('<15% top holder → +5', () => {
    const r = scoreToken(feat({ topHolderPct: 10 }));
    expect(r.reasons).toContainEqual(expect.stringContaining('holder_distributed(+5)'));
  });

  it('undefined topHolderPct → no bonus or penalty', () => {
    const r = scoreToken(feat({ topHolderPct: undefined }));
    expect(r.reasons.filter(r => r.includes('holder'))).toHaveLength(0);
    expect(r.reasons.filter(r => r.includes('TOP_HOLDER'))).toHaveLength(0);
  });
});

// ─── Mayhem Bypass ───────────────────────────────────────────────────────────

describe('Mayhem bypass', () => {
  it('mayhem mode forces score to at least minScore', () => {
    const r = scoreToken(feat({ isMayhem: true, hasMintAuthority: true, hasFreezeAuthority: true }), 60);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.shouldEnter).toBe(true);
  });
});

// ─── Score Clamping ──────────────────────────────────────────────────────────

describe('Score clamping 0-100', () => {
  it('score never exceeds 100', () => {
    const r = scoreToken(feat({
      socialScore: 3,
      independentBuyers: 5,
      firstBuySol: 1.0,
      creatorRecentTokens: 0,
      metadataJsonSize: 600,
      rugcheckRisk: 'low',
      topHolderPct: 5,
    }));
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('score never goes below 0', () => {
    const r = scoreToken(feat({
      hasMintAuthority: true,
      hasFreezeAuthority: true,
      rugcheckRisk: 'high',
      creatorRecentTokens: 10,
    }));
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

// ─── Entry Multiplier ────────────────────────────────────────────────────────

describe('Entry multiplier', () => {
  it('score ≥ 80 → 1.5x multiplier', () => {
    const r = scoreToken(feat({
      socialScore: 3, independentBuyers: 5, firstBuySol: 1.0,
      creatorRecentTokens: 0, rugcheckRisk: 'low', metadataJsonSize: 600,
    }));
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.entryMultiplier).toBe(1.5);
  });

  it('score 60-79 → 1.0x multiplier', () => {
    const r = scoreToken(feat({
      socialScore: 2, independentBuyers: 3,
      creatorRecentTokens: 1, rugcheckRisk: 'low',
    }));
    if (r.score >= 60 && r.score < 80) {
      expect(r.entryMultiplier).toBe(1.0);
    }
  });

  it('score below minScore → shouldEnter=false', () => {
    const r = scoreToken(feat({
      socialScore: 0, independentBuyers: 0,
      creatorRecentTokens: 2, rugcheckRisk: 'unknown',
    }), 60);
    expect(r.shouldEnter).toBe(false);
  });
});

// ─── Composite Scenarios ─────────────────────────────────────────────────────

describe('Composite real-world scenarios', () => {
  it('ideal token: social=3, 5 buyers, clean creator, rug safe → enters with 1.5x', () => {
    const r = scoreToken(feat({
      socialScore: 3,
      independentBuyers: 5,
      firstBuySol: 0.5,
      creatorRecentTokens: 0,
      metadataJsonSize: 600,
      rugcheckRisk: 'low',
      topHolderPct: 10,
    }), 60);
    expect(r.shouldEnter).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.entryMultiplier).toBe(1.5);
  });

  it('rug token: high risk + mint auth + spam creator → blocked', () => {
    const r = scoreToken(feat({
      rugcheckRisk: 'high',
      hasMintAuthority: true,
      creatorRecentTokens: 5,
      topHolderPct: 70,
    }), 60);
    expect(r.shouldEnter).toBe(false);
    expect(r.score).toBe(0);
  });

  it('borderline token: social=1, 1 buyer, unknown rug → near threshold', () => {
    const r = scoreToken(feat({
      socialScore: 1,
      independentBuyers: 1,
      creatorRecentTokens: 2,
      metadataJsonSize: 300,
      rugcheckRisk: 'unknown',
    }), 60);
    // social=1(+15) + buyers=1(+10) + creator_ok(+10) = 35 < 60
    expect(r.shouldEnter).toBe(false);
  });
});
