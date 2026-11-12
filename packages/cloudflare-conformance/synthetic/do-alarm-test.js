import assert from 'node:assert';
import { DurableObject } from 'cloudflare:workers';

const FAR = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Rollback extends Error {}

const scenarios = {
  // actor-sqlite-test.c++: "initial alarm value is unset", "can set and get alarm", "can clear alarm",
  // "can set alarm twice"; actor-cache-test.c++: "ActorCache alarm get/put"
  async getSetDelete(ctx) {
    const s = ctx.storage;
    assert.strictEqual(await s.getAlarm(), null);

    const t1 = Date.now() + FAR;
    await s.setAlarm(t1);
    assert.strictEqual(await s.getAlarm(), t1);

    const t2 = t1 + 1000;
    const p1 = s.setAlarm(t1 + 500);
    const p2 = s.setAlarm(t2);
    await Promise.all([p1, p2]);
    assert.strictEqual(await s.getAlarm(), t2);

    await s.setAlarm(new Date(t1));
    assert.strictEqual(await s.getAlarm(), t1);

    await s.deleteAlarm();
    assert.strictEqual(await s.getAlarm(), null);
  },

  // actor-sqlite-test.c++: "alarm write happens transactionally with storage ops",
  // "rolling back transaction leaves alarm in expected state"; actor-cache-test.c++: "ActorCache alarm get/put"
  async transactionCommitsAndRollsBackAlarm(ctx) {
    const s = ctx.storage;
    const t1 = Date.now() + FAR;
    const t2 = t1 + 1000;
    await s.setAlarm(t2);

    await s.transaction(async (txn) => {
      assert.strictEqual(await txn.getAlarm(), t2);
      await txn.setAlarm(t1);
      await txn.put('foo', 'bar');
      assert.strictEqual(await txn.getAlarm(), t1);
      txn.rollback();
    });
    assert.strictEqual(await s.getAlarm(), t2);
    assert.strictEqual(await s.get('foo'), undefined);

    await assert.rejects(
      s.transaction(async (txn) => {
        await txn.setAlarm(t1);
        await txn.put('foo', 'bar');
        throw new Rollback('boom');
      }),
      Rollback
    );
    assert.strictEqual(await s.getAlarm(), t2);
    assert.strictEqual(await s.get('foo'), undefined);

    await s.transaction(async (txn) => {
      await txn.setAlarm(t1);
      await txn.put('foo', 'bar');
    });
    assert.strictEqual(await s.getAlarm(), t1);
    assert.strictEqual(await s.get('foo'), 'bar');
    await s.deleteAlarm();
  },

  // actor-sqlite-test.c++: "getAlarm() returns null during handler",
  // "alarm handler handle clears alarm when dropped with no writes"
  async handlerSeesNullAndClearsAlarm(ctx, self) {
    const s = ctx.storage;
    const t = Date.now() + 50;
    const run = self.nextAlarm(async (info) => ({ inHandler: await s.getAlarm(), info }));
    await s.setAlarm(t);
    assert.strictEqual(await s.getAlarm(), t);
    const { inHandler, info } = await run;
    assert.strictEqual(inHandler, null);
    assert.strictEqual(info.scheduledTime, t);
    assert.strictEqual(info.isRetry, false);
    assert.strictEqual(info.retryCount, 0);
    assert.strictEqual(await s.getAlarm(), null);
  },

  // actor-sqlite-test.c++: "alarm deleter does not clear alarm when dropped with writes"
  async setAlarmInHandlerReschedules(ctx, self) {
    const s = ctx.storage;
    let next;
    const first = self.nextAlarm(async () => {
      next = Date.now() + 50;
      await s.setAlarm(next);
    });
    const second = self.nextAlarm(async (info) => info);
    await s.setAlarm(Date.now() + 50);
    await first;
    assert.strictEqual(await s.getAlarm(), next);
    const info = await second;
    assert.strictEqual(info.scheduledTime, next);
    assert.strictEqual(await s.getAlarm(), null);
    assert.strictEqual(self.runs, 2);
  },

  // actor-sqlite-test.c++: "runs overdue alarm immediately when local alarm time is in the past"
  async overdueAlarmRunsImmediately(ctx, self) {
    const s = ctx.storage;
    const past = Date.now() - 10_000;
    const run = self.nextAlarm(async (info) => info);
    await s.setAlarm(past);
    const info = await run;
    assert.strictEqual(info.isRetry, false);
    assert.strictEqual(await s.getAlarm(), null);
  },

  // actor-sqlite-test.c++: "tells alarm handler to cancel when committed alarm is empty"
  async deletedAlarmDoesNotFire(ctx, self) {
    const s = ctx.storage;
    await s.setAlarm(Date.now() + 50);
    await s.deleteAlarm();
    await sleep(300);
    assert.strictEqual(self.runs, 0);
    assert.strictEqual(await s.getAlarm(), null);
  },

  // actor-sqlite-test.c++: "tells alarm handler to reschedule when handler alarm is later than committed alarm",
  // "tells alarm handler to reschedule when handler alarm is earlier than committed alarm"
  async replacedAlarmFiresOnceAtCommittedTime(ctx, self) {
    const s = ctx.storage;

    const later = Date.now() + 200;
    let run = self.nextAlarm(async (info) => info);
    await s.setAlarm(Date.now() + 50);
    await s.setAlarm(later);
    assert.strictEqual((await run).scheduledTime, later);
    assert.strictEqual(self.runs, 1);

    const earlier = Date.now() + 50;
    run = self.nextAlarm(async (info) => info);
    await s.setAlarm(Date.now() + FAR);
    await s.setAlarm(earlier);
    assert.strictEqual((await run).scheduledTime, earlier);
    assert.strictEqual(self.runs, 2);
    assert.strictEqual(await s.getAlarm(), null);
  },

  // actor-sqlite-test.c++: "deleteAll with deleteAlarm option deletes alarm",
  // "calling deleteAll() preserves alarm state if alarm is not set";
  // actor-cache-test.c++: "ActorCache deleteAll() with deleteAlarm deletes alarm after deleteAll succeeds"
  async deleteAllDeletesAlarm(ctx, self) {
    const s = ctx.storage;
    await s.deleteAll();
    assert.strictEqual(await s.getAlarm(), null);
    await Promise.all([s.deleteAll(), s.deleteAll()]);
    assert.strictEqual(await s.getAlarm(), null);

    await s.setAlarm(Date.now() + 100);
    await s.put('k', 'v');
    await s.deleteAll();
    assert.strictEqual(await s.getAlarm(), null);
    assert.strictEqual(await s.get('k'), undefined);
    await sleep(300);
    assert.strictEqual(self.runs, 0);
  },

  // actor-sqlite-test.c++: "deleteAll deleteAlarm does not schedule alarm cancellation if setAlarm interleaves";
  // actor-cache-test.c++: "ActorCache deleteAll() with deleteAlarm does not overwrite subsequent setAlarm"
  async setAlarmAfterDeleteAllSurvives(ctx, self) {
    const s = ctx.storage;
    await s.setAlarm(Date.now() + FAR);
    const t2 = Date.now() + 100;
    const run = self.nextAlarm(async (info) => info);
    const p1 = s.deleteAll();
    const p2 = s.setAlarm(t2);
    await Promise.all([p1, p2]);
    assert.strictEqual(await s.getAlarm(), t2);
    assert.strictEqual((await run).scheduledTime, t2);
  },

  // actor-sqlite-test.c++: "deleteAll with deleteAlarm during alarm handler cancels deferred delete";
  // actor-cache-test.c++: "ActorCache deleteAll() with deleteAlarm during alarm handler cancels deferred delete"
  async deleteAllInHandlerDeletesAlarm(ctx, self) {
    const s = ctx.storage;
    const run = self.nextAlarm(async () => {
      await s.put('k', 'v');
      const before = await s.getAlarm();
      await s.deleteAll();
      return { before, after: await s.getAlarm(), k: await s.get('k') };
    });
    await s.setAlarm(Date.now() + 50);
    assert.deepStrictEqual(await run, { before: null, after: null, k: undefined });
    assert.strictEqual(await s.getAlarm(), null);
    await sleep(200);
    assert.strictEqual(self.runs, 1);
  },

  // actor-sqlite-test.c++: "rolling back transaction leaves deferred alarm deletion in expected state"
  async rolledBackSetAlarmInHandlerKeepsDeletion(ctx, self) {
    const s = ctx.storage;
    const run = self.nextAlarm(async () => {
      const seen = [];
      await s.transaction(async (txn) => {
        seen.push(await txn.getAlarm());
        await txn.setAlarm(Date.now() + 50);
        seen.push(typeof (await txn.getAlarm()));
        txn.rollback();
      });
      seen.push(await s.getAlarm());
      return seen;
    });
    await s.setAlarm(Date.now() + 50);
    assert.deepStrictEqual(await run, [null, 'number', null]);
    assert.strictEqual(await s.getAlarm(), null);
    await sleep(200);
    assert.strictEqual(self.runs, 1);
  },

  // actor-sqlite-test.c++: "committing transaction leaves deferred alarm deletion in expected state"
  async committedSetAlarmInHandlerSurvives(ctx, self) {
    const s = ctx.storage;
    let next;
    const first = self.nextAlarm(async () => {
      next = Date.now() + 50;
      await s.transaction(async (txn) => {
        assert.strictEqual(await txn.getAlarm(), null);
        await txn.setAlarm(next);
      });
      return s.getAlarm();
    });
    const second = self.nextAlarm(async (info) => info);
    await s.setAlarm(Date.now() + 50);
    assert.strictEqual(await first, next);
    assert.strictEqual((await second).scheduledTime, next);
    assert.strictEqual(await s.getAlarm(), null);
  },

  // actor-sqlite-test.c++: "rolling back nested transaction leaves deferred alarm deletion in expected state"
  async rolledBackNestedSetAlarmInHandlerKeepsDeletion(ctx, self) {
    const s = ctx.storage;
    const run = self.nextAlarm(async () => {
      const x = Date.now() + FAR;
      const seen = [];
      await s.transaction(async (t1) => {
        seen.push(await t1.getAlarm());
        await s.transaction(async (t2) => {
          await t2.setAlarm(x);
          seen.push(await t2.getAlarm());
          t2.rollback();
        });
        seen.push(await t1.getAlarm());
        await s.transaction(async (t3) => {
          await t3.setAlarm(x);
        });
        seen.push(await t1.getAlarm());
        await s.transaction(async (t4) => {
          t4.rollback();
        });
        seen.push(await t1.getAlarm());
        t1.rollback();
      });
      seen.push(await s.getAlarm());
      return seen.map((v) => (v === x ? 'x' : v));
    });
    await s.setAlarm(Date.now() + 50);
    assert.deepStrictEqual(await run, [null, 'x', null, 'x', 'x', null]);
    assert.strictEqual(await s.getAlarm(), null);
    await sleep(200);
    assert.strictEqual(self.runs, 1);
  },

  // actor-sqlite-test.c++: "can cancel deferred alarm deletion during handler";
  // alarm-retry-test.c++: "alarmRetryCountsAgainstLimit: failures without a broken output gate always count"
  async throwingHandlerIsRetried(ctx, self) {
    const s = ctx.storage;
    const t = Date.now() + 50;
    const first = self.nextAlarm(async (info) => {
      self.failNext = true;
      return info;
    });
    const second = self.nextAlarm(async (info) => info);
    await s.setAlarm(t);

    const info1 = await first;
    assert.strictEqual(info1.isRetry, false);
    assert.strictEqual(info1.retryCount, 0);

    // Polling because the failed handler's alarm state settles after the handler returns, and there is no event for it.
    let stored = null;
    for (let i = 0; i < 50 && stored === null; i++) {
      await sleep(20);
      stored = await s.getAlarm();
    }
    assert.strictEqual(stored, t);

    const info2 = await second;
    assert.strictEqual(info2.scheduledTime, t);
    assert.strictEqual(info2.isRetry, true);
    assert.strictEqual(info2.retryCount, 1);
    assert.strictEqual(await s.getAlarm(), null);
  },

  // alarm-scheduler-test.c++: "AlarmScheduler restores the persisted actor_name onto the ActorKey when an alarm fires"
  async idNameVisibleInAlarm(ctx, self, name) {
    const run = self.nextAlarm(async () => ctx.id.name);
    await ctx.storage.setAlarm(Date.now() + 50);
    assert.strictEqual(await run, name);
  },
};

export class TestDurableObject extends DurableObject {
  runs = 0;
  failNext = false;
  pending = [];

  // Registers a handler for the next alarm run and returns a promise for its result.
  nextAlarm(handler) {
    const { promise, resolve, reject } = Promise.withResolvers();
    this.pending.push({ handler, resolve, reject });
    return promise;
  }

  async alarm(info) {
    this.runs++;
    const entry = this.pending.shift();
    if (entry === undefined) return;
    try {
      entry.resolve(await entry.handler(info));
    } catch (e) {
      entry.reject(e);
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error('alarm handler failure');
    }
  }

  async run(name, arg) {
    await scenarios[name](this.ctx, this, arg);
  }

  async getAlarm() {
    return this.ctx.storage.getAlarm();
  }

  async getRuns() {
    return this.runs;
  }

  // Schedules an alarm whose handler signals `signalName` and then aborts without retry.
  async armAbort(signalName) {
    this.nextAlarm(async () => {
      await this.env.ns.get(this.env.ns.idFromName(signalName)).signal();
      this.ctx.abort('stop', { retryAlarm: false });
    });
    const t = Date.now() + 50;
    await this.ctx.storage.setAlarm(t);
    return t;
  }

  async setAlarmAndWait(delay) {
    const run = this.nextAlarm(async (info) => info);
    const t = Date.now() + delay;
    await this.ctx.storage.setAlarm(t);
    assert.strictEqual(await this.ctx.storage.getAlarm(), t);
    const info = await run;
    return { t, scheduledTime: info.scheduledTime, after: await this.ctx.storage.getAlarm() };
  }

  signal() {
    this.signalled ??= Promise.withResolvers();
    this.signalled.resolve();
  }

  async waitSignal() {
    this.signalled ??= Promise.withResolvers();
    await this.signalled.promise;
  }
}

function stub(env, name) {
  return env.ns.get(env.ns.idFromName(name));
}

function scenarioTest(name) {
  return {
    async test(ctrl, env) {
      const doName = `do-alarm-${name}`;
      await stub(env, doName).run(name, doName);
    },
  };
}

// Calls `fn` with a fresh stub, retrying while the aborted instance is still being torn down.
async function withFreshStub(env, name, fn) {
  let lastError;
  for (let i = 0; i < 50; i++) {
    try {
      return await fn(stub(env, name));
    } catch (e) {
      lastError = e;
      await sleep(20);
    }
  }
  throw lastError;
}

export const getSetDelete = scenarioTest('getSetDelete');
export const transactionCommitsAndRollsBackAlarm = scenarioTest('transactionCommitsAndRollsBackAlarm');
export const handlerSeesNullAndClearsAlarm = scenarioTest('handlerSeesNullAndClearsAlarm');
export const setAlarmInHandlerReschedules = scenarioTest('setAlarmInHandlerReschedules');
export const overdueAlarmRunsImmediately = scenarioTest('overdueAlarmRunsImmediately');
export const deletedAlarmDoesNotFire = scenarioTest('deletedAlarmDoesNotFire');
export const replacedAlarmFiresOnceAtCommittedTime = scenarioTest('replacedAlarmFiresOnceAtCommittedTime');
export const deleteAllDeletesAlarm = scenarioTest('deleteAllDeletesAlarm');
export const setAlarmAfterDeleteAllSurvives = scenarioTest('setAlarmAfterDeleteAllSurvives');
export const deleteAllInHandlerDeletesAlarm = scenarioTest('deleteAllInHandlerDeletesAlarm');
export const rolledBackSetAlarmInHandlerKeepsDeletion = scenarioTest('rolledBackSetAlarmInHandlerKeepsDeletion');
export const committedSetAlarmInHandlerSurvives = scenarioTest('committedSetAlarmInHandlerSurvives');
export const rolledBackNestedSetAlarmInHandlerKeepsDeletion = scenarioTest(
  'rolledBackNestedSetAlarmInHandlerKeepsDeletion'
);
export const throwingHandlerIsRetried = scenarioTest('throwingHandlerIsRetried');
export const idNameVisibleInAlarm = scenarioTest('idNameVisibleInAlarm');

// actor-cache-test.c++: "ActorCache alarm cleared by abandonAlarm"; actor-sqlite-test.c++: "ActorSqlite alarm cleared by abandonAlarm";
// alarm-scheduler-test.c++: "AlarmScheduler abandons an alarm when ctx.abort() sets retryAlarm to false"
export const abortWithoutRetryClearsAlarm = {
  async test(ctrl, env) {
    const name = 'do-alarm-abortWithoutRetryClearsAlarm';
    const signalName = `${name}-signal`;
    await stub(env, name).armAbort(signalName);
    await stub(env, signalName).waitSignal();

    // Polling because the runtime clears the abandoned alarm after the aborted handler ends, with no event for it.
    let stored;
    for (let i = 0; i < 75; i++) {
      stored = await withFreshStub(env, name, (s) => s.getAlarm());
      if (stored === null) break;
      await sleep(20);
    }
    assert.strictEqual(stored, null);
  },
};

// actor-cache-test.c++: "ActorCache abandonAlarm is a no-op when a newer alarm has replaced the abandoned one";
// actor-sqlite-test.c++: "ActorSqlite abandonAlarm is a no-op when a newer alarm has replaced the abandoned one";
// alarm-scheduler-test.c++: "AlarmScheduler preserves an alarm queued while abandonment is pending"
export const alarmSetAfterAbortSurvivesAbandon = {
  async test(ctrl, env) {
    const name = 'do-alarm-alarmSetAfterAbortSurvivesAbandon';
    const signalName = `${name}-signal`;
    await stub(env, name).armAbort(signalName);
    await stub(env, signalName).waitSignal();

    const result = await withFreshStub(env, name, (s) => s.setAlarmAndWait(100));
    assert.strictEqual(result.scheduledTime, result.t);
    assert.strictEqual(result.after, null);
  },
};
