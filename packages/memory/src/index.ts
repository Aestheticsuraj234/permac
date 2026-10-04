import Supermemory from "supermemory";

export type MemoryResult = "stored" | "skipped";

export function memoryConfigured(): boolean {
  return Boolean(process.env.SUPERMEMORY_API_KEY);
}

export interface MemoryClient {
  add(params: {
    content: string;
    containerTag: string;
    metadata?: Record<string, string>;
  }): Promise<{ id?: string }>;
  search(params: {
    q: string;
    searchMode: "hybrid" | "memories" | "documents";
    containerTag: string;
  }): Promise<{ results?: unknown[] }>;
  documents: {
    delete(id: string): Promise<unknown>;
  };
}

function containerTag(): string {
  return process.env.SUPERMEMORY_CONTAINER_TAG ?? "permac";
}

function clientFromEnv(): MemoryClient | undefined {
  const apiKey = process.env.SUPERMEMORY_API_KEY;
  if (!apiKey) return undefined;
  const baseURL = process.env.SUPERMEMORY_BASE_URL;
  return new Supermemory({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  }) as MemoryClient;
}

export async function storeMemory(
  content: string,
  metadata: Record<string, string> = {},
  client: MemoryClient | undefined = clientFromEnv(),
): Promise<MemoryResult> {
  if (!client) return "skipped";
  await client.add({
    content,
    containerTag: containerTag(),
    metadata: { source: "permac", ...metadata },
  });
  return "stored";
}

export async function recallMemory(
  query: string,
  client: MemoryClient | undefined = clientFromEnv(),
): Promise<string[]> {
  if (!client) return [];
  const response = await client.search({
    q: query,
    searchMode: "hybrid",
    containerTag: containerTag(),
  });
  return (response.results ?? []).map(textOf).filter((text) => text.length > 0);
}

export async function forgetMemory(
  docId: string,
  client: MemoryClient | undefined = clientFromEnv(),
): Promise<MemoryResult> {
  if (!client) return "skipped";
  await client.documents.delete(docId);
  return "stored";
}

function textOf(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const row = item as Record<string, unknown>;
  for (const key of ["memory", "content", "chunk", "text"]) {
    if (typeof row[key] === "string") return row[key];
  }
  return "";
}
