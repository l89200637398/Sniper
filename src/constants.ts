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