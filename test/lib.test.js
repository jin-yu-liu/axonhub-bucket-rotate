import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { hex, hmac, sha256 } from "../lib/crypto.js";
import { parseListPage, signedListRequest } from "../lib/s3.js";
import { GB, credentialsFor, evaluate, gidInt, measureDue, parseConfig, resolveRotation } from "../lib/rotate.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("sha256 / hmac match node:crypto", () => {
  const inputs = ["", "abc", "中文载荷", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(1000)];
  for (const s of inputs) {
    assert.equal(hex(sha256(s)), createHash("sha256").update(s).digest("hex"), s.slice(0, 10));
    assert.equal(hex(hmac("key-" + s, s)), createHmac("sha256", "key-" + s).update(s).digest("hex"));
  }
  const longKey = "k".repeat(100);
  assert.equal(hex(hmac(longKey, "m")), createHmac("sha256", longKey).update("m").digest("hex"));
});

// Reference values produced by the original Python script (bucket_rotate.s3_list_request), which ran against real buckets.
test("SigV4 list request matches the reference implementation", () => {
  const s3 = {
    endpoint: "https://acc.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "payload-1",
    accessKeyId: "AKID",
    secretAccessKey: "SECRET/key+1",
    pathStyle: true,
  };
  const params = { "list-type": "2", "max-keys": "1000", "continuation-token": "1a/b+c=" };
  const js = signedListRequest(s3, params, new Date(Date.UTC(2026, 10, 14, 12, 34, 56)));
  assert.equal(js.url, "https://acc.r2.cloudflarestorage.com/payload-1?continuation-token=1a%2Fb%2Bc%3D&list-type=2&max-keys=1000");
  assert.equal(
    js.headers.Authorization,
    "AWS4-HMAC-SHA256 Credential=AKID/20261114/auto/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
      "Signature=f8a04057983cf4ffc10643436bf384bbe37ba1fcff4cf796a0381b32245c1d0e",
  );
  assert.equal(js.headers["x-amz-date"], "20261114T123456Z");
});

test("virtual-host style URL", () => {
  const r = signedListRequest(
    { endpoint: "oss-cn-hangzhou.aliyuncs.com", region: "oss-cn-hangzhou", bucket: "b1", accessKeyId: "a", secretAccessKey: "s", pathStyle: false },
    { "list-type": "2" },
    new Date(0),
  );
  assert.equal(r.url, "https://b1.oss-cn-hangzhou.aliyuncs.com/?list-type=2");
});

test("network regexes accept the URLs the plugin sends", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(path.join(here, "..", "manifest.json"), "utf8"));
  const rules = manifest.network.map((r) => new RegExp(r.regex));
  const allowed = (u) => rules.some((re) => re.test(u.split("?")[0]));
  assert.ok(allowed("https://ai.example.com/admin/auth/signin"));
  assert.ok(allowed("https://ai.example.com/admin/graphql"));
  assert.ok(allowed("https://acc.r2.cloudflarestorage.com/payload-1?list-type=2"));
  assert.ok(allowed("https://b1.oss-cn-hangzhou.aliyuncs.com/?list-type=2"));
  assert.ok(!allowed("https://evil.example.com/a/b"));
  for (const r of manifest.network) assert.ok(r.regex.length <= 256);
});

test("parseListPage", () => {
  const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
<Contents><Key>a</Key><Size>10</Size></Contents><Contents><Key>b</Key><Size>32</Size></Contents>
<NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>`;
  assert.deepEqual(parseListPage(xml), { bytes: 42, objects: 2, truncated: true, token: "tok&1" });
  assert.deepEqual(parseListPage("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>"), {
    bytes: 0, objects: 0, truncated: false, token: null,
  });
});

const baseConfig = {
  axonhubUrl: "https://ai.example.com/",
  adminEmail: "ops@example.com",
  adminPassword: "pw",
  accessKeyId: "a",
  secretAccessKey: "s",
  thresholdGb: 10,
};

function nodes(statuses = {}) {
  const n = {};
  for (const [id, bucket] of [[2, "b1"], [3, "b2"], [4, "b3"]]) {
    n[id] = {
      id: "gid://axonhub/DataStorage/" + id, name: "桶" + (id - 1), type: "s3", status: statuses[id] || "active", primary: false,
      settings: { s3: { bucketName: bucket, endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto", pathStyle: true } },
    };
  }
  n[1] = { id: "gid://axonhub/DataStorage/1", name: "Primary", type: "database", status: "active", primary: true, settings: {} };
  return n;
}

function cfgWith(extra = {}) {
  const cfg = parseConfig({ ...baseConfig, ...extra });
  const rot = resolveRotation(cfg, nodes());
  assert.deepEqual(rot.problems, []);
  return { ...cfg, storages: rot.storages };
}

test("parseConfig validates", () => {
  const cfg = parseConfig(baseConfig);
  assert.equal(cfg.axonhubUrl, "https://ai.example.com");
  assert.equal(cfg.dryRun, true);
  assert.deepEqual(cfg.order, []);
  assert.deepEqual(parseConfig({ ...baseConfig, rotationOrder: " 桶2，3, b1 " }).order, ["桶2", "3", "b1"]);
  assert.throws(() => parseConfig({ ...baseConfig, axonhubUrl: "http://x" }));
  assert.throws(() => parseConfig({ ...baseConfig, accessKeyId: "", secretAccessKey: "" }), /只读密钥/);
  assert.throws(() => parseConfig({ ...baseConfig, secretAccessKey: "" }));
  assert.throws(() => parseConfig({ ...baseConfig, extraCredentials: "bad" }), /extraCredentials/);
  assert.throws(() => parseConfig({ ...baseConfig, switchRatio: 0.5, targetMaxRatio: 0.8 }));
});

test("gidInt", () => {
  assert.equal(gidInt("gid://axonhub/DataStorage/3"), 3);
  assert.equal(gidInt(null), 0);
});

test("resolveRotation discovers S3 storages and applies the order", () => {
  let rot = resolveRotation(parseConfig(baseConfig), nodes());
  assert.deepEqual(rot.problems, []);
  assert.deepEqual(rot.storages.map((s) => s.id), [2, 3, 4], "empty order = all non-primary S3 by ID");
  assert.equal(rot.storages[0].endpoint, "https://acc.r2.cloudflarestorage.com");
  assert.equal(rot.storages[0].region, "auto");
  assert.equal(rot.storages[0].bucket, "b1");

  rot = resolveRotation(parseConfig({ ...baseConfig, rotationOrder: "桶3, 2, b2" }), nodes());
  assert.deepEqual(rot.problems, []);
  assert.deepEqual(rot.storages.map((s) => s.id), [4, 2, 3], "by name, ID and bucket");

  rot = resolveRotation(parseConfig({ ...baseConfig, rotationOrder: "桶1,桶1,Primary,nope" }), nodes());
  assert.equal(rot.problems.length, 3);

  rot = resolveRotation(parseConfig({ ...baseConfig, rotationOrder: "桶1" }), nodes());
  assert.match(rot.problems[0], /至少需要 2 个/);
});

test("credentialsFor: override by name / ID, else shared key", () => {
  const cfg = parseConfig({ ...baseConfig, extraCredentials: "桶2=AK2:SK/2+x; 4=AK4:SK4" });
  const rot = resolveRotation(cfg, nodes());
  const keys = rot.storages.map((s) => credentialsFor(cfg, s).accessKeyId);
  assert.deepEqual(keys, ["a", "AK2", "AK4"]);
  assert.equal(credentialsFor(cfg, rot.storages[1]).secretAccessKey, "SK/2+x");

  const onlyOverrides = parseConfig({ ...baseConfig, accessKeyId: "", secretAccessKey: "", extraCredentials: "桶1=A:B;桶2=C:D" });
  const r2 = resolveRotation(onlyOverrides, nodes());
  assert.equal(r2.problems.length, 1, "桶3 has no key");
  assert.match(r2.problems[0], /桶3/);
});

test("evaluate", () => {
  const cfg = cfgWith();
  const now = 10 * 3600000;
  const fresh = (gb) => ({ bytes: gb * GB, objects: 1, at: now - 1000 });
  assert.equal(evaluate(cfg, 9, nodes(), {}, 0, now).action, "alert");
  assert.deepEqual(evaluate(cfg, 2, nodes(), {}, 0, now).action, "measure");
  assert.equal(evaluate(cfg, 2, nodes(), { 2: fresh(5) }, 0, now).action, "noop");
  // over the line, candidate unknown -> measure candidate
  let d = evaluate(cfg, 2, nodes(), { 2: fresh(9.6) }, 0, now);
  assert.equal(d.action, "measure");
  assert.equal(d.storageId, 3);
  d = evaluate(cfg, 2, nodes(), { 2: fresh(9.6), 3: fresh(1) }, 0, now);
  assert.equal(d.action, "switch");
  assert.equal(d.target.id, 3);
  // candidate full, next one disabled -> alert
  d = evaluate(cfg, 2, nodes({ 4: "disabled" }), { 2: fresh(9.6), 3: fresh(9) }, 0, now);
  assert.equal(d.action, "alert");
  // wraps around: current 4 -> 2
  d = evaluate(cfg, 4, nodes(), { 4: fresh(9.9), 2: fresh(0.5) }, 0, now);
  assert.equal(d.target.id, 2);
  // cooldown
  d = evaluate(cfg, 2, nodes(), { 2: fresh(9.6), 3: fresh(1) }, now - 60000, now);
  assert.equal(d.action, "alert");
});

test("measureDue", () => {
  const cfg = cfgWith();
  const now = 100 * 60000;
  assert.equal(measureDue(cfg, null, now), true);
  assert.equal(measureDue(cfg, { bytes: 1 * GB, at: now - 30 * 60000 }, now), false);
  assert.equal(measureDue(cfg, { bytes: 1 * GB, at: now - 61 * 60000 }, now), true);
  assert.equal(measureDue(cfg, { bytes: 7 * GB, at: now - 21 * 60000 }, now), true);
  assert.equal(measureDue(cfg, { bytes: 9 * GB, at: now - 10000 }, now), false);
  assert.equal(measureDue(cfg, { bytes: 9 * GB, at: now - 61000 }, now), true);
  assert.equal(measureDue(cfg, { bytes: 13 * GB, at: now - 10000 }, now), false, "over 100% must not re-measure forever");
});
