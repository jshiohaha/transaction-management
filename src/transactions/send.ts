import {
  Connection,
  SendOptions,
  SendTransactionError,
  Transaction,
} from "@solana/web3.js";

import { log } from "../logger";
import { awaitTransactionSignatureConfirmation } from "./confirm";
import { TransactionLifecycleEventCallback } from "./events";
import {
  NoTimeoutConfig,
  StaticTimeoutConfig,
  TransactionExpirationTimeoutConfig,
} from "./types";
import { getUnixTs, sleep, tryInvokeAbort } from "./utils";

const DEFAULT_CONFIRMATION_TIMEOUT = 30_000;

const MAX_SEND_TX_RETRIES = 10;

/**
 * Sends a signed transaction to the Solana blockchain and waits for confirmation.
 *
 * @param signedTransaction - The signed transaction to send.
 * @param connection - The Solana connection object.
 * @param continuouslySendTransactions - (optional) Whether to continuously send transactions until aborted. Default is true.
 * @param config - (optional) The transaction timeout configuration. Default is { type: "static", timeout: DEFAULT_CONFIRMATION_TIMEOUT }.
 * @param options - (optional) The send options for the transaction.
 * @param eventCallback - (optional) The callback function to handle transaction lifecycle events.
 *
 * @returns A promise that resolves to the transaction ID once the transaction is confirmed.
 *
 * @throws Error if the transaction times out or fails.
 */
export const sendSignedTransaction = async ({
  signedTransaction,
  connection,
  continuouslySendTransactions = true,
  config = {
    type: "static",
    timeout: DEFAULT_CONFIRMATION_TIMEOUT,
  },
  options = {
    skipPreflight: true,
    maxRetries: MAX_SEND_TX_RETRIES,
  },
  eventCallback = (...args) => console.log(...args),
}: {
  signedTransaction: Transaction;
  connection: Connection;
  continuouslySendTransactions?: boolean;
  config?:
    | StaticTimeoutConfig
    | TransactionExpirationTimeoutConfig
    | NoTimeoutConfig;
  options?: SendOptions;
  eventCallback?: TransactionLifecycleEventCallback;
}): Promise<string> => {
  /**
   * todos:
   * - [ ] handle `sendTransactions` errors - can throw `SendTransactionError`
   *   > source: https://github.com/solana-labs/solana-web3.js/blob/2d48c0954a3823b937a9b4e572a8d63cd7e4631c/packages/library-legacy/src/connection.ts#L5918-L5927
   * - [ ] add error handling
   */

  const rawTransaction = signedTransaction.serialize();
  const startTime = getUnixTs();
  const controller = new AbortController();

  const transactionId = await connection
    .sendRawTransaction(rawTransaction, options)
    .catch((err: SendTransactionError) => {
      console.error("SendTransactionError: ", err);
      throw new Error("Failed to send transaction");
    });

  eventCallback({
    type: "sent",
    timing: "after",
    transactionId,
    latency: getUnixTs() - startTime,
  });

  if (config.type === "none") {
    return transactionId;
  }

  const pollingTimeout = config.pollingTimeoutMs ?? 1_000;
  if (continuouslySendTransactions) {
    while (!controller.signal.aborted) {
      connection
        .sendRawTransaction(rawTransaction, options)
        .catch((err: SendTransactionError) => {
          console.error("SendTransactionError: ", err);
          throw new Error("Failed to send transaction");
        });
      await sleep(pollingTimeout);
    }
  }

  try {
    await awaitTransactionSignatureConfirmation({
      connection,
      transactionId,
      config,
      eventCallback,
    });
  } catch (err: any) {
    if (err.timeout) {
      eventCallback({
        type: "timeout",
        timing: "after",
        transactionId,
        durationMs: getUnixTs() - startTime,
      });

      tryInvokeAbort(controller);
      throw new Error("Timed out awaiting confirmation on transaction");
    }

    // other implementations opt to simulate the transaction after a failure, not sure why at the moment
    // ref: mango client v3: https://github.com/blockworks-foundation/mango-client-v3/blame/fb92f9cf8caaf72966e4f4135c9d6ebd14756df4/src/client.ts#L508

    throw new Error("Transaction failed");
  } finally {
    tryInvokeAbort(controller);
  }

  log(
    "Transaction confirmation latency: ",
    transactionId,
    getUnixTs() - startTime,
  );

  return transactionId;
};
