import {
  Commitment,
  Connection,
  TransactionConfirmationStatus,
  TransactionSignature,
} from "@solana/web3.js";

import { log } from "../logger";
import { DEFAULT_COMMITMENT, DEFAULT_POLLING_TIMEOUT } from "./constants";
import { TransactionLifecycleEventCallback } from "./events";
import { applyTransactionExpiration } from "./timeouts/expiration";
import { applyStaticTimeout } from "./timeouts/static";
import {
  NoTimeoutConfig,
  StaticTimeoutConfig,
  TransactionExpirationTimeoutConfig,
} from "./types";
import { abortableSleep, tryInvokeAbort } from "./utils";

const TRANSACTION_CONFIRMATION_VALUES = [
  "processed",
  "confirmed",
  "finalized",
] as const;

const cleanupSubscription = async (
  connection: Connection,
  subscriptionId?: number
) => {
  if (subscriptionId) {
    connection.removeSignatureListener(subscriptionId).catch((err) => {
      log("[Web Socket] error in cleanup", err);
    });
  }
};

// enum to help define ordering of transaction confirmation statuses
enum TransactionConfirmationStatusEnum {
  processed = 1,
  confirmed,
  finalized,
}

/**
 * Determines if the current transaction confirmation status satisfies the required target commitments.
 *
 * @param requiredStatuses - An array of required transaction confirmation statuses.
 * @param currentStatus - The current transaction confirmation status.
 * @returns A boolean indicating whether the current transaction confirmation status satisfies the required target commitments.
 */
function areConfirmationLevelsSatisfied(
  requiredStatuses: TransactionConfirmationStatus[],
  currentStatus?: TransactionConfirmationStatus
): boolean {
  if (!currentStatus) return false;
  const currentStatusValue = TransactionConfirmationStatusEnum[currentStatus];
  const requiredStatusOrders = requiredStatuses.map(
    (s) => TransactionConfirmationStatusEnum[s]
  );

  return currentStatusValue >= Math.max(...requiredStatusOrders);
}

/**
 * Waits for the confirmation of a transaction signature.
 *
 * @param connection - The Solana connection object.
 * @param transactionId - The transaction signature to wait for confirmation.
 * @param config - The configuration object for the timeout and polling settings.
 * @returns A promise that resolves with the confirmation result of the transaction.
 */
export const awaitTransactionSignatureConfirmation = async ({
  connection,
  transactionId,
  config,
  onTransactionEvent,
  controller: _controller,
  transactionCommitment
}: {
  connection: Connection;
  transactionId: TransactionSignature;
  config?:
    | StaticTimeoutConfig
    | TransactionExpirationTimeoutConfig
    | NoTimeoutConfig;
  onTransactionEvent: TransactionLifecycleEventCallback;
  controller?: AbortController;
  transactionCommitment?: Commitment;
}) => {
  const controller = _controller ?? new AbortController();
  const signal = controller.signal;

  const subscriptionConfirmationCommitment =
    config?.initialConfirmationCommitment ??
    connection.commitment ??
    DEFAULT_COMMITMENT;
  const requiredConfirmationLevels = config?.requiredConfirmationLevels ?? ["confirmed"];

  onTransactionEvent({
    type: "confirm",
    phase: "pending",
    transactionId,
  });

  const result = await new Promise(async (resolve, reject) => {
    if (config?.type === "static")
      applyStaticTimeout(config, controller, reject);
    if (config?.type === "expiration")
      applyTransactionExpiration({
        connection,
        config,
        controller,
        reject,
        transactionCommitment
      });

    await new Promise(async (innerResolve, _) => {
      let subscriptionId: number | undefined;
      try {
        log("[WebSocket] Setting up onSignature subscription...");
        subscriptionId = connection.onSignature(
          transactionId,
          async (result) => {
            log("[WebSocket] result confirmed: ", transactionId, result);

            cleanupSubscription(connection, subscriptionId);
            if (result.err) {
              onTransactionEvent({
                type: "confirm",
                phase: "completed",
                transactionId,
                err: result.err,
                status:
                  subscriptionConfirmationCommitment as TransactionConfirmationStatus,
              });

              tryInvokeAbort(controller);
              reject(result.err);
            } else {
              const isValidConfirmationValue =
                TRANSACTION_CONFIRMATION_VALUES.includes(
                  subscriptionConfirmationCommitment as Extract<
                    Commitment,
                    TransactionConfirmationStatus
                  >
                );

              // resolve promise if valid transaction confirmation value OR all target commitments are satisfied.
              // else, continue polling for transaction status below.
              if (
                !isValidConfirmationValue ||
                (isValidConfirmationValue &&
                  areConfirmationLevelsSatisfied(
                    requiredConfirmationLevels,
                    subscriptionConfirmationCommitment as TransactionConfirmationStatus
                  ))
              ) {
                onTransactionEvent({
                  type: "confirm",
                  phase: "completed",
                  transactionId,
                  status:
                    subscriptionConfirmationCommitment as TransactionConfirmationStatus,
                });

                tryInvokeAbort(controller);
                resolve(result);
              } else {
                onTransactionEvent({
                  type: "confirm",
                  phase: "pending",
                  transactionId,
                  status:
                    subscriptionConfirmationCommitment as TransactionConfirmationStatus,
                });

                innerResolve(result);
              }
            }
          },
          subscriptionConfirmationCommitment
        );

        log("[WebSocket] Setup connection for transaction ", transactionId);
      } catch (err: any) {
        // note: at the moment, no event callback invoked here

        cleanupSubscription(connection, subscriptionId);
        tryInvokeAbort(controller);
        log("[WebSocket] error: ", transactionId, err);
      }
    });

    const pollingTimeout =
      config?.pollingConfirmationTimeoutMs ?? DEFAULT_POLLING_TIMEOUT;
    while (!signal.aborted) {
      try {
        const signatureStatuses = await connection.getSignatureStatuses([
          transactionId,
        ]);
        log("[REST] Signature status result: ", signatureStatuses);

        const result = signatureStatuses && signatureStatuses.value[0];
        if (!signal.aborted) {
          if (!result) {
            log("[REST] result is null: ", transactionId, result);
          } else if (result.err) {
            log("[REST] result has error: ", transactionId, result);

            onTransactionEvent({
              type: "confirm",
              phase: "completed",
              transactionId,
              err: result.err,
              status: result.confirmationStatus,
            });

            tryInvokeAbort(controller);
            reject(result.err);
          } else if (!(result.confirmations || result.confirmationStatus)) {
            log(
              `[REST] result "confirmations" or "confirmationStatus" is null: `,
              transactionId,
              requiredConfirmationLevels,
              result
            );
          } else if (
            !areConfirmationLevelsSatisfied(
              requiredConfirmationLevels,
              result.confirmationStatus
            )
          ) {
            log(
              "[REST] result confirmed with commitment: ",
              transactionId,
              result
            );

            onTransactionEvent({
              type: "confirm",
              phase: "active",
              transactionId,
              status: result.confirmationStatus,
            });
          } else {
            log("[REST] result confirmed: ", transactionId, result);

            onTransactionEvent({
              type: "confirm",
              phase: "completed",
              transactionId,
              status: result.confirmationStatus,
            });

            tryInvokeAbort(controller);
            resolve(result);
          }
        }
      } catch (e) {
        // note: at the moment, no event callback invoked here
        if (!controller.signal.aborted) {
          log("[REST] connection error: ", transactionId, e);
        }

        tryInvokeAbort(controller);
      }

      await abortableSleep(pollingTimeout, controller);
    }
  });

  return result;
};
