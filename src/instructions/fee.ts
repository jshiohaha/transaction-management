import {
  ComputeBudgetProgram,
  Connection,
  GetRecentPrioritizationFeesConfig,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";

type ComputePrioritizationFeeStrategy = "max" | "average" | "median";

export interface ConstantPrioritizationFee {
  type: "constant";
  value: number;
}

export interface DynamicPrioritizationFee {
  type: "dynamic";
  calculatePriorityFee?: () => Promise<number>;
}

// yanked from: https://docs.helius.dev/solana-rpc-nodes/alpha-priority-fee-api#helius-priority-fee-api-an-improved-solution
export enum PriorityLevel {
  NONE, // 0th percentile
  LOW, // 25th percentile
  MEDIUM, // 50th percentile
  HIGH, // 75th percentile
  VERY_HIGH, // 95th percentile
  // labelled unsafe to prevent people using and draining their funds by accident
  UNSAFE_MAX, // 100th percentile
  DEFAULT, // 50th percentile
}

/**
 * Retrieves the estimated priority fee for a given transaction on the Solana blockchain.
 *
 * @param connection - The connection object for interacting with the Solana network.
 * @param transaction - The transaction for which to retrieve the priority fee estimate.
 * @param feeConfig - Optional configuration object for specifying the priority level.
 * @returns A promise that resolves to the estimated priority fee as a number.
 */
export const getPriorityFeeEstimate_Helius = async (
  connection: Connection,
  instructions: TransactionInstruction[],
  feeConfig?: {
    priorityLevel?: PriorityLevel;
  },
): Promise<number> => {
  const priorityLevel = feeConfig?.priorityLevel || PriorityLevel.DEFAULT;

  // create most basic transaction just to encode and send
  const transaction = new Transaction();
  transaction.add(...instructions);

  // note: in the new version of @solana/web3.js, it should be possible to define a custom RPC method here and
  // leverage the benefits making requests via a Connection object. for now, we have raw fetch?
  const response = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getPriorityFeeEstimate",
      params: [
        {
          // or, accountKeys
          transaction: bs58.encode(transaction.serialize()),
          // or, includeAllPriorityFeeLevels: true
          options: { priorityLevel },
        },
      ],
    }),
  }).then((response) => response.json());

  if (response?.result?.hasOwnProperty("priorityFeeEstimate")) {
    return response.result.priorityFeeEstimate as number;
  } else {
    console.error(
      "Error fetching priority fee estimate from Helius: ",
      response,
    );

    throw new Error(
      "Something went wrong fetching priority fee estimate from Helius",
    );
  }
};

/**
 * Retrieves the recent prioritization fees based on the provided configuration and strategy.
 *
 * @param connection - The Solana connection object.
 * @param transaction - The Solana transaction object.
 * @param withLockedWritableAccounts - Optional. Specifies whether to include locked writable accounts in the configuration. Default is true.
 * @param computePrioritizationFeeStrategy - Optional. The strategy to compute the prioritization fee. Default is "median".
 * @returns The computed prioritization fee based on the strategy.
 * @throws Error if an invalid prioritization fee strategy is provided.
 */
export const getRecentPrioritizationFees = async (
  connection: Connection,
  instructions: TransactionInstruction[],
  withLockedWritableAccounts: boolean = true,
  computePrioritizationFeeStrategy: ComputePrioritizationFeeStrategy = "median",
): Promise<number> => {
  let config: GetRecentPrioritizationFeesConfig | undefined = undefined;
  if (withLockedWritableAccounts) {
    config = {
      lockedWritableAccounts: instructions.reduce((acc, i) => {
        const writableKeys = i.keys.filter((k) => k.isWritable);
        return acc.concat(writableKeys.map((a) => a.pubkey));
      }, [] as PublicKey[]),
    };
  }

  const recentFees = await connection.getRecentPrioritizationFees(config);
  switch (computePrioritizationFeeStrategy) {
    case "max":
      return Math.max(...recentFees.map((fee) => fee.prioritizationFee));
    case "average":
      const sum = recentFees.reduce(
        (acc, fee) => acc + fee.prioritizationFee,
        0,
      );
      return Math.floor(sum / recentFees.length);
    case "median":
      const sortedFees = recentFees
        .map((fee) => fee.prioritizationFee)
        .sort((a, b) => a - b);
      const middleIndex = Math.floor(sortedFees.length / 2);
      return sortedFees[middleIndex];
    default:
      console.warn(
        `Invalid compute prioritization fee strategy: ${computePrioritizationFeeStrategy}`,
      );
      return 0;
  }
};

/**
 * Finds the prioritization fee based on the given fee configuration.
 *
 * @param connection - The Solana connection object.
 * @param transaction - The Solana transaction object.
 * @param feeConfig - The fee configuration object, which can be either a constant prioritization fee or a dynamic prioritization fee.
 * @returns The prioritization fee as a number.
 */
export const findPrioritizationFee = async (
  connection: Connection,
  instructions: TransactionInstruction[],
  feeConfig?: ConstantPrioritizationFee | DynamicPrioritizationFee,
): Promise<number> => {
  if (feeConfig?.type === "constant") {
    return feeConfig.value;
  } else if (feeConfig?.type === "dynamic" && feeConfig?.calculatePriorityFee) {
    return feeConfig.calculatePriorityFee();
  }

  return getRecentPrioritizationFees(connection, instructions);
};

/**
 * Generates a transaction instruction to set the prioritization fee for a given transaction.
 *
 * @param connection - The Solana connection object.
 * @param transaction - The transaction for which to generate the instruction.
 * @param feeConfig - The configuration for the prioritization fee, which can be a constant fee or a dynamic fee.
 * @returns A promise that resolves to a transaction instruction.
 */
export const generatePrioritizationFeeInstruction = async (
  connection: Connection,
  instructions: TransactionInstruction[],
  feeConfig: ConstantPrioritizationFee | DynamicPrioritizationFee,
): Promise<TransactionInstruction> =>
  findPrioritizationFee(connection, instructions, feeConfig).then((fee) =>
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
  );
