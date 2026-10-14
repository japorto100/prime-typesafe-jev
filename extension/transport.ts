import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * J12: remove only provably stale bridge directories. Conservative by design:
 * requires an owner.json with a dead owner pid, an age guard, and never touches
 * a live process's directory.
 */
export function sweepStaleBridges(tmpRoot: string = os.tmpdir(), now: number = Date.now()): string[] {
	const removed: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("prime-jev-")) continue;
		const directory = path.join(tmpRoot, entry.name);
		try {
			const owner = JSON.parse(fs.readFileSync(path.join(directory, "owner.json"), "utf8"));
			const pid = owner?.pid;
			if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
			try {
				process.kill(pid, 0); // owner still alive → never touch
				continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
			}
			if (now - fs.statSync(directory).mtimeMs < 60 * 60 * 1000) continue; // age guard
			fs.rmSync(directory, { recursive: true, force: true });
			removed.push(directory);
		} catch {
			// unreadable/unexpected → preserve
		}
	}
	return removed;
}

/** One request per connection; private per-instance path, never unlink another owner. */
export function startBridge(dispatch: (request: any) => Promise<any>) {
	sweepStaleBridges();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prime-jev-"));
	fs.chmodSync(directory, 0o700);
	const socketPath = path.join(directory, "bridge.sock");
	fs.writeFileSync(
		path.join(directory, "owner.json"),
		JSON.stringify({ pid: process.pid, socket: socketPath, started_at: new Date().toISOString() }) + "\n",
		{ mode: 0o600 },
	);
	const connections = new Set<net.Socket>();
	let closed = false;
	const server = net.createServer((socket) => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
		socket.on("error", () => {});
		socket.setTimeout(5000, () => socket.destroy());
		let buffer = Buffer.alloc(0);
		let dispatched = false;
		socket.on("data", async (chunk: Buffer) => {
			if (dispatched) return;
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > 65536) {
				dispatched = true;
				socket.end(JSON.stringify({ error: "JevRequestTooLarge" }) + "\n");
				return;
			}
			const newline = buffer.indexOf(10);
			if (newline < 0) return;
			dispatched = true;
			socket.pause();
			try {
				const request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
				if (
					!request ||
					typeof request.method !== "string" ||
					!request.params ||
					typeof request.params !== "object" ||
					Array.isArray(request.params)
				) {
					throw new Error("JevInvalidRequest");
				}
				const result = await dispatch(request);
				const response = JSON.stringify({ result }) + "\n";
				if (Buffer.byteLength(response) > 1024 * 1024) throw new Error("JevResponseTooLarge");
				socket.end(response);
			} catch (error) {
				// Do not echo parser errors containing request content or arbitrary upstream errors.
				const message = error instanceof Error ? error.message : "";
				const code = /^(Jev[A-Za-z]+)(?::|$)/.exec(message)?.[1] ?? "JevBridgeError";
				socket.end(JSON.stringify({ error: code }) + "\n");
			}
		});
	});
	server.maxConnections = 16;
	// A host service must not keep an otherwise finished Prime process alive.
	server.unref();
	const ready = new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			try {
				fs.chmodSync(socketPath, 0o600);
				resolve();
			} catch (error) {
				reject(error);
			}
		});
	});
	const close = () => {
		if (closed) return;
		closed = true;
		for (const socket of connections) socket.destroy();
		server.close();
		// Deterministic cleanup even when the process exits before the close callback:
		// remove only the files we created, then the dir if it is (now) empty.
		try {
			fs.rmSync(path.join(directory, "owner.json"), { force: true });
		} catch {
			/* preserve */
		}
		try {
			fs.rmSync(socketPath, { force: true });
		} catch {
			/* preserve */
		}
		try {
			fs.rmdirSync(directory);
		} catch {
			/* Preserve unexpected contents. */
		}
	};
	return { socketPath, ready, close };
}

type HostBridge = ReturnType<typeof startBridge> & {
	dispatch: (request: any) => Promise<any>;
	retire: () => void;
};
const HOST_BRIDGE = Symbol.for("prime.typesafe.host-bridge.v1");

/**
 * Variant A (R3): the endpoint stays stable across extension reloads — only the
 * dispatch handler is swapped. `retire()` (quit only) closes the bridge AND clears
 * registry/env atomically; a naive close without registry cleanup would hand out a
 * dead socket after `/reload`.
 */
export function acquireHostBridge(dispatch: (request: any) => Promise<any>): HostBridge {
	const registry = globalThis as any;
	const existing: HostBridge | undefined = registry[HOST_BRIDGE];
	if (existing) {
		existing.dispatch = dispatch;
		process.env.PRIME_JEV_SOCKET = existing.socketPath;
		return existing;
	}
	const holder = { dispatch };
	const transport = startBridge((request) => holder.dispatch(request));
	const bridge = Object.assign(holder, transport) as HostBridge;
	bridge.retire = () => {
		bridge.close();
		if (registry[HOST_BRIDGE] === bridge) delete registry[HOST_BRIDGE];
		if (process.env.PRIME_JEV_SOCKET === bridge.socketPath) delete process.env.PRIME_JEV_SOCKET;
	};
	registry[HOST_BRIDGE] = bridge;
	process.env.PRIME_JEV_SOCKET = bridge.socketPath;
	process.once("exit", bridge.close);
	void bridge.ready.catch(() => bridge.retire());
	return bridge;
}
