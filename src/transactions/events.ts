import {
  TransactionConfirmationStatus,
  TransactionError,
  TransactionSignature,
} from "@solana/web3.js";

export type EventTiming = "processing" | "after";

export interface TransactionSentEvent {
  type: "sent";
  timing: EventTiming;
  latency: number;
  transactionId: TransactionSignature;
}

export interface TransactionConfirmedEvent {
  type: "confirm";
  timing: EventTiming;
  status?: TransactionConfirmationStatus;
  err?: TransactionError;
  transactionId: TransactionSignature;
}

export interface TransactionTimeoutEvent {
  type: "timeout";
  timing: EventTiming;
  transactionId: TransactionSignature;
  durationMs: number;
}

export type TransactionLifecycleEventCallback = (
  event:
    | TransactionSentEvent
    | TransactionConfirmedEvent
    | TransactionTimeoutEvent,
) => void;
