import type {
	WebSocket,
	WebSocketRequestResponsePair,
} from "../../globals/websocket.js";
import type { DurableObjectId } from "../../bindings/durable-objects/id.js";

const durableObjectClassBrand = Symbol.for(
	"open-orange.runtime.DurableObject.class",
);

// Cloudflare's Workers WebSocket type omits the browser-only bufferedAmount
// member even though Orange's concrete Node socket can expose it.
export type DurableObjectWebSocket = Omit<WebSocket, "bufferedAmount">;

export type SqlStorageValue = ArrayBuffer | string | number | null;

export abstract class SqlStorageCursor<
	T extends Record<string, SqlStorageValue>,
> {
	abstract next(): { done?: false; value: T } | { done: true; value?: never };
	abstract toArray(): T[];
	abstract one(): T;
	abstract raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
	abstract readonly columnNames: string[];
	abstract get rowsRead(): number;
	abstract get rowsWritten(): number;
	abstract [Symbol.iterator](): IterableIterator<T>;
}

export abstract class SqlStorageStatement {}

export interface SqlStorage {
	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlStorageCursor<T>;
	readonly databaseSize: number;
	readonly Cursor: typeof SqlStorageCursor;
	readonly Statement: typeof SqlStorageStatement;
}

export interface SyncKvListOptions {
	start?: string;
	startAfter?: string;
	end?: string;
	prefix?: string;
	reverse?: boolean;
	limit?: number;
}

export interface SyncKvStorage {
	get<T = unknown>(key: string): T | undefined;
	list<T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]>;
	put<T>(key: string, value: T): void;
	delete(key: string): boolean;
}

export interface DurableObjectListOptions extends SyncKvListOptions {
	allowConcurrency?: boolean;
	noCache?: boolean;
}

export interface DurableObjectGetOptions {
	allowConcurrency?: boolean;
	noCache?: boolean;
}

export interface DurableObjectPutOptions {
	allowConcurrency?: boolean;
	allowUnconfirmed?: boolean;
	noCache?: boolean;
}

export interface DurableObjectGetAlarmOptions {
	allowConcurrency?: boolean;
}

export interface DurableObjectSetAlarmOptions {
	allowConcurrency?: boolean;
	allowUnconfirmed?: boolean;
}

export interface DurableObjectTransaction {
	get<T = unknown>(
		key: string,
		options?: DurableObjectGetOptions,
	): Promise<T | undefined>;
	get<T = unknown>(
		keys: string[],
		options?: DurableObjectGetOptions,
	): Promise<Map<string, T>>;
	list<T = unknown>(
		options?: DurableObjectListOptions,
	): Promise<Map<string, T>>;
	put<T>(
		key: string,
		value: T,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	put<T>(
		entries: Record<string, T>,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	delete(
		key: string,
		options?: DurableObjectPutOptions,
	): Promise<boolean>;
	delete(
		keys: string[],
		options?: DurableObjectPutOptions,
	): Promise<number>;
	rollback(): void;
	getAlarm(options?: DurableObjectGetAlarmOptions): Promise<number | null>;
	setAlarm(
		scheduledTime: number | Date,
		options?: DurableObjectSetAlarmOptions,
	): Promise<void>;
	deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void>;
}

export interface DurableObjectStorage {
	readonly sql: SqlStorage;
	readonly kv: SyncKvStorage;
	get<T = unknown>(
		key: string,
		options?: DurableObjectGetOptions,
	): Promise<T | undefined>;
	get<T = unknown>(
		keys: string[],
		options?: DurableObjectGetOptions,
	): Promise<Map<string, T>>;
	list<T = unknown>(
		options?: DurableObjectListOptions,
	): Promise<Map<string, T>>;
	put<T>(
		key: string,
		value: T,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	put<T>(
		entries: Record<string, T>,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	delete(
		key: string,
		options?: DurableObjectPutOptions,
	): Promise<boolean>;
	delete(
		keys: string[],
		options?: DurableObjectPutOptions,
	): Promise<number>;
	deleteAll(options?: DurableObjectPutOptions): Promise<void>;
	transaction<T>(
		closure: (transaction: DurableObjectTransaction) => Promise<T>,
	): Promise<T>;
	getAlarm(options?: DurableObjectGetAlarmOptions): Promise<number | null>;
	setAlarm(
		scheduledTime: number | Date,
		options?: DurableObjectSetAlarmOptions,
	): Promise<void>;
	deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void>;
	sync(): Promise<void>;
	transactionSync<T>(closure: () => T): T;
	getCurrentBookmark(): Promise<string>;
	getBookmarkForTime(timestamp: number | Date): Promise<string>;
	onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

export interface DurableObjectState<Props = unknown> {
	waitUntil(promise: Promise<unknown>): void;
	readonly exports: object;
	readonly props: Props;
	readonly id: DurableObjectId;
	readonly storage: DurableObjectStorage;
	readonly container?: object;
	readonly facets: DurableObjectFacets;
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
	acceptWebSocket(webSocket: DurableObjectWebSocket, tags?: string[]): void;
	getWebSockets(tag?: string): DurableObjectWebSocket[];
	setWebSocketAutoResponse(
		maybeRequestResponse?: WebSocketRequestResponsePair,
	): void;
	getWebSocketAutoResponse(): WebSocketRequestResponsePair | null;
	getWebSocketAutoResponseTimestamp(
		webSocket: DurableObjectWebSocket,
	): Date | null;
	setHibernatableWebSocketEventTimeout(timeoutMs?: number): void;
	getHibernatableWebSocketEventTimeout(): number | null;
	getTags(webSocket: DurableObjectWebSocket): string[];
	abort(reason?: string, options?: DurableObjectAbortOptions): void;
}

export interface FacetStartupOptions {
	/** A Durable Object class from `ctx.exports`, or a namespace of one. */
	class: object;
	id?: DurableObjectId | string;
}

export interface DurableObjectFacets {
	/** Returns a stub that starts the facet at its first call. */
	get(
		name: string,
		getStartupOptions: () => FacetStartupOptions | Promise<FacetStartupOptions>,
	): object;
	abort(name: string, reason: unknown): void;
	delete(name: string): void;
	clone(src: string, dst: string): void;
}

export interface DurableObjectAbortOptions {
	retryAlarm?: boolean;
}

export interface AlarmInvocationInfo {
	readonly isRetry: boolean;
	readonly retryCount: number;
	readonly scheduledTime: number;
}

export abstract class DurableObject<Env = unknown, Props = unknown> {
	protected ctx: DurableObjectState<Props>;
	protected env: Env;

	declare alarm?: (alarmInfo?: AlarmInvocationInfo) => void | Promise<void>;
	declare connect?: (socket: object) => void | Promise<void>;
	constructor(ctx: DurableObjectState<Props>, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}
}

export interface DurableObject<Env = unknown, Props = unknown> {
	fetch?(request: Request): Response | Promise<Response>;
	webSocketClose?(
		webSocket: DurableObjectWebSocket,
		code: number,
		reason: string,
		wasClean: boolean,
	): void | Promise<void>;
	webSocketError?(
		webSocket: DurableObjectWebSocket,
		error: unknown,
	): void | Promise<void>;
	webSocketMessage?(
		webSocket: DurableObjectWebSocket,
		message: string | ArrayBuffer,
	): void | Promise<void>;
}

Object.defineProperty(DurableObject.prototype, durableObjectClassBrand, {
	value: true,
});

export function extendsDurableObject(instance: object): boolean {
	return durableObjectClassBrand in instance;
}
