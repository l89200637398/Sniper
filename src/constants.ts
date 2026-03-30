// src/constants.ts
import { sha256 } from './utils/sha';

// ─── Program IDs ──────────────────────────────────────────────────────────────
export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_FUN_ROUTER_PROGRAM_ID = 'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y';
export const PUMP_SWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// ─── Fee Program (обязательно с 1 сентября 2025) ──────────────────────────────
export const FEE_PROGRAM_ID = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';

// ─── Mayhem mode (Breaking change 12.11.2025) ─────────────────────────────────
export const MAYHEM_PROGRAM_ID = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';

// Mayhem fee recipients — хранятся в Global.reserved_fee_recipient[0..7].
// Можно использовать любой из 8 для mayhem-токена.
// Источник: https://t.me/pump_tech_updates (message 31, November 2025)
// deepwiki: Global.reserved_fee_recipient + Global.reserved_fee_recipients[7]
export const MAYHEM_FEE_RECIPIENTS: string[] = [
  'GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS',
  '4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6',
  '8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR',
  '4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH',
  '8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6',
  'Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk',
  '463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq',
  '6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA',
];

// ─── Total supply constants ───────────────────────────────────────────────────
export const MAYHEM_TOTAL_SUPPLY = 2_000_000_000;
export const REGULAR_TOTAL_SUPPLY = 1_000_000_000;

// ─── Instruction discriminators ───────────────────────────────────────────────
//
// Anchor discriminator = sha256('global:<instructionName>')[0..8]
// Instruction names берутся из camelCase IDL (pump.json / pump_amm.json).
//
export const DISCRIMINATOR = {
  // Старый buy (exact-out: amount=токены, max_sol_cost=SOL) — устарел с фев 2026
  BUY:                   Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  // Новый buy_exact_sol_in (exact-in: sol_amount=SOL, min_tokens_out=токены) — актуален
  BUY_EXACT_SOL_IN:      Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]),
  SELL:                  Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  CREATE:                Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]),
  CREATE_V2:             Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]),

  // ── PumpSwap (pAMMBay6...) discriminators ────────────────────────────────────
  //
  // Источник: реальные транзакции, декодированные через Solscan
  //   create_pool: 0xe992d18ecf6840bc (из tx 2WYV7xKvdp6...)
  //   buy:         0x66063d1201daebea (совпадает с pump.fun buy)
  //   sell:        0x33e685a4017f83ad (совпадает с pump.fun sell)
  //
  // Разделение происходит по programId в client.ts ПЕРЕД проверкой дискриминатора.
  //
  // Verified against pump_amm IDL: sha256('global:<name>')[0:8]
  PUMP_SWAP_CREATE_POOL: Buffer.from([0xe9, 0x92, 0xd1, 0x8e, 0xcf, 0x68, 0x40, 0xbc]), // global:create_pool
  PUMP_SWAP_BUY:         Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]), // global:buy
  PUMP_SWAP_SELL:        Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]), // global:sell
};

// ─── BondingCurve account layout (151 bytes after февраль 2026 cashback upgrade) ──
//
// После Anchor discriminator (8 байт):
//   virtual_token_reserves : u64   @ 8
//   virtual_sol_reserves   : u64   @ 16
//   real_token_reserves    : u64   @ 24
//   real_sol_reserves      : u64   @ 32
//   token_total_supply     : u64   @ 40
//   complete               : bool  @ 48
//   creator                : Pubkey @ 49  (32 bytes)
//   is_mayhem_mode         : bool  @ 81  (reserved/legacy — у не-mayhem всегда 0)
//   cashback_enabled       : bool  @ 82  ← НОВОЕ (cashback upgrade фев 2026)
//   extended_fields        :       @ 83–150 (68 bytes)
//
// Источник: allenhark.com cashback upgrade guide, idl/pump.json
export const BONDING_CURVE_LAYOUT = {
  VIRTUAL_TOKEN_RESERVES_OFFSET: 8,
  VIRTUAL_SOL_RESERVES_OFFSET:   16,
  REAL_TOKEN_RESERVES_OFFSET:    24,
  REAL_SOL_RESERVES_OFFSET:      32,
  TOKEN_TOTAL_SUPPLY_OFFSET:     40,
  COMPLETE_OFFSET:               48,
  CREATOR_OFFSET:                49,  // Pubkey, 32 bytes
  IS_MAYHEM_MODE_OFFSET:         81,  // bool, 1 byte
  CASHBACK_ENABLED_OFFSET:       82,  // bool, 1 byte (new in cashback upgrade Feb 2026)
  MIN_SIZE:                      83,  // минимальный размер с cashback полем
  EXTENDED_SIZE:                 151, // полный размер после апгрейда
} as const;

// ─── Global account layout ────────────────────────────────────────────────────
//
// Верифицировано по официальному IDL (deepwiki 3.3-account-structure).
// После Anchor discriminator (8 байт):
//   initialized                : bool   @ 8    (legacy, always true)
//   authority                  : Pubkey @ 9    (32 bytes)
//   fee_recipient              : Pubkey @ 41   <- ПЕРВЫЙ из 8 протокольных получателей
//   initial_virtual_token_res. : u64    @ 73
//   initial_virtual_sol_res.   : u64    @ 81
//   initial_real_token_res.    : u64    @ 89
//   token_total_supply         : u64    @ 97
//   fee_basis_points           : u64    @ 105
//   withdraw_authority         : Pubkey @ 113
//   enable_migrate             : bool   @ 145
//   pool_migration_fee         : u64    @ 146
//   creator_fee_basis_points   : u64    @ 154
//   fee_recipients[7]          : Pubkey @ 162  <- СЛЕДУЮЩИЕ 7 (по 32 байта каждый)
//     fee_recipients[0]: @ 162, [1]: @ 194, [2]: @ 226, [3]: @ 258
//     fee_recipients[4]: @ 290, [5]: @ 322, [6]: @ 354
//   admin_set_creator_authority: Option<Pubkey> @ 386
//   ...
//
// ИТОГО 8 валидных feeRecipient-адресов (fee_recipient + fee_recipients[0..6]).
// Программа: require!(fee_recipient IN all_8, NotAuthorized).
//
// ВАЖНО: feeConfig (pfeeUxB6...) содержит fee RATES, а НЕ адреса получателей.
// Читать feeRecipient из feeConfig -> NotAuthorized (6000).
// Читать из Global аккаунта -> ПРАВИЛЬНО.

export const GLOBAL_ACCOUNT_ADDRESS = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';

export const GLOBAL_ACCOUNT_LAYOUT = {
  FEE_RECIPIENT_OFFSET:        41,   // Pubkey, 32 bytes (первый из 8)
  FEE_RECIPIENTS_ARRAY_OFFSET: 162,  // [Pubkey; 7] — следующие 7 (каждый по 32 байта)
  FEE_RECIPIENTS_COUNT:        7,    // количество в массиве (не считая первый)
  FEE_TOTAL_COUNT:             8,    // всего валидных адресов
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// ═══ RAYDIUM ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Raydium Program IDs (mainnet) ───────────────────────────────────────────
//
// Источник: https://docs.raydium.io/raydium/protocol/developers/addresses
//           https://github.com/raydium-io/raydium-sdk-V2/src/common/programId.ts

// LaunchLab — bonding curve launchpad (аналог pump.fun)
export const RAYDIUM_LAUNCHLAB_PROGRAM_ID = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const RAYDIUM_LAUNCHLAB_AUTH        = 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh';
export const RAYDIUM_LAUNCHLAB_PLATFORM    = '4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4';
export const RAYDIUM_LAUNCHLAB_CONFIG      = '6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX';

// CPMM (CP-Swap) — новый constant product AMM (аналог PumpSwap, Token-2022 support)
export const RAYDIUM_CPMM_PROGRAM_ID  = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
export const RAYDIUM_CPMM_AUTH        = 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL';
export const RAYDIUM_CPMM_FEE_ACC    = 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8';

// AMM v4 — legacy constant product (основной DEX Solana, огромный объём)
export const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_AMM_V4_AUTHORITY  = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'; // PDA nonce=252

// Fee destination (для детекции создания AMM v4 пулов через gRPC)
export const RAYDIUM_FEE_DESTINATION = '7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5';

// Router
export const RAYDIUM_ROUTER_PROGRAM_ID = 'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS';

// ─── Raydium LaunchLab discriminators ────────────────────────────────────────
//
// Anchor discriminator = первые 8 байт sha256('global:<instructionName>')
// Источник: raydium-sdk-V2/src/raydium/launchpad/instrument.ts
//
export const RAYDIUM_DISCRIMINATOR = {
  // ── LaunchLab (LanMV9sA...) ──────────────────────────────────────────────
  LAUNCH_INITIALIZE_V2:  Buffer.from([67, 153, 175, 39, 218, 16, 38, 32]),
  LAUNCH_BUY_EXACT_IN:   Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]),
  LAUNCH_BUY_EXACT_OUT:  Buffer.from([24, 211, 116, 40, 105, 3, 153, 56]),
  LAUNCH_SELL_EXACT_IN:  Buffer.from([149, 39, 222, 155, 211, 124, 152, 26]),
  LAUNCH_SELL_EXACT_OUT: Buffer.from([95, 200, 71, 34, 8, 9, 11, 166]),

  // ── CPMM (CPMMoo8L...) ──────────────────────────────────────────────────
  // Источник: raydium-sdk-V2/src/raydium/cpmm/instruction.ts
  CPMM_CREATE_POOL:    Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]),
  CPMM_SWAP_BASE_IN:   Buffer.from([143, 190, 90, 218, 196, 30, 51, 222]),
  CPMM_SWAP_BASE_OUT:  Buffer.from([55, 217, 98, 86, 163, 74, 180, 173]),

  // ── AMM v4 (675kPX9M...) ────────────────────────────────────────────────
  // AMM v4 НЕ использует Anchor discriminators — вместо этого instruction index (u8).
  // SwapBaseIn  = index 9 (legacy), SwapBaseInV2  = index 16 (актуальный, без OpenBook)
  // SwapBaseOut = index 10 (legacy), SwapBaseOutV2 = index 17 (актуальный)
  // CreatePool  = index 1
  // Для детекции новых пулов: instruction data[0] == 1
  AMM_V4_CREATE_POOL_INDEX:    1,
  AMM_V4_SWAP_BASE_IN_INDEX:   9,
  AMM_V4_SWAP_BASE_IN_V2_INDEX:  16,  // без OpenBook accounts — используем этот
  AMM_V4_SWAP_BASE_OUT_INDEX:  10,
  AMM_V4_SWAP_BASE_OUT_V2_INDEX: 17,  // без OpenBook accounts — используем этот
};

// ─── Raydium LaunchLab Pool layout ───────────────────────────────────────────
//
// Источник: raydium-sdk-V2/src/raydium/launchpad/layout.ts (LaunchpadPool)
//
// Поля LaunchpadPool (после 8-байтного Anchor discriminator):
//   epoch                : u64     @ 8
//   status               : u8      @ 16    (0=active, 1=migrate)
//   mintDecimalA         : u8      @ 17
//   mintDecimalB         : u8      @ 18
//   supply               : u64     @ 19
//   totalSellA           : u64     @ 27    (всего токенов A продано на curve)
//   virtualA             : u64     @ 35    (виртуальные резервы token A)
//   virtualB             : u64     @ 43    (виртуальные резервы token B / SOL)
//   realA                : u64     @ 51    (реальные резервы token A)
//   realB                : u64     @ 59    (реальные резервы token B / SOL)
//   protocolFee          : u64     @ 67
//   platformFee          : u64     @ 75
//   migrateFee           : u64     @ 83
//   --- vesting struct ---
//   totalLockedAmount    : u64     @ 91
//   cliffPeriod          : u64     @ 99
//   unlockPeriod         : u64     @ 107
//   --- public keys ---
//   configId             : Pubkey  @ 115   (32 bytes)
//   platformId           : Pubkey  @ 147   (32 bytes)
//   mintA                : Pubkey  @ 179   (32 bytes) — токен проекта
//   mintB                : Pubkey  @ 211   (32 bytes) — wSOL
//   vaultA               : Pubkey  @ 243   (32 bytes)
//   vaultB               : Pubkey  @ 275   (32 bytes)
//   mintAuthorityA       : Pubkey  @ 307   (32 bytes)
//   creator              : Pubkey  @ 339   (32 bytes)
//   migrateType          : u8      @ 371   (0=AMM v4, 1=CPMM)
//   ...reserved          : 54 bytes
//
// ВАЖНО: status=0 → торговля на bonding curve, status=1 → пул мигрирован
//
export const RAYDIUM_LAUNCH_POOL_LAYOUT = {
  EPOCH_OFFSET:          8,
  STATUS_OFFSET:         16,   // u8: 0=active, 1=migrate
  MINT_DECIMAL_A_OFFSET: 17,
  MINT_DECIMAL_B_OFFSET: 18,
  SUPPLY_OFFSET:         19,
  TOTAL_SELL_A_OFFSET:   27,
  VIRTUAL_A_OFFSET:      35,   // virtual reserves token A
  VIRTUAL_B_OFFSET:      43,   // virtual reserves SOL (quote)
  REAL_A_OFFSET:         51,   // real reserves token A
  REAL_B_OFFSET:         59,   // real reserves SOL (quote)
  PROTOCOL_FEE_OFFSET:   67,
  PLATFORM_FEE_OFFSET:   75,
  MIGRATE_FEE_OFFSET:    83,
  CONFIG_ID_OFFSET:      115,  // Pubkey, 32 bytes
  PLATFORM_ID_OFFSET:    147,  // Pubkey, 32 bytes
  MINT_A_OFFSET:         179,  // Pubkey, 32 bytes — project token
  MINT_B_OFFSET:         211,  // Pubkey, 32 bytes — wSOL
  VAULT_A_OFFSET:        243,  // Pubkey, 32 bytes
  VAULT_B_OFFSET:        275,  // Pubkey, 32 bytes
  CREATOR_OFFSET:        339,  // Pubkey, 32 bytes
  MIGRATE_TYPE_OFFSET:   371,  // u8: 0=AMM v4, 1=CPMM
} as const;

// ─── Raydium CPMM Pool layout ───────────────────────────────────────────────
//
// Источник: raydium-sdk-V2/src/raydium/cpmm/layout.ts (CpmmPoolInfoLayout)
//
// Поля CpmmPoolInfoLayout (после 8-байтного Anchor discriminator):
//   configId             : Pubkey  @ 8     (32 bytes)
//   poolCreator          : Pubkey  @ 40    (32 bytes)
//   vaultA               : Pubkey  @ 72    (32 bytes)
//   vaultB               : Pubkey  @ 104   (32 bytes)
//   mintLp               : Pubkey  @ 136   (32 bytes)
//   mintA                : Pubkey  @ 168   (32 bytes) — base token
//   mintB                : Pubkey  @ 200   (32 bytes) — quote token (wSOL)
//   mintProgramA         : Pubkey  @ 232   (32 bytes)
//   mintProgramB         : Pubkey  @ 264   (32 bytes)
//   observationId        : Pubkey  @ 296   (32 bytes)
//   bump                 : u8      @ 328
//   status               : u8      @ 329
//   lpDecimals           : u8      @ 330
//   mintDecimalA         : u8      @ 331
//   mintDecimalB         : u8      @ 332
//   lpAmount             : u64     @ 333
//   protocolFeesMintA    : u64     @ 341
//   protocolFeesMintB    : u64     @ 349
//   fundFeesMintA        : u64     @ 357
//   fundFeesMintB        : u64     @ 365
//   openTime             : u64     @ 373
//
export const RAYDIUM_CPMM_POOL_LAYOUT = {
  CONFIG_ID_OFFSET:       8,    // Pubkey, 32 bytes
  POOL_CREATOR_OFFSET:    40,   // Pubkey, 32 bytes
  VAULT_A_OFFSET:         72,   // Pubkey, 32 bytes
  VAULT_B_OFFSET:         104,  // Pubkey, 32 bytes
  MINT_LP_OFFSET:         136,  // Pubkey, 32 bytes
  MINT_A_OFFSET:          168,  // Pubkey, 32 bytes — base token
  MINT_B_OFFSET:          200,  // Pubkey, 32 bytes — quote token (wSOL)
  MINT_PROGRAM_A_OFFSET:  232,  // Pubkey, 32 bytes
  MINT_PROGRAM_B_OFFSET:  264,  // Pubkey, 32 bytes
  OBSERVATION_ID_OFFSET:  296,  // Pubkey, 32 bytes
  BUMP_OFFSET:            328,  // u8
  STATUS_OFFSET:          329,  // u8
  LP_DECIMALS_OFFSET:     330,  // u8
  MINT_DECIMAL_A_OFFSET:  331,  // u8
  MINT_DECIMAL_B_OFFSET:  332,  // u8
  LP_AMOUNT_OFFSET:       333,  // u64
  OPEN_TIME_OFFSET:       373,  // u64
} as const;

// ─── Raydium AMM v4 Pool layout ─────────────────────────────────────────────
//
// Источник: raydium-sdk-V2/src/raydium/liquidity/layout.ts (liquidityStateV4Layout)
//
// Огромный аккаунт (~700+ bytes). Ключевые поля для торговли:
//   status               : u64    @ 0
//   nonce                : u64    @ 8     (для PDA authority)
//   baseDecimal          : u64    @ 32
//   quoteDecimal         : u64    @ 40
//   tradeFeeNumerator    : u64    @ 144
//   tradeFeeDenominator  : u64    @ 152
//   swapBaseInAmount     : u128   @ 248   (16 bytes)
//   swapQuoteOutAmount   : u128   @ 264   (16 bytes)
//   swapQuoteInAmount    : u128   @ 288   (16 bytes)
//   swapBaseOutAmount    : u128   @ 304   (16 bytes)
//   baseVault            : Pubkey @ 336   (32 bytes)
//   quoteVault           : Pubkey @ 368   (32 bytes)
//   baseMint             : Pubkey @ 400   (32 bytes)
//   quoteMint            : Pubkey @ 432   (32 bytes)
//   lpMint               : Pubkey @ 464   (32 bytes)
//   openOrders           : Pubkey @ 496   (32 bytes)
//   marketId             : Pubkey @ 528   (32 bytes)
//   marketProgramId      : Pubkey @ 560   (32 bytes)
//   targetOrders         : Pubkey @ 592   (32 bytes)
//
// Fee: 25 bps (numerator=25, denominator=10000)
// Formula: amountOut = amountIn * (1 - fee) * reserveOut / (reserveIn + amountIn * (1 - fee))
//
export const RAYDIUM_AMM_V4_POOL_LAYOUT = {
  STATUS_OFFSET:           0,
  NONCE_OFFSET:            8,
  BASE_DECIMAL_OFFSET:     32,
  QUOTE_DECIMAL_OFFSET:    40,
  TRADE_FEE_NUM_OFFSET:    144,
  TRADE_FEE_DEN_OFFSET:    152,
  BASE_VAULT_OFFSET:       336,  // Pubkey, 32 bytes
  QUOTE_VAULT_OFFSET:      368,  // Pubkey, 32 bytes
  BASE_MINT_OFFSET:        400,  // Pubkey, 32 bytes
  QUOTE_MINT_OFFSET:       432,  // Pubkey, 32 bytes
  LP_MINT_OFFSET:          464,  // Pubkey, 32 bytes
  OPEN_ORDERS_OFFSET:      496,  // Pubkey, 32 bytes
  MARKET_ID_OFFSET:        528,  // Pubkey, 32 bytes
  MARKET_PROGRAM_ID_OFFSET: 560, // Pubkey, 32 bytes
  TARGET_ORDERS_OFFSET:    592,  // Pubkey, 32 bytes
} as const;

// ─── Raydium AMM v4 new pool detection (gRPC) ───────────────────────────────
//
// Для детекции создания новых AMM v4 пулов через gRPC:
//   1. Подписка на транзакции с account_include = [RAYDIUM_FEE_DESTINATION]
//   2. Фильтр: instruction data[0] == 1 (create pool)
//   3. Извлечение аккаунтов по индексам:
//
export const RAYDIUM_AMM_V4_CREATE_POOL_ACCOUNT_INDICES = {
  POOL_ID:        4,
  AUTHORITY:      5,
  OPEN_ORDERS:    6,
  LP_MINT:        7,
  BASE_MINT:      8,
  QUOTE_MINT:     9,
  BASE_VAULT:     10,
  QUOTE_VAULT:    11,
  TARGET_ORDERS:  12,
  MARKET:         16,
} as const;

// ─── Raydium LaunchLab PDA seeds ─────────────────────────────────────────────
//
// Источник: raydium-sdk-V2/src/raydium/launchpad/pda.ts
//
export const RAYDIUM_PDA_SEEDS = {
  AUTH:                   'vault_auth_seed',
  GLOBAL_CONFIG:          'global_config',
  POOL:                   'pool',           // seeds: [POOL, mintA, mintB]
  POOL_VAULT:             'pool_vault',     // seeds: [POOL_VAULT, poolId, mint]
  POOL_VESTING:           'pool_vesting',
  PLATFORM_CONFIG:        'platform_config',
  PLATFORM_FEE_VAULT_AUTH: 'platform_fee_vault_auth_seed',
  CREATOR_FEE_VAULT_AUTH: 'creator_fee_vault_auth_seed',
  CPI_EVENT:              '__event_authority',
} as const;

// ─── Raydium fee structure ───────────────────────────────────────────────────
//
// AMM v4: фиксированные 25 bps (22 bps LP + 3 bps RAY buyback)
// CPMM: 4 тира — 25, 100, 200, 400 bps (84% LP, 12% buyback, 4% treasury)
// LaunchLab: bonding curve fees dynamic from platformConfig + configId
// LaunchLab graduation: при достижении totalFundRaisingB (default 85 SOL)
//   → status меняется на 1 (migrate)
//   → migrateType=0 → AMM v4, migrateType=1 → CPMM
//
export const RAYDIUM_FEES = {
  AMM_V4_FEE_BPS:        25,     // 0.25%
  CPMM_FEE_TIERS_BPS:    [25, 100, 200, 400] as const,  // 0.25%, 1%, 2%, 4%
  LAUNCH_GRADUATION_SOL:  85,     // default threshold (min 30 SOL)
  POOL_CREATION_FEE_SOL:  0.15,   // fee for creating AMM v4 or CPMM pool
} as const;