export function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
// An error that also tells the browser why in a way it can act on: { code: "confirm_required", ... }.
export function failWith(status, message, extra = {}) {
  const error = fail(status, message);
  error.extra = extra;
  return error;
}
export const route = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === "23505" ? 409 : 500);
  if (status === 500) console.error("Request failed:", error.message);
  res
    .status(status)
    .json({
      status: "error",
      message:
        status === 500
          ? "The operation failed. Please try again."
          : error.message,
      ...(status === 500 ? {} : error.extra || {}),
    });
}
export function text(value, name, max = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw fail(400, `${name} is required (maximum ${max} characters)`);
  return value.trim();
}
