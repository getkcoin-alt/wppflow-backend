// Waits for `promise` at most `ms`. Past that it rejects with { code: "DEADLINE" } and the work is left to finish (or fail) on its own:
// nothing here cancels it. Used wherever a person or a job waits on WhatsApp's browser, which can be busy or stuck for minutes.
export function withDeadline(promise, ms, what = "The call") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${what} took longer than ${Math.round(ms / 1000)} s`);
        error.code = "DEADLINE";
        reject(error);
      }, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
