import { spawn } from "node:child_process";
import type { LineTransport } from "./index.ts";

export function spawnStdioTransport(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): LineTransport {
  const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const queued: string[] = [];
  let handler: ((line: string) => void) | undefined;
  let closeHandler: ((reason: string) => void) | undefined;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) emit(line);
      newline = buffer.indexOf("\n");
    }
  });
  child.on("exit", (code) => closeHandler?.(`exit ${code ?? "null"}`));

  function emit(line: string): void {
    if (handler) handler(line);
    else queued.push(line);
  }

  return {
    write(line: string) {
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    onLine(next) {
      handler = next;
      for (const line of queued.splice(0)) next(line);
    },
    onClose(next) {
      closeHandler = next;
    },
    close() {
      child.kill();
    },
  };
}
