export interface SessionInput {
  title?: string;
}
export interface SessionRef {
  sessionId: string;
}
export interface RunInput {
  session: SessionRef;
  text: string;
}
export interface RunRef {
  sessionId: string;
  status: string;
}
export interface InterruptReceipt {
  sessionId: string;
  status: string;
}
export interface RequestAnswer {
  rpcId: string;
  result: Record<string, unknown>;
}
export interface HistoryMessage {
  role: string;
  content: string;
}
export interface RuntimeHealth {
  ok: boolean;
  detail: string;
}

export type EngineEvent =
  | { type: "gateway.ready"; sessionId: "" }
  | { type: "message.delta"; sessionId: string; text: string }
  | { type: "tool.started"; sessionId: string; toolId: string; name: string; args: unknown }
  | { type: "tool.completed"; sessionId: string; toolId: string; name: string; result: unknown }
  | {
      type: "approval.requested";
      sessionId: string;
      rpcId: string;
      requestId: string;
      command: string;
      description: string;
      toolName?: string;
    }
  | {
      type: "clarification.requested";
      sessionId: string;
      rpcId: string;
      question: string;
      choices: string[];
    }
  | {
      type: "run.finished";
      sessionId: string;
      status: "complete" | "error" | "interrupted";
      text: string;
      error?: string;
    }
  | { type: "runtime.crashed"; sessionId: ""; reason: string }
  | { type: "unsupported"; sessionId: ""; message: string };

export interface HermesAdapter {
  createSession(input: SessionInput): Promise<SessionRef>;
  submit(input: RunInput): Promise<RunRef>;
  interrupt(run: RunRef): Promise<InterruptReceipt>;
  answerRequest(input: RequestAnswer): Promise<void>;
  readHistory(session: SessionRef): Promise<HistoryMessage[]>;
  subscribe(session: SessionRef): AsyncIterable<EngineEvent>;
  health(): Promise<RuntimeHealth>;
}

export interface LineTransport {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class UnsupportedRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRequest";
  }
}

export class HermesGatewayAdapter implements HermesAdapter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(event: EngineEvent) => void>();
  private crashed = false;
  private readyPromise: Promise<void>;
  private markReady!: () => void;

  constructor(private readonly transport: LineTransport) {
    this.readyPromise = new Promise((resolve) => {
      this.markReady = resolve;
    });
    this.transport.onLine((line) => this.onLine(line));
    this.transport.onClose((reason) => {
      this.crashed = true;
      this.emit({ type: "runtime.crashed", sessionId: "", reason });
      for (const pending of this.pending.values()) pending.reject(new Error(reason));
      this.pending.clear();
    });
  }

  private emit(event: EngineEvent): void {
    if (event.type === "gateway.ready") this.markReady();
    for (const listener of this.listeners) listener(event);
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id) && !message.method) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        const error = message.error as { code?: number; message?: string };
        const text = error.message ?? "Hermes request failed";
        if (error.code === -32601) pending.reject(new UnsupportedRequest(text));
        else pending.reject(new Error(text));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (message.method === "event") {
      this.onEvent(message.params as { type?: string; session_id?: string; payload?: Record<string, unknown> });
      return;
    }
    if (typeof message.id === "string" && typeof message.method === "string") {
      this.onServerRequest(message);
    }
  }

  private onEvent(params: { type?: string; session_id?: string; payload?: Record<string, unknown> }): void {
    const sessionId = params.session_id ?? "";
    const payload = params.payload ?? {};
    if (params.type === "gateway.ready") {
      this.emit({ type: "gateway.ready", sessionId: "" });
      void this.request("client.capabilities", { server_requests: true }).catch(() => {});
      return;
    }
    if (params.type === "message.delta") {
      this.emit({ type: "message.delta", sessionId, text: String(payload.text ?? "") });
    } else if (params.type === "tool.start") {
      this.emit({
        type: "tool.started",
        sessionId,
        toolId: String(payload.tool_id ?? ""),
        name: String(payload.name ?? ""),
        args: payload.args,
      });
    } else if (params.type === "tool.complete") {
      this.emit({
        type: "tool.completed",
        sessionId,
        toolId: String(payload.tool_id ?? ""),
        name: String(payload.name ?? ""),
        result: payload.result,
      });
    } else if (params.type === "message.complete") {
      const status = payload.status === "error" || payload.status === "interrupted" ? payload.status : "complete";
      this.emit({
        type: "run.finished",
        sessionId,
        status,
        text: String(payload.text ?? ""),
        error: typeof payload.error === "string" ? payload.error : undefined,
      });
    }
  }

  private onServerRequest(message: Record<string, unknown>): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const sessionId = String(params.session_id ?? "");
    const rpcId = String(message.id);
    if (message.method === "approval") {
      this.emit({
        type: "approval.requested",
        sessionId,
        rpcId,
        requestId: String(params.request_id ?? rpcId),
        command: String(params.command ?? ""),
        description: String(params.description ?? ""),
        toolName: typeof params.tool_name === "string" ? params.tool_name : undefined,
      });
      return;
    }
    if (message.method === "clarify") {
      const choices = Array.isArray(params.choices) ? params.choices.map(String) : [];
      this.emit({
        type: "clarification.requested",
        sessionId,
        rpcId,
        question: String(params.question ?? ""),
        choices,
      });
      return;
    }
    this.transport.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported server request ${String(message.method)}` },
      }),
    );
    this.emit({
      type: "unsupported",
      sessionId: "",
      message: `Unsupported server request ${String(message.method)}`,
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.transport.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  async createSession(input: SessionInput): Promise<SessionRef> {
    await this.readyPromise;
    const result = (await this.request("session.create", {
      title: input.title,
      hidden: true,
    })) as { session_id: string };
    return { sessionId: result.session_id };
  }

  async submit(input: RunInput): Promise<RunRef> {
    const result = (await this.request("prompt.submit", {
      session_id: input.session.sessionId,
      text: input.text,
    })) as { status?: string };
    return { sessionId: input.session.sessionId, status: result.status ?? "streaming" };
  }

  async interrupt(run: RunRef): Promise<InterruptReceipt> {
    const result = (await this.request("session.interrupt", {
      session_id: run.sessionId,
    })) as { status?: string };
    return { sessionId: run.sessionId, status: result.status ?? "interrupted" };
  }

  async answerRequest(input: RequestAnswer): Promise<void> {
    this.transport.write(
      JSON.stringify({ jsonrpc: "2.0", id: input.rpcId, result: input.result }),
    );
  }

  async readHistory(session: SessionRef): Promise<HistoryMessage[]> {
    const result = (await this.request("session.history", {
      session_id: session.sessionId,
    })) as { messages?: Array<{ role?: string; content?: string; text?: string }> };
    return (result.messages ?? []).map((message) => ({
      role: String(message.role ?? ""),
      content: String(message.content ?? message.text ?? ""),
    }));
  }

  subscribe(session: SessionRef): AsyncIterable<EngineEvent> {
    const queue = new AsyncQueue<EngineEvent>();
    const listener = (event: EngineEvent) => {
      if (event.sessionId && event.sessionId !== session.sessionId) return;
      queue.push(event);
    };
    this.listeners.add(listener);
    const adapter = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const event = await queue.next();
            yield event;
            if (
              event.type === "run.finished" ||
              event.type === "runtime.crashed" ||
              adapter.crashed
            ) {
              return;
            }
          }
        } finally {
          adapter.listeners.delete(listener);
        }
      },
    };
  }

  async health(): Promise<RuntimeHealth> {
    if (this.crashed) return { ok: false, detail: "Hermes gateway exited" };
    try {
      const result = (await this.request("ping", {})) as { pong?: boolean };
      return { ok: result.pong === true, detail: result.pong ? "pong" : "no pong" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : "unhealthy" };
    }
  }
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.items.push(value);
  }

  next(): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export function scriptedTransport(): LineTransport & {
  outbound: string[];
  emit(line: string): void;
  fail(reason: string): void;
} {
  let onLine: (line: string) => void = () => {};
  let onClose: (reason: string) => void = () => {};
  const outbound: string[] = [];
  return {
    outbound,
    write(line: string) {
      outbound.push(line);
    },
    onLine(handler) {
      onLine = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close() {
      onClose("closed");
    },
    emit(line: string) {
      onLine(line);
    },
    fail(reason: string) {
      onClose(reason);
    },
  };
}
