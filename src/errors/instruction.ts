import {
  Transaction,
  TransactionError,
  TransactionInstruction,
} from "@solana/web3.js";

export class InstructionError extends Error {
  transactionId: string;
  message: string;
  error: TransactionError;
  instruction: TransactionInstruction;

  constructor({
    transactionId,
    transaction,
    error,
    message,
  }: {
    transactionId: string;
    transaction: Transaction;
    error: TransactionError;
    message?: string;
  }) {
    super();
    this.transactionId = transactionId;
    this.error = error;

    const [ixKey, errorName] = (error as any).InstructionError;
    this.instruction = transaction.instructions[ixKey];

    const displayableErrorName =
      typeof errorName === "string" ? errorName : JSON.stringify(errorName);
    this.message =
      message ??
      `Transaction failed with error ${displayableErrorName} at instruction at index = ${ixKey}`;
  }
}
