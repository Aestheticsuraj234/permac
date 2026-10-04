import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[]): Promise<CommandResult>;
}

const sensitiveNames = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  "Keychains",
  "Cookies",
  "Mail",
  "Messages",
]);

export function isSensitivePath(path: string): boolean {
  return path.split(sep).some((part) => sensitiveNames.has(part));
}

export function locateFiles(
  entries: readonly string[],
  roots: readonly string[],
  query: string,
): { ok: true; root: string; matches: string[] } | { ok: false; reason: string } {
  if (roots.length === 0) return { ok: false, reason: "No granted directories" };
  for (const root of roots) {
    if (isSensitivePath(root)) {
      return { ok: false, reason: `Granted directory is sensitive: ${root}` };
    }
  }
  const needle = query.toLowerCase();
  const matches = entries.filter((entry) => {
    if (isSensitivePath(entry)) return false;
    const underRoot = roots.some((root) => entry === root || entry.startsWith(root.endsWith(sep) ? root : root + sep));
    return underRoot && entry.toLowerCase().includes(needle);
  });
  return { ok: true, root: roots[0]!, matches };
}

export function walkFiles(root: string): string[] {
  if (isSensitivePath(root)) return [];
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (isSensitivePath(path)) continue;
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else found.push(path);
    }
  };
  visit(root);
  return found;
}

export interface OpenAppInput {
  app: string;
  registry: readonly string[];
  runner: CommandRunner;
}

export async function openApp(input: OpenAppInput): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!input.registry.includes(input.app)) {
    return { ok: false, reason: `App is not registered: ${input.app}` };
  }
  const result = await input.runner.run("open", ["-a", input.app]);
  if (result.code !== 0) return { ok: false, reason: result.stderr || `Could not open ${input.app}` };
  return { ok: true };
}

export async function openRegisteredPath(input: {
  path: string;
  roots: readonly string[];
  runner: CommandRunner;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isSensitivePath(input.path)) return { ok: false, reason: "Path is in a sensitive directory" };
  const allowed = input.roots.some(
    (root) => input.path === root || input.path.startsWith(root.endsWith(sep) ? root : root + sep),
  );
  if (!allowed) return { ok: false, reason: "Path is outside granted directories" };
  const result = await input.runner.run("open", [input.path]);
  if (result.code !== 0) return { ok: false, reason: result.stderr || "Could not open path" };
  return { ok: true };
}

export async function readSelection(input: {
  runner: CommandRunner;
  pasteboard?: { read(): Promise<string>; write(value: string): Promise<void> };
  allowClipboardFallback?: boolean;
}): Promise<{ ok: true; source: string; text: string } | { ok: false; reason: string }> {
  const ax = await input.runner.run("osascript", [
    "-e",
    'tell application "System Events" to get value of attribute "AXSelectedText" of (first process whose frontmost is true)',
  ]);
  if (ax.code === 0 && ax.stdout.trim()) {
    return { ok: true, source: "accessibility", text: ax.stdout.trim() };
  }
  if (!input.allowClipboardFallback || !input.pasteboard) {
    return { ok: false, reason: "Selection is not available through accessibility" };
  }
  const original = await input.pasteboard.read();
  try {
    const copied = await input.runner.run("osascript", [
      "-e",
      'tell application "System Events" to keystroke "c" using command down',
    ]);
    if (copied.code !== 0) {
      return { ok: false, reason: "Clipboard fallback could not copy the selection" };
    }
    const text = await input.pasteboard.read();
    if (!text.trim() || text === original) {
      return { ok: false, reason: "Clipboard fallback found no selection" };
    }
    return { ok: true, source: "clipboard", text };
  } finally {
    await input.pasteboard.write(original);
  }
}

export function relativeWorkspace(path: string, root: string): string {
  return relative(root, path);
}
