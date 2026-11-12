import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { DurableObject } from 'cloudflare:workers';

// Workerd evicts an object whose only connections are hibernatable WebSockets
// after ten idle seconds. Each test proves eviction by observing a new
// constructor id, so a missed eviction fails instead of passing vacuously.
const hibernationWaitMs = 12_000;

export class TestDurableObject extends DurableObject {
  instance = crypto.randomUUID();
  closeWaiters = [];

  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS closes (tag TEXT, code INTEGER, reason TEXT, clean INTEGER, listed INTEGER)'
    );
  }

  async fetch(req) {
    const tags = new URL(req.url).searchParams.getAll('tag');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0], tags);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  webSocketClose(ws, code, reason, wasClean) {
    const listed = this.ctx.getWebSockets().includes(ws);
    this.ctx.storage.sql.exec(
      'INSERT INTO closes VALUES (?, ?, ?, ?, ?)',
      this.ctx.getTags(ws)[0],
      code,
      reason,
      wasClean ? 1 : 0,
      listed ? 1 : 0
    );
    for (const wake of this.closeWaiters.splice(0)) wake();
    ws.close(1000, 'server done');
  }

  closes() {
    return this.ctx.storage.sql
      .exec('SELECT tag, code, reason, clean, listed FROM closes ORDER BY tag')
      .toArray()
      .map((row) => ({
        tag: row.tag,
        code: row.code,
        reason: row.reason,
        wasClean: row.clean === 1,
        listed: row.listed === 1,
      }));
  }

  // Resolves once `count` webSocketClose events ran, without polling.
  async waitForCloses(count) {
    while (this.closes().length < count) {
      await new Promise((resolve) => this.closeWaiters.push(resolve));
    }
    return this.closes();
  }

  info() {
    return {
      instance: this.instance,
      tags: this.ctx
        .getWebSockets()
        .flatMap((ws) => this.ctx.getTags(ws))
        .sort(),
    };
  }
}

async function connect(stub, tag) {
  const resp = await stub.fetch(`http://x/ws?tag=${tag}`, {
    headers: { Upgrade: 'websocket' },
  });
  assert.strictEqual(resp.status, 101);
  const ws = resp.webSocket;
  ws.accept();
  return ws;
}

function stubFor(env, name) {
  return env.ns.get(env.ns.idFromName(name));
}

async function hibernate(stub, before) {
  await delay(hibernationWaitMs);
  const after = await stub.info();
  assert.notStrictEqual(after.instance, before.instance, 'object did not hibernate');
  return after;
}

function tagsAndListing(closes) {
  return closes.map(({ tag, listed }) => ({ tag, listed }));
}

// hibernation-manager-test.c++: "HibernationManager: eyeball close dispatches webSocketClose to worker"
// The socket survives one eviction, so its connection is durable before the
// client closes it. Workerd runs webSocketClose while the socket is still
// listed, then drops it for good.
export const closedSocketIsNotRestoredAfterHibernation = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-closed-while-awake');
    const gone = await connect(stub, 'gone');
    const kept = await connect(stub, 'kept');
    const connected = await stub.info();
    assert.deepStrictEqual(connected.tags, ['gone', 'kept']);
    const woken = await hibernate(stub, connected);
    assert.deepStrictEqual(woken.tags, ['gone', 'kept']);

    gone.close(1000, 'bye');
    assert.deepStrictEqual(tagsAndListing(await stub.waitForCloses(1)), [
      { tag: 'gone', listed: true },
    ]);
    assert.deepStrictEqual((await stub.info()).tags, ['kept']);

    const rewoken = await hibernate(stub, woken);
    assert.deepStrictEqual(rewoken.tags, ['kept']);
    kept.close(1000, 'done');
  },
};

// hibernation-manager-test.c++: "HibernationManager: delivering one event leaves other hibernated WebSockets registered"
// Two clients close concurrently while the object is evicted. Each close runs
// webSocketClose once, the third socket stays registered, and neither closed
// socket returns after the next eviction.
export const socketsClosedWhileHibernatedAreDropped = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-closed-while-hibernated');
    const first = await connect(stub, 'first');
    const second = await connect(stub, 'second');
    const kept = await connect(stub, 'kept');
    const connected = await stub.info();
    assert.deepStrictEqual(connected.tags, ['first', 'kept', 'second']);

    await delay(hibernationWaitMs);
    first.close(1000, 'one');
    second.close(1000, 'two');
    assert.deepStrictEqual(tagsAndListing(await stub.waitForCloses(2)), [
      { tag: 'first', listed: true },
      { tag: 'second', listed: true },
    ]);
    const woken = await stub.info();
    assert.notStrictEqual(woken.instance, connected.instance, 'object did not hibernate');
    assert.deepStrictEqual(woken.tags, ['kept']);

    const rewoken = await hibernate(stub, woken);
    assert.deepStrictEqual(rewoken.tags, ['kept']);
    kept.close(1000, 'done');
  },
};

// hibernation-manager-test.c++: "HibernationManager: eyeball close dispatches webSocketClose to worker"
// A close frame sent while the object is evicted reaches webSocketClose with
// the client's code and reason.
export const closeWhileHibernatedKeepsCodeAndReason = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-close-code-while-hibernated');
    const client = await connect(stub, 'client');
    const connected = await stub.info();

    await delay(hibernationWaitMs);
    client.close(4000, 'going away');
    const closes = await stub.waitForCloses(1);
    assert.notStrictEqual((await stub.info()).instance, connected.instance, 'object did not hibernate');
    assert.deepStrictEqual(closes, [
      { tag: 'client', code: 4000, reason: 'going away', wasClean: true, listed: true },
    ]);
  },
};
