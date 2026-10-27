/** Wait without keeping the coordinator alive after Ctrl+C / SIGTERM. */
export function interruptibleWait(milliseconds, signal) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error("Invalid wait duration");
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(true), milliseconds);
    const onAbort = () => finish(false);
    function finish(completed) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
