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
import { abortableSleep, getUnixTs, tryInvokeAbort } from "./utils";
import {
  ConfirmationTimeoutError,
  InstructionError,
  SignatureError,
} from "../errors";
import { TransactionError } from "../errors/transaction";

const DEFAULT_CONFIRMATION_TIMEOUT = 30_000;

const MAX_SEND_TX_RETRIES = 10;

const toVersionedTransaction = async ({
  connection,
  transaction,
}: {
  connection: Connection;
  transaction: Transaction;
}) => {
  if (!transaction.feePayer) {
    throw new Error("Cannot convert a transaction that is missing fee payer");
  }

  const { blockhash: recentBlockhash } = await connection.getLatestBlockhash({
    commitment: "confirmed",
  });

  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: transaction.feePayer!,
      recentBlockhash,
      instructions: transaction.instructions,
    }).compileToV0Message()
  );
};

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
  const startTime = getUnixTs();
  const controller = new AbortController();
  let rawTransaction: Buffer;

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

  if (signedTransaction.signatures.length === 0)
    throw new Error(`Transaction does not have any signatures`);
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
       * todo: handle the possible `SendTransactionError` errors, which right now we just catch and
       * throw a generic error related to sending a transaction
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

      throw new ConfirmationTimeoutError({
        transactionId,
        message: "Timed out awaiting confirmation on transaction",
        config: ConfirmationTimeoutError.formatConfig(config),
      });
    }

    log("Transaction failed, try to simulate transaction");
    let simulationResult: SimulatedTransactionResponse | null = null;
    try {
      const transactionToSimulate =
        signedTransaction instanceof VersionedTransaction
          ? signedTransaction
          : await toVersionedTransaction({
              connection,
              transaction: signedTransaction,
            });

      onTransactionEvent({
        type: "simulate",
        phase: "pending",
        transactionId,
      });

      simulationResult = (
        await connection.simulateTransaction(transactionToSimulate, {
          commitment: "confirmed",
        })
      ).value;

      log(`Transaction ${transactionId} simulation result: `, simulationResult);
      onTransactionEvent({
        type: "simulate",
        phase: "completed",
        status: "success",
        transactionId,
        result: simulationResult,
      });
    } catch (err) {
      log(`Simulate transaction ${transactionId} failed`);

      onTransactionEvent({
        type: "simulate",
        phase: "completed",
        status: "failed",
        transactionId,
        err,
      });
    }

    if (simulationResult && simulationResult.err) {
      // note: mango parses logs if available to surface a transaction message. do we want to do this as well?
      // source: https://github.com/blockworks-foundation/mango-client-v3/blob/fb92f9cf8caaf72966e4f4135c9d6ebd14756df4/src/client.ts#L521

      log(
        "Transaction simulation error: ",
        JSON.stringify(simulationResult.err, undefined, 2)
      );
      throw new InstructionError({
        transactionId,
        error: simulationResult.err,
        transaction: signedTransaction,
      });
    }

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
