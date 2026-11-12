import assert from 'node:assert';
import { DurableObject } from 'cloudflare:workers';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TestDurableObject extends DurableObject {
  log = [];
  memory = 'initial';

  note(entry) {
    this.log.push(entry);
  }

  getLog() {
    return this.log;
  }

  async awaitStorage(label) {
    this.note(`${label}-start`);
    await this.ctx.storage.put(label, 1);
    await this.ctx.storage.get(label);
    this.note(`${label}-end`);
  }

  async awaitTimer(label, ms) {
    this.note(`${label}-start`);
    await sleep(ms);
    this.note(`${label}-end`);
  }

  async critical(label, ms) {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.note(`${label}-start`);
      await sleep(ms);
      this.note(`${label}-end`);
    });
  }

  async nested() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.note('outer-start');
      await this.ctx.blockConcurrencyWhile(async () => {
        this.note('inner-start');
        await sleep(50);
        this.note('inner-end');
      });
      this.note('outer-end');
    });
  }

  async deeplyNested() {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.note('cs1-start');
      await this.ctx.blockConcurrencyWhile(async () => {
        this.note('cs2-start');
        await Promise.all([
          this.ctx.blockConcurrencyWhile(async () => {
            this.note('cs3-start');
            await sleep(30);
            this.note('cs3-end');
          }),
          this.ctx.blockConcurrencyWhile(async () => {
            this.note('cs4-start');
            await sleep(5);
            this.note('cs4-end');
          }),
        ]);
        this.note('cs2-end');
      });
      this.note('cs1-end');
    });
  }

  async setState(value) {
    this.memory = value;
    await this.ctx.storage.put('stored', value);
  }

  async getState() {
    return { memory: this.memory, stored: (await this.ctx.storage.get('stored')) ?? null };
  }

  async breakGate() {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.blockConcurrencyWhile(async () => {
        await sleep(20);
        throw new Error('foobar');
      });
    });
  }
}

function stubFor(env, name) {
  return env.ns.get(env.ns.idFromName(name));
}

// io-gate-test.c++: "InputGate basics"
export const storageAwaitHoldsInputGate = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'gate-basics-storage');
    await Promise.all([stub.awaitStorage('A'), stub.note('B')]);
    assert.deepStrictEqual(await stub.getLog(), ['A-start', 'A-end', 'B']);

    // A non-storage await releases the gate, so the queued call runs in between.
    const control = stubFor(env, 'gate-basics-timer');
    await Promise.all([control.awaitTimer('A', 100), control.note('B')]);
    assert.deepStrictEqual(await control.getLog(), ['A-start', 'B', 'A-end']);
  },
};

// io-gate-test.c++: "InputGate critical section"
export const criticalSectionBlocksOtherCalls = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'gate-critical');
    await Promise.all([stub.critical('A', 50), stub.note('B'), stub.note('C')]);
    assert.deepStrictEqual(await stub.getLog(), ['A-start', 'A-end', 'B', 'C']);
  },
};

// io-gate-test.c++: "InputGate nested critical sections"
export const nestedCriticalSections = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'gate-nested');
    await Promise.all([stub.nested(), stub.note('B')]);
    assert.deepStrictEqual(await stub.getLog(), [
      'outer-start',
      'inner-start',
      'inner-end',
      'outer-end',
      'B',
    ]);
  },
};

// io-gate-test.c++: "InputGate deeply nested critical sections"
export const deeplyNestedCriticalSections = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'gate-deeply-nested');
    await Promise.all([stub.deeplyNested(), stub.note('B')]);
    // Sibling sections cs3 and cs4 run one after the other even though cs4 sleeps less.
    assert.deepStrictEqual(await stub.getLog(), [
      'cs1-start',
      'cs2-start',
      'cs3-start',
      'cs3-end',
      'cs4-start',
      'cs4-end',
      'cs2-end',
      'cs1-end',
      'B',
    ]);
  },
};

// io-gate-test.c++: "InputGate broken"
export const throwingCriticalSectionBreaksObject = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'gate-broken');
    await stub.setState('kept');

    const results = await Promise.allSettled([
      stub.breakGate(),
      stub.note('B'),
      stub.getState(),
    ]);
    for (const result of results) {
      assert.strictEqual(result.status, 'rejected');
      assert.match(result.reason.message, /foobar/);
    }
    await assert.rejects(stub.getState(), /foobar/);

    // A new stub reaches a fresh instance: in-memory state is gone, storage survives.
    const fresh = stubFor(env, 'gate-broken');
    assert.deepStrictEqual(await fresh.getState(), { memory: 'initial', stored: 'kept' });
  },
};
