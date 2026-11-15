// Bucket Rotate: switch AxonHub's default payload data storage to the next S3 bucket
// before the current one reaches a size threshold.
//
// There is no scheduler for plugins, so request.completed events act as the clock:
// at most one tick every POLL_MS per VM, and a short KV lease keeps ticks from overlapping.
// Each tick does one bounded step (one check, or a slice of an S3 bucket scan),
// so it always stays inside the 10 s hook timeout.
import { login, readState, switchDefault } from "./lib/axonhub.js";
import { credentialsFor, describeStorages, evaluate, fmtGb, parseConfig, resolveRotation } from "./lib/rotate.js";
import { parseListPage, s3ErrorText, signedListRequest } from "./lib/s3.js";

const POLL_MS = 10000;
const LEASE_SECONDS = 30;
const SCAN_BUDGET_MS = 6500;
const SCAN_MAX_PAGES = 200000;
const LOG_LIMIT = 40;
const ALERT_REPEAT_MS = 3600000;

let lastPoll = 0; // per-VM pre-filter, safe to lose

export async function onEvent(ctx, event) {
  const now = Date.now();
  if (now - lastPoll < POLL_MS) return;
  lastPoll = now;

  if (ctx.kv.get("lease")) return;
  ctx.kv.set("lease", String(now), { ttlSeconds: LEASE_SECONDS });
  try {
    await tick(ctx, now);
  } finally {
    ctx.kv.delete("lease");
  }
}

// KV writes per tick stay below the host limit of 10 per call.
async function tick(ctx, now) {
  const before = ctx.kv.get("status");
  const status = (before && safeParse(before)) || {};
  let cfg;
  try {
    cfg = parseConfig(ctx.config);
  } catch (err) {
    alertOnce(ctx, null, status, "配置错误：" + err.message, now);
    const after = JSON.stringify(status);
    if (after !== before) ctx.kv.set("status", after);
    return;
  }

  try {
    const scan = readJSON(ctx, "scan");
    if (scan) {
      await continueScan(ctx, cfg, scan, status);
    } else {
      const command = readJSON(ctx, "command");
      if (command || !status.nextCheckAt || now >= status.nextCheckAt) {
        if (command) ctx.kv.delete("command");
        await check(ctx, cfg, status, command, now);
      }
    }
  } catch (err) {
    ctx.kv.delete("scan");
    status.scanning = null;
    status.nextCheckAt = now + 5 * 60000;
    alertOnce(ctx, cfg, status, "检查失败（未做任何切换）：" + (err && err.message ? err.message : String(err)), now);
  }
  const after = JSON.stringify(status);
  if (after !== before) ctx.kv.set("status", after);
}

async function check(ctx, base, status, command, now) {
  const token = await login(ctx, base);
  const st = await readState(ctx, base, token);
  // The rotation list comes from AxonHub's own data storages; config only gives the order and read-only keys.
  const rot = resolveRotation(base, st.nodes);
  const cfg = Object.assign({}, base, { storages: rot.storages });
  status.checkedAt = now;
  status.currentId = st.currentId;
  status.discovered = describeStorages(st.nodes);
  status.storages = cfg.storages.map((s) => {
    const n = st.nodes[s.id] || {};
    return { id: s.id, name: s.name, bucket: s.bucket, status: n.status || "missing" };
  });
  status.dryRun = cfg.dryRun;
  status.thresholdBytes = cfg.thresholdBytes;
  status.switchRatio = cfg.switchRatio;
  status.targetMaxRatio = cfg.targetMaxRatio;

  const problems = rot.problems;
  status.problems = problems;
  if (problems.length) {
    status.nextCheckAt = now + cfg.checkIntervalMinutes * 60000;
    alertOnce(ctx, cfg, status, "配置与 AxonHub 不一致，已停止：" + problems.join("；"), now);
    return;
  }

  if (command && command.type === "switch") {
    await manualSwitch(ctx, cfg, token, st, Number(command.to), status, now);
    return;
  }
  if (command && command.type === "measure") {
    const id = Number(command.id) || st.currentId;
    if (cfg.storages.some((s) => s.id === id)) {
      startScan(ctx, cfg, id, status, now);
      return;
    }
  }

  const usage = {};
  for (const s of cfg.storages) {
    const u = readJSON(ctx, "usage." + s.id);
    if (u) usage[s.id] = u;
  }
  const d = evaluate(cfg, st.currentId, st.nodes, usage, status.lastSwitchAt || 0, now);
  status.lastDecision = { action: d.action, reason: d.reason, at: now };

  if (d.action === "measure") {
    startScan(ctx, cfg, d.storageId, status, now);
    return;
  }
  status.nextCheckAt = now + cfg.checkIntervalMinutes * 60000;
  if (d.action === "noop") return;
  if (d.action === "alert") {
    alertOnce(ctx, cfg, status, d.reason, now);
    return;
  }
  if (cfg.dryRun) {
    alertOnce(ctx, cfg, status, "[dry-run，未执行] " + d.reason, now);
    return;
  }
  await doSwitch(ctx, cfg, token, st, d.target.id, d.reason, status, now);
}

async function manualSwitch(ctx, cfg, token, st, to, status, now) {
  const node = st.nodes[to];
  if (!node || !cfg.storages.some((s) => s.id === to)) throw new Error("手动切换的目标 ID " + to + " 不在轮换列表中");
  if (String(node.status || "").toLowerCase() !== "active") throw new Error(node.name + " 状态是 " + node.status + "，不能设为默认");
  const from = st.nodes[st.currentId];
  await doSwitch(ctx, cfg, token, st, to, "手动切换：" + (from ? from.name : st.currentId) + " → " + node.name, status, now);
}

async function doSwitch(ctx, cfg, token, st, to, reason, status, now) {
  await switchDefault(ctx, cfg, token, st.nodes[to].id);
  const after = await readState(ctx, cfg, token);
  if (after.currentId !== to) throw new Error("切换后复查默认存储仍是 ID " + after.currentId);
  status.currentId = to;
  status.lastSwitchAt = now;
  status.lastSwitch = { from: st.currentId, to, reason, at: now };
  status.nextCheckAt = now + cfg.checkIntervalMinutes * 60000;
  appendLog(ctx, reason, now);
  notify(ctx, cfg, reason + "。历史请求仍从原桶读取，无需迁移。");
}

function startScan(ctx, cfg, id, status, now) {
  const s = cfg.storages.find((x) => x.id === id);
  // Only public S3 settings go to KV (the status page can read it); keys are taken from config at scan time.
  const target = { id: s.id, name: s.name, bucket: s.bucket, endpoint: s.endpoint, region: s.region, pathStyle: s.pathStyle };
  writeJSON(ctx, "scan", { id, s3: target, token: null, bytes: 0, objects: 0, pages: 0, startedAt: now });
  status.scanning = { id, name: s.name, pages: 0, objects: 0, startedAt: now };
}

async function continueScan(ctx, cfg, scan, status) {
  const target = scan.s3;
  const key = target && credentialsFor(cfg, target);
  if (!key) {
    ctx.kv.delete("scan");
    status.scanning = null;
    return;
  }
  const s = Object.assign({}, target, key);
  const started = Date.now();
  while (Date.now() - started < SCAN_BUDGET_MS) {
    const params = { "list-type": "2", "max-keys": "1000" };
    if (scan.token) params["continuation-token"] = scan.token;
    const req = signedListRequest(s, params, new Date());
    const res = await ctx.fetch(req.url, { method: "GET", headers: req.headers });
    if (res.status !== 200) throw new Error("列举桶 " + s.bucket + " 失败：" + s3ErrorText(res.status, res.body));
    const page = parseListPage(res.body || "");
    scan.bytes += page.bytes;
    scan.objects += page.objects;
    scan.pages++;
    if (!page.truncated) {
      const done = Date.now();
      writeJSON(ctx, "usage." + s.id, { bytes: scan.bytes, objects: scan.objects, at: done });
      ctx.kv.delete("scan");
      status.scanning = null;
      status.nextCheckAt = 0; // evaluate on the next tick
      appendLog(ctx, "测量完成：" + s.name + " " + fmtGb(scan.bytes) + "，" + scan.objects + " 个对象，" + scan.pages + " 页", done);
      return;
    }
    if (!page.token) throw new Error("桶 " + s.bucket + " 列举返回截断但没有续页 token");
    if (scan.pages >= SCAN_MAX_PAGES) throw new Error("桶 " + s.bucket + " 超过 " + SCAN_MAX_PAGES + " 页仍未列举完");
    scan.token = page.token;
  }
  writeJSON(ctx, "scan", scan);
  status.scanning = { id: s.id, name: s.name, pages: scan.pages, objects: scan.objects, bytes: scan.bytes, startedAt: scan.startedAt };
}

function alertOnce(ctx, cfg, status, text, now) {
  const last = status.lastAlert;
  if (last && last.text === text && now - last.at < ALERT_REPEAT_MS) return;
  status.lastAlert = { text, at: now };
  appendLog(ctx, text, now);
  if (cfg) notify(ctx, cfg, text);
  else ctx.log.warn("bucket-rotate alert", { text });
}

function notify(ctx, cfg, text) {
  ctx.log.info("bucket-rotate", { text });
  if (!cfg.webhookTarget) return;
  try {
    ctx.webhook.send(cfg.webhookTarget, { message: "[AxonHub 切桶] " + text });
  } catch (err) {
    ctx.log.error("webhook send failed", { code: err && err.code ? String(err.code) : "unknown" });
  }
}

function appendLog(ctx, text, at) {
  const log = readJSON(ctx, "log") || [];
  log.unshift({ at, text });
  writeJSON(ctx, "log", log.slice(0, LOG_LIMIT));
}

function readJSON(ctx, key) {
  return safeParse(ctx.kv.get(key));
}

function safeParse(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function writeJSON(ctx, key, value) {
  ctx.kv.set(key, JSON.stringify(value));
}
