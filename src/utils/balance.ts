import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Рассчитывает приблизительную комиссию за транзакцию.
 * @param numSignatures количество подписей (обычно 1 или 2)
 * @param computeUnits лимит CU
 * @param priorityFeeMicroLamports цена за CU в микро-ламport
 * @returns комиссия в ламport
 */
export function estimateTransactionFee(
  numSignatures: number,
  computeUnits: number,
  priorityFeeMicroLamports: number
): number {
  const baseFee = 5000 * numSignatures; // базовая комиссия за подпись
  const priorityFeeLamports = (priorityFeeMicroLamports * computeUnits) / 1_000_000;
  return baseFee + priorityFeeLamports;
}

/**
 * Проверяет, достаточно ли SOL на кошельке для выполнения операции.
 * @param connection - соединение с RPC
 * @param owner - публичный ключ кошелька
 * @param requiredSol - сумма операции + максимальный tip + комиссии (в SOL)
 * @throws {Error} если баланс недостаточен.
 */
export async function ensureSufficientBalance(
  connection: Connection,
  owner: PublicKey,
  requiredSol: number
): Promise<void> {
  const balance = await connection.getBalance(owner);
  const requiredLamports = BigInt(Math.floor(requiredSol * 1e9));
  if (BigInt(balance) < requiredLamports) {
    throw new Error(
      `Insufficient balance: have ${(balance / 1e9).toFixed(6)} SOL, need ${(Number(requiredLamports) / 1e9).toFixed(6)} SOL`
    );
  }
}