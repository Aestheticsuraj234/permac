import { createServer, type Server, type Socket } from "node:net";
import { CoordinatorService } from "./service.ts";

const MAX_FRAME_BYTES = 1_000_000;

export interface SocketServer {
  port: number;
  close: () => Promise<void>;
}

export function listen(service: CoordinatorService, token: string, port = 0): Promise<SocketServer> {
  const clients = new Set<Socket>();
  const server: Server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let authed = false;
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.write(`${JSON.stringify({ ok: false, error: "Payload too large" })}\n`);
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => clients.delete(socket));

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let message: { id?: string; token?: string; command?: string; payload?: Record<string, unknown> };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        socket.write(`${JSON.stringify({ ok: false, error: "Malformed frame" })}\n`);
        return;
      }
      if (!authed) {
        if (message.token !== token) {
          socket.write(`${JSON.stringify({ id: message.id, ok: false, error: "Unauthorized" })}\n`);
          socket.destroy();
          return;
        }
        authed = true;
      }
      void dispatch(service, message.command ?? "", message.payload ?? {})
        .then((result) => {
          socket.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
        })
        .catch((error: unknown) => {
          socket.write(
            `${JSON.stringify({
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : "Command failed",
            })}\n`,
          );
        });
    };
  });

  const unsubscribe = service.onEvent((event) => {
    const line = `${JSON.stringify(event)}\n`;
    for (const client of clients) client.write(line);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      resolve({
        port: bound,
        close: () =>
          new Promise((done) => {
            unsubscribe();
            server.close(() => done());
          }),
      });
    });
  });
}

async function dispatch(
  service: CoordinatorService,
  command: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  if (command === "task.submit") {
    return service.submitText(String(payload.instruction ?? ""), (payload.source as "text") ?? "text");
  }
  if (command === "task.interrupt") return service.interrupt(String(payload.task_id));
  if (command === "task.pause") return service.pause(String(payload.task_id));
  if (command === "approval.resolve") {
    await service.resolveApproval(
      String(payload.approval_id),
      payload.decision === "rejected" ? "rejected" : "approved",
      String(payload.payload_hash),
    );
    return { ok: true };
  }
  if (command === "clarification.answer") {
    service.answerClarification(String(payload.request_id), String(payload.answer));
    return { ok: true };
  }
  if (command === "journal.subscribe") {
    return service.eventsAfter(String(payload.task_id), Number(payload.after_sequence ?? 0));
  }
  if (command === "workflow.run") {
    return service.runWorkflow(String(payload.tool), String(payload.target), payload);
  }
  if (command === "health") return { ok: true };
  throw new Error(`Unknown command ${command}`);
}
