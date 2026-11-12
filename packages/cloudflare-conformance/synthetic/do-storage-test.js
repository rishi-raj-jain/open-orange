import { DurableObject } from 'cloudflare:workers';
import assert from 'node:assert';

const entries = (map) => [...map];
const obj = (map) => Object.fromEntries(map);

const scenarios = {
  // actor-cache-test.c++: "ActorCache single-key basics", "ActorCache more puts", "ActorCache more deletes"
  async singleKeyBasics(s) {
    await s.put('foo', 'bar');
    assert.strictEqual(await s.get('foo'), 'bar');
    assert.strictEqual(await s.get('bar'), undefined);

    await s.put('foo', 'bar');
    assert.strictEqual(await s.get('foo'), 'bar');
    await s.put('foo', 'baz');
    assert.strictEqual(await s.get('foo'), 'baz');

    const deleted = s.delete('foo');
    assert.strictEqual(await s.get('foo'), undefined);
    assert.strictEqual(await deleted, true);
    assert.strictEqual(await s.delete('bar'), false);
    assert.strictEqual(await s.delete('foo'), false);

    await s.put('foo', 'baz');
    assert.strictEqual(await s.get('foo'), 'baz');
    assert.strictEqual(await s.delete('foo'), true);
    assert.strictEqual(await s.get('foo'), undefined);
  },

  // actor-cache-test.c++: "ActorCache multi-key basics", "ActorCache more multi-puts",
  // "ActorCache more multi-deletes", "ActorCache get-multiple multiple blocks"
  async multiKeyBasics(s) {
    await s.put({ bar: '456', foo: '123' });
    assert.deepStrictEqual(obj(await s.get(['foo', 'bar', 'baz', 'qux'])), {
      bar: '456',
      foo: '123',
    });

    await s.put({ foo: '321', bar: '654' });
    assert.deepStrictEqual(obj(await s.get(['foo', 'bar'])), { bar: '654', foo: '321' });

    await s.put({ foo: '321', bar: '654', baz: '654', corge: '987' });
    assert.deepStrictEqual(
      obj(await s.get(['foo', 'bar', 'baz', 'qux', 'corge', 'grault'])),
      { bar: '654', baz: '654', corge: '987', foo: '321' }
    );

    await s.put('garply', 'abcd');
    assert.strictEqual(await s.delete(['bar', 'qux', 'corge', 'grault']), 2);
    assert.deepStrictEqual(
      obj(await s.get(['foo', 'bar', 'baz', 'qux', 'corge', 'grault', 'garply'])),
      { baz: '654', foo: '321', garply: 'abcd' }
    );

    assert.strictEqual(await s.delete(['foo', 'baz', 'garply', 'qux']), 3);
    assert.deepStrictEqual(obj(await s.get(['foo', 'bar', 'baz'])), {});
  },

  // sqlite-kv-test.c++: "SQLite-KV"
  async sqliteKvListMatrix(s) {
    await s.put({ foo: 'abc', bar: 'def', baz: '123', qux: '321' });
    assert.strictEqual(await s.get('foo'), 'abc');
    assert.strictEqual(await s.get('bar'), 'def');
    assert.strictEqual(await s.get('corge'), undefined);

    const list = async (opts) =>
      entries(await s.list(opts))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');

    assert.strictEqual(await list({}), 'bar=def, baz=123, foo=abc, qux=321');
    assert.strictEqual(await list({ start: 'cat' }), 'foo=abc, qux=321');
    assert.strictEqual(await list({ start: 'foo' }), 'foo=abc, qux=321');
    assert.strictEqual(await list({ start: 'fop' }), 'qux=321');
    assert.strictEqual(await list({ start: 'foo ' }), 'qux=321');

    assert.strictEqual(await list({ end: 'cat' }), 'bar=def, baz=123');
    assert.strictEqual(await list({ end: 'foo' }), 'bar=def, baz=123');
    assert.strictEqual(await list({ end: 'fop' }), 'bar=def, baz=123, foo=abc');

    assert.strictEqual(await list({ limit: 2 }), 'bar=def, baz=123');
    assert.strictEqual(await list({ limit: 3 }), 'bar=def, baz=123, foo=abc');
    assert.strictEqual(await list({ start: 'baz', limit: 2 }), 'baz=123, foo=abc');
    assert.strictEqual(await list({ end: 'foo', limit: 1 }), 'bar=def');
    assert.strictEqual(await list({ end: 'foo', limit: 2 }), 'bar=def, baz=123');
    assert.strictEqual(await list({ end: 'foo', limit: 3 }), 'bar=def, baz=123');

    assert.strictEqual(await list({ reverse: true }), 'qux=321, foo=abc, baz=123, bar=def');
    assert.strictEqual(await list({ start: 'foo', reverse: true }), 'qux=321, foo=abc');
    assert.strictEqual(await list({ end: 'foo', reverse: true }), 'baz=123, bar=def');
    assert.strictEqual(await list({ limit: 2, reverse: true }), 'qux=321, foo=abc');
    assert.strictEqual(await list({ end: 'foo', limit: 1, reverse: true }), 'baz=123');

    assert.strictEqual(await s.delete('baz'), true);
    assert.strictEqual(await s.delete('corge'), false);
    assert.strictEqual(await list({}), 'bar=def, foo=abc, qux=321');

    await s.put('foo', 'hello');
    assert.strictEqual(await list({}), 'bar=def, foo=hello, qux=321');

    await s.deleteAll();
    assert.strictEqual(await list({}), '');
    assert.strictEqual(await s.get('bar'), undefined);

    await s.put('bar', 'ghi');
    await s.put('corge', 'garply');
    assert.strictEqual(await list({}), 'bar=ghi, corge=garply');
    assert.strictEqual(await s.get('bar'), 'ghi');
  },

  // actor-cache-test.c++: "ActorCache deleteAll()"
  async deleteAllWithPendingWrites(s) {
    await s.put({ bar: 'b', baz: 'z', corge: '555' });

    s.put('foo', '123');
    const counted = s.delete(['bar', 'baz', 'grault']);
    s.put('baz', '789');
    s.delete('garply');
    const deleteAll = s.deleteAll();
    s.put('grault', '12345');
    s.put('garply', '54321');
    s.put('waldo', '99999');

    for (const key of ['foo', 'baz', 'corge', 'bar', 'a', 'z', '']) {
      assert.strictEqual(await s.get(key), undefined, key);
    }
    assert.strictEqual(await s.get('grault'), '12345');
    assert.strictEqual(await s.get('garply'), '54321');
    assert.strictEqual(await s.get('waldo'), '99999');

    await deleteAll;
    assert.strictEqual(await counted, 2);
    assert.deepStrictEqual(entries(await s.list()), [
      ['garply', '54321'],
      ['grault', '12345'],
      ['waldo', '99999'],
    ]);
  },

  // actor-cache-test.c++: "ActorCache deleteAll() during transaction commit"
  async deleteAllDuringFlush(s) {
    s.put('foo', '123');
    s.put('bar', '456');
    await s.deleteAll();
    assert.deepStrictEqual(entries(await s.list()), []);
    await s.put('after', '1');
    assert.deepStrictEqual(entries(await s.list()), [['after', '1']]);
  },

  // actor-cache-test.c++: "ActorCache deleteAll() again when previous one isn't done yet"
  async deleteAllTwice(s) {
    await s.put({ bar: 'b', baz: 'z', corge: '555' });
    s.put('foo', '123');
    const counted = s.delete(['bar', 'baz', 'grault']);
    s.put('baz', '789');
    s.delete('garply');
    const a = s.deleteAll();
    s.put('grault', '12345');
    s.put('garply', '54321');
    s.put('waldo', '99999');
    const b = s.deleteAll();
    s.put('fred', '2323');
    await Promise.all([a, b]);
    assert.strictEqual(await counted, 2);
    assert.deepStrictEqual(entries(await s.list()), [['fred', '2323']]);
  },

  // actor-cache-test.c++: "ActorCache get-put ordering"
  async getPutOrdering(s) {
    await s.put({ foo: '321', bar: '654', baz: '987' });

    const p1 = s.get(['foo', 'bar', 'baz']);
    s.put('foo', '123');
    const del = s.delete('bar');
    const p2 = s.get(['foo', 'bar', 'baz']);
    s.put('bar', '456');

    assert.deepStrictEqual(obj(await p1), { bar: '654', baz: '987', foo: '321' });
    assert.deepStrictEqual(obj(await p2), { baz: '987', foo: '123' });
    assert.strictEqual(await del, true);
    assert.deepStrictEqual(obj(await s.get(['foo', 'bar', 'baz'])), {
      bar: '456',
      baz: '987',
      foo: '123',
    });
  },

  // actor-cache-test.c++: "ActorCache put during flush"
  async putDuringFlush(s) {
    const first = s.put({ foo: '123', bar: '456' });
    s.put('bar', '654');
    await first;
    assert.strictEqual(await s.get('foo'), '123');
    assert.strictEqual(await s.get('bar'), '654');
    await s.sync();
    assert.strictEqual(await s.get('bar'), '654');
  },

  // actor-cache-test.c++: "ActorCache list()", "ActorCache list() all", "ActorCache list() with limit",
  // "ActorCache list() start point is not present", "ActorCache list() multiple ranges",
  // "ActorCache get() of endpoint of previous list() returning negative is cached correctly"
  async listForward(s) {
    await s.put({ bar: '456', baz: '789', foo: '123', qux: '555' });
    const three = [
      ['bar', '456'],
      ['baz', '789'],
      ['foo', '123'],
    ];

    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux' })), three);
    assert.strictEqual(await s.get('bara'), undefined);
    assert.strictEqual(await s.get('corge'), undefined);
    for (const [limit, n] of [[1, 1], [2, 2], [3, 3], [4, 3], [1000, 3]]) {
      assert.deepStrictEqual(
        entries(await s.list({ start: 'bar', end: 'qux', limit })),
        three.slice(0, n)
      );
    }
    assert.strictEqual(await s.get('qux'), '555');

    assert.deepStrictEqual(entries(await s.list()), [...three, ['qux', '555']]);
    assert.deepStrictEqual(entries(await s.list({ start: 'baz' })), [
      ['baz', '789'],
      ['foo', '123'],
      ['qux', '555'],
    ]);
    assert.deepStrictEqual(entries(await s.list({ end: 'foo' })), three.slice(0, 2));
    assert.deepStrictEqual(entries(await s.list({ prefix: 'ba' })), three.slice(0, 2));

    await s.put('garply', '54321');
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux', limit: 3 })), three);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux', limit: 4 })), [
      ...three,
      ['garply', '54321'],
    ]);

    assert.deepStrictEqual(entries(await s.list({ start: 'bara', end: 'qux' })), [
      ['baz', '789'],
      ['foo', '123'],
      ['garply', '54321'],
    ]);

    await s.deleteAll();
    await s.put({ a: '1', b: '2', y: '9' });
    assert.deepStrictEqual(entries(await s.list({ start: 'a', end: 'c' })), [
      ['a', '1'],
      ['b', '2'],
    ]);
    assert.deepStrictEqual(entries(await s.list({ start: 'x', end: 'z' })), [['y', '9']]);
    assert.strictEqual(await s.get('w'), undefined);
    assert.strictEqual(await s.get('c'), undefined);

    assert.deepStrictEqual(entries(await s.list({ start: 'h', end: 'p', limit: 4 })), []);
    assert.strictEqual(await s.get('p'), undefined);
  },

  // actor-cache-test.c++: "ActorCache listReverse()", "ActorCache listReverse() all",
  // "ActorCache listReverse() with limit", "ActorCache listReverse() start point is not present",
  // "ActorCache listReverse() multiple ranges"
  async listReverse(s) {
    await s.put({ bar: '456', baz: '789', foo: '123', qux: '555' });
    const three = [
      ['foo', '123'],
      ['baz', '789'],
      ['bar', '456'],
    ];
    const rev = async (opts) => entries(await s.list({ ...opts, reverse: true }));

    assert.deepStrictEqual(await rev({ start: 'abc', end: 'qux' }), three);
    for (const [limit, n] of [[1, 1], [2, 2], [3, 3], [4, 3]]) {
      assert.deepStrictEqual(await rev({ start: 'bar', end: 'qux', limit }), three.slice(0, n));
    }
    assert.deepStrictEqual(await rev({}), [['qux', '555'], ...three]);
    assert.deepStrictEqual(await rev({ start: 'baz' }), [
      ['qux', '555'],
      ['foo', '123'],
      ['baz', '789'],
    ]);
    assert.deepStrictEqual(await rev({ end: 'foo' }), three.slice(1));

    await s.put('baa', 'xyz');
    assert.deepStrictEqual(await rev({ start: 'abc', end: 'qux', limit: 3 }), three);
    assert.deepStrictEqual(await rev({ start: 'abc', end: 'qux', limit: 4 }), [
      ...three,
      ['baa', 'xyz'],
    ]);
    assert.deepStrictEqual(await rev({ start: 'bara', end: 'qux' }), three.slice(0, 2));

    await s.deleteAll();
    await s.put({ a: '1', b: '2', y: '9' });
    assert.deepStrictEqual(await rev({ start: 'a', end: 'c' }), [
      ['b', '2'],
      ['a', '1'],
    ]);
    assert.deepStrictEqual(await rev({ start: 'x', end: 'z' }), [['y', '9']]);
  },

  // actor-cache-test.c++: "ActorCache list() with limit around negative entries",
  // "ActorCache listReverse() with limit around negative entries"
  async listLimitAroundDeletedKeys(s) {
    await s.put({ bar: '456', bar1: 'xxx', bar3: 'yyy', foo: '123' });
    s.delete(['bar1', 'bar2', 'bar3', 'bar4']);
    s.put('baz', '789');
    const expected = [
      ['bar', '456'],
      ['baz', '789'],
      ['foo', '123'],
    ];
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux', limit: 3 })), expected);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux', limit: 4 })), expected);
    assert.deepStrictEqual(
      entries(await s.list({ start: 'bar', end: 'qux', limit: 3, reverse: true })),
      [...expected].reverse()
    );
  },

  // actor-cache-test.c++: "ActorCache list() with some already-cached keys in range",
  // "ActorCache listReverse() with some already-cached keys in range"
  async listSeesUnflushedWrites(s) {
    await s.put({ ccc: 'cval', eee: 'eval' });
    assert.strictEqual(await s.get('bbb'), undefined);
    assert.strictEqual(await s.get('ccc'), 'cval');

    s.put('ddd', 'dval');
    const del = s.delete('eee');
    const expected = [
      ['ccc', 'cval'],
      ['ddd', 'dval'],
    ];
    assert.deepStrictEqual(entries(await s.list({ start: 'aaa', end: 'fff' })), expected);
    assert.deepStrictEqual(
      entries(await s.list({ start: 'aaa', end: 'fff', reverse: true })),
      [...expected].reverse()
    );
    assert.strictEqual(await del, true);
  },

  // actor-cache-test.c++: "ActorCache list() with seemingly-redundant dirty entries",
  // "ActorCache listReverse() with seemingly-redundant dirty entries"
  async listSnapshotBeforeLaterWrites(s) {
    await s.put('bbb', 'old');
    const del = s.delete('bbb');
    s.put('ccc', 'cval');

    const fwd = s.list({ start: 'aaa', end: 'fff' });
    const back = s.list({ start: 'aaa', end: 'fff', reverse: true });
    s.put('bbb', 'bval');
    const del2 = s.delete('ccc');

    assert.deepStrictEqual(entries(await fwd), [['ccc', 'cval']]);
    assert.deepStrictEqual(entries(await back), [['ccc', 'cval']]);
    assert.strictEqual(await del, true);
    assert.strictEqual(await del2, true);
    assert.strictEqual(await s.get('bbb'), 'bval');
    assert.strictEqual(await s.get('ccc'), undefined);

    await s.sync();
    assert.deepStrictEqual(entries(await s.list({ start: 'aaa', end: 'fff' })), [['bbb', 'bval']]);
  },

  // actor-cache-test.c++: "ActorCache list() starting from known value", "ActorCache list() starting from unknown value",
  // "ActorCache list() consecutively, absent midpoint", "ActorCache list() consecutively reverse, absent midpoint",
  // "ActorCache list() consecutively, present midpoint", "ActorCache list() consecutively reverse, present midpoint",
  // and the eight matching "ActorCache listReverse() ..." variants
  async listConsecutiveRanges(s) {
    await s.put({ baz: '456', foo: '123' });
    const fwd = async (start, end) => entries(await s.list({ start, end }));
    const rev = async (start, end) => entries(await s.list({ start, end, reverse: true }));

    assert.deepStrictEqual(await fwd('corge', 'qux'), [['foo', '123']]);
    assert.deepStrictEqual(await fwd('bar', 'corge'), [['baz', '456']]);
    assert.deepStrictEqual(await fwd('bar', 'qux'), [
      ['baz', '456'],
      ['foo', '123'],
    ]);
    assert.deepStrictEqual(await rev('bar', 'corge'), [['baz', '456']]);
    assert.deepStrictEqual(await rev('corge', 'qux'), [['foo', '123']]);
    assert.deepStrictEqual(await rev('bar', 'qux'), [
      ['foo', '123'],
      ['baz', '456'],
    ]);

    await s.put('corge', '789');
    assert.deepStrictEqual(await fwd('corge', 'qux'), [
      ['corge', '789'],
      ['foo', '123'],
    ]);
    assert.deepStrictEqual(await fwd('bar', 'corge'), [['baz', '456']]);
    assert.deepStrictEqual(await fwd('bar', 'qux'), [
      ['baz', '456'],
      ['corge', '789'],
      ['foo', '123'],
    ]);
    assert.deepStrictEqual(await rev('corge', 'qux'), [
      ['foo', '123'],
      ['corge', '789'],
    ]);
    assert.deepStrictEqual(await rev('bar', 'qux'), [
      ['foo', '123'],
      ['corge', '789'],
      ['baz', '456'],
    ]);

    await s.put('bar', '123');
    assert.deepStrictEqual(await fwd('bar', 'qux'), [
      ['bar', '123'],
      ['baz', '456'],
      ['corge', '789'],
      ['foo', '123'],
    ]);
    assert.deepStrictEqual(await rev('bar', 'qux'), [
      ['foo', '123'],
      ['corge', '789'],
      ['baz', '456'],
      ['bar', '123'],
    ]);
  },

  // actor-cache-test.c++: "ActorCache list() starting in known-empty gap", "ActorCache list() ending in known-empty gap",
  // "ActorCache listReverse() starting in known-empty gap", "ActorCache listReverse() ending in known-empty gap"
  async listEmptyGaps(s) {
    await s.put('foo', '123');
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'corge' })), []);
    assert.deepStrictEqual(entries(await s.list({ start: 'baz', end: 'qux' })), [['foo', '123']]);
    assert.deepStrictEqual(entries(await s.list({ start: 'baz', end: 'qux', reverse: true })), [
      ['foo', '123'],
    ]);

    await s.delete('foo');
    await s.put('baz', '123');
    assert.deepStrictEqual(entries(await s.list({ start: 'corge', end: 'qux' })), []);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'foo' })), [['baz', '123']]);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'foo', reverse: true })), [
      ['baz', '123'],
    ]);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux' })), [['baz', '123']]);
  },

  // actor-cache-test.c++: "ActorCache list() with limit and dirty puts that end up past the limit"
  async listLimitWithUnflushedPuts(s) {
    await s.put({ bar: '456', baz: '654', foo: '789' });
    s.put('corge', '123');
    s.put('grault', '321');
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux', limit: 3 })), [
      ['bar', '456'],
      ['baz', '654'],
      ['corge', '123'],
    ]);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux', limit: 4 })), [
      ['bar', '456'],
      ['baz', '654'],
      ['corge', '123'],
      ['foo', '789'],
    ]);
  },

  // actor-cache-test.c++: "ActorCache listReverse() with limit and dirty puts that end up past the limit"
  async listReverseLimitWithUnflushedPuts(s) {
    await s.put({ grault: '456', foo: '654', baz: '789' });
    s.put('corge', '123');
    s.put('bar', '321');
    const rev = async (limit) =>
      entries(await s.list({ start: 'bar', end: 'qux', limit, reverse: true }));
    assert.deepStrictEqual(await rev(3), [
      ['grault', '456'],
      ['foo', '654'],
      ['corge', '123'],
    ]);
    assert.deepStrictEqual(await rev(4), [
      ['grault', '456'],
      ['foo', '654'],
      ['corge', '123'],
      ['baz', '789'],
    ]);
  },

  // actor-cache-test.c++: "ActorCache list() overwrite endpoint", "ActorCache list() delete endpoint",
  // "ActorCache list() delete endpoint empty range", "ActorCache listReverse() overwrite endpoint",
  // "ActorCache listReverse() delete endpoint"
  async listEndpointChanges(s) {
    await s.put({ corge: '789', foo: '123' });
    assert.deepStrictEqual(entries(await s.list({ start: 'corge', end: 'qux' })), [
      ['corge', '789'],
      ['foo', '123'],
    ]);
    assert.deepStrictEqual(entries(await s.list({ start: 'corge', end: 'qux', reverse: true })), [
      ['foo', '123'],
      ['corge', '789'],
    ]);
    s.put('qux', '456');
    assert.deepStrictEqual(entries(await s.list({ start: 'corge', end: 'xyzzy', limit: 3 })), [
      ['corge', '789'],
      ['foo', '123'],
      ['qux', '456'],
    ]);

    await s.put('waldo', '555');
    assert.strictEqual(await s.delete('qux'), true);
    assert.deepStrictEqual(entries(await s.list({ start: 'corge', end: 'xyzzy', limit: 4 })), [
      ['corge', '789'],
      ['foo', '123'],
      ['waldo', '555'],
    ]);

    await s.put('baz', '555');
    assert.strictEqual(await s.delete('corge'), true);
    assert.deepStrictEqual(
      entries(await s.list({ start: 'bar', end: 'qux', limit: 4, reverse: true })),
      [
        ['foo', '123'],
        ['baz', '555'],
      ]
    );

    await s.deleteAll();
    await s.put('qux', '555');
    assert.deepStrictEqual(entries(await s.list({ start: 'corge', end: 'qux' })), []);
    assert.strictEqual(await s.delete('qux'), true);
    assert.deepStrictEqual(entries(await s.list({ start: 'corge', end: 'xyzzy', limit: 4 })), []);
  },

  // actor-cache-test.c++: "ActorCache list() interleave streaming with other ops"
  async listInterleavedWrites(s) {
    await s.put({ bar: '123', corge: '456', foo: '789', garply: '555' });
    const listed = s.list({ start: 'bar', end: 'qux' });
    const bar = s.get('bar');
    const grault = s.get('grault');
    s.put('foo', '987');
    const del = s.delete('garply');

    assert.deepStrictEqual(entries(await listed), [
      ['bar', '123'],
      ['corge', '456'],
      ['foo', '789'],
      ['garply', '555'],
    ]);
    assert.strictEqual(await bar, '123');
    assert.strictEqual(await grault, undefined);
    assert.strictEqual(await del, true);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux' })), [
      ['bar', '123'],
      ['corge', '456'],
      ['foo', '987'],
    ]);
  },

  // actor-cache-test.c++: "ActorCache listReverse() interleave streaming with other ops"
  async listReverseInterleavedWrites(s) {
    await s.put({ bar: '123', corge: '456', foo: '789', garply: '555' });
    const listed = s.list({ start: 'baa', end: 'qux', reverse: true });
    const baz = s.get('baz');
    s.put('corge', '987');
    const del = s.delete('bar');

    assert.deepStrictEqual(entries(await listed), [
      ['garply', '555'],
      ['foo', '789'],
      ['corge', '456'],
      ['bar', '123'],
    ]);
    assert.strictEqual(await baz, undefined);
    assert.strictEqual(await del, true);
    assert.deepStrictEqual(entries(await s.list({ start: 'bar', end: 'qux', reverse: true })), [
      ['garply', '555'],
      ['foo', '789'],
      ['corge', '987'],
    ]);
  },

  // actor-cache-test.c++: "ActorCache transaction read-through"
  async transactionReadThrough(s) {
    await s.put({ foo: '123', baz: '456', qux: '789', grault: '555' });
    await s.transaction(async (txn) => {
      assert.strictEqual(await txn.get('foo'), '123');
      assert.strictEqual(await txn.get('bar'), undefined);
      assert.deepStrictEqual(obj(await txn.get(['baz', 'qux', 'corge'])), {
        baz: '456',
        qux: '789',
      });
      assert.deepStrictEqual(obj(await txn.get(['foo', 'bar', 'baz', 'qux', 'corge'])), {
        baz: '456',
        foo: '123',
        qux: '789',
      });
      const expected = [
        ['baz', '456'],
        ['foo', '123'],
        ['grault', '555'],
        ['qux', '789'],
      ];
      assert.deepStrictEqual(entries(await txn.list({ start: 'a', end: 'z', limit: 10 })), expected);
      assert.deepStrictEqual(
        entries(await txn.list({ start: 'a', end: 'z', reverse: true })),
        [...expected].reverse()
      );
    });
  },

  // actor-cache-test.c++: "ActorCache transaction overlay changes", "ActorCache transaction overlay changes precached"
  async transactionOverlay(s, { precache }) {
    await s.put({ baz: '456', foo: '123', grault: '555', qux: '789' });
    if (precache) {
      assert.deepStrictEqual(entries(await s.list({ start: 'a', end: 'z', limit: 10, reverse: true })), [
        ['qux', '789'],
        ['grault', '555'],
        ['foo', '123'],
        ['baz', '456'],
      ]);
    }
    const expected = [
      ['bar', '654'],
      ['foo', '321'],
      ['qux', '987'],
    ];
    await s.transaction(async (txn) => {
      txn.put('foo', '321');
      txn.put({ bar: '654', qux: '987' });
      const d1 = txn.delete('grault');
      const d2 = txn.delete(['baz', 'garply']);

      assert.strictEqual(await txn.get('foo'), '321');
      assert.strictEqual(await txn.get('baz'), undefined);
      assert.deepStrictEqual(obj(await txn.get(['bar', 'baz', 'qux'])), { bar: '654', qux: '987' });
      assert.strictEqual(await d1, true);
      assert.strictEqual(await d2, 1);
      assert.deepStrictEqual(obj(await txn.get(['baz', 'qux', 'corge'])), { qux: '987' });
      assert.deepStrictEqual(obj(await txn.get(['foo', 'bar', 'baz', 'qux', 'corge'])), {
        bar: '654',
        foo: '321',
        qux: '987',
      });
      assert.deepStrictEqual(entries(await txn.list({ start: 'a', end: 'z', limit: 10 })), expected);
      assert.deepStrictEqual(
        entries(await txn.list({ start: 'a', end: 'z', reverse: true })),
        [...expected].reverse()
      );
    });
    assert.deepStrictEqual(entries(await s.list()), expected);
  },

  // actor-cache-test.c++: "ActorCache transaction multiple counted delete batches"
  async transactionCountedDelete(s) {
    await s.put({ count1: '1', count2: '2' });
    await s.transaction(async (txn) => {
      txn.put('count3', '3');
      assert.strictEqual(await txn.delete(['count1', 'count2', 'count3', 'count4', 'count5']), 3);
    });
    assert.deepStrictEqual(entries(await s.list({ prefix: 'count' })), []);
  },

  // actor-cache-test.c++: "ActorCache transaction negative list range returns nothing"
  async transactionInvertedListRange(s) {
    await s.transaction(async (txn) => {
      txn.put('foo', '123');
      assert.deepStrictEqual(entries(await txn.list({ start: 'qux', end: 'bar' })), []);
      assert.deepStrictEqual(entries(await txn.list({ start: 'qux', end: 'bar', reverse: true })), []);
    });
    assert.strictEqual(await s.get('foo'), '123');
  },

  // actor-cache-test.c++: "ActorCache can wait for flush"; actor-sqlite-test.c++: "sync() returns immediately when no writes are pending"
  async syncWaitsForWrites(s) {
    await s.sync();
    s.put('foo', 'bar');
    await s.sync();
    s.put('foo-0', 'bar');
    s.put({ 'foo-1': 'bar', 'foo-2': 'bar' });
    await s.sync();
    assert.deepStrictEqual(entries(await s.list({ prefix: 'foo' })), [
      ['foo', 'bar'],
      ['foo-0', 'bar'],
      ['foo-1', 'bar'],
      ['foo-2', 'bar'],
    ]);
    await s.sync();
  },

  // actor-sqlite-test.c++: "check put multiple wraps operations in a transaction" (x2); sqlite-kv-test.c++: "SQLite-KV multi-put"
  async putMultipleInTransactions(s) {
    await s.put({ foo: 'bar' });
    assert.strictEqual(await s.get('foo'), 'bar');

    s.transactionSync(() => {
      s.put({ foo: 'bar', foo2: 'bar2' });
    });
    assert.strictEqual(await s.get('foo2'), 'bar2');

    s.put('baz', 'bat');
    s.put({ foo: 'bar', foo2: 'bar2', foo3: 'bar3' });
    assert.strictEqual(await s.get('baz'), 'bat');
    assert.strictEqual(await s.get('foo3'), 'bar3');

    await s.put({ foo: 'abc', bar: 'def', qux: '123' });
    await s.put({ foo: 'xyz', bar: 'uvw' });
    assert.deepStrictEqual(obj(await s.get(['foo', 'bar', 'qux'])), {
      bar: 'uvw',
      foo: 'xyz',
      qux: '123',
    });
    await s.put({});
    assert.strictEqual(await s.get('foo'), 'xyz');
  },

  // actor-sqlite-test.c++: "check put multiple wraps operations in a transaction and rollback on error";
  // sqlite-kv-test.c++: "SQLite-KV multi-put rollback on error"
  async putMultipleRollbackOnError(s) {
    // workerd's test fails the batch with a 4 MiB key, over Cloudflare's key size quota, which
    // Orange does not copy. A value that cannot be cloned fails the batch the same way.
    const batch = () => ({ foo: 'bar', foo2: 'bar2', foo3: 'bar3', last: () => 'not cloneable' });
    const absent = async () =>
      assert.deepStrictEqual(obj(await s.get(['foo', 'foo2', 'foo3'])), {});

    await s.put('existing', 'value');
    await assert.rejects(async () => s.put(batch()));
    await absent();

    await assert.rejects(async () =>
      s.transactionSync(() => {
        return s.put(batch());
      })
    );
    await absent();

    s.put('baz', 'bat');
    await assert.rejects(async () => s.put(batch()));
    assert.strictEqual(await s.get('baz'), 'bat');
    await absent();
    assert.strictEqual(await s.get('existing'), 'value');
  },
};

export class TestDurableObject extends DurableObject {
  async run(name, opts = {}) {
    await scenarios[name](this.ctx.storage, opts);
    return 'ok';
  }
}

const stub = (env, name) => env.ns.get(env.ns.idFromName(`do-storage-test:${name}`));

const scenario = (...names) => ({
  async test(ctrl, env) {
    for (const name of names) {
      assert.strictEqual(await stub(env, name).run(name), 'ok');
    }
  },
});

export const singleKeyBasics = scenario('singleKeyBasics');
export const multiKeyBasics = scenario('multiKeyBasics');
export const sqliteKvListMatrix = scenario('sqliteKvListMatrix');
export const deleteAllWithPendingWrites = scenario('deleteAllWithPendingWrites');
export const deleteAllDuringFlushAndTwice = scenario('deleteAllDuringFlush', 'deleteAllTwice');
export const getPutOrdering = scenario('getPutOrdering');
export const putDuringFlush = scenario('putDuringFlush');
export const listForward = scenario('listForward');
export const listReverse = scenario('listReverse');
export const listLimitAroundDeletedKeys = scenario('listLimitAroundDeletedKeys');
export const listSeesUnflushedWrites = scenario('listSeesUnflushedWrites');
export const listSnapshotBeforeLaterWrites = scenario('listSnapshotBeforeLaterWrites');
export const listConsecutiveRanges = scenario('listConsecutiveRanges');
export const listEmptyGaps = scenario('listEmptyGaps');
export const listLimitWithUnflushedPuts = scenario(
  'listLimitWithUnflushedPuts',
  'listReverseLimitWithUnflushedPuts'
);
export const listEndpointChanges = scenario('listEndpointChanges');
export const listInterleavedWrites = scenario('listInterleavedWrites', 'listReverseInterleavedWrites');
export const transactionReadThrough = scenario('transactionReadThrough');
export const transactionOverlay = {
  async test(ctrl, env) {
    assert.strictEqual(await stub(env, 'txnOverlay').run('transactionOverlay', { precache: false }), 'ok');
    assert.strictEqual(
      await stub(env, 'txnOverlayPrecached').run('transactionOverlay', { precache: true }),
      'ok'
    );
  },
};
export const transactionCountedDelete = scenario('transactionCountedDelete');
export const transactionInvertedListRange = scenario('transactionInvertedListRange');
export const syncWaitsForWrites = scenario('syncWaitsForWrites');
export const putMultipleInTransactions = scenario('putMultipleInTransactions');
export const putMultipleRollbackOnError = scenario('putMultipleRollbackOnError');
