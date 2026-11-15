// Pure decision logic: config parsing, measurement scheduling and the switch decision.

export const GB = 1024 * 1024 * 1024;

const DEFAULTS = {
  thresholdGb: 10,
  switchRatio: 0.95,
  targetMaxRatio: 0.8,
  cooldownMinutes: 30,
  checkIntervalMinutes: 10,
  candidateFreshMinutes: 30,
  dryRun: true,
  webhookTarget: "",
};

// usage ratio upper bound -> minimum minutes between two measurements of the current bucket.
// At >= 80 % the bucket is re-measured on every check (a fresh scan is used for the decision right after it).
export const MEASURE_INTERVALS = [
  [0.5, 60],
  [0.8, 20],
  [Infinity, 1],
];

function num(v, d) {
  return typeof v === "number" && isFinite(v) ? v : d;
}

/** Validate ctx.config and fill defaults. Throws Error with a readable message. */
export function parseConfig(raw) {
  const c = raw || {};
  const url = String(c.axonhubUrl || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(url)) throw new Error("axonhubUrl 必须是 https://域名（不带路径）");
  if (!c.adminEmail) throw new Error("adminEmail 未填写");
  if (!c.adminPassword) throw new Error("adminPassword 未填写");
  const ak = String(c.accessKeyId || "").trim();
  const sk = String(c.secretAccessKey || "").trim();
  if (!ak !== !sk) throw new Error("accessKeyId 和 secretAccessKey 要同时填写");
  const cfg = {
    axonhubUrl: url,
    adminEmail: String(c.adminEmail),
    adminPassword: String(c.adminPassword),
    order: splitList(c.rotationOrder),
    defaultKey: ak ? { accessKeyId: ak, secretAccessKey: sk } : null,
    keyOverrides: parseOverrides(c.extraCredentials),
    storages: [],
    thresholdBytes: num(c.thresholdGb, DEFAULTS.thresholdGb) * GB,
    switchRatio: num(c.switchRatio, DEFAULTS.switchRatio),
    targetMaxRatio: num(c.targetMaxRatio, DEFAULTS.targetMaxRatio),
    cooldownMinutes: num(c.cooldownMinutes, DEFAULTS.cooldownMinutes),
    checkIntervalMinutes: Math.max(1, num(c.checkIntervalMinutes, DEFAULTS.checkIntervalMinutes)),
    candidateFreshMinutes: DEFAULTS.candidateFreshMinutes,
    dryRun: typeof c.dryRun === "boolean" ? c.dryRun : DEFAULTS.dryRun,
    webhookTarget: String(c.webhookTarget || "").trim(),
  };
  if (!cfg.defaultKey && !Object.keys(cfg.keyOverrides).length) throw new Error("请填写只读密钥 accessKeyId / secretAccessKey");
  if (!(cfg.thresholdBytes > 0)) throw new Error("thresholdGb 必须大于 0");
  if (!(cfg.targetMaxRatio > 0 && cfg.targetMaxRatio < cfg.switchRatio && cfg.switchRatio <= 1)) {
    throw new Error("需要满足 0 < targetMaxRatio < switchRatio <= 1");
  }
  return cfg;
}

/** "a, b，c" or ["a","b"] -> ["a","b","c"] */
function splitList(v) {
  const parts = Array.isArray(v) ? v.map(String) : String(v || "").split(/[,，;；\n]/);
  return parts.map((x) => x.trim()).filter(Boolean);
}

/** "桶3=AK:SK; 5=AK2:SK2" -> { "桶3": {...}, "5": {...} } */
function parseOverrides(v) {
  const out = {};
  for (const line of String(v || "").split(/[;；\n]/)) {
    const s = line.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    const colon = s.indexOf(":", eq + 1);
    const key = eq > 0 ? s.slice(0, eq).trim() : "";
    const ak = colon > eq ? s.slice(eq + 1, colon).trim() : "";
    const sk = colon > eq ? s.slice(colon + 1).trim() : "";
    if (!key || !ak || !sk) throw new Error("extraCredentials 格式应为 存储名称或ID=AccessKeyID:SecretKey，多条用分号分隔");
    out[key] = { accessKeyId: ak, secretAccessKey: sk };
  }
  return out;
}

export function fmtGb(bytes) {
  return (bytes / GB).toFixed(2) + "G";
}

/** Parse a GraphQL global id like "gid://axonhub/DataStorage/3" to 3. */
export function gidInt(gid) {
  if (gid === null || gid === undefined || gid === "") return 0;
  const tail = String(gid).replace(/\/+$/, "").split("/").pop();
  const n = Number(tail);
  if (!(n >= 0) || Math.floor(n) !== n) throw new Error("无法解析 ID：" + gid);
  return n;
}

function isS3(n) {
  return String(n.type || "").toLowerCase() === "s3";
}

/** Public (non-secret) view of every data storage AxonHub has. */
export function describeStorages(nodes) {
  return Object.keys(nodes)
    .map(Number)
    .sort((a, b) => a - b)
    .map((id) => {
      const n = nodes[id];
      const s3 = (n.settings && n.settings.s3) || {};
      return { id, name: n.name || "#" + id, type: n.type, status: n.status, primary: !!n.primary, bucket: s3.bucketName || "" };
    });
}

/**
 * Build the rotation list from the storages configured in AxonHub.
 * cfg.order holds names / IDs / bucket names; empty means every non-primary S3 storage by ID.
 * Returns { storages: [{ id, name, bucket, endpoint, region, pathStyle }], problems: [string] }.
 */
export function resolveRotation(cfg, nodes) {
  const problems = [];
  const all = Object.keys(nodes).map(Number).sort((a, b) => a - b);
  let ids = [];
  if (!cfg.order.length) {
    ids = all.filter((id) => isS3(nodes[id]) && !nodes[id].primary);
  } else {
    for (const token of cfg.order) {
      const id = findStorage(nodes, all, token);
      if (!id) {
        problems.push("轮换顺序里的「" + token + "」在 AxonHub 数据存储中找不到");
        continue;
      }
      const n = nodes[id];
      if (n.primary) problems.push("「" + n.name + "」是主数据库存储，不能放进轮换");
      else if (!isS3(n)) problems.push("「" + n.name + "」类型是 " + n.type + "，本插件只支持 S3");
      else if (ids.indexOf(id) >= 0) problems.push("「" + n.name + "」在轮换顺序里重复");
      else ids.push(id);
    }
  }
  const storages = ids.map((id) => {
    const n = nodes[id];
    const s3 = (n.settings && n.settings.s3) || {};
    return {
      id,
      name: n.name || "#" + id,
      bucket: s3.bucketName || "",
      endpoint: s3.endpoint || "",
      region: s3.region || "us-east-1",
      pathStyle: s3.pathStyle !== false,
    };
  });
  for (const s of storages) {
    if (!s.bucket) problems.push("「" + s.name + "」没有桶名");
    if (!credentialsFor(cfg, s)) problems.push("「" + s.name + "」没有可用的只读密钥");
  }
  if (!problems.length && storages.length < 2) {
    problems.push("可轮换的 S3 存储只有 " + storages.length + " 个，至少需要 2 个");
  }
  return { storages, problems };
}

function findStorage(nodes, all, token) {
  if (/^\d+$/.test(token) && nodes[Number(token)]) return Number(token);
  for (const id of all) if (String(nodes[id].name || "").trim() === token) return id;
  for (const id of all) {
    const s3 = nodes[id].settings && nodes[id].settings.s3;
    if (s3 && s3.bucketName === token) return id;
  }
  return 0;
}

/** Read-only S3 key for a storage: a per-storage override (by ID, name or bucket), else the shared key. */
export function credentialsFor(cfg, s) {
  const o = cfg.keyOverrides;
  return o[String(s.id)] || o[s.name] || o[s.bucket] || cfg.defaultKey || null;
}

/** Whether the current bucket needs a new measurement. */
export function measureDue(cfg, entry, now) {
  if (!entry) return true;
  const ratio = entry.bytes / cfg.thresholdBytes;
  for (const [upto, minutes] of MEASURE_INTERVALS) {
    if (ratio < upto) return now - entry.at >= minutes * 60000;
  }
  return true;
}

/**
 * Decide what to do. usage maps storage id -> { bytes, objects, at } (ms epoch).
 * Returns { action: "noop" | "measure" | "switch" | "alert", reason, storageId?, target? }.
 * "measure" means: scan storageId first, then evaluate again.
 */
export function evaluate(cfg, currentId, nodes, usage, lastSwitchAt, now) {
  const ids = cfg.storages.map((s) => s.id);
  const idx = ids.indexOf(currentId);
  if (idx < 0) {
    return { action: "alert", reason: "当前默认存储 ID " + currentId + " 不在轮换列表（" + cfg.storages.map((s) => s.name).join(" → ") + "）中，插件不接管，请人工确认" };
  }
  const cur = cfg.storages[idx];
  const curUsage = usage[cur.id];
  if (measureDue(cfg, curUsage, now)) {
    return { action: "measure", storageId: cur.id, reason: "测量当前桶 " + cur.name };
  }
  const used = curUsage.bytes;
  const trigger = cfg.thresholdBytes * cfg.switchRatio;
  if (used < trigger) {
    return { action: "noop", reason: cur.name + " 已用 " + fmtGb(used) + "，切换线 " + fmtGb(trigger) };
  }
  if (now - (lastSwitchAt || 0) < cfg.cooldownMinutes * 60000) {
    return { action: "alert", reason: cur.name + " 已用 " + fmtGb(used) + " 超过切换线，但距上次切换不足 " + cfg.cooldownMinutes + " 分钟，暂不再切" };
  }
  const limit = cfg.thresholdBytes * cfg.targetMaxRatio;
  const skipped = [];
  for (let step = 1; step < ids.length; step++) {
    const cand = cfg.storages[(idx + step) % ids.length];
    const node = nodes[cand.id] || {};
    if (String(node.status || "").toLowerCase() !== "active") {
      skipped.push(cand.name + "（状态 " + node.status + "）");
      continue;
    }
    const u = usage[cand.id];
    if (!u || now - u.at > cfg.candidateFreshMinutes * 60000) {
      return { action: "measure", storageId: cand.id, reason: "测量候选桶 " + cand.name };
    }
    if (u.bytes >= limit) {
      skipped.push(cand.name + "（已用 " + fmtGb(u.bytes) + "）");
      continue;
    }
    return {
      action: "switch",
      target: cand,
      reason: cur.name + " 已用 " + fmtGb(used) + " ≥ 切换线 " + fmtGb(trigger) + "，切到 " + cand.name + "（已用 " + fmtGb(u.bytes) + "）",
    };
  }
  return {
    action: "alert",
    reason: cur.name + " 已用 " + fmtGb(used) + " 超过切换线，但没有可用的下一个桶：" + skipped.join("、") + "。请新增存储或清理旧数据",
  };
}
