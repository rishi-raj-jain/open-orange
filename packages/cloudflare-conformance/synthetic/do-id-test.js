import assert from 'node:assert';
import { DurableObject } from 'cloudflare:workers';

export class TestDurableObject extends DurableObject {
  whoami() {
    return { id: this.ctx.id.toString(), name: this.ctx.id.name ?? null };
  }
}

export class OtherDurableObject extends DurableObject {}

// actor-id-impl-test.c++: "ActorIdImpl equals test"
export const idEqualityIgnoresName = {
  async test(ctrl, env) {
    const named = env.ns.idFromName('id-equals');
    assert.ok(named.equals(env.ns.idFromName('id-equals')));
    assert.ok(!named.equals(env.ns.idFromName('id-equals-other')));

    // Same id bytes compare equal whether or not one side carries a name.
    const unnamed = env.ns.idFromString(named.toString());
    assert.strictEqual(named.name, 'id-equals');
    assert.strictEqual(unnamed.name, undefined);
    assert.ok(named.equals(unnamed));
    assert.ok(unnamed.equals(named));

    const unique = env.ns.newUniqueId();
    assert.ok(!unique.equals(env.ns.newUniqueId()));
    assert.ok(unique.equals(env.ns.idFromString(unique.toString())));
    assert.ok(!unique.equals(named));
  },
};

// actor-id-impl-test.c++: "ActorIdImplFactory idFromString test"
export const idFromStringValidatesInput = {
  async test(ctrl, env) {
    // Wrong length.
    assert.throws(() => env.ns.idFromString('goodbye'));
    // Right length but the MAC half does not match this namespace.
    assert.throws(() => env.ns.idFromString('deadbeef'.repeat(8)));
    // Valid for another namespace only.
    const foreign = env.other.idFromName('id-from-string').toString();
    assert.throws(() => env.ns.idFromString(foreign));

    // A valid string round-trips, has no name, and routes to the same object.
    const original = env.ns.idFromName('id-from-string');
    const parsed = env.ns.idFromString(original.toString());
    assert.strictEqual(parsed.toString(), original.toString());
    assert.strictEqual(parsed.name, undefined);
    const viaName = await env.ns.get(original).whoami();
    const viaString = await env.ns.get(parsed).whoami();
    assert.strictEqual(viaName.id, original.toString());
    assert.strictEqual(viaString.id, original.toString());
  },
};
