import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const hermesHome = process.env.HERMES_HOME ?? join(dataDir, "hermes-home");
configureHermesMemory(hermesHome);

const store = await HarnessStore.open();
const transport = spawnStdioTransport(
  process.env.HERMES_PYTHON ?? "python3",
  ["-m", "tui_gateway.entry"],
  { ...process.env, HERMES_HOME: hermesHome },
);
const hermes = new HermesGatewayAdapter(transport);
const service = new CoordinatorService(store, hermes, {
  registry: ["Cursor", "TextEdit", "Safari"],
  roots: [join(process.env.HOME ?? dataDir, "Documents")],
});
const port = Number(process.env.PERMAC_PORT ?? 8788);
const server = await listen(service, token, port);
writeFileSync(join(dataDir, "port"), String(server.port), { mode: 0o600 });
console.log(`permac coordinator listening on 127.0.0.1:${server.port}`);

function configureHermesMemory(home: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "supermemory.json"),
    `${JSON.stringify(
      {
        base_url: process.env.SUPERMEMORY_BASE_URL ?? "https://api.supermemory.ai",
        container_tag: process.env.SUPERMEMORY_CONTAINER_TAG ?? "permac",
        auto_recall: true,
        auto_capture: true,
      },
      null,
      2,
    )}\n`,
  );
  const provider = process.env.SUPERMEMORY_API_KEY ? "  provider: supermemory\n" : "";
  const block = `# permac-memory-start\nmemory:\n${provider}  memory_enabled: false\n  user_profile_enabled: false\n# permac-memory-end\n`;
  const configPath = join(home, "config.yaml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const marked = /# permac-memory-start[\s\S]*?# permac-memory-end\n?/;
  const next = marked.test(existing)
    ? existing.replace(marked, block)
    : `${existing.trimEnd()}${existing.trim() ? "\n" : ""}${block}`;
  writeFileSync(configPath, next);
  const key = process.env.SUPERMEMORY_API_KEY;
  if (!key) return;
  const envPath = join(home, ".env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (env.includes("SUPERMEMORY_API_KEY=")) return;
  writeFileSync(envPath, `${env.trimEnd()}${env.trim() ? "\n" : ""}SUPERMEMORY_API_KEY=${key}\n`, { mode: 0o600 });
}
