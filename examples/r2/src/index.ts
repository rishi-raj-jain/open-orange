// A small file service on R2: uploads with metadata and checksums, downloads
// with ranges and conditional requests, paginated listing, bulk delete, and
// multipart uploads for large files.

interface Env {
	FILES: R2Bucket;
}

function describe(object: R2Object) {
	return {
		checksums: object.checksums.toJSON(),
		customMetadata: object.customMetadata,
		etag: object.etag,
		httpMetadata: object.httpMetadata,
		key: object.key,
		size: object.size,
		uploaded: object.uploaded.toISOString(),
	};
}

// Request headers like `x-meta-owner: ada` become custom metadata.
function customMetadata(headers: Headers): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const [name, value] of headers) {
		if (name.startsWith("x-meta-")) metadata[name.slice("x-meta-".length)] = value;
	}
	return metadata;
}

function objectHeaders(object: R2Object): Headers {
	const headers = new Headers();
	// Copies Content-Type, Content-Disposition, Cache-Control, and the rest.
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("last-modified", object.uploaded.toUTCString());
	headers.set("accept-ranges", "bytes");
	for (const [name, value] of Object.entries(object.customMetadata ?? {})) {
		headers.set(`x-meta-${name}`, value);
	}
	return headers;
}

async function files(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
	switch (request.method) {
		case "PUT": {
			const sha256 = request.headers.get("x-sha256");
			const object = await bucket.put(key, request.body, {
				customMetadata: customMetadata(request.headers),
				// R2 hashes the body and rejects the upload if it does not match.
				...(sha256 === null ? {} : { sha256 }),
				// Stores Content-Type, Cache-Control, Content-Disposition, and so on.
				httpMetadata: request.headers,
				// `If-Match: "<etag>"` makes the write optimistic: R2 returns null
				// instead of overwriting a newer version.
				onlyIf: request.headers,
			});
			if (object === null) {
				return Response.json({ error: `${key} changed since you read it` }, { status: 412 });
			}
			return Response.json(describe(object), { status: 201 });
		}
		case "HEAD": {
			const object = await bucket.head(key);
			if (object === null) return new Response(null, { status: 404 });
			return new Response(null, { headers: objectHeaders(object) });
		}
		case "GET": {
			const object = await bucket.get(key, { onlyIf: request.headers, range: request.headers });
			if (object === null) return new Response(`No file named ${key}`, { status: 404 });
			const headers = objectHeaders(object);
			// A failed condition returns the metadata without a body.
			if (!("body" in object)) {
				const status =
					request.headers.has("if-match") || request.headers.has("if-unmodified-since")
						? 412
						: 304;
				return new Response(null, { headers, status });
			}
			if (request.headers.has("range") && object.range !== undefined) {
				const range = object.range as { length: number; offset: number };
				const end = range.offset + range.length - 1;
				headers.set("content-range", `bytes ${range.offset}-${end}/${object.size}`);
				return new Response(object.body, { headers, status: 206 });
			}
			return new Response(object.body, { headers });
		}
		case "DELETE":
			await bucket.delete(key);
			return new Response(null, { status: 204 });
		default:
			return new Response("Use GET, HEAD, PUT, or DELETE", { status: 405 });
	}
}

async function list(url: URL, bucket: R2Bucket): Promise<Response> {
	const limit = url.searchParams.get("limit");
	const page = await bucket.list({
		cursor: url.searchParams.get("cursor") ?? undefined,
		// With delimiter=/, keys under a "folder" collapse into one prefix.
		delimiter: url.searchParams.get("delimiter") ?? undefined,
		include: ["httpMetadata", "customMetadata"],
		limit: limit === null ? undefined : Number(limit),
		prefix: url.searchParams.get("prefix") ?? undefined,
	});
	return Response.json({
		cursor: page.truncated ? page.cursor : undefined,
		files: page.objects.map((object) => ({
			contentType: object.httpMetadata?.contentType,
			customMetadata: object.customMetadata,
			key: object.key,
			size: object.size,
		})),
		folders: page.delimitedPrefixes,
		truncated: page.truncated,
	});
}

// Multipart uploads: POST /uploads/<key> starts one, PUT
// /uploads/<key>?uploadId=..&part=N sends a part, POST
// /uploads/<key>?uploadId=..&complete with the parts finishes it, and DELETE
// aborts it. Every part except the last must be at least 5 MiB.
async function uploads(request: Request, url: URL, bucket: R2Bucket, key: string) {
	const uploadId = url.searchParams.get("uploadId");
	if (uploadId === null) {
		if (request.method !== "POST") return new Response("Start with POST", { status: 405 });
		const upload = await bucket.createMultipartUpload(key, {
			customMetadata: customMetadata(request.headers),
			httpMetadata: request.headers,
		});
		return Response.json({ key: upload.key, uploadId: upload.uploadId }, { status: 201 });
	}
	const upload = bucket.resumeMultipartUpload(key, uploadId);
	switch (request.method) {
		case "PUT": {
			const partNumber = Number(url.searchParams.get("part"));
			if (request.body === null) return new Response("Send the part as the body", { status: 400 });
			return Response.json(await upload.uploadPart(partNumber, request.body));
		}
		case "POST": {
			const { parts } = await request.json<{ parts: R2UploadedPart[] }>();
			return Response.json(describe(await upload.complete(parts)), { status: 201 });
		}
		case "DELETE":
			await upload.abort();
			return new Response(null, { status: 204 });
		default:
			return new Response("Use PUT, POST, or DELETE", { status: 405 });
	}
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === "/files" && request.method === "GET") return list(url, env.FILES);
	if (url.pathname === "/files/delete" && request.method === "POST") {
		const { keys } = await request.json<{ keys: string[] }>();
		// One call deletes up to 1,000 keys.
		await env.FILES.delete(keys);
		return Response.json({ deleted: keys.length });
	}
	const file = /^\/files\/(.+)$/.exec(url.pathname)?.[1];
	if (file !== undefined) return files(request, env.FILES, decodeURIComponent(file));
	const upload = /^\/uploads\/(.+)$/.exec(url.pathname)?.[1];
	if (upload !== undefined) return uploads(request, url, env.FILES, decodeURIComponent(upload));
	return new Response("Try /files, /files/<key>, or /uploads/<key>", { status: 404 });
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			// R2 rejects bad input with an Error, for example a checksum that does
			// not match, a part that is too small, or an unknown upload ID.
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ error: message }, { status: 400 });
		}
	},
} satisfies ExportedHandler<Env>;
