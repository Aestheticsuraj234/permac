import Foundation
import Network

enum PermacPaths {
    static func dataDirectory() -> URL? {
        if let override = ProcessInfo.processInfo.environment["PERMAC_DATA_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        var url = Bundle.main.bundleURL
        for _ in 0..<6 {
            let candidate = url.appendingPathComponent("data", isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.appendingPathComponent("token").path) {
                return candidate
            }
            url.deleteLastPathComponent()
        }
        return nil
    }
}

final class CoordinatorLink: @unchecked Sendable {
    var onStatus: (@MainActor (String) -> Void)?
    var onEvent: (@MainActor (Data) -> Void)?
    var onTask: (@MainActor (String, String, String, String?) -> Void)?

    private let queue = DispatchQueue(label: "permac.coordinator")
    private var connection: NWConnection?
    private var buffer = Data()
    private var token = ""
    private var port: UInt16 = 8788
    private var nextID = 0
    private var started = false
    private var retrying = false
    private var isReady = false

    func start() {
        queue.async {
            guard !self.started else { return }
            self.started = true
            self.connect()
        }
    }

    func submit(instruction: String, source: String) {
        send(command: "task.submit", payload: ["instruction": instruction, "source": source])
    }

    func interrupt(taskID: String) {
        send(command: "task.interrupt", payload: ["task_id": taskID])
    }

    private func connect() {
        guard let directory = PermacPaths.dataDirectory(),
              let token = try? String(contentsOf: directory.appendingPathComponent("token"), encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else {
            fail("Coordinator not connected. No local access token was found.")
            scheduleRetry()
            return
        }
        self.token = token
        if let directory = PermacPaths.dataDirectory(),
           let raw = try? String(contentsOf: directory.appendingPathComponent("port"), encoding: .utf8),
           let parsed = UInt16(raw.trimmingCharacters(in: .whitespacesAndNewlines)) {
            port = parsed
        }
        let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port) ?? 8788, using: .tcp)
        self.connection = connection
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.buffer.removeAll()
                self.health()
            case .failed, .cancelled:
                self.fail("Coordinator not connected. Text entry and push-to-talk stay available.")
                self.scheduleRetry()
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(on: connection)
    }

    private func health() {
        send(command: "health", payload: [:])
    }

    private func send(command: String, payload: [String: String]) {
        queue.async {
            guard let connection = self.connection else { return }
            self.nextID += 1
            let body: [String: Any] = [
                "id": String(self.nextID),
                "token": self.token,
                "command": command,
                "payload": payload,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
            var frame = data
            frame.append(0x0A)
            connection.send(content: frame, completion: .contentProcessed { _ in })
        }
    }

    private func receive(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                self.drain()
            }
            if error != nil || isComplete {
                self.fail("Coordinator not connected. Text entry and push-to-talk stay available.")
                self.scheduleRetry()
                return
            }
            self.receive(on: connection)
        }
    }

    private func drain() {
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty else { continue }
            handle(line)
        }
    }

    private func handle(_ line: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
        if object["schema_version"] != nil {
            let data = line
            Task { @MainActor in self.onEvent?(data) }
            return
        }
        guard object["id"] != nil, let ok = object["ok"] as? Bool else { return }
        if ok, let result = object["result"] as? [String: Any], let id = result["id"] as? String, let instruction = result["instruction"] as? String {
            let state = result["state"] as? String ?? "queued"
            let error = result["error"] as? String
            Task { @MainActor in self.onTask?(id, instruction, state, error) }
            return
        }
        if ok {
            isReady = true
            Task { @MainActor in self.onStatus?("Connected. The coordinator is ready.") }
        } else {
            let message = object["error"] as? String ?? "The coordinator rejected the command."
            Task { @MainActor in self.onStatus?(message) }
        }
    }

    private func fail(_ message: String) {
        isReady = false
        connection?.cancel()
        connection = nil
        Task { @MainActor in self.onStatus?(message) }
    }

    private func scheduleRetry() {
        guard !retrying else { return }
        retrying = true
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.retrying = false
            self?.connect()
        }
    }
}
