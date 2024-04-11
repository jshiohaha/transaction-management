import {
  Connection,
  SendOptions,
  SendTransactionError,
  Transaction,
} from "@solana/web3.js";
import base58 from "bs58";

import { log } from "../logger";
import { awaitTransactionSignatureConfirmation } from "./confirm";
import { TransactionLifecycleEventCallback } from "./events";
import {
  NoTimeoutConfig,
  StaticTimeoutConfig,
  TransactionExpirationTimeoutConfig,
} from "./types";
import { abortableSleep, getUnixTs, tryInvokeAbort } from "./utils";

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
 * @param onTransactionEvent - (optional) The callback function to handle transaction lifecycle events.
 *
 * @returns A promise that resolves to the transaction ID once the transaction is confirmed.
 *
 * @throws Error if the transaction times out or fails.
 */
export const sendSignedTransaction = async ({
  signedTransaction,
  connection,
  config = {
    type: "static",
    timeout: DEFAULT_CONFIRMATION_TIMEOUT,
  },
  options = {
    skipPreflight: true,
    maxRetries: MAX_SEND_TX_RETRIES,
  },
  onTransactionEvent = (...args) => console.log(...args),
}: {
  signedTransaction: Transaction;
  connection: Connection;
  config?:
    | StaticTimeoutConfig
    | TransactionExpirationTimeoutConfig
    | NoTimeoutConfig;
  options?: SendOptions;
  onTransactionEvent?: TransactionLifecycleEventCallback;
}): Promise<string> => {
  const rawTransaction = signedTransaction.serialize();
  const startTime = getUnixTs();
  const controller = new AbortController();

  const signature =
    signedTransaction.signatures[0] instanceof Uint8Array
      ? Buffer.from(signedTransaction.signatures[0])
      : signedTransaction.signatures[0].signature;
  if (!signature) throw new Error(`Invalid signature`);

  const transactionId = base58.encode(Buffer.from(signature));

  (async () => {
    const pollingSendTransactionTimeoutMs =
      config.pollingSendTransactionTimeoutMs ?? 1_000;
    const continuouslySendTransactions =
      config.continuouslySendTransactions ?? true;

    while (!controller.signal.aborted) {
      onTransactionEvent({
        type: "send",
        phase: "pending",
        transactionId,
      });

      /**
       * todo: properly handle the possible `SendTransactionError` errors, which right now we just catch and
       * throw a generic error
       *
       * source: https://github.com/solana-labs/solana-web3.js/blob/2d48c0954a3823b937a9b4e572a8d63cd7e4631c/packages/library-legacy/src/connection.ts#L5918-L5927
       */
      connection
        .sendRawTransaction(rawTransaction, options)
        .catch((err: SendTransactionError) => {
          console.error("SendTransactionError: ", err);
          throw new Error("Failed to send transaction");
        });

      onTransactionEvent({
        type: "send",
        phase: "completed",
        transactionId,
      });

      if (!continuouslySendTransactions) {
        log("[Continuous send = false] first transaction sent, bailing...");
        break;
      }

      await abortableSleep(pollingSendTransactionTimeoutMs, controller);
    }
  })();

  if (config.type === "none") {
    controller.abort();
    log(
      "Caller requested no confirmation, skipping all confirmation and returning after initial transaction sent to cluster"
    );

    return transactionId;
  }

  try {
    await awaitTransactionSignatureConfirmation({
      connection,
      transactionId,
      config,
      onTransactionEvent,
      controller,
      transactionCommitment:
        config?.type === "expiration"
          ? config?.transactionCommitment
          : undefined,
    });

    log(
      "Finished transaction status confirmation: ",
      transactionId,
      getUnixTs() - startTime
    );
  } catch (err: any) {
    if (err.timeout) {
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
    getUnixTs() - startTime
  );

  return transactionId;
};
