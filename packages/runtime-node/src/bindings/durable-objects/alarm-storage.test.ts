import assert from "node:assert/strict";
import test from "node:test";

import type {
	RivetActorSchedule,
	RivetScheduledEventInfo,
	RivetScheduledFireInfo,
} from "../../internal/rivetkit.js";
import {
	type DurableObjectAlarmPersistence,
	type DurableObjectAlarmRecord,
	DurableObjectAlarmScheduler,
	durableObjectAlarmRetryDelay,
	durableObjectAlarmAction,
} from "./alarm-storage.js";
import { createDurableObjectAbortError } from "./abort.js";

class TestSchedule implements RivetActorSchedule {
	readonly events: RivetScheduledEventInfo[] = [];
	#nextId = 1;

	async at(
		timestamp: number,
		action: string,
		...args: unknown[]
	): Promise<string> {
		const id = `schedule-${this.#nextId}`;
		this.#nextId += 1;
		this.events.push({ action, args, id, runAt: timestamp });
		return id;
	}

	async cancel(id: string): Promise<boolean> {
		const index = this.events.findIndex((event) => event.id === id);
		if (index < 0) return false;
		this.events.splice(index, 1);
		return true;
	}

	claim(id: string): RivetScheduledFireInfo {
		const index = this.events.findIndex((event) => event.id === id);
		const [event] = this.events.splice(index, 1);
		if (index < 0 || event === undefined) {
			throw new Error(`Test schedule ${id} does not exist`);
		}
		return {
			firedAt: event.runAt,
			id,
			kind: "at",
			scheduledAt: event.runAt,
		};
	}

	async list(): Promise<RivetScheduledEventInfo[]> {
		return this.events.map((event) => ({ ...event, args: [...event.args] }));
	}
}

class TestAlarmStore implements DurableObjectAlarmPersistence {
	record: DurableObjectAlarmRecord | null = null;

	delete(): void {
		this.record = null;
	}

	getRecord(): DurableObjectAlarmRecord | null {
		return this.record === null ? null : { ...this.record };
	}

	set(scheduledTime: number, token: string): void {
		this.record = { scheduledTime, token };
	}
}

function expectedAlarm(
	id: string,
	scheduledTime: number,
	token: string,
	retryCount = 0,
	runAt = scheduledTime,
): RivetScheduledEventInfo {
	return {
		action: durableObjectAlarmAction,
		args: [scheduledTime, token, retryCount],
		id,
		runAt,
	};
}

test("creates, reuses, replaces, and deletes one durable alarm schedule", async () => {
	const schedule = new TestSchedule();
	const store = new TestAlarmStore();
	const scheduler = new DurableObjectAlarmScheduler(schedule, true, store);

	store.set(1_000, "first");
	await scheduler.synchronize(1_000);
	assert.deepEqual(schedule.events, [
		expectedAlarm("schedule-1", 1_000, "first"),
	]);
	await scheduler.synchronize(1_000);
	assert.deepEqual(schedule.events, [
		expectedAlarm("schedule-1", 1_000, "first"),
	]);

	store.set(2_000, "second");
	await scheduler.synchronize(2_000);
	assert.deepEqual(schedule.events, [
		expectedAlarm("schedule-2", 2_000, "second"),
	]);
	store.delete();
	await scheduler.synchronize(null);
	assert.deepEqual(schedule.events, []);
});

test("repairs duplicate alarms and preserves the newest retry on initialization", async () => {
	const schedule = new TestSchedule();
	const store = new TestAlarmStore();
	store.set(3_000, "current");
	await schedule.at(
		3_000,
		durableObjectAlarmAction,
		3_000,
		"current",
		0,
	);
	await schedule.at(
		5_000,
		durableObjectAlarmAction,
		3_000,
		"current",
		1,
	);
	await schedule.at(
		2_000,
		durableObjectAlarmAction,
		2_000,
		"stale",
		0,
	);
	await schedule.at(1_000, "application-action", "unchanged");

	const scheduler = new DurableObjectAlarmScheduler(schedule, true, store);
	await scheduler.restore();
	assert.deepEqual(schedule.events, [
		expectedAlarm("schedule-2", 3_000, "current", 1, 5_000),
		{
			action: "application-action",
			args: ["unchanged"],
			id: "schedule-4",
			runAt: 1_000,
		},
	]);
});

test("serializes overlapping alarm replacements in invocation order", async () => {
	const schedule = new TestSchedule();
	const store = new TestAlarmStore();
	const scheduler = new DurableObjectAlarmScheduler(schedule, true, store);

	store.set(4_000, "first");
	const first = scheduler.synchronize(4_000);
	store.set(5_000, "second");
	const second = scheduler.synchronize(5_000);
	await Promise.all([first, second]);
	assert.deepEqual(schedule.events, [
		expectedAlarm("schedule-1", 5_000, "second"),
	]);
});

test("allows constructor alarm setup before requiring an alarm handler", () => {
	const scheduler = new DurableObjectAlarmScheduler(
		new TestSchedule(),
		false,
		new TestAlarmStore(),
	);
	assert.doesNotThrow(() => scheduler.assertSupported());
	scheduler.finishConstruction();
	assert.throws(
		() => scheduler.assertSupported(),
		/Your Durable Object class must have an alarm\(\) handler/,
	);
	const instanceFieldScheduler = new DurableObjectAlarmScheduler(
		new TestSchedule(),
		false,
		new TestAlarmStore(),
	);
	instanceFieldScheduler.finishConstruction({ alarm: () => undefined });
	assert.doesNotThrow(() => instanceFieldScheduler.assertSupported());
});

test("dispatches retry metadata and reschedules failures with bounded backoff", async () => {
	assert.deepEqual(
		[1, 2, 3, 4, 5, 6].map((retryCount) =>
			durableObjectAlarmRetryDelay(retryCount, () => 0),
		),
		[2_000, 4_000, 8_000, 16_000, 32_000, 64_000],
	);
	assert.equal(durableObjectAlarmRetryDelay(1, () => 1), 2_500);
	const schedule = new TestSchedule();
	const store = new TestAlarmStore();
	store.set(10_000, "alarm");
	const scheduler = new DurableObjectAlarmScheduler(schedule, true, store, {
		now: () => 20_000,
		random: () => 0.5,
	});
	await scheduler.restore();
	const firstFire = schedule.claim("schedule-1");
	const invocations: unknown[] = [];
	const instance = {
		alarm(info: unknown): void {
			assert.equal(Object.isFrozen(info), true);
			invocations.push({ info, visible: scheduler.visibleAlarm(store.getRecord()) });
			if (invocations.length === 1) throw new Error("retry me");
		},
	};

	await assert.rejects(
		scheduler.dispatch(
			instance,
			{ scheduledTime: 10_000, token: "alarm" },
			0,
			firstFire,
		),
		/retry me/,
	);
	assert.deepEqual(invocations, [
		{
			info: { isRetry: false, retryCount: 0, scheduledTime: 10_000 },
			visible: null,
		},
	]);
	assert.deepEqual(store.record, { scheduledTime: 10_000, token: "alarm" });
	assert.deepEqual(schedule.events, [
		expectedAlarm("schedule-2", 10_000, "alarm", 1, 22_250),
	]);

	const retryFire = schedule.claim("schedule-2");
	await scheduler.dispatch(
		instance,
		{ scheduledTime: 10_000, token: "alarm" },
		1,
		retryFire,
	);
	assert.deepEqual(invocations[1], {
		info: { isRetry: true, retryCount: 1, scheduledTime: 10_000 },
		visible: null,
	});
	assert.equal(store.record, null);
	assert.deepEqual(schedule.events, []);
});

test("honors abort retryAlarm false without scheduling another alarm", async () => {
	const schedule = new TestSchedule();
	const store = new TestAlarmStore();
	store.set(10_000, "alarm");
	const scheduler = new DurableObjectAlarmScheduler(schedule, true, store);
	await scheduler.restore();
	const fire = schedule.claim("schedule-1");
	const error = createDurableObjectAbortError("alarm complete", false);
	await assert.rejects(
		scheduler.dispatch(
			{ alarm: () => undefined },
			{ scheduledTime: 10_000, token: "alarm" },
			0,
			fire,
			async () => {
				throw error;
			},
		),
		/alarm complete/,
	);
	assert.equal(store.record, null);
	assert.deepEqual(schedule.events, []);
});

test("runs at most one alarm handler for an object at a time", async () => {
	const schedule = new TestSchedule();
	const store = new TestAlarmStore();
	store.set(10_000, "alarm");
	const scheduler = new DurableObjectAlarmScheduler(schedule, true, store);
	await scheduler.restore();
	const fire = schedule.claim("schedule-1");
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	let active = 0;
	let maximumActive = 0;
	let calls = 0;
	const instance = {
		async alarm(): Promise<void> {
			calls += 1;
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			entered.resolve();
			await release.promise;
			active -= 1;
		},
	};
	const first = scheduler.dispatch(
		instance,
		{ scheduledTime: 10_000, token: "alarm" },
		0,
		fire,
	);
	const duplicate = scheduler.dispatch(
		instance,
		{ scheduledTime: 10_000, token: "alarm" },
		0,
		{ ...fire, id: "duplicate" },
	);
	await entered.promise;
	await Promise.resolve();
	assert.equal(calls, 1);
	release.resolve();
	await Promise.all([first, duplicate]);
	assert.equal(calls, 1);
	assert.equal(maximumActive, 1);
});

test("a replacement or deletion during a failed handler cancels the old retry", async () => {
	for (const replacement of [
		{ scheduledTime: 30_000, token: "replacement" },
		null,
	] as const) {
		const schedule = new TestSchedule();
		const store = new TestAlarmStore();
		store.set(10_000, "old");
		const scheduler = new DurableObjectAlarmScheduler(schedule, true, store);
		await scheduler.restore();
		const fire = schedule.claim("schedule-1");
		const instance = {
			async alarm(): Promise<void> {
				if (replacement === null) {
					store.delete();
					await scheduler.synchronize(null);
				} else {
					store.set(replacement.scheduledTime, replacement.token);
					await scheduler.synchronize(replacement.scheduledTime);
				}
				throw new Error("old alarm failed");
			},
		};
		await assert.rejects(
			scheduler.dispatch(
				instance,
				{ scheduledTime: 10_000, token: "old" },
				0,
				fire,
			),
			/old alarm failed/,
		);
		assert.deepEqual(store.record, replacement);
		assert.deepEqual(
			schedule.events,
			replacement === null
				? []
				: [
						expectedAlarm(
							"schedule-2",
							replacement.scheduledTime,
							replacement.token,
						),
					],
		);
	}
});

test("abandons an alarm after six retries and diagnoses a missing handler", async () => {
	for (const instance of [{}, { alarm: () => Promise.reject(new Error("final")) }]) {
		const schedule = new TestSchedule();
		const store = new TestAlarmStore();
		store.set(10_000, "alarm");
		const scheduler = new DurableObjectAlarmScheduler(schedule, true, store);
		await scheduler.restore();
		const fire = schedule.claim("schedule-1");
		await assert.rejects(
			scheduler.dispatch(
				instance,
				{ scheduledTime: 10_000, token: "alarm" },
				6,
				fire,
			),
			/alarm\(\) handler|final/,
		);
		assert.equal(store.record, null);
		assert.deepEqual(schedule.events, []);
	}
});
