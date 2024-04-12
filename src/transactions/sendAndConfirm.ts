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
  SendTransactionConfig,
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
import { sendSignedTransaction } from "./send";

const DEFAULT_CONFIRMATION_TIMEOUT = 30_000;

/**
 * Sends a transaction to the Solana blockchain and waits for confirmation.
 *
 * @param signedTransaction - The signed transaction to send.
 * @param connection - The Solana connection object.
 * @param config - The configuration options for sending and confirming the transaction.
 * @param onTransactionEvent - Optional callback function to handle transaction lifecycle events.
 * @returns The transaction ID of the sent transaction.
 * @throws {ConfirmationTimeoutError} If the transaction confirmation times out.
 * @throws {TransactionError} If the transaction fails.
 */
export const sendAndConfirmTransaction = async ({
  signedTransaction,
  connection,
  config = {
    type: "static",
    timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT,
  },
  onTransactionEvent
}: {
  signedTransaction: Transaction | VersionedTransaction;
  connection: Connection;
  config?: SendTransactionConfig &
    (
      | StaticTimeoutConfig
      | TransactionExpirationTimeoutConfig
      | NoTimeoutConfig
    );
  onTransactionEvent?: TransactionLifecycleEventCallback;
}): Promise<string> => {
  const startTime = getUnixTs();
  const controller = new AbortController();

  const {
    continuouslySendTransactions,
    pollingSendTransactionTimeoutMs,
    sendOptions,
    ...confirmationConfig
  } = config;

  const transactionId = await sendSignedTransaction({
    signedTransaction,
    connection,
    config: {
      controller,
      continuouslySendTransactions,
      pollingSendTransactionTimeoutMs,
      sendOptions,
    },
    onTransactionEvent
  });

  if (confirmationConfig.type === "none") {
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
      config: confirmationConfig,
      onTransactionEvent,
      controller,
      transactionCommitment:
        confirmationConfig?.type === "expiration"
          ? confirmationConfig?.transactionCommitment
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
        config: ConfirmationTimeoutError.formatConfig(confirmationConfig),
      });
    }

    await simulateTransaction({
      transaction: signedTransaction,
      connection,
      config: {
        commitment: confirmationConfig.transactionCommitment,
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
