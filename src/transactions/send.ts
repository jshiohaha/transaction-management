import {
  Connection,
  SendTransactionError,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

import { debug, error, log } from "../logger";
import { SignatureError } from "./errors";
import { TransactionLifecycleEventCallback } from "./events";
import { SendTransactionConfig } from "./types";
import { abortableSleep, getTransactionSignatureOrThrow, sleep } from "./utils";

const MAX_SEND_TX_RETRIES = 10;

// source: https://github.com/solana-labs/solana-web3.js/blob/master/packages/errors/src/messages.ts
const TRANSACTION_ALREADY_PROCESSED_MESSAGE =
  "This transaction has already been processed";

/**
 * Sends a signed transaction to the Solana blockchain.
 *
 * @param signedTransaction - The signed transaction to send.
 * @param connection - The Solana connection object.
 * @param config - (Optional) Configuration options for sending the transaction.
 * @param onTransactionEvent - (Optional) Callback function to handle transaction lifecycle events.
 * @returns A promise that resolves to the transaction ID of the sent transaction.
 * @throws {SignatureError} If there is an error serializing the transaction.
 * @throws {Error} If there is an error sending the transaction.
 */
export const sendSignedTransaction = async ({
  signedTransaction,
  connection,
  config = {
    sendOptions: {
      skipPreflight: true,
      maxRetries: MAX_SEND_TX_RETRIES,
    },
  },
  onTransactionEvent,
}: {
  signedTransaction: Transaction | VersionedTransaction;
  connection: Connection;
  config?: SendTransactionConfig;
  onTransactionEvent?: TransactionLifecycleEventCallback;
}): Promise<string> => {
  const transactionProcessedController = new AbortController();
  let rawTransaction: Buffer | Uint8Array;

  try {
    /**
     * throws on signature errors unless explicitly told not to via config
     *
     * source: https://github.com/solana-labs/solana-web3.js/blob/7265594ce8ac9480dea2b0f5fe84b24fdacf115b/packages/library-legacy/src/transaction/legacy.ts#L797-L833
     */
    rawTransaction = signedTransaction.serialize();
  } catch (err: any) {
    error("Serialize transaction error: ", err.message);
    throw new SignatureError({
      transaction: signedTransaction,
      message: err.message,
    });
  }

  const transactionId = getTransactionSignatureOrThrow(signedTransaction);
  (async () => {
    const pollingSendTransactionTimeoutMs =
      config.pollingSendTransactionTimeoutMs ?? 1_000;
    const continuouslySendTransactions =
      config.continuouslySendTransactions ?? false;

    if (continuouslySendTransactions && !config.controller) {
      throw new Error(
        "AbortController is required to continuously send a transaction to the cluster"
      );
    }

    while (
      !transactionProcessedController.signal.aborted &&
      !config.controller?.signal.aborted
    ) {
      onTransactionEvent?.({
        type: "send",
        phase: "pending",
        transactionId,
      });

      /**
       * todo: handle the possible `SendTransactionError` errors, which right now we just catch and
       * throw a generic error related to sending a transaction
       *
       * source: https://github.com/solana-labs/solana-web3.js/blob/2d48c0954a3823b937a9b4e572a8d63cd7e4631c/packages/library-legacy/src/connection.ts#L5918-L5927
       */
      connection
        .sendRawTransaction(rawTransaction, config.sendOptions)
        .catch((err: SendTransactionError) => {
          if (err.message.includes(TRANSACTION_ALREADY_PROCESSED_MESSAGE)) {
            transactionProcessedController.abort();
            return;
          }

          error("SendTransactionError: ", err);
          throw new Error("Failed to send transaction");
        });

      onTransactionEvent?.({
        type: "send",
        phase: "completed",
        transactionId,
      });

      if (!continuouslySendTransactions) {
        log("[Continuous send = false] first transaction sent, bailing...");
        break;
      }

      await abortableSleep(pollingSendTransactionTimeoutMs, config.controller);
    }
  })();

  return transactionId;
};
