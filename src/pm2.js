import { startServer } from "./server.js";

startServer().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
