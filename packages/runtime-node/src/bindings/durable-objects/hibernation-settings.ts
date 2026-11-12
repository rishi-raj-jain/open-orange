import { isRecord } from "../unknown-values.js";
import type { DurableObjectTurnDatabase } from "./gates.js";
import {
	readDurableObjectMetadata,
	writeDurableObjectMetadata,
} from "./metadata.js";

export interface DurableObjectWebSocketAutoResponseValue {
	request: string;
	response: string;
}

interface DurableObjectHibernationSettingsValue {
	autoResponse: DurableObjectWebSocketAutoResponseValue | null;
	eventTimeoutMilliseconds: number | null;
}

// Workerd caps this at 7 days, a Cloudflare quota. The bound here is the longest Node.js timer.
const maximumEventTimeoutMilliseconds = 2_147_483_647;

function cloneAutoResponse(
	value: DurableObjectWebSocketAutoResponseValue | null,
): DurableObjectWebSocketAutoResponseValue | null {
	return value === null
		? null
		: { request: value.request, response: value.response };
}

function validateSettings(value: unknown): DurableObjectHibernationSettingsValue {
	if (!isRecord(value)) {
		throw new TypeError("Durable Object hibernation settings are invalid");
	}
	const autoResponse = value.autoResponse;
	let normalizedAutoResponse: DurableObjectWebSocketAutoResponseValue | null = null;
	if (autoResponse !== null) {
		if (!isRecord(autoResponse)) {
			throw new TypeError("Durable Object WebSocket auto-response setting is invalid");
		}
		const request = autoResponse.request;
		const response = autoResponse.response;
		if (typeof request !== "string" || typeof response !== "string") {
			throw new TypeError("Durable Object WebSocket auto-response setting is invalid");
		}
		normalizedAutoResponse = { request, response };
	}
	const eventTimeoutMilliseconds = value.eventTimeoutMilliseconds;
	if (
		eventTimeoutMilliseconds !== null &&
		(typeof eventTimeoutMilliseconds !== "number" ||
			!Number.isInteger(eventTimeoutMilliseconds) ||
			eventTimeoutMilliseconds <= 0 ||
			eventTimeoutMilliseconds > maximumEventTimeoutMilliseconds)
	) {
		throw new TypeError("Durable Object WebSocket event-timeout setting is invalid");
	}
	return {
		autoResponse: normalizedAutoResponse,
		eventTimeoutMilliseconds,
	};
}

function initialSettings(): DurableObjectHibernationSettingsValue {
	return { autoResponse: null, eventTimeoutMilliseconds: null };
}

/**
 * The object's WebSocket auto-response and event timeout. Workerd keeps them while the object
 * hibernates, so Orange keeps them in the object's SQLite across Rivet sleep.
 */
export class DurableObjectHibernationSettings {
	readonly #database: DurableObjectTurnDatabase | undefined;
	#value: DurableObjectHibernationSettingsValue;

	constructor(database?: DurableObjectTurnDatabase) {
		this.#database = database;
		const stored =
			database === undefined
				? undefined
				: readDurableObjectMetadata(database, "hibernation");
		this.#value =
			stored === undefined ? initialSettings() : validateSettings(stored);
	}

	getAutoResponse(): DurableObjectWebSocketAutoResponseValue | null {
		return cloneAutoResponse(this.#value.autoResponse);
	}

	setAutoResponse(value: DurableObjectWebSocketAutoResponseValue | null): void {
		this.#write({ ...this.#value, autoResponse: cloneAutoResponse(value) });
	}

	getEventTimeout(): number | null {
		return this.#value.eventTimeoutMilliseconds;
	}

	setEventTimeout(value: number | null): void {
		this.#write({ ...this.#value, eventTimeoutMilliseconds: value });
	}

	#write(value: DurableObjectHibernationSettingsValue): void {
		// Settings are not storage in workerd. They do not hold the output gate, and a rolled-back
		// storage transaction keeps them.
		this.#database?.writeAtCommitBoundary(this.#persist);
		this.#value = value;
	}

	readonly #persist = (): void => {
		if (this.#database === undefined) return;
		writeDurableObjectMetadata(this.#database, "hibernation", this.#value);
	};
}
