import assert from 'node:assert';
import { DurableObject } from 'cloudflare:workers';

export class TestDurableObject extends DurableObject {
  events = [];
  waiters = [];

  async fetch(req) {
    const tags = new URL(req.url).searchParams.getAll('tag');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[0], tags);
    return new Response(null, { status: 101, webSocket: pair[1] });
  }

  record(event) {
    this.events.push(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  webSocketMessage(ws, message) {
    if (typeof message === 'string') {
      this.record({ type: 'message', data: message });
      if (message === 'close-me') ws.close(1001, 'already-closing');
    } else {
      this.record({ type: 'binary', data: Array.from(new Uint8Array(message)) });
    }
  }

  webSocketClose(ws, code, reason) {
    this.record({ type: 'close', code, reason });
    ws.close(code, reason);
  }

  webSocketError(ws, error) {
    this.record({ type: 'error', message: String(error) });
  }

  async waitEvents(n) {
    while (this.events.length < n) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    return this.events;
  }

  count(tag) {
    return this.ctx.getWebSockets(tag).length;
  }

  send(tag, data) {
    for (const ws of this.ctx.getWebSockets(tag)) ws.send(data);
  }

  sendBinary(tag, bytes) {
    for (const ws of this.ctx.getWebSockets(tag)) ws.send(new Uint8Array(bytes));
  }

  close(tag, code, reason) {
    for (const ws of this.ctx.getWebSockets(tag)) ws.close(code, reason);
  }

  setAutoResponse(request, response) {
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(request, response)
    );
  }

  autoResponseTimestamp(tag) {
    const ws = this.ctx.getWebSockets(tag)[0];
    return this.ctx.getWebSocketAutoResponseTimestamp(ws);
  }
}

// Client side ("eyeball"). Messages arrive in `inbox`; `next()` resolves with the next one.
async function connect(stub, tags = []) {
  const qs = tags.map((t) => `tag=${encodeURIComponent(t)}`).join('&');
  const resp = await stub.fetch(`http://x/ws?${qs}`, {
    headers: { Upgrade: 'websocket' },
  });
  assert.strictEqual(resp.status, 101);
  const ws = resp.webSocket;
  ws.accept();
  const inbox = [];
  const waiters = [];
  const push = (item) => {
    inbox.push(item);
    for (const wake of waiters.splice(0)) wake();
  };
  ws.addEventListener('message', (e) => push({ type: 'message', data: e.data }));
  const closed = new Promise((resolve) => {
    ws.addEventListener('close', (e) => {
      const item = { type: 'close', code: e.code, reason: e.reason };
      push(item);
      resolve(item);
    });
  });
  let read = 0;
  const next = async () => {
    while (inbox.length <= read) {
      await new Promise((resolve) => waiters.push(resolve));
    }
    return inbox[read++];
  };
  return { ws, inbox, next, closed };
}

async function hangUp(client) {
  client.ws.close(1000, 'done');
  await client.closed;
}

function stubFor(env, name) {
  return env.ns.get(env.ns.idFromName(name));
}

// hibernation-manager-test.c++: "HibernationManager: smoke (create, accept, query)"
export const acceptedWebSocketIsListed = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-smoke');
    const client = await connect(stub);
    assert.strictEqual(await stub.count(), 1);
    await hangUp(client);
  },
};

// hibernation-manager-test.c++: "HibernationManager: DO sends string message to eyeball"
export const doSendsStringToClient = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-do-send-string');
    const client = await connect(stub);
    await stub.send(undefined, 'hello');
    assert.deepStrictEqual(await client.next(), { type: 'message', data: 'hello' });
    await hangUp(client);
  },
};

// hibernation-manager-test.c++: "HibernationManager: eyeball sends non-auto-response message → dispatched to worker"
export const clientStringDispatchedToHandler = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-eyeball-send');
    const client = await connect(stub);
    client.ws.send('hello from eyeball');
    assert.deepStrictEqual(await stub.waitEvents(1), [
      { type: 'message', data: 'hello from eyeball' },
    ]);
    await hangUp(client);
  },
};

// hibernation-manager-test.c++: "HibernationManager: DO close sends close frame to eyeball"
export const doCloseSendsCloseFrame = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-do-close');
    const client = await connect(stub);
    await stub.close(undefined, 1001, 'bye');
    const close = await client.closed;
    assert.strictEqual(close.code, 1001);
    assert.strictEqual(close.reason, 'bye');
  },
};

// hibernation-manager-test.c++: "HibernationManager: eyeball close dispatches webSocketClose to worker"
export const clientCloseDispatchedToHandler = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-eyeball-close');
    const client = await connect(stub);
    client.ws.close(1001, 'eyeball bye');
    const events = await stub.waitEvents(1);
    assert.deepStrictEqual(events[0], {
      type: 'close',
      code: 1001,
      reason: 'eyeball bye',
    });
    await client.closed;
  },
};

// hibernation-manager-test.c++: "HibernationManager: DO sends binary message to eyeball"
export const doSendsBinaryToClient = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-do-send-bin');
    const client = await connect(stub);
    await stub.sendBinary(undefined, [0xde, 0xad, 0xbe, 0xef]);
    const msg = await client.next();
    assert.notStrictEqual(typeof msg.data, 'string');
    // The payload is a Blob or ArrayBuffer depending on binaryType defaults.
    const bytes = new Uint8Array(await new Response(msg.data).arrayBuffer());
    assert.deepStrictEqual(Array.from(bytes), [0xde, 0xad, 0xbe, 0xef]);
    await hangUp(client);
  },
};

// hibernation-manager-test.c++: "HibernationManager: eyeball sends binary message → dispatched to worker"
export const clientBinaryDispatchedToHandler = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-eyeball-send-bin');
    const client = await connect(stub);
    client.ws.send(new Uint8Array([0xca, 0xfe, 0xba, 0xbe]));
    assert.deepStrictEqual(await stub.waitEvents(1), [
      { type: 'binary', data: [0xca, 0xfe, 0xba, 0xbe] },
    ]);
    await hangUp(client);
  },
};

// hibernation-manager-test.c++: "HibernationManager: multiple tagged WebSockets are addressable independently"
export const taggedWebSocketsAddressedIndependently = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-multi');
    const alice = await connect(stub, ['alice']);
    const bob = await connect(stub, ['bob']);
    assert.strictEqual(await stub.count(), 2);
    assert.strictEqual(await stub.count('alice'), 1);
    assert.strictEqual(await stub.count('bob'), 1);

    await stub.send('alice', 'for-alice');
    assert.deepStrictEqual(await alice.next(), { type: 'message', data: 'for-alice' });
    await stub.send('bob', 'for-bob');
    // Bob's first message proves the alice-scoped send did not reach him.
    assert.deepStrictEqual(await bob.next(), { type: 'message', data: 'for-bob' });

    await hangUp(alice);
    await hangUp(bob);
  },
};

// hibernation-manager-test.c++: "HibernationManager: auto-response request not dispatched to worker (active)"
export const autoResponseNotDispatchedToHandler = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-autoresp-active');
    await stub.setAutoResponse('ping', 'pong');
    const client = await connect(stub);
    assert.strictEqual(await stub.autoResponseTimestamp(), null);

    client.ws.send('ping');
    assert.deepStrictEqual(await client.next(), { type: 'message', data: 'pong' });
    assert.ok((await stub.autoResponseTimestamp()) instanceof Date);

    // Messages are dispatched in order, so once the marker arrives the ping would have too.
    client.ws.send('marker');
    assert.deepStrictEqual(await stub.waitEvents(1), [{ type: 'message', data: 'marker' }]);
    await hangUp(client);
  },
};

// hibernation-manager-test.c++: "HibernationManager: auto-response interleaved with DO sends (active)"
export const autoResponseInterleavedWithDoSends = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-autoresp-interleaved');
    await stub.setAutoResponse('ping', 'pong');
    const client = await connect(stub);

    await stub.send(undefined, 'before');
    client.ws.send('ping');
    await stub.send(undefined, 'after');

    const got = [];
    for (let i = 0; i < 3; i++) {
      const msg = await client.next();
      assert.strictEqual(msg.type, 'message');
      got.push(msg.data);
    }
    assert.deepStrictEqual(got.sort(), ['after', 'before', 'pong']);

    client.ws.send('marker');
    assert.deepStrictEqual(await stub.waitEvents(1), [{ type: 'message', data: 'marker' }]);
    await hangUp(client);
  },
};

// hibernation-manager-test.c++: "HibernationManager: auto-response is skipped after close is queued"
export const autoResponseSkippedAfterClose = {
  async test(ctrl, env) {
    const stub = stubFor(env, 'ws-autoresp-after-close');
    await stub.setAutoResponse('ping', 'pong');
    const client = await connect(stub);

    // The handler for 'close-me' queues a close; the ping arrives right behind it.
    client.ws.send('close-me');
    client.ws.send('ping');

    const close = await client.closed;
    assert.strictEqual(close.code, 1001);
    assert.strictEqual(close.reason, 'already-closing');
    assert.deepStrictEqual(
      client.inbox.filter((m) => m.type === 'message'),
      []
    );
    const events = await stub.waitEvents(1);
    assert.ok(!events.some((e) => e.data === 'ping'));
  },
};
