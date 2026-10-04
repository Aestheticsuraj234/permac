import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { HermesGatewayAdapter } from "../../../packages/hermes-adapter/src/index.ts";
import { spawnStdioTransport } from "../../../packages/hermes-adapter/src/stdio.ts";
import { HarnessStore } from "../../../packages/storage/src/index.ts";
import { CoordinatorService } from "./service.ts";
import { listen } from "./server.ts";

const dataDir = process.env.PERMAC_DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const token = process.env.PERMAC_TOKEN ?? randomBytes(24).toString("hex");
writeFileSync(join(dataDir, "token"), token, { mode: 0o600 });

const store = HarnessStore.open(join(dataDir, "harness.sqlite"));
const transport = spawnStdioTransport(
  process.env.HERMES_PYTHON ?? "python3",
  ["-m", "tui_gateway.entry"],
  { ...process.env, HERMES_HOME: process.env.HERMES_HOME ?? join(dataDir, "hermes-home") },
);
const hermes = new HermesGatewayAdapter(transport);
const service = new CoordinatorService(store, hermes, {
  registry: ["Cursor", "TextEdit", "Safari"],
  roots: [join(process.env.HOME ?? dataDir, "Documents")],
});
const port = Number(process.env.PERMAC_PORT ?? 8788);
const server = await listen(service, token, port);
console.log(`permac coordinator listening on 127.0.0.1:${server.port}`);
