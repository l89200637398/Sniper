// src/geyser/client.ts
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { config } from '../config';
import path from 'path';
import bs58 from 'bs58';
import { logger } from '../utils/logger';
import {
    PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, DISCRIMINATOR, PUMP_FUN_ROUTER_PROGRAM_ID,
    RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID,
    RAYDIUM_FEE_DESTINATION, RAYDIUM_DISCRIMINATOR,
} from '../constants';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const PROTO_PATH = path.join(__dirname, '../../proto/geyser.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});
const geyserProto: any = grpc.loadPackageDefinition(packageDefinition).geyser;

// --- Интерфейсы ---
export interface PumpToken { mint: string; creator: string; bondingCurve: string; bondingCurveTokenAccount: string; signature: string; receivedAt: number; }
export interface PumpBuy { mint: string; creator: string; amount: bigint; solLamports: bigint; programIds: string[]; signature: string; }
export interface PumpSwapNewPool { mint: string; pool: string; creator: string; quoteMint: string; signature: string; }
export interface PumpSwapBuy { mint: string; creator: string; amount: bigint; solLamports: bigint; signature: string; }
export interface PumpSwapSell { mint: string; creator: string; amount: bigint; signature: string; }
export interface PumpFunSell { mint: string; seller: string; amount: bigint; signature: string; }

// --- Raydium интерфейсы ---
export interface RaydiumLaunchCreate { mint: string; pool: string; creator: string; signature: string; receivedAt: number; }
export interface RaydiumLaunchBuy { mint: string; pool: string; buyer: string; amountSol: bigint; signature: string; }
export interface RaydiumLaunchSell { mint: string; pool: string; seller: string; amountTokens: bigint; signature: string; }
export interface RaydiumCpmmNewPool { mint: string; pool: string; creator: string; signature: string; }
export interface RaydiumAmmV4NewPool { pool: string; baseMint: string; quoteMint: string; signature: string; }

// uint64 max = sentinel/overflow → не использовать как торговое значение
const U64_MAX = 18446744073709551615n;
function sanitizeAmount(val: bigint): bigint {
    return val === U64_MAX ? 0n : val;
}

function pubkeyToBuffer(pubkey: any): Buffer | null {
    try {
        if (!pubkey) return null;
        if (Buffer.isBuffer(pubkey)) return pubkey;
        if (pubkey instanceof Uint8Array) return Buffer.from(pubkey);
        if (pubkey.data && pubkey.data instanceof Uint8Array) return Buffer.from(pubkey.data);
        if (pubkey.toBuffer && typeof pubkey.toBuffer === 'function') return pubkey.toBuffer();
        if (typeof pubkey === 'string') return Buffer.from(pubkey, 'base64');
        if (pubkey.length && typeof pubkey !== 'string') return Buffer.from(Array.from(pubkey));
        logger.error('Cannot convert pubkey to buffer, unknown format:', pubkey);
        return null;
    } catch (err) {
        logger.error('Error converting pubkey to buffer:', err);
        return null;
    }
}

export class GeyserClient extends EventEmitter {
    private client: any;
    private stream: any;
    private running = false;
    private reconnectAttempts = 0;
    private readonly PUMP_PROGRAM = PUMP_FUN_PROGRAM_ID;
    private readonly PUMP_SWAP = PUMP_SWAP_PROGRAM_ID;
    private readonly PUMP_ROUTER = PUMP_FUN_ROUTER_PROGRAM_ID; // ← добавлен роутер
    private readonly RAYDIUM_LAUNCH = RAYDIUM_LAUNCHLAB_PROGRAM_ID;
    private readonly RAYDIUM_CPMM = RAYDIUM_CPMM_PROGRAM_ID;
    private readonly RAYDIUM_AMM_V4 = RAYDIUM_AMM_V4_PROGRAM_ID;
    private readonly RAYDIUM_FEE_DEST = RAYDIUM_FEE_DESTINATION;

    private eventQueue: Array<{ data: any }> = [];
    private processing = false;
    private maxQueueSize = config.geyser.maxEventQueueSize ?? 1000;

    private subscribedAccounts: Set<string> = new Set();
    private pendingSubscribeRequest: NodeJS.Timeout | null = null;

    constructor() {
        super();
        logger.debug('gRPC client created', {
            endpoint: config.geyser.endpoint,
            token: config.geyser.token ? `${config.geyser.token.slice(0, 8)}...` : 'none',
        });

        const channelOptions = {
            'grpc.keepalive_time_ms': 30000,
            'grpc.keepalive_timeout_ms': 10000,
            'grpc.keepalive_permit_without_calls': 1,
            'grpc.http2.min_time_between_pings_ms': 10000,
            'grpc.http2.max_pings_without_data': 0,
        };

        const sslCreds = grpc.credentials.createSsl();
        const callCreds = grpc.credentials.createFromMetadataGenerator((_params, callback) => {
            const meta = new grpc.Metadata();
            meta.add('x-token', config.geyser.token);
            callback(null, meta);
        });
        const combinedCreds = grpc.credentials.combineChannelCredentials(sslCreds, callCreds);

        this.client = new geyserProto.Geyser(config.geyser.endpoint, combinedCreds, channelOptions);
    }

    async subscribe() {
        this.running = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    private connect() {
        if (!this.running) return;

        this.stream = this.client.subscribe();

        this.stream.on('data', (data: any) => {
            // Для отладки: выводим, что данные пришли, даже если очередь переполнена
            // logger.debug('gRPC raw data received'); // можно раскомментировать для очень детальной отладки
            if (this.eventQueue.length >= this.maxQueueSize) {
                logger.warn(`Event queue full (${this.maxQueueSize}), pausing stream and dropping oldest event`);
                this.eventQueue.shift();
                if (this.stream) this.stream.pause();
            }
            this.eventQueue.push({ data });
            this.processQueue();
        });

        this.stream.on('error', (err: any) => {
            logger.error(`gRPC stream error: ${err?.message ?? err?.code ?? err}`);
            if (err.code === 16) {
                logger.error('gRPC authentication failed. Check GRPC_TOKEN.');
                process.exit(1);
                return;
            }
            this.reconnect();
        });

        this.stream.on('end', () => {
            logger.warn('gRPC stream ended');
            this.reconnect();
        });

        this.sendSubscribeRequest();
    }

    private reconnect() {
        if (!this.running) return;
        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
        logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
        setTimeout(() => {
            this.connect();
        }, delay);
    }

    private sendSubscribeRequest() {
        if (!this.stream) return;

        const accountAddresses = Array.from(this.subscribedAccounts);

        const accountFilter: any = {
            owner_include: [
                this.PUMP_PROGRAM,
                this.PUMP_SWAP,
                TOKEN_2022_PROGRAM_ID.toBase58(),
                this.PUMP_ROUTER, // ← добавили роутер
                this.RAYDIUM_LAUNCH,  // ← Raydium LaunchLab
                this.RAYDIUM_CPMM,    // ← Raydium CPMM
                this.RAYDIUM_AMM_V4,  // ← Raydium AMM v4
            ],
        };
        if (accountAddresses.length > 0) {
            accountFilter.account_include = accountAddresses;
        }

        const request: any = {
            accounts: {
                pump_accounts: accountFilter,
            },
            slots: {},
            transactions: {
                pump_fun_and_swap_filter: {
                    vote: false,
                    failed: false,
                    account_include: [
                        this.PUMP_PROGRAM, this.PUMP_SWAP, this.PUMP_ROUTER,
                        this.RAYDIUM_LAUNCH, this.RAYDIUM_CPMM, this.RAYDIUM_AMM_V4, this.RAYDIUM_FEE_DEST,
                    ],
                },
            },
            blocks: {},
            blocks_meta: {},
            entry: {},
            commitment: 0,
            ping: null,
        };

        logger.debug('gRPC subscribe request', request);

        try {
            this.stream.write(request);
        } catch (err) {
            logger.error('Failed to write to gRPC stream:', err);
        }
    }

    public addAccount(account: PublicKey) {
        const key = account.toBase58();
        if (this.subscribedAccounts.has(key)) return;
        this.subscribedAccounts.add(key);
        this.scheduleSubscribeUpdate();
    }

    public removeAccount(account: PublicKey) {
        const key = account.toBase58();
        if (!this.subscribedAccounts.has(key)) return;
        this.subscribedAccounts.delete(key);
        this.scheduleSubscribeUpdate();
    }

    private scheduleSubscribeUpdate() {
        if (this.pendingSubscribeRequest) clearTimeout(this.pendingSubscribeRequest);
        this.pendingSubscribeRequest = setTimeout(() => {
            if (this.running && this.stream) {
                this.sendSubscribeRequest();
            }
            this.pendingSubscribeRequest = null;
        }, 1000);
    }

    private async processQueue() {
        if (this.processing) return;
        this.processing = true;

        try {
            while (this.eventQueue.length > 0 && this.running) {
                const batchSize = Math.min(50, this.eventQueue.length);
                for (let i = 0; i < batchSize; i++) {
                    const item = this.eventQueue.shift();
                    if (!item) continue;
                    try {
                        if (item.data.transaction) {
                            this.handleTransaction(item.data.transaction);
                        } else if (item.data.account) {
                            this.handleAccount(item.data.account);
                        } else if (item.data.slot) {
                            // Skip slot debug
                        } else if (item.data.error) {
                            logger.error('gRPC server error:', item.data.error);
                        }
                    } catch (err) {
                        logger.error('Error handling gRPC data:', err);
                    }
                }
                await new Promise(resolve => setImmediate(resolve));
            }
        } finally {
            this.processing = false;
            if (this.stream && this.stream.isPaused() && this.eventQueue.length < this.maxQueueSize * 0.5) {
                this.stream.resume();
            }
        }
    }

    private handleAccount(accountData: any) {
        const pubkey = accountData.pubkey;
        if (!pubkey) return;

        let accountKey: PublicKey;
        try {
            accountKey = new PublicKey(pubkey);
        } catch {
            logger.warn('handleAccount: invalid pubkey format');
            return;
        }

        const rawData = accountData.data;
        let data: Buffer;
        try {
            if (typeof rawData === 'string') {
                data = Buffer.from(rawData, 'base64');
            } else if (rawData instanceof Uint8Array) {
                data = Buffer.from(rawData);
            } else if (rawData?.data instanceof Uint8Array) {
                data = Buffer.from(rawData.data);
            } else if (Array.isArray(rawData)) {
                data = Buffer.from(rawData);
            } else {
                logger.warn(`handleAccount: unexpected data format for ${accountKey.toBase58()}: ${typeof rawData}`);
                return;
            }
        } catch (err) {
            logger.warn(`handleAccount: failed to parse data for ${accountKey.toBase58()}:`, err);
            return;
        }

        if (data.length < 8) {
            logger.debug(`handleAccount: data too short (${data.length} bytes) for ${accountKey.toBase58()}`);
            return;
        }

        this.emit('accountUpdate', {
            pubkey: accountKey,
            data,
            slot: accountData.slot,
        });
    }

    private keyToString(key: any): string {
        if (!key) return '';
        if (typeof key === 'string') return key;
        if (key instanceof Uint8Array) {
            return bs58.encode(key);
        }
        if (key.data && key.data instanceof Uint8Array) {
            return bs58.encode(key.data);
        }
        if (key.pubkey) return key.pubkey;
        return String(key);
    }

    private handleTransaction(txData: any) {
        const tx = txData.transaction?.transaction;
        const meta = txData.transaction?.meta;
        if (!tx || !tx.message) return;

        const message = tx.message;
        const signatures = tx.signatures;
        const signature = signatures?.[0] ? bs58.encode(signatures[0]) : '';
        const slot = txData.slot;

        // Включаем логирование всех транзакций для диагностики (можно закомментировать после)
        logger.debug(`Transaction received: ${signature.slice(0, 8)}... slot=${slot}`);

        const staticKeys  = message.accountKeys || [];
        const writableAlt = meta?.loadedWritableAddresses
                         ?? meta?.loadedAddresses?.writable
                         ?? [];
        const readonlyAlt = meta?.loadedReadonlyAddresses
                         ?? meta?.loadedAddresses?.readonly
                         ?? [];
        const allKeys     = (writableAlt.length > 0 || readonlyAlt.length > 0)
            ? [...staticKeys, ...writableAlt, ...readonlyAlt]
            : staticKeys;
        const fullMessage = allKeys.length > staticKeys.length
            ? { ...message, accountKeys: allKeys }
            : message;

        this.parseInstructions(message.instructions, fullMessage, signature, meta, slot);

        if (meta?.innerInstructions) {
            for (const inner of meta.innerInstructions) {
                if (inner.instructions) {
                    this.parseInstructions(inner.instructions, fullMessage, signature, meta, slot);
                }
            }
        }
    }

    private parseInstructions(instructions: any[], message: any, signature: string, meta?: any, slot?: number) {
        for (const ix of instructions) {
            if (ix.programIdIndex === undefined) continue;

            const key = message.accountKeys[ix.programIdIndex];
            const programId = this.keyToString(key);

            const data =
                typeof ix.data === 'string'
                    ? Buffer.from(ix.data, 'base64')
                    : Buffer.from(ix.data);

            // Проверяем pump.fun основную программу
            if (programId === this.PUMP_PROGRAM && data.length >= 8) {
                const discriminator = data.subarray(0, 8);
                if (discriminator.equals(DISCRIMINATOR.CREATE) || discriminator.equals(DISCRIMINATOR.CREATE_V2)) {
                    this.handlePumpCreate(ix, message, signature, discriminator.equals(DISCRIMINATOR.CREATE_V2) ? 5 : 7, slot);
                } else if (discriminator.equals(DISCRIMINATOR.BUY) || discriminator.equals(DISCRIMINATOR.BUY_EXACT_SOL_IN)) {
                    this.handlePumpBuy(ix, message, signature, slot, discriminator.equals(DISCRIMINATOR.BUY_EXACT_SOL_IN));
                } else if (discriminator.equals(DISCRIMINATOR.SELL)) {
                    this.handlePumpSell(ix, message, signature, slot);
                } else {
                    // Только unknown — не логируем каждый BUY/SELL (снижаем спам)
                    logger.debug(`[diag] Unknown pump discriminator: ${discriminator.toString('hex')} tx=${signature.slice(0,8)}`);
                }
            }

            // Проверяем pump.fun роутер
            if (programId === this.PUMP_ROUTER && data.length >= 8) {
                const discriminator = data.subarray(0, 8);
                if (discriminator.equals(DISCRIMINATOR.CREATE) || discriminator.equals(DISCRIMINATOR.CREATE_V2)) {
                    logger.info(`🔥 CREATE via Router in tx ${signature.slice(0,8)}`);
                    this.handlePumpCreate(ix, message, signature, 5, slot);
                } else if (discriminator.equals(DISCRIMINATOR.BUY) || discriminator.equals(DISCRIMINATOR.BUY_EXACT_SOL_IN)) {
                    this.handlePumpBuy(ix, message, signature, slot, discriminator.equals(DISCRIMINATOR.BUY_EXACT_SOL_IN));
                } else if (discriminator.equals(DISCRIMINATOR.SELL)) {
                    this.handlePumpSell(ix, message, signature, slot);
                } else {
                    logger.debug(`[diag] Unknown Router discriminator: ${discriminator.toString('hex')} tx=${signature.slice(0,8)}`);
                }
            }

            // PumpSwap (без изменений)
            if (programId === this.PUMP_SWAP) {
                this.parsePumpSwapInstruction(ix, message, signature, data, slot);
            }

            // ── Raydium LaunchLab ────────────────────────────────────────────
            if (programId === this.RAYDIUM_LAUNCH && data.length >= 8) {
                this.parseRaydiumLaunchInstruction(ix, message, signature, data, slot);
            }

            // ── Raydium CPMM — детекция новых пулов ──────────────────────────
            if (programId === this.RAYDIUM_CPMM && data.length >= 8) {
                const disc = data.subarray(0, 8);
                if (disc.equals(RAYDIUM_DISCRIMINATOR.CPMM_CREATE_POOL)) {
                    this.parseRaydiumCpmmCreatePool(ix, message, signature, slot);
                }
            }

            // ── Raydium AMM v4 — детекция новых пулов по fee destination ─────
            // AMM v4 использует instruction index (первый байт), не Anchor disc
            if (programId === this.RAYDIUM_AMM_V4 && data.length >= 1) {
                if (data[0] === RAYDIUM_DISCRIMINATOR.AMM_V4_CREATE_POOL_INDEX) {
                    this.parseRaydiumAmmV4CreatePool(ix, message, signature, slot);
                }
            }
        }
    }

    private handlePumpCreate(ix: any, message: any, signature: string, creatorIndex: number, slot?: number) {
        try {
            const mintIndex = ix.accounts?.[0];
            const bondingCurveIndex = ix.accounts?.[2];
            const bondingCurveTokenIndex = ix.accounts?.[3];
            const creatorIndexActual = ix.accounts?.[creatorIndex];

            if (mintIndex === undefined || bondingCurveIndex === undefined ||
                bondingCurveTokenIndex === undefined || creatorIndexActual === undefined) {
                logger.warn('CREATE instruction missing expected accounts');
                return;
            }

            const mint = this.keyToString(message.accountKeys[mintIndex]);
            const bondingCurve = this.keyToString(message.accountKeys[bondingCurveIndex]);
            const bondingCurveTokenAccount = this.keyToString(message.accountKeys[bondingCurveTokenIndex]);
            const creator = this.keyToString(message.accountKeys[creatorIndexActual]);

            const numRequiredSignatures = message.header?.numRequiredSignatures ?? 0;
            const isCreatorSigner = creatorIndexActual < numRequiredSignatures;

            logger.info(`CREATE DIAGNOSTIC: mint=${mint}, creator=${creator}, isSigner=${isCreatorSigner}, index=${creatorIndexActual}, required=${numRequiredSignatures}`);

            if (!isCreatorSigner) {
                logger.warn(`Skipping CREATE for ${mint}: creator ${creator} is not a signer (tx: ${signature.slice(0,8)})`);
                return;
            }

            if (mint && bondingCurve && bondingCurveTokenAccount && creator) {
                logger.info(`🔥 NEW PUMP TOKEN: ${mint}, creator: ${creator}, slot=${slot}, tx=${signature.slice(0,8)}`);
                this.emit('newToken', {
                    mint,
                    bondingCurve,
                    bondingCurveTokenAccount,
                    creator,
                    signature,
                    receivedAt: Date.now(),
                });
            }
        } catch (err) {
            logger.error('Error handling Pump CREATE:', err);
        }
    }

    private handlePumpBuy(ix: any, message: any, signature: string, slot?: number, isBuyExactSolIn: boolean = false) {
        try {
            const data =
                typeof ix.data === 'string'
                    ? Buffer.from(ix.data, 'base64')
                    : Buffer.from(ix.data);

            const amount = sanitizeAmount(data.readBigUInt64LE(8));
            const mintIndex = ix.accounts?.[2];
            if (mintIndex === undefined) return;
            const mint = this.keyToString(message.accountKeys[mintIndex]);
            if (mint) {
                const amountLabel = isBuyExactSolIn ? 'sol_lamports' : 'tokens';
                logger.info(`💰 BUY DETECTED: ${mint}, ${amountLabel}: ${amount}, slot=${slot}, tx=${signature.slice(0,8)}${isBuyExactSolIn ? ' (exact_sol_in)' : ''}`);
                const programIdsInTx = new Set<string>();
                for (const key of message.accountKeys) {
                    const progId = this.keyToString(key);
                    if (progId) programIdsInTx.add(progId);
                }
                this.emit('buyDetected', {
                    mint,
                    creator: this.keyToString(message.accountKeys[0]),
                    amount,
                    solLamports: isBuyExactSolIn ? amount : 0n,
                    programIds: Array.from(programIdsInTx),
                    signature,
                });
            }
        } catch (err) {
            logger.error('Error handling Pump BUY:', err);
        }
    }

    private handlePumpSell(ix: any, message: any, signature: string, slot?: number) {
        try {
            const data =
                typeof ix.data === 'string'
                    ? Buffer.from(ix.data, 'base64')
                    : Buffer.from(ix.data);

            const amount = sanitizeAmount(data.readBigUInt64LE(8));
            const mintIndex = ix.accounts?.[2];
            const sellerIndex = ix.accounts?.[6];
            if (mintIndex === undefined || sellerIndex === undefined) return;

            const mint = this.keyToString(message.accountKeys[mintIndex]);
            const seller = this.keyToString(message.accountKeys[sellerIndex]);
            if (mint && seller) {
                logger.debug(`📤 PUMP SELL: ${mint}, seller=${seller.slice(0,8)}, amount=${amount}, slot=${slot}, tx=${signature.slice(0,8)}`);
                this.emit('pumpFunSellDetected', { mint, seller, amount, signature });
            }
        } catch (err) {
            logger.error('Error handling Pump SELL:', err);
        }
    }

    private parsePumpSwapInstruction(ix: any, message: any, signature: string, data: Buffer, slot?: number) {
        if (data.length < 8) return;
        const d = data.subarray(0, 8);

        // Discriminators verified against pump_amm IDL.
        // IMPORTANT: baseMint=wSOL, quoteMint=meme_token in PumpSwap pools.
        //   PUMP_SWAP_BUY  (66063d12 = global:buy)  = user BUYs wSOL by paying TOKEN  → from bot's view: SELL
        //   PUMP_SWAP_SELL (33e685a4 = global:sell)  = user SELLs wSOL to receive TOKEN → from bot's view: BUY
        if (d.equals(DISCRIMINATOR.PUMP_SWAP_CREATE_POOL)) {
            this.parseCreatePool(ix, message, signature, data, slot);
        } else if (d.equals(DISCRIMINATOR.PUMP_SWAP_BUY) || d.equals(DISCRIMINATOR.PUMP_SWAP_BUY_ALT)) {
            // IDL buy / buy_alt = user pays TOKEN, gets wSOL → someone SELLING their token
            this.parsePumpSwapSell(ix, message, signature, data, slot);
        } else if (d.equals(DISCRIMINATOR.PUMP_SWAP_SELL) || d.equals(DISCRIMINATOR.PUMP_SWAP_BUY_EXACT_QUOTE_IN)) {
            // IDL sell = user pays wSOL, gets TOKEN → someone BUYING the token
            // buy_exact_quote_in = user specifies SOL input, gets TOKEN → also a BUY
            this.parsePumpSwapBuy(ix, message, signature, data, slot);
        } else {
            logger.debug(`[pumpswap] Unknown discriminator: ${d.toString('hex')} tx=${signature.slice(0,8)}`);
        }
    }

    private parseCreatePool(ix: any, message: any, signature: string, data: Buffer, slot?: number) {
        // create_pool instruction accounts (IDL):
        //   [0] pool (writable PDA)  ← реальный адрес пула, читаем его напрямую
        //   [1] global_config
        //   [2] creator (signer)
        //   [3] base_mint
        //   [4] quote_mint
        //   ...
        // Для canonical pump.fun pools: base=wSOL, quote=meme token
        // Для нестандартных пулов порядок может быть другим — ищем wSOL и определяем meme token.

        const poolIndex     = ix.accounts?.[0];
        const creatorIndex  = ix.accounts?.[2];
        const baseMintIndex = ix.accounts?.[3];
        const quoteMintIndex = ix.accounts?.[4];

        if (baseMintIndex === undefined || quoteMintIndex === undefined) return;

        const pool      = poolIndex !== undefined ? this.keyToString(message.accountKeys[poolIndex]) : '';
        const baseMint  = this.keyToString(message.accountKeys[baseMintIndex]);
        const quoteMint = this.keyToString(message.accountKeys[quoteMintIndex]);
        const creator   = creatorIndex !== undefined
            ? this.keyToString(message.accountKeys[creatorIndex])
            : '';

        // Определяем meme token: один из base/quote является wSOL, другой — токен
        let mintToken: string;
        if (baseMint === config.wsolMint) {
            mintToken = quoteMint;
        } else if (quoteMint === config.wsolMint) {
            mintToken = baseMint;
        } else {
            logger.debug(`[pumpswap] create_pool без wSOL, пропускаем: base=${baseMint?.slice(0,8)} quote=${quoteMint?.slice(0,8)}`);
            return;
        }
        if (!mintToken || mintToken === config.wsolMint) return;

        logger.info(`🆕 NEW PUMP SWAP POOL: mint=${mintToken.slice(0,8)}, pool=${pool.slice(0,8)}, creator=${creator.slice(0,8)}, slot=${slot}`);
        this.emit('newPumpSwapToken', {
            mint:      mintToken,
            pool,       // ← реальный адрес пула из accounts[0]
            creator,
            quoteMint: config.wsolMint,
            signature,
        });
    }

    private parsePumpSwapBuy(ix: any, message: any, signature: string, data: Buffer, slot?: number) {
        // Called when disc = PUMP_SWAP_SELL (33e685a4 = IDL sell) = user BUYING tokens with SOL
        // Accounts: [3]=wSOL (baseMint), [4]=token (quoteMint)
        // Args: base_amount_in (wSOL lamports), min_quote_amount_out (min tokens)
        const mintIndex = ix.accounts?.[4];  // quoteMint = meme token (was [3], incorrect)
        if (mintIndex === undefined) {
            logger.warn('PumpSwap buy: quoteMint index not found');
            return;
        }
        const mint = this.keyToString(message.accountKeys[mintIndex]);
        if (!mint || mint === 'So11111111111111111111111111111111111111112') return;

        const solLamports  = sanitizeAmount(data.length >= 16 ? data.readBigUInt64LE(8)  : 0n); // base_amount_in
        const tokenAmount  = sanitizeAmount(data.length >= 24 ? data.readBigUInt64LE(16) : 0n); // min_quote_amount_out

        logger.info(`🔄 PUMP SWAP BUY: ${mint}, sol=${Number(solLamports)/1e9}SOL, minTokens=${tokenAmount}, slot=${slot}`);
        this.emit('pumpSwapBuyDetected', {
            mint,
            creator:     this.keyToString(message.accountKeys[0]),
            amount:      tokenAmount,
            solLamports,
            signature,
        });
    }

    private parsePumpSwapSell(ix: any, message: any, signature: string, data: Buffer, slot?: number) {
        // Called when disc = PUMP_SWAP_BUY (66063d12 = IDL buy) = user SELLING tokens for SOL
        // Accounts: [3]=wSOL (baseMint), [4]=token (quoteMint)
        // Args: base_amount_out (wSOL lamports to receive), max_quote_amount_in (max tokens to pay)
        const mintIndex = ix.accounts?.[4];  // quoteMint = meme token
        if (mintIndex === undefined) {
            logger.warn('PumpSwap sell: quoteMint index not found');
            return;
        }
        const mint = this.keyToString(message.accountKeys[mintIndex]);
        if (!mint || mint === 'So11111111111111111111111111111111111111112') return;

        const solLamports = sanitizeAmount(data.length >= 16 ? data.readBigUInt64LE(8)  : 0n); // base_amount_out (SOL received)
        const tokenAmount = sanitizeAmount(data.length >= 24 ? data.readBigUInt64LE(16) : 0n); // max_quote_amount_in (tokens sold)

        logger.debug(`🔄 PUMP SWAP SELL: ${mint}, seller=${this.keyToString(message.accountKeys[0]).slice(0,8)}, tokens=${tokenAmount}, sol=${Number(solLamports)/1e9}SOL, slot=${slot}`);
        this.emit('pumpSwapSellDetected', {
            mint,
            creator:  this.keyToString(message.accountKeys[0]),
            amount:   tokenAmount,
            signature,
        });
    }

    // ═══ Raydium LaunchLab parsing ══════════════════════════════════════════════

    private parseRaydiumLaunchInstruction(ix: any, message: any, signature: string, data: Buffer, slot?: number) {
        const disc = data.subarray(0, 8);

        if (disc.equals(RAYDIUM_DISCRIMINATOR.LAUNCH_INITIALIZE_V2)) {
            this.parseRaydiumLaunchCreate(ix, message, signature, slot);
        } else if (disc.equals(RAYDIUM_DISCRIMINATOR.LAUNCH_BUY_EXACT_IN) ||
                   disc.equals(RAYDIUM_DISCRIMINATOR.LAUNCH_BUY_EXACT_OUT)) {
            this.parseRaydiumLaunchBuy(ix, message, signature, data, slot);
        } else if (disc.equals(RAYDIUM_DISCRIMINATOR.LAUNCH_SELL_EXACT_IN) ||
                   disc.equals(RAYDIUM_DISCRIMINATOR.LAUNCH_SELL_EXACT_OUT)) {
            this.parseRaydiumLaunchSell(ix, message, signature, data, slot);
        }
    }

    private parseRaydiumLaunchCreate(ix: any, message: any, signature: string, slot?: number) {
        try {
            // InitializeV2 accounts:
            //   [0] payer (signer), [1] creator, [4] auth, [5] poolId, [6] mintA (signer)
            const creatorIndex = ix.accounts?.[1];
            const poolIndex    = ix.accounts?.[5];
            const mintIndex    = ix.accounts?.[6];

            if (mintIndex === undefined || poolIndex === undefined) return;

            const mint    = this.keyToString(message.accountKeys[mintIndex]);
            const pool    = this.keyToString(message.accountKeys[poolIndex]);
            const creator = creatorIndex !== undefined ? this.keyToString(message.accountKeys[creatorIndex]) : '';

            if (!mint || !pool) return;

            logger.info(`🚀 RAYDIUM LAUNCHLAB CREATE: mint=${mint.slice(0,8)}, pool=${pool.slice(0,8)}, creator=${creator.slice(0,8)}, slot=${slot}`);
            this.emit('raydiumLaunchCreate', {
                mint,
                pool,
                creator,
                signature,
                receivedAt: Date.now(),
            } as RaydiumLaunchCreate);
        } catch (err) {
            logger.error('Error handling Raydium LaunchLab CREATE:', err);
        }
    }

    private parseRaydiumLaunchBuy(ix: any, message: any, signature: string, data: Buffer, slot?: number) {
        try {
            // BuyExactIn: [0] owner, [4] poolId, [9] mintA
            // Args @ offset 8: amountB (u64) = SOL
            const buyerIndex = ix.accounts?.[0];
            const poolIndex  = ix.accounts?.[4];
            const mintIndex  = ix.accounts?.[9];

            if (mintIndex === undefined || poolIndex === undefined) return;

            const mint   = this.keyToString(message.accountKeys[mintIndex]);
            const pool   = this.keyToString(message.accountKeys[poolIndex]);
            const buyer  = buyerIndex !== undefined ? this.keyToString(message.accountKeys[buyerIndex]) : '';
            const amountSol = data.length >= 16 ? data.readBigUInt64LE(8) : 0n;

            if (!mint) return;

            logger.info(`💰 RAYDIUM LAUNCH BUY: ${mint.slice(0,8)}, sol=${Number(amountSol)/1e9}, buyer=${buyer.slice(0,8)}, slot=${slot}`);
            this.emit('raydiumLaunchBuyDetected', {
                mint,
                pool,
                buyer,
                amountSol,
                signature,
            } as RaydiumLaunchBuy);
        } catch (err) {
            logger.error('Error handling Raydium LaunchLab BUY:', err);
        }
    }

    private parseRaydiumLaunchSell(ix: any, message: any, signature: string, data: Buffer, slot?: number) {
        try {
            // SellExactIn: [0] owner, [4] poolId, [9] mintA
            // Args @ offset 8: amountA (u64) = tokens
            const sellerIndex = ix.accounts?.[0];
            const poolIndex   = ix.accounts?.[4];
            const mintIndex   = ix.accounts?.[9];

            if (mintIndex === undefined) return;

            const mint   = this.keyToString(message.accountKeys[mintIndex]);
            const pool   = poolIndex !== undefined ? this.keyToString(message.accountKeys[poolIndex]) : '';
            const seller = sellerIndex !== undefined ? this.keyToString(message.accountKeys[sellerIndex]) : '';
            const amountTokens = data.length >= 16 ? data.readBigUInt64LE(8) : 0n;

            if (!mint) return;

            logger.debug(`📤 RAYDIUM LAUNCH SELL: ${mint.slice(0,8)}, seller=${seller.slice(0,8)}, tokens=${amountTokens}, slot=${slot}`);
            this.emit('raydiumLaunchSellDetected', {
                mint,
                pool,
                seller,
                amountTokens,
                signature,
            } as RaydiumLaunchSell);
        } catch (err) {
            logger.error('Error handling Raydium LaunchLab SELL:', err);
        }
    }

    // ═══ Raydium CPMM new pool detection ═════════════════════════════════════════

    private parseRaydiumCpmmCreatePool(ix: any, message: any, signature: string, slot?: number) {
        try {
            // CreatePool accounts (20): [0] creator, [4] pool, [5] mintA, [6] mintB
            const poolIndex  = ix.accounts?.[4];
            const mintAIndex = ix.accounts?.[5];
            const mintBIndex = ix.accounts?.[6];
            const creatorIndex = ix.accounts?.[0];

            if (poolIndex === undefined || mintAIndex === undefined || mintBIndex === undefined) return;

            const pool    = this.keyToString(message.accountKeys[poolIndex]);
            const mintA   = this.keyToString(message.accountKeys[mintAIndex]);
            const mintB   = this.keyToString(message.accountKeys[mintBIndex]);
            const creator = creatorIndex !== undefined ? this.keyToString(message.accountKeys[creatorIndex]) : '';

            // Определяем meme token — один из пары является wSOL
            let mint: string;
            if (mintA === config.wsolMint) {
                mint = mintB;
            } else if (mintB === config.wsolMint) {
                mint = mintA;
            } else {
                logger.debug(`[raydium-cpmm] create_pool без wSOL: mintA=${mintA?.slice(0,8)} mintB=${mintB?.slice(0,8)}`);
                return;
            }
            if (!mint) return;

            logger.info(`🆕 RAYDIUM CPMM POOL: mint=${mint.slice(0,8)}, pool=${pool.slice(0,8)}, creator=${creator.slice(0,8)}, slot=${slot}`);
            this.emit('raydiumCpmmNewPool', {
                mint,
                pool,
                creator,
                signature,
            } as RaydiumCpmmNewPool);
        } catch (err) {
            logger.error('Error handling Raydium CPMM create_pool:', err);
        }
    }

    // ═══ Raydium AMM v4 new pool detection ═══════════════════════════════════════

    private parseRaydiumAmmV4CreatePool(ix: any, message: any, signature: string, slot?: number) {
        try {
            // AMM v4 create pool: instruction data[0] == 1
            // Account indices from raydium-sdk-V2-demo/src/grpc/subNewAmmPool.ts:
            //   [4] poolId, [8] baseMint, [9] quoteMint
            const poolIndex      = ix.accounts?.[4];
            const baseMintIndex  = ix.accounts?.[8];
            const quoteMintIndex = ix.accounts?.[9];

            if (poolIndex === undefined || baseMintIndex === undefined || quoteMintIndex === undefined) return;

            const pool      = this.keyToString(message.accountKeys[poolIndex]);
            const baseMint  = this.keyToString(message.accountKeys[baseMintIndex]);
            const quoteMint = this.keyToString(message.accountKeys[quoteMintIndex]);

            if (!pool || !baseMint || !quoteMint) return;

            logger.info(`🆕 RAYDIUM AMM V4 POOL: base=${baseMint.slice(0,8)}, quote=${quoteMint.slice(0,8)}, pool=${pool.slice(0,8)}, slot=${slot}`);
            this.emit('raydiumAmmV4NewPool', {
                pool,
                baseMint,
                quoteMint,
                signature,
            } as RaydiumAmmV4NewPool);
        } catch (err) {
            logger.error('Error handling Raydium AMM v4 create_pool:', err);
        }
    }

    stop() {
        this.running = false;
        if (this.stream) {
            this.stream.cancel();
            this.stream = null;
        }
        if (this.pendingSubscribeRequest) {
            clearTimeout(this.pendingSubscribeRequest);
            this.pendingSubscribeRequest = null;
        }
        this.reconnectAttempts = 0;
        logger.debug('gRPC client stopped');
    }
}