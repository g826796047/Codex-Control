import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createControlServer } from "./app.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const server = await createControlServer({
  dataDir: resolve(currentDir, "../data"),
  secureCookies: false,
  autoDownloadBinaries: false,
  codexPath: process.env.CODEX_CONTROL_CODEX_PATH ?? null,
  webRoot: resolve(currentDir, "../../web/dist"),
  logger: true,
});

process.on("SIGINT", () => void server.stop().then(() => process.exit(0)));
