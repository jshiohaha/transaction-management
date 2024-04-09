import {
  ComputeBudgetProgram,
  Connection,
  TransactionInstruction,
} from "@solana/web3.js";

export interface ConstantComputeUnitLimit {
  type: "constant";
  value: number;
}

export interface DynamicComputeUnitLimit {
  type: "dynamic";
  calculateLimit?: () => Promise<number>;
}

export const findComputeLimit = async (
  connection: Connection,
  instructions: TransactionInstruction[],
  limitConfig?: ConstantComputeUnitLimit | DynamicComputeUnitLimit,
): Promise<number | undefined> => {
  if (limitConfig?.type === "constant") {
    return limitConfig.value;
  } else if (limitConfig?.type === "dynamic" && limitConfig?.calculateLimit) {
    return limitConfig.calculateLimit();
  }

  return undefined;
};

/**
 * Generates a transaction instruction to set the compute unit limit for a Solana transaction.
 *
 * @param connection - The Solana connection object.
 * @param transaction - The Solana transaction object.
 * @param limitConfig - The configuration for the compute unit limit.
 * @returns A promise that resolves to a transaction instruction or undefined.
 */
export const generateComputeLimitInstruction = async (
  connection: Connection,
  instructions: TransactionInstruction[],
  limitConfig?: ConstantComputeUnitLimit | DynamicComputeUnitLimit,
): Promise<TransactionInstruction | undefined> =>
  findComputeLimit(connection, instructions, limitConfig).then((units) => {
    if (!units) return undefined;
    return ComputeBudgetProgram.setComputeUnitLimit({ units });
  });
