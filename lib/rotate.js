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
  let list;
  try {
    list = JSON.parse(String(c.storages || ""));
  } catch (e) {
    throw new Error("storages 不是合法 JSON");
  }
  if (!Array.isArray(list) || list.length < 2) throw new Error("storages 至少需要 2 个存储才能轮换");
  const seen = {};
  const storages = list.map((s, i) => {
    const id = Number(s && s.id);
    if (!(id > 0) || Math.floor(id) !== id || seen[id]) throw new Error("storages[" + i + "].id 无效或重复");
    seen[id] = true;
    for (const k of ["bucket", "accessKeyId", "secretAccessKey"]) {
      if (!s[k]) throw new Error("storages[" + i + "]." + k + " 未填写");
    }
    return {
      id,
      name: String(s.name || "#" + id),
      endpoint: String(s.endpoint || ""),
      region: String(s.region || "us-east-1"),
      bucket: String(s.bucket),
      accessKeyId: String(s.accessKeyId),
      secretAccessKey: String(s.secretAccessKey),
      pathStyle: s.pathStyle !== false,
    };
  });
  const cfg = {
    axonhubUrl: url,
    adminEmail: String(c.adminEmail),
    adminPassword: String(c.adminPassword),
    storages,
    thresholdBytes: num(c.thresholdGb, DEFAULTS.thresholdGb) * GB,
    switchRatio: num(c.switchRatio, DEFAULTS.switchRatio),
    targetMaxRatio: num(c.targetMaxRatio, DEFAULTS.targetMaxRatio),
    cooldownMinutes: num(c.cooldownMinutes, DEFAULTS.cooldownMinutes),
    checkIntervalMinutes: Math.max(1, num(c.checkIntervalMinutes, DEFAULTS.checkIntervalMinutes)),
    candidateFreshMinutes: DEFAULTS.candidateFreshMinutes,
    dryRun: typeof c.dryRun === "boolean" ? c.dryRun : DEFAULTS.dryRun,
    webhookTarget: String(c.webhookTarget || "").trim(),
  };
  if (!(cfg.thresholdBytes > 0)) throw new Error("thresholdGb 必须大于 0");
  if (!(cfg.targetMaxRatio > 0 && cfg.targetMaxRatio < cfg.switchRatio && cfg.switchRatio <= 1)) {
    throw new Error("需要满足 0 < targetMaxRatio < switchRatio <= 1");
  }
  return cfg;
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

/** Every configured storage must exist in AxonHub, not be primary, be S3 and point at the same bucket. */
export function validateAgainstAxonHub(cfg, nodes) {
  const problems = [];
  for (const s of cfg.storages) {
    const n = nodes[s.id];
    if (!n) {
      problems.push(s.name + "（ID " + s.id + "）在 AxonHub 中不存在");
      continue;
    }
    if (n.primary) problems.push(s.name + " 是主数据库存储，不能放进轮换列表");
    if (String(n.type || "").toLowerCase() !== "s3") problems.push(s.name + " 在 AxonHub 中的类型是 " + n.type + "，本插件只支持 s3");
    const real = (n.settings && n.settings.s3 && n.settings.s3.bucketName) || "";
    if (real !== s.bucket) problems.push(s.name + " 桶名不一致：配置 " + s.bucket + "，AxonHub " + real);
  }
  return problems;
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
    return { action: "alert", reason: "当前默认存储 ID " + currentId + " 不在轮换列表 [" + ids.join(", ") + "] 中，插件不接管，请人工确认" };
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
