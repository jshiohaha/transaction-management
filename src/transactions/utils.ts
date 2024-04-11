import { log } from "../logger";

export const getUnixTs = () => new Date().getTime() / 1000;

export const sleep = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const abortableSleep = async (
  ms: number,
  controller: AbortController
) => {
  if (controller?.signal.aborted) return;
  return new Promise<void>((resolve) => {
    let timeoutId: NodeJS.Timeout;

    const onAbort = () => {
      log(`Received abort, removing abort listener for timeout = ${timeoutId}`);

      clearTimeout(timeoutId);
      controller?.signal.removeEventListener("abort", onAbort);
      resolve();
    };

    if (controller?.signal.aborted) {
      onAbort();
    } else {
      controller?.signal.addEventListener("abort", onAbort);

      timeoutId = setTimeout(() => {
        controller?.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
    }
  });
};

export const tryInvokeAbort = (controller: AbortController) => {
  if (!controller.signal.aborted) {
    controller.abort();
  }
};
