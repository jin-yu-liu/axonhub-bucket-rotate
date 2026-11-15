// Calls this AxonHub's own admin API through the host-proxied ctx.fetch.
// Plugins cannot be granted write_settings, so switching the default data storage
// goes through a dedicated admin account, the same way an external script would.
import { gidInt } from "./rotate.js";

const Q_STATE = `query BucketRotateState {
  defaultDataStorageID
  dataStorages(first: 200) { edges { node { id name type status primary settings { s3 { bucketName } } } } }
}`;

const M_SWITCH = `mutation BucketRotateSwitch($id: ID!) {
  updateDefaultDataStorage(input: { dataStorageID: $id })
}`;

async function postJSON(ctx, url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await ctx.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  let data = null;
  try {
    data = JSON.parse(res.body || "{}");
  } catch (e) {
    data = null;
  }
  return { status: res.status, data };
}

export async function login(ctx, cfg) {
  const res = await postJSON(ctx, cfg.axonhubUrl + "/admin/auth/signin", {
    email: cfg.adminEmail,
    password: cfg.adminPassword,
  });
  const token = res.data && res.data.token;
  if (res.status !== 200 || !token) throw new Error("AxonHub 登录失败：HTTP " + res.status);
  return token;
}

async function gql(ctx, cfg, token, query, variables) {
  const res = await postJSON(ctx, cfg.axonhubUrl + "/admin/graphql", { query, variables: variables || {} }, token);
  if (res.status !== 200 || !res.data) throw new Error("AxonHub GraphQL HTTP " + res.status);
  if (res.data.errors && res.data.errors.length) {
    throw new Error("AxonHub GraphQL 错误：" + res.data.errors.map((e) => e.message).join("; "));
  }
  return res.data.data || {};
}

/** Returns { currentId, nodes: { [id]: node } }. */
export async function readState(ctx, cfg, token) {
  const d = await gql(ctx, cfg, token, Q_STATE);
  const nodes = {};
  const edges = (d.dataStorages && d.dataStorages.edges) || [];
  for (const e of edges) nodes[gidInt(e.node.id)] = e.node;
  return { currentId: gidInt(d.defaultDataStorageID), nodes };
}

export async function switchDefault(ctx, cfg, token, nodeGid) {
  const d = await gql(ctx, cfg, token, M_SWITCH, { id: nodeGid });
  if (d.updateDefaultDataStorage !== true) throw new Error("切换返回异常");
}
