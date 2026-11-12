declare module "cloudflare:workers" {
	type SqlStorageValue = ArrayBuffer | string | number | null;
	interface SqlStorageCursor<T extends Record<string, SqlStorageValue>> {
		readonly columnNames: string[];
		readonly rowsRead: number;
		readonly rowsWritten: number;
		one(): T;
		raw<U extends SqlStorageValue[]>(): IterableIterator<U>;
		toArray(): T[];
	}
	interface SqlStorage {
		exec<T extends Record<string, SqlStorageValue>>(
			query: string,
			...bindings: unknown[]
		): SqlStorageCursor<T>;
		readonly databaseSize: number;
	}
	interface SyncKvListOptions {
		start?: string;
		startAfter?: string;
		end?: string;
		prefix?: string;
		reverse?: boolean;
		limit?: number;
	}
	interface SyncKvStorage {
		get<T = unknown>(key: string): T | undefined;
		list<T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]>;
		put<T>(key: string, value: T): void;
		delete(key: string): boolean;
	}
	interface DurableObjectListOptions extends SyncKvListOptions {
		allowConcurrency?: boolean;
		noCache?: boolean;
	}
	interface DurableObjectGetOptions {
		allowConcurrency?: boolean;
		noCache?: boolean;
	}
	interface DurableObjectPutOptions {
		allowConcurrency?: boolean;
		allowUnconfirmed?: boolean;
		noCache?: boolean;
	}
	interface DurableObjectGetAlarmOptions {
		allowConcurrency?: boolean;
	}
	interface DurableObjectSetAlarmOptions {
		allowConcurrency?: boolean;
		allowUnconfirmed?: boolean;
	}
	interface DurableObjectId {
		toString(): string;
		equals(other: DurableObjectId): boolean;
		readonly name?: string;
		readonly jurisdiction?: string;
	}
	interface DurableObjectAbortOptions {
		retryAlarm?: boolean;
	}
	interface DurableObjectTransaction {
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
	interface DurableObjectState {
		waitUntil(promise: Promise<unknown>): void;
		readonly id: DurableObjectId;
		blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
		abort(reason?: string, options?: DurableObjectAbortOptions): void;
		readonly storage: {
			readonly kv: SyncKvStorage;
			readonly sql: SqlStorage;
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
			getAlarm(
				options?: DurableObjectGetAlarmOptions,
			): Promise<number | null>;
			setAlarm(
				scheduledTime: number | Date,
				options?: DurableObjectSetAlarmOptions,
			): Promise<void>;
			deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void>;
			sync(): Promise<void>;
			transactionSync<T>(closure: () => T): T;
		};
	}
	export class DurableObject {
		protected ctx: DurableObjectState;
		constructor(ctx: DurableObjectState, env: unknown);
	}
}
