import { Connection } from "@solana/web3.js";

import { DEFAULT_COMMITMENT, DEFAULT_POLLING_TIMEOUT } from "../constants";
import { TransactionExpirationTimeoutConfig } from "../types";
import { sleep } from "../utils";

/**
 * Applies transaction expiration logic to wait for a transaction blockhash to become valid.
 *
 * @param connection - The Solana connection object.
 * @param config - The configuration object for the transaction expiration timeout.
 * @param controller - The AbortController object used to control the timeout.
 * @param reject - The function to reject the promise if the timeout occurs.
 * @returns A promise that resolves when the transaction blockhash becomes valid.
 */
export const applyTransactionExpiration = async (
  connection: Connection,
  config: TransactionExpirationTimeoutConfig,
  controller: AbortController,
  reject: (reason?: any) => void,
) => {
  const pollingTimeout =
    config.blockhashValidityPollingTimeoutMs ?? DEFAULT_POLLING_TIMEOUT;
  const commitment =
    config.commitment ?? connection.commitment ?? DEFAULT_COMMITMENT;

  while (!controller.signal.aborted) {
    const isBlockhashValid = await connection.isBlockhashValid(
      config.transactionBlockhash,
      {
        commitment,
      },
    );

    if (!isBlockhashValid.value) {
      if (controller.signal.aborted) return;
      controller.abort();

      reject({ timeout: true });
    }

    await sleep(pollingTimeout);
  }
};
