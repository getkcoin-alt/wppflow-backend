// The server hosts a browser for every linked WhatsApp number. If the process dies, all of them are stopped and relaunched, and a stray
// error is enough to kill it: since Node 15 an unhandled promise rejection ends the process, and the browser library rejects promises
// all the time when a page closes ("Target closed", "Execution context was destroyed"). Nothing here hides an error: every one is
// logged with its stack, and an error that leaves the process in an unknown state still ends it, but cleanly (the numbers are closed
// properly first), not with every browser killed mid-write.

// Errors the browser library throws when a page or browser goes away underneath a call. Harmless to the rest of the server: the number
// concerned is noticed and brought back by the checks and the recovery loop.
const BROWSER_NOISE = /Target closed|Protocol error|Execution context was destroyed|Session closed|Navigating frame was detached|Page crashed|Browser has disconnected|Connection closed|WebSocket is not open|page has been closed|browser has been closed|Most likely the page has been closed/i;
export const isBrowserNoise = (error) => BROWSER_NOISE.test(String(error?.message ?? error ?? ""));

let installed = null;
// `onFatal` stops the server cleanly (it returns a promise); the process then exits with code 1 so that pm2 starts it again.
export function installProcessGuards({ onFatal, log = console, target = process } = {}) {
  if (installed) return installed;
  let ending = false;
  const onRejection = (reason) => {
    log.error(`Unhandled promise rejection${isBrowserNoise(reason) ? " (browser)" : ""}; the server keeps running:`, reason?.stack || reason);
  };
  const onException = (error, origin) => {
    if (isBrowserNoise(error)) {
      log.error("Browser error ignored; the server keeps running:", error?.stack || error);
      return;
    }
    log.error(`Uncaught exception (${origin || "unknown"}); stopping cleanly so that pm2 starts the server again:`, error?.stack || error);
    if (ending) return;
    ending = true;
    Promise.resolve()
      .then(() => onFatal?.(error))
      .catch((e) => log.error("Clean stop failed:", e?.message || e))
      .finally(() => target.exit(1));
  };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  installed = () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
    installed = null;
  };
  return installed;
}
