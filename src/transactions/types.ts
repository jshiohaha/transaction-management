import {
  Blockhash,
  Commitment,
  TransactionConfirmationStatus,
} from "@solana/web3.js";

export interface BaseTimeoutConfig {
  commitment?: Commitment;
  confirmationLevels?: TransactionConfirmationStatus[];
  pollingTimeoutMs?: number;
  blockhashValidityPollingTimeoutMs?: number;
}

export interface StaticTimeoutConfig extends BaseTimeoutConfig {
  type: "static";
  timeout: number;
}

export interface TransactionExpirationTimeoutConfig extends BaseTimeoutConfig {
  type: "expiration";
  transactionBlockhash: Blockhash;
}

export interface NoTimeoutConfig extends BaseTimeoutConfig {
  type: "none";
}
