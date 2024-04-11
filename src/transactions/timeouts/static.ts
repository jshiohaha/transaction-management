import { log } from "../../logger";
import { StaticTimeoutConfig } from "../types";

/**
 * Applies a static timeout to the given configuration.
 * If the timeout is reached, the provided AbortController is aborted and the rejection function is called with a timeout error.
 *
 * @param config - The static timeout configuration.
 * @param controller - The AbortController used to abort the operation if the timeout is reached.
 * @param reject - The rejection function to be called if the timeout is reached.
 */
export const applyStaticTimeout = (
  config: StaticTimeoutConfig,
  controller: AbortController,
  reject: (reason?: any) => void
) => {
  const timeoutId = setTimeout(() => {
    if (controller.signal.aborted) return;
    controller.abort();

    reject({ timeout: true });
  }, config.timeoutMs);

  controller.signal.addEventListener("abort", () => {
    log(`Controller signal aborted, cancelling static timeout: ${timeoutId}`);
    clearTimeout(timeoutId);
  });
};
