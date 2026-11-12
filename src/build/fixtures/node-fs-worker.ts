import {
	chmodSync,
	createReadStream,
	createWriteStream,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { cp, mkdir, readFile } from "node:fs/promises";
import { finished } from "node:stream/promises";

// The bundle holds this string, so a read of /bundle/worker can find it.
const marker = "open-orange-node-fs-fixture-marker";
const secondWrote = Promise.withResolvers<void>();

function errorCode(run: () => unknown): Promise<unknown> {
	return Promise.resolve()
		.then(run)
		.then(
			() => "no error",
			(error: unknown) => ({
				code: Reflect.get(Object(error), "code"),
				path: Reflect.get(Object(error), "path"),
			}),
		);
}

async function streamRoundTrip(path: string): Promise<string> {
	const writer = createWriteStream(path);
	writer.write("one,");
	writer.end("two");
	await finished(writer);
	let text = "";
	for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
		text += chunk;
	}
	return text;
}

// Runs common fs calls in `dir`, a host directory the test owns, as a Worker would in /tmp.
async function scratch(dir: string): Promise<Response> {
	writeFileSync(`${dir}/a.txt`, "alpha");
	mkdirSync(`${dir}/tree/nested`, { recursive: true });
	writeFileSync(`${dir}/tree/nested/file.txt`, "nested");
	await cp(`${dir}/tree`, `${dir}/tree-copy`, { recursive: true });
	symlinkSync(`${dir}/a.txt`, `${dir}/link`);
	chmodSync(`${dir}/a.txt`, 0o600);
	return Response.json({
		read: readFileSync(`${dir}/a.txt`, "utf8"),
		stream: await streamRoundTrip(`${dir}/stream.txt`),
		copied: await readFile(`${dir}/tree-copy/nested/file.txt`, "utf8"),
		entries: readdirSync(dir).sort(),
		stat: { size: statSync(`${dir}/a.txt`).size, file: statSync(`${dir}/a.txt`).isFile() },
		link: {
			target: readlinkSync(`${dir}/link`),
			symbolic: lstatSync(`${dir}/link`).isSymbolicLink(),
			read: readFileSync(`${dir}/link`, "utf8"),
		},
		mode: statSync(`${dir}/a.txt`).mode & 0o777,
		bundleStream: await errorCode(
			() =>
				new Promise((resolve, reject) =>
					createWriteStream("/bundle/stream.txt").on("error", reject).on("open", resolve),
				),
		),
		bundleCopy: await errorCode(() => cp(`${dir}/a.txt`, "/bundle/a.txt")),
	});
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/bundle") {
			return Response.json({
				entries: readdirSync("/bundle"),
				holdsWorker: (await readFile("/bundle/worker", "utf8")).includes(marker),
				missing: await errorCode(() => readFileSync("/bundle/missing.txt")),
				syncWrite: await errorCode(() => writeFileSync("/bundle/worker", "x")),
				promiseWrite: await errorCode(() => mkdir("/bundle/a")),
			});
		}
		if (url.pathname === "/scratch") {
			return scratch(url.searchParams.get("dir") ?? "");
		}
		const file = url.searchParams.get("file") ?? "";
		const value = url.searchParams.get("value") ?? "";
		writeFileSync(file, value);
		if (url.searchParams.has("hold")) {
			await secondWrote.promise;
		} else {
			secondWrote.resolve();
		}
		return new Response(readFileSync(file, "utf8"));
	},
};
