import { test } from "node:test";
import assert from "node:assert/strict";

import { onEvent } from "../plugin.js";

const GB = 1024 * 1024 * 1024;

function fakeHost({ sizes, current = 2, dryRun = false, pageSize = 1000 }) {
  const kv = new Map();
  const calls = { switch: [], webhook: [], fetch: 0 };
  const state = { current };
  const objectsPerBucket = { b1: 0, b2: 0 };
  const ctx = {
    config: {
      axonhubUrl: "https://ai.example.com",
      adminEmail: "ops@example.com",
      adminPassword: "pw",
      storages: JSON.stringify([
        { id: 2, name: "桶1", endpoint: "https://s3.example.com", region: "auto", bucket: "b1", accessKeyId: "a", secretAccessKey: "s" },
        { id: 3, name: "桶2", endpoint: "https://s3.example.com", region: "auto", bucket: "b2", accessKeyId: "a", secretAccessKey: "s" },
      ]),
      thresholdGb: 10,
      dryRun,
      webhookTarget: "feishu",
    },
    kv: {
      get: (k) => (kv.has(k) ? kv.get(k) : null),
      set: (k, v) => void kv.set(k, v),
      delete: (k) => kv.delete(k),
    },
    log: { info() {}, warn() {}, error() {} },
    webhook: { send: (target, payload) => calls.webhook.push([target, payload.message]) },
    async fetch(url, init) {
      calls.fetch++;
      if (url.endsWith("/admin/auth/signin")) return { status: 200, headers: {}, body: JSON.stringify({ token: "T" }) };
      if (url.endsWith("/admin/graphql")) {
        assert.equal(init.headers.Authorization, "Bearer T");
        const body = JSON.parse(init.body);
        if (body.query.includes("updateDefaultDataStorage")) {
          state.current = Number(body.variables.id.split("/").pop());
          calls.switch.push(state.current);
          return { status: 200, headers: {}, body: JSON.stringify({ data: { updateDefaultDataStorage: true } }) };
        }
        const node = (id, bucket) => ({ node: { id: "gid://axonhub/DataStorage/" + id, name: "n" + id, type: "s3", status: "active", primary: false, settings: { s3: { bucketName: bucket } } } });
        return { status: 200, headers: {}, body: JSON.stringify({ data: { defaultDataStorageID: "gid://axonhub/DataStorage/" + state.current, dataStorages: { edges: [node(2, "b1"), node(3, "b2")] } } }) };
      }
      const m = /^https:\/\/s3\.example\.com\/(b\d)\?(.*)$/.exec(url);
      assert.ok(m, url);
      assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=a\//);
      const bucket = m[1];
      const page = Number((/continuation-token=(\d+)/.exec(m[2]) || [0, 0])[1]);
      const totalPages = 3;
      const perObject = Math.floor(sizes[bucket] / (totalPages * pageSize));
      let xml = "<ListBucketResult>";
      for (let i = 0; i < pageSize; i++) xml += "<Contents><Key>k</Key><Size>" + perObject + "</Size></Contents>";
      objectsPerBucket[bucket] += pageSize;
      xml += page + 1 < totalPages ? "<IsTruncated>true</IsTruncated><NextContinuationToken>" + (page + 1) + "</NextContinuationToken>" : "<IsTruncated>false</IsTruncated>";
      return { status: 200, headers: {}, body: xml + "</ListBucketResult>" };
    },
  };
  return { ctx, kv, calls, state };
}

async function tick(host, clock) {
  clock.now += 11000;
  host.kv.delete("lease"); // the lease TTL would have expired
  await onEvent(host.ctx, { type: "request.completed" });
}

const clock = { now: 1_800_000_000_000 };

function withClock(fn) {
  return async () => {
    const realNow = Date.now;
    clock.now += 3600000; // module-level poll state survives between tests
    Date.now = () => clock.now;
    try {
      await fn(clock);
    } finally {
      Date.now = realNow;
    }
  };
}

test("measures, then switches when the current bucket passes the line", withClock(async (clock) => {
  const host = fakeHost({ sizes: { b1: 9.7 * GB, b2: 0.3 * GB } });
  for (let i = 0; i < 6; i++) await tick(host, clock);
  assert.deepEqual(host.calls.switch, [3]);
  const status = JSON.parse(host.kv.get("status"));
  assert.equal(status.currentId, 3);
  assert.match(status.lastSwitch.reason, /切到 桶2/);
  assert.equal(host.calls.webhook.length, 1);
  assert.equal(host.calls.webhook[0][0], "feishu");
  const u = JSON.parse(host.kv.get("usage.2"));
  assert.equal(u.objects, 3000);
  assert.ok(Math.abs(u.bytes - 9.7 * GB) < 3000);
  // nothing more happens right after
  for (let i = 0; i < 3; i++) await tick(host, clock);
  assert.deepEqual(host.calls.switch, [3]);
}));

test("dry run never switches", withClock(async (clock) => {
  const host = fakeHost({ sizes: { b1: 9.7 * GB, b2: 0.3 * GB }, dryRun: true });
  for (let i = 0; i < 8; i++) await tick(host, clock);
  assert.deepEqual(host.calls.switch, []);
  assert.match(JSON.parse(host.kv.get("log"))[0].text, /dry-run/);
}));

test("below the line does nothing and waits for the interval", withClock(async (clock) => {
  const host = fakeHost({ sizes: { b1: 2 * GB, b2: 0 } });
  for (let i = 0; i < 4; i++) await tick(host, clock);
  const status = JSON.parse(host.kv.get("status"));
  assert.equal(status.lastDecision.action, "noop");
  const fetches = host.calls.fetch;
  await tick(host, clock);
  assert.equal(host.calls.fetch, fetches, "no calls until the next check");
}));

test("manual switch command from the page", withClock(async (clock) => {
  const host = fakeHost({ sizes: { b1: 1 * GB, b2: 0 } });
  host.kv.set("command", JSON.stringify({ type: "switch", to: 3 }));
  await tick(host, clock);
  assert.deepEqual(host.calls.switch, [3]);
  assert.equal(host.kv.has("command"), false);
}));

test("bad config is reported without fetching", withClock(async (clock) => {
  const host = fakeHost({ sizes: { b1: 0, b2: 0 } });
  host.ctx.config = { ...host.ctx.config, storages: "not json" };
  await tick(host, clock);
  assert.equal(host.calls.fetch, 0);
  assert.match(JSON.parse(host.kv.get("status")).lastAlert.text, /配置错误/);
}));

test("ticks closer than 10 s are skipped", withClock(async (clock) => {
  const host = fakeHost({ sizes: { b1: 0, b2: 0 } });
  await tick(host, clock);
  const fetches = host.calls.fetch;
  clock.now += 1000;
  host.kv.delete("lease");
  host.kv.set("command", JSON.stringify({ type: "switch", to: 3 }));
  await onEvent(host.ctx, {});
  assert.equal(host.calls.fetch, fetches);
}));

test("switches when the bucket is already over 100%", withClock(async (clock) => {
  const host = fakeHost({ sizes: { b1: 12.3 * GB, b2: 0 } });
  for (let i = 0; i < 6; i++) await tick(host, clock);
  assert.deepEqual(host.calls.switch, [3]);
}));
