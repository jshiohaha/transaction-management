export const getUnixTs = () => new Date().getTime() / 1000;

export const sleep = async (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const tryInvokeAbort = (controller: AbortController) => {
  if (!controller.signal.aborted) {
    controller.abort();
  }
};
