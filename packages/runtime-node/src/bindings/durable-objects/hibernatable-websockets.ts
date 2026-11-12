import { Buffer } from "node:buffer";

import {
	acceptWebSocketForHibernation,
	getSerializedWebSocketAttachment,
	getWebSocketAutoResponseTimestamp,
	getWebSocketPairPeer,
	restoreSerializedWebSocketAttachment,
	setWebSocketAttachmentChangeHandler,
	setWebSocketAutoResponseTimestamp,
	WebSocket,
	WebSocketPair,
	WebSocketRequestResponsePair,
} from "../../globals/websocket.js";
import type { RivetActorConnection } from "../../internal/rivetkit.js";
import {
	DurableObjectHibernationSettings,
	type DurableObjectWebSocketAutoResponseValue,
} from "./hibernation-settings.js";
import { isRecord } from "../unknown-values.js";

// Workerd caps an accepted socket's attachment at 16 KiB, sockets per object at 32,768, a tag at
// 256 bytes, tags per socket at 10, and an auto-response at 2,048 bytes. Those are Cloudflare
// quotas, which Orange does not copy.
// The event timeout runs on a Node timer, which fires at once past 2^31 - 1 ms (about 24.8 days).
const maximumEventTimeoutMilliseconds = 2_147_483_647;
const persistedStateKind = "open-orange:durable-object-websocket";
const persistedStateVersion = 1;

interface HibernatableWebSocketRegistration {
	attachment?: Uint8Array;
	connection?: RivetActorConnection;
	connectionId?: string;
	detach?: () => void;
	readonly tags: readonly string[];
}

interface DecodedHibernatableWebSocketState {
	attachment?: Uint8Array;
	autoResponseTimestamp?: number;
	kind: typeof persistedStateKind;
	tags: string[];
	version: typeof persistedStateVersion;
}

interface PersistedHibernatableWebSocketState {
	attachment?: string;
	autoResponseTimestamp?: number;
	kind: typeof persistedStateKind;
	tags: string[];
	version: typeof persistedStateVersion;
}

function normalizeTags(tags: string[] | undefined): string[] {
	if (tags === undefined) return [];
	if (!Array.isArray(tags)) {
		throw new TypeError("Durable Object WebSocket tags must be an array");
	}
	const distinct = new Set<string>();
	for (const tag of tags) {
		if (typeof tag !== "string") {
			throw new TypeError("Durable Object WebSocket tags must be strings");
		}
		distinct.add(tag);
	}
	return [...distinct];
}

function decodeAttachment(value: unknown): Uint8Array | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new TypeError("Persisted Durable Object WebSocket attachment is invalid");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) {
		throw new TypeError("Persisted Durable Object WebSocket attachment is invalid");
	}
	return decoded;
}

function persistedState(
	value: unknown,
): DecodedHibernatableWebSocketState | undefined {
	if (!isRecord(value) || value.kind !== persistedStateKind) return undefined;
	if (value.version !== persistedStateVersion || !Array.isArray(value.tags)) {
		throw new TypeError("Persisted Durable Object WebSocket state is invalid");
	}
	if (value.attachment !== undefined && typeof value.attachment !== "string") {
		throw new TypeError("Persisted Durable Object WebSocket attachment is invalid");
	}
	const tags = normalizeTags(value.tags);
	const attachment = decodeAttachment(value.attachment);
	const autoResponseTimestamp = value.autoResponseTimestamp;
	if (
		autoResponseTimestamp !== undefined &&
		(typeof autoResponseTimestamp !== "number" ||
			!Number.isFinite(autoResponseTimestamp) ||
			autoResponseTimestamp < 0)
	) {
		throw new TypeError(
			"Persisted Durable Object WebSocket auto-response timestamp is invalid",
		);
	}
	return {
		...(attachment === undefined ? {} : { attachment }),
		...(autoResponseTimestamp === undefined ? {} : { autoResponseTimestamp }),
		kind: persistedStateKind,
		tags,
		version: persistedStateVersion,
	};
}

function encodeState(
	socket: WebSocket,
	registration: HibernatableWebSocketRegistration,
): PersistedHibernatableWebSocketState {
	const autoResponseTimestamp =
		getWebSocketAutoResponseTimestamp(socket)?.getTime();
	return {
		...(registration.attachment === undefined
			? {}
			: { attachment: Buffer.from(registration.attachment).toString("base64") }),
		...(autoResponseTimestamp === undefined ? {} : { autoResponseTimestamp }),
		kind: persistedStateKind,
		tags: [...registration.tags],
		version: persistedStateVersion,
	};
}

// One generation owns only the live JavaScript wrappers. Each socket's tags,
// attachment, and auto-response timestamp are written to a connection record
// that the actor's socket host keeps in process memory and that outlives the
// generation, so the next generation recreates a wrapper from the record
// without retaining the old isolate graph. Nothing is persisted: when the actor
// stops, its sockets close and the records go with them.
// Workerd likewise keeps direct all-socket and per-tag indexes, removes every
// tag entry with the socket, and rebuilds a wrapper from its hibernation package:
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L21-L55
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L103-L116
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L235-L252
export class DurableObjectHibernatableWebSocketStore {
	readonly #byConnectionId = new Map<string, WebSocket>();
	readonly #byTag = new Map<string, Set<WebSocket>>();
	readonly #registrations = new Map<
		WebSocket,
		HibernatableWebSocketRegistration
	>();
	readonly #onAutoResponseChange: ((value: DurableObjectWebSocketAutoResponseValue | null) => void) | undefined;
	readonly #settings: DurableObjectHibernationSettings;

	constructor(
		settings = new DurableObjectHibernationSettings(),
		onAutoResponseChange?: (value: DurableObjectWebSocketAutoResponseValue | null) => void,
	) {
		this.#settings = settings;
		this.#onAutoResponseChange = onAutoResponseChange;
		onAutoResponseChange?.(settings.getAutoResponse());
	}

	acceptWebSocket(socket: WebSocket, tags?: string[]): void {
		const normalizedTags = normalizeTags(tags);
		acceptWebSocketForHibernation(socket);
		const registration: HibernatableWebSocketRegistration = {
			attachment: getSerializedWebSocketAttachment(socket),
			tags: normalizedTags,
		};
		this.#registrations.set(socket, registration);
		this.#addToTagIndex(socket, normalizedTags);
		setWebSocketAttachmentChangeHandler(socket, (serialized) => {
			const previous = registration.attachment;
			registration.attachment = Uint8Array.from(serialized);
			try {
				this.#persist(socket, registration);
			} catch (error) {
				registration.attachment = previous;
				throw error;
			}
		});
		socket.addEventListener(
			"close",
			() => {
				this.#remove(socket, true);
			},
			{ once: true },
		);
	}

	bindConnection(
		responseSocket: WebSocket,
		connection: RivetActorConnection,
		detach?: () => void,
	): boolean {
		const userSocket = getWebSocketPairPeer(responseSocket);
		if (userSocket === undefined) return false;
		const registration = this.#registrations.get(userSocket);
		if (registration === undefined) return false;
		if (
			registration.connectionId !== undefined &&
			registration.connectionId !== connection.id
		) {
			throw new Error("Hibernatable WebSocket is already bound to a connection");
		}
		const existing = this.#byConnectionId.get(connection.id);
		if (existing !== undefined && existing !== userSocket) {
			throw new Error("RivetKit connection is already bound to a WebSocket");
		}
		registration.connection = connection;
		registration.connectionId = connection.id;
		registration.detach = detach;
		this.#byConnectionId.set(connection.id, userSocket);
		this.#persist(userSocket, registration);
		return true;
	}

	restoreConnection(
		connection: RivetActorConnection,
	): { responseSocket: WebSocket; userSocket: WebSocket } | undefined {
		const state = persistedState(connection.state);
		if (state === undefined) return undefined;
		const existing = this.#byConnectionId.get(connection.id);
		if (existing !== undefined) {
			const responseSocket = getWebSocketPairPeer(existing);
			if (responseSocket === undefined) {
				throw new Error("Restored hibernatable WebSocket lost its pair");
			}
			return { responseSocket, userSocket: existing };
		}
		const pair = new WebSocketPair();
		restoreSerializedWebSocketAttachment(pair[1], state.attachment);
		setWebSocketAutoResponseTimestamp(pair[1], state.autoResponseTimestamp);
		this.acceptWebSocket(pair[1], state.tags);
		const registration = this.#registrations.get(pair[1]);
		if (registration === undefined) {
			throw new Error("Failed to register restored hibernatable WebSocket");
		}
		registration.connection = connection;
		registration.connectionId = connection.id;
		this.#byConnectionId.set(connection.id, pair[1]);
		return { responseSocket: pair[0], userSocket: pair[1] };
	}

	isResponseSocketHibernatable(socket: WebSocket): boolean {
		const userSocket = getWebSocketPairPeer(socket);
		return userSocket !== undefined && this.#registrations.has(userSocket);
	}

	getUserSocket(responseSocket: WebSocket): WebSocket | undefined {
		const userSocket = getWebSocketPairPeer(responseSocket);
		return userSocket !== undefined && this.#registrations.has(userSocket)
			? userSocket
			: undefined;
	}

	// Rivet deletes a connection's persisted record when its transport closes. A
	// later state write queues the removed connection for save and cancels that
	// deletion, so the socket would come back after the next wake. Stop
	// persisting before user code can observe the close.
	// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/rivetkit-core/src/actor/connection.rs#L597-L610
	endConnection(socket: WebSocket): void {
		const registration = this.#registrations.get(socket);
		if (registration === undefined) return;
		if (registration.connectionId !== undefined) {
			this.#byConnectionId.delete(registration.connectionId);
		}
		registration.connection = undefined;
		registration.connectionId = undefined;
	}

	releaseWebSocket(socket: WebSocket): void {
		this.endConnection(socket);
		this.#remove(socket, false);
	}

	// Workerd owns this configuration in its native hibernation manager. Orange
	// stores the same actor-wide pair in Rivet state so it survives JavaScript
	// generation replacement; the public getters still return fresh holders.
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/actor-state.c%2B%2B#L1250-L1289
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L199-L220
	setAutoResponse(maybePair?: WebSocketRequestResponsePair): void {
		if (maybePair === undefined) {
			this.#settings.setAutoResponse(null);
			this.#onAutoResponseChange?.(null);
			return;
		}
		if (!(maybePair instanceof WebSocketRequestResponsePair)) {
			throw new TypeError(
				"setWebSocketAutoResponse requires a WebSocketRequestResponsePair",
			);
		}
		const value = { request: maybePair.request, response: maybePair.response };
		this.#settings.setAutoResponse(value);
		this.#onAutoResponseChange?.(value);
	}

	getAutoResponse(): WebSocketRequestResponsePair | null {
		const value = this.#settings.getAutoResponse();
		return value === null
			? null
			: new WebSocketRequestResponsePair(value.request, value.response);
	}

	getAutoResponseTimestamp(socket: WebSocket): Date | null {
		return getWebSocketAutoResponseTimestamp(socket);
	}

	/** Records an auto-response that the actor's socket host sent for `socket`. */
	recordAutoResponse(socket: WebSocket, timestamp: number): void {
		const registration = this.#registrations.get(socket);
		if (registration === undefined) return;
		setWebSocketAutoResponseTimestamp(socket, timestamp);
		this.#persist(socket, registration);
	}

	// Workerd lists a socket whatever its ready state until the manager drops it
	// after the terminal event, so webSocketClose still finds the closing socket.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L224-L253
	getWebSockets(tag?: string): WebSocket[] {
		if (tag !== undefined && typeof tag !== "string") {
			throw new TypeError("Durable Object WebSocket tag must be a string");
		}
		const candidates =
			tag === undefined ? this.#registrations.keys() : this.#byTag.get(tag);
		return candidates === undefined ? [] : [...candidates];
	}

	getTags(socket: WebSocket): string[] {
		const registration = this.#registrations.get(socket);
		if (registration === undefined) {
			throw new Error(
				"you must call 'acceptWebSocket()' before attempting to access the tags of a WebSocket.",
			);
		}
		return [...registration.tags];
	}

	releaseForSleep(): void {
		for (const [socket, registration] of this.#registrations) {
			registration.detach?.();
			setWebSocketAttachmentChangeHandler(socket, undefined);
		}
		this.#registrations.clear();
		this.#byConnectionId.clear();
		this.#byTag.clear();
	}

	dispose(): void {
		for (const socket of [...this.#registrations.keys()]) {
			this.#remove(socket, true);
		}
	}

	setEventTimeout(timeoutMilliseconds?: number): void {
		if (timeoutMilliseconds === undefined || timeoutMilliseconds === 0) {
			this.#settings.setEventTimeout(null);
			return;
		}
		if (
			!Number.isInteger(timeoutMilliseconds) ||
			timeoutMilliseconds < 0 ||
			timeoutMilliseconds > maximumEventTimeoutMilliseconds
		) {
			throw new Error(
				`Event timeout should not exceed ${maximumEventTimeoutMilliseconds} ms, the longest delay of a Node.js timer.`,
			);
		}
		this.#settings.setEventTimeout(timeoutMilliseconds);
	}

	getEventTimeout(): number | null {
		return this.#settings.getEventTimeout();
	}

	#addToTagIndex(socket: WebSocket, tags: readonly string[]): void {
		for (const tag of tags) {
			const sockets = this.#byTag.get(tag) ?? new Set<WebSocket>();
			sockets.add(socket);
			this.#byTag.set(tag, sockets);
		}
	}

	#remove(socket: WebSocket, clearConnectionState: boolean): void {
		const registration = this.#registrations.get(socket);
		if (registration === undefined) return;
		registration.detach?.();
		setWebSocketAttachmentChangeHandler(socket, undefined);
		for (const tag of registration.tags) {
			const sockets = this.#byTag.get(tag);
			if (sockets === undefined) continue;
			sockets.delete(socket);
			if (sockets.size === 0) this.#byTag.delete(tag);
		}
		if (registration.connectionId !== undefined) {
			this.#byConnectionId.delete(registration.connectionId);
		}
		this.#registrations.delete(socket);
		if (clearConnectionState && registration.connection !== undefined) {
			registration.connection.state = null;
		}
	}

	#persist(
		socket: WebSocket,
		registration: HibernatableWebSocketRegistration,
	): void {
		if (registration.connection !== undefined) {
			registration.connection.state = encodeState(socket, registration);
		}
	}
}
