import {
  Blockhash,
  Commitment,
  TransactionConfirmationStatus,
} from "@solana/web3.js";

export interface BaseConfig {
  /**
   * Commitment level used when first setting up a websocket connection
   * to listen for the status of a transaction.
   */
  initialConfirmationCommitment?: Commitment;
  /**
   * The confirmation status values that should be verified before returning.
   */
  requiredConfirmationLevels?: TransactionConfirmationStatus[];
  /**
   * If polling for transaction status is used, what is the amount of time between
   * calls, in milliseconds.
   */
  pollingConfirmationTimeoutMs?: number;
  /**
   * Whether or not the transaction should continuously be sent to the cluster
   * before returning.
   */
  continuouslySendTransactions?: boolean;
  /**
   * If continuously sending transactions to the cluster status is used, what is the
   * amount of time between calls, in milliseconds. Ignored if "continuouslySendTransactions"
   * is false.
   */
  pollingSendTransactionTimeoutMs?: number;
}

export interface StaticTimeoutConfig extends BaseConfig {
  type: "static";
  timeout: number;
}

export interface TransactionExpirationTimeoutConfig extends BaseConfig {
  type: "expiration";
  transactionBlockhash: Blockhash;
  /**
   * Commitment level used when creating the transaction. If not defined,
   * the fallback values will be:
   *
   * 1. the Connection instance's commitment level,
   * 2. the defined `DEFAULT_COMMITMENT` constant
   */
  transactionCommitment: Commitment;
  /**
   * What is the amount of time between calls when checking if the transaction blockhash
   * is still valid, in milliseconds.
   */
  blockhashValidityPollingTimeoutMs?: number;
}

export interface NoTimeoutConfig extends BaseConfig {
  type: "none";
}
