import {
  CompiledInstruction,
  Connection,
  Keypair,
  Message,
  RpcResponseAndContext,
  SendOptions,
  SendTransactionError,
  SimulatedTransactionResponse,
  Transaction,
  TransactionMessage,
  VersionedMessage,
  VersionedTransaction,
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
import {
  abortableSleep,
  getTransactionSignature,
  getTransactionSignatureOrThrow,
  getUnixTs,
  tryInvokeAbort,
} from "./utils";
import {
  ConfirmationTimeoutError,
  InstructionError,
  SignatureError,
} from "./errors";
import { TransactionError } from "./errors/transaction";
import { simulateTransaction } from "./simulate";

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
    timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT,
  },
  sendOptions = {
    skipPreflight: true,
    maxRetries: MAX_SEND_TX_RETRIES,
  },
  onTransactionEvent = (...args) => console.log(...args),
}: {
  signedTransaction: Transaction | VersionedTransaction;
  connection: Connection;
  config?:
    | StaticTimeoutConfig
    | TransactionExpirationTimeoutConfig
    | NoTimeoutConfig;
  sendOptions?: SendOptions;
  onTransactionEvent?: TransactionLifecycleEventCallback;
}): Promise<string> => {
  const startTime = getUnixTs();
  const controller = new AbortController();
  let rawTransaction: Buffer | Uint8Array;

  try {
    /**
     * throws on signature errors unless explicitly told not to via config
     *
     * source: https://github.com/solana-labs/solana-web3.js/blob/7265594ce8ac9480dea2b0f5fe84b24fdacf115b/packages/library-legacy/src/transaction/legacy.ts#L797-L833
     */
    rawTransaction = signedTransaction.serialize();
  } catch (err: any) {
    log("Serialize transaction error: ", err.message);
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
      config.continuouslySendTransactions ?? true;

    while (!controller.signal.aborted) {
      onTransactionEvent({
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
        .sendRawTransaction(rawTransaction, sendOptions)
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

      throw new ConfirmationTimeoutError({
        transactionId,
        message: "Timed out awaiting confirmation on transaction",
        config: ConfirmationTimeoutError.formatConfig(config),
      });
    }

    await simulateTransaction({
      transaction: signedTransaction,
      connection,
      config: {
        commitment: config.transactionCommitment,
      },
      onTransactionEvent,
    });

    /**
     * question: is there any additional processing we can do to give back more information to the caller?
     */
    throw new TransactionError({
      message: "Transaction failed",
      transactionId,
    });
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
