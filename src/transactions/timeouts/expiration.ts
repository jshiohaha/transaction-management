import { Commitment, Connection } from '@solana/web3.js';

import { DEFAULT_COMMITMENT, DEFAULT_POLLING_TIMEOUT } from '../constants';
import { TransactionExpirationTimeoutConfig } from '../types';
import { abortableSleep } from '../utils';
import { log } from '../../logger';

/**
 * Applies transaction expiration logic to wait for a transaction blockhash to become valid.
 *
 * @param connection - The Solana connection object.
 * @param config - The configuration object for the transaction expiration timeout.
 * @param controller - The AbortController object used to control the timeout.
 * @param reject - The function to reject the promise if the timeout occurs.
 * @returns A promise that resolves when the transaction blockhash becomes valid.
 */
export const applyTransactionExpiration = async ({
  connection,
  config,
  controller,
  reject,
  transactionCommitment,
}: {
  connection: Connection;
  config: TransactionExpirationTimeoutConfig;
  controller: AbortController;
  reject: (reason?: any) => void;
  transactionCommitment?: Commitment;
}) => {
  const pollingTimeout = config.blockhashValidityPollingTimeoutMs ?? DEFAULT_POLLING_TIMEOUT;
  const commitment = transactionCommitment ?? connection.commitment ?? DEFAULT_COMMITMENT;

  while (!controller.signal.aborted) {
    const isBlockhashValid = await connection.isBlockhashValid(config.transactionBlockhash, {
      commitment,
    });

    log(
      `blockhash: ${config.transactionBlockhash}, commitment: ${commitment} is valid? `,
      isBlockhashValid,
    );

    if (!isBlockhashValid.value) {
      if (controller.signal.aborted) return;
      controller.abort();

      reject({ timeout: true });
    }

    await abortableSleep(pollingTimeout, controller);
  }
};
