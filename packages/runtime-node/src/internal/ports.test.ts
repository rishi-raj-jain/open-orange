import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveRivetEnginePort } from "./ports.js";

function listen(server: Server, port = 0): Promise<number> {
	return new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", rejectListen);
			const address = server.address();
			if (address === null || typeof address === "string") {
				rejectListen(new Error("Test server has no TCP address"));
				return;
			}
			resolveListen(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolveClose, rejectClose) => {
		server.close((error) =>
			error === undefined ? resolveClose() : rejectClose(error),
		);
	});
}

test("selects a deterministic free Engine port set", async () => {
	const storagePath = await mkdtemp(join(tmpdir(), "open-orange-ports-"));
	const options = {
		host: "127.0.0.1",
		portSeed: "deterministic-project",
		storagePath,
	};
	const firstPort = await resolveRivetEnginePort(options);
	assert.equal(await resolveRivetEnginePort(options), firstPort);

	const blocker = createServer();
	await listen(blocker, firstPort + 1);
	try {
		assert.notEqual(await resolveRivetEnginePort(options), firstPort);
	} finally {
		await close(blocker);
		await rm(storagePath, { force: true, recursive: true });
	}
});

test("reuses the healthy Engine recorded in project storage", async () => {
	const storagePath = await mkdtemp(join(tmpdir(), "open-orange-ports-"));
	const engine = createServer((request, response) => {
		response.statusCode = request.url === "/health" ? 200 : 404;
		response.end();
	});
	const port = await listen(engine);
	const stampDirectory = join(
		storagePath,
		".rivetkit",
		"var",
		"engine",
	);
	await mkdir(stampDirectory, { recursive: true });
	await writeFile(
		join(stampDirectory, "runtime.json"),
		JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, pid: process.pid }),
	);
	try {
		assert.equal(
			await resolveRivetEnginePort({
				host: "127.0.0.1",
				portSeed: "ignored-when-stamped",
				storagePath,
			}),
			port,
		);
	} finally {
		await close(engine);
		await rm(storagePath, { force: true, recursive: true });
	}
});
