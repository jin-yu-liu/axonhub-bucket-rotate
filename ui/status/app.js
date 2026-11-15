const axonhub = window.axonhub;
const GB = 1024 * 1024 * 1024;

const COPY = {
  zh: {
    title: "载荷存储切桶",
    lead: "当前默认载荷桶接近阈值时，自动把默认数据存储切到下一个桶。历史请求仍从原桶读取。",
    refresh: "刷新",
    loading: "加载中…",
    noStatus: "还没有检查记录。插件由请求完成事件驱动，有请求经过后约 10 秒内开始第一次检查。",
    current: "当前默认存储",
    mode: "模式",
    dryRun: "演练（只记录不切换）",
    live: "自动切换",
    threshold: "阈值 / 切换线 / 候选上限",
    checkedAt: "上次检查",
    nextCheck: "下次检查",
    lastSwitch: "上次切换",
    lastDecision: "上次判断",
    problems: "配置问题",
    buckets: "轮换中的存储",
    cols: ["存储", "ID", "桶", "状态", "已用", "对象数", "测量时间", ""],
    measure: "测量",
    switchTo: "设为默认",
    confirmSwitch: (n) => "把默认存储切换到「" + n + "」？新请求会写入该桶。",
    queued: "已提交，下一次请求经过时执行（约 10 秒内）。",
    pendingCmd: (c) => "待执行指令：" + c,
    scanning: (s) => "正在测量 " + s.name + "：已列举 " + s.pages + " 页 / " + s.objects + " 个对象",
    log: "最近记录",
    none: "—",
    noWrite: "当前账号没有 write_plugins 权限，不能提交操作。",
  },
  en: {
    title: "Payload bucket rotate",
    lead: "Switches the default data storage to the next bucket before the current one fills up. Old requests keep reading from their original bucket.",
    refresh: "Refresh",
    loading: "Loading…",
    noStatus: "No check yet. The plugin is driven by request.completed events; the first check starts within ~10 s after traffic arrives.",
    current: "Current default storage",
    mode: "Mode",
    dryRun: "Dry run (log only)",
    live: "Auto switch",
    threshold: "Threshold / switch line / candidate max",
    checkedAt: "Last check",
    nextCheck: "Next check",
    lastSwitch: "Last switch",
    lastDecision: "Last decision",
    problems: "Config problems",
    buckets: "Rotated storages",
    cols: ["Storage", "ID", "Bucket", "Status", "Used", "Objects", "Measured", ""],
    measure: "Measure",
    switchTo: "Make default",
    confirmSwitch: (n) => "Switch the default storage to \"" + n + "\"? New requests will be written there.",
    queued: "Queued. It runs on the next request (within ~10 s).",
    pendingCmd: (c) => "Pending command: " + c,
    scanning: (s) => "Measuring " + s.name + ": " + s.pages + " pages / " + s.objects + " objects so far",
    log: "Recent log",
    none: "—",
    noWrite: "Your account lacks write_plugins and cannot submit actions.",
  },
};

let t = COPY.zh;
let canWrite = false;

const $ = (id) => document.getElementById(id);

const READ = `query BucketRotateKV {
  status: pluginKV(key: "status") { value }
  log: pluginKV(key: "log") { value }
  command: pluginKV(key: "command") { value }
  usage: pluginKVList(prefix: "usage.", first: 100) { entries { key value } }
}`;
const WRITE = `mutation BucketRotateCommand($value: String!) {
  setPluginKV(key: "command", value: $value) { key }
}`;

if (!axonhub) {
  $("status").textContent = "AxonHub bridge did not load";
} else {
  start().catch(showError);
}

async function start() {
  const init = await axonhub.ready();
  t = String(init.locale || "").toLowerCase().startsWith("zh") ? COPY.zh : COPY.en;
  document.documentElement.lang = init.locale || "zh-CN";
  canWrite = !!init.canWriteKV;
  $("heading").textContent = t.title;
  $("lead").textContent = t.lead;
  $("refresh").textContent = t.refresh;
  $("buckets-title").textContent = t.buckets;
  $("log-title").textContent = t.log;
  const head = $("buckets-head");
  head.replaceChildren(...t.cols.map((c) => el("th", c)));
  $("refresh").addEventListener("click", () => load().catch(showError));
  await load();
}

function parse(entry) {
  if (!entry || !entry.value) return null;
  try {
    return JSON.parse(entry.value);
  } catch (e) {
    return null;
  }
}

async function load() {
  setStatus(t.loading);
  const res = await axonhub.graphql(READ);
  if (res.errors && res.errors.length) throw new Error(res.errors.map((e) => e.message).join("; "));
  const d = res.data || {};
  const status = parse(d.status);
  const log = parse(d.log) || [];
  const command = parse(d.command);
  const usage = {};
  for (const e of (d.usage && d.usage.entries) || []) {
    const v = parse(e);
    if (v) usage[e.key.slice("usage.".length)] = v;
  }
  render(status, usage, log, command);
  setStatus(canWrite ? "" : t.noWrite);
}

function render(status, usage, log, command) {
  const summary = $("summary");
  const tbody = $("buckets");
  if (!status || !status.storages) {
    summary.replaceChildren(item(t.current, t.noStatus));
    tbody.replaceChildren();
  } else {
    const cur = status.storages.find((s) => s.id === status.currentId);
    const th = status.thresholdBytes || 0;
    const items = [
      item(t.current, cur ? cur.name + " (ID " + cur.id + ")" : "ID " + status.currentId),
      item(t.mode, status.dryRun ? t.dryRun : t.live),
      item(t.threshold, gb(th) + " / " + gb(th * status.switchRatio) + " / " + gb(th * status.targetMaxRatio)),
      item(t.checkedAt, time(status.checkedAt)),
      item(t.nextCheck, status.nextCheckAt ? time(status.nextCheckAt) : t.none),
      item(t.lastSwitch, status.lastSwitch ? time(status.lastSwitch.at) + " · " + status.lastSwitch.reason : t.none),
      item(t.lastDecision, status.lastDecision ? status.lastDecision.reason : t.none),
    ];
    if (status.problems && status.problems.length) items.push(item(t.problems, status.problems.join("；")));
    summary.replaceChildren(...items);

    tbody.replaceChildren(
      ...status.storages.map((s) => {
        const u = usage[String(s.id)];
        const ratio = u && th ? u.bytes / th : 0;
        const bar = el("span", "");
        bar.className = "bar" + (ratio >= status.switchRatio ? " warn" : "");
        const fill = el("span", "");
        fill.style.width = Math.min(100, ratio * 100).toFixed(1) + "%";
        bar.append(fill);
        const used = el("td", "");
        used.className = "num";
        used.append(bar, document.createTextNode(u ? gb(u.bytes) + " (" + (ratio * 100).toFixed(1) + "%)" : t.none));
        const name = el("td", s.name + " ");
        if (s.id === status.currentId) name.append(tag("default"));
        const actions = el("td", "");
        actions.className = "actions";
        actions.append(
          button(t.measure, () => submit({ type: "measure", id: s.id })),
          button(t.switchTo, () => {
            if (window.confirm(t.confirmSwitch(s.name))) submit({ type: "switch", to: s.id });
          }, s.id === status.currentId || String(s.status).toLowerCase() !== "active"),
        );
        const objects = el("td", u ? String(u.objects) : t.none);
        objects.className = "num";
        return row([name, el("td", String(s.id)), el("td", s.bucket), el("td", s.status), used, objects, el("td", u ? time(u.at) : t.none), actions]);
      }),
    );
  }
  const pending = [];
  if (status && status.scanning) pending.push(t.scanning(status.scanning));
  if (command) pending.push(t.pendingCmd(command.type + (command.to ? " → " + command.to : command.id ? " " + command.id : "")));
  $("pending").textContent = pending.join("　");

  $("log").replaceChildren(
    ...log.map((l) => {
      const li = el("li", "");
      li.append(el("time", time(l.at)), el("span", l.text));
      return li;
    }),
  );
}

async function submit(cmd) {
  try {
    cmd.at = Date.now();
    const res = await axonhub.graphql(WRITE, { value: JSON.stringify(cmd) });
    if (res.errors && res.errors.length) throw new Error(res.errors.map((e) => e.message).join("; "));
    await axonhub.toast(t.queued, { kind: "success" });
    await load();
  } catch (err) {
    showError(err);
  }
}

function item(label, value) {
  const d = el("div", "");
  d.append(el("dt", label), el("dd", value));
  return d;
}

function row(cells) {
  const tr = el("tr", "");
  tr.append(...cells);
  return tr;
}

function tag(text) {
  const s = el("span", text);
  s.className = "tag";
  return s;
}

function button(label, onClick, disabled) {
  const b = el("button", label);
  b.type = "button";
  b.className = "secondary";
  b.disabled = !canWrite || !!disabled;
  b.addEventListener("click", onClick);
  return b;
}

function el(name, text) {
  const n = document.createElement(name);
  if (text) n.textContent = text;
  return n;
}

function gb(bytes) {
  return (bytes / GB).toFixed(2) + "G";
}

function time(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function setStatus(text, isError) {
  const s = $("status");
  s.textContent = text;
  s.className = "status" + (isError ? " error" : "");
}

function showError(err) {
  setStatus((err && err.message) || String(err), true);
}
