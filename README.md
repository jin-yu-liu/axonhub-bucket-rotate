# 载荷存储切桶（AxonHub 插件）

当 AxonHub 当前默认的载荷存储（S3 桶）接近阈值时，自动把默认数据存储切到下一个桶。
历史请求仍按记录里的 `data_storage_id` 从原桶读取和清理，**不迁移数据、不改 AxonHub 代码、不重启**。

> English summary: Switches AxonHub's default payload data storage to the next S3 bucket before the current one
> reaches a size threshold. Old requests keep reading from their original bucket. Includes a status page.

- 插件 ID：`jinyuliu.bucket-rotate`
- 需要 AxonHub `^1.0.0`（插件系统，`pluginApiVersion: 1`）
- 支持任何 S3 协议的对象存储：AWS S3、Cloudflare R2、MinIO、阿里云 OSS、腾讯云 COS 等

## 工作方式

插件没有定时器，所以用 `request.completed` 事件当时钟：每个 VM 至少间隔 10 秒才处理一次，
再用一个短期 KV 锁避免并发。每次只做一小步，保证在 10 秒钩子超时内完成：

1. 每隔 `checkIntervalMinutes`（默认 10 分钟）检查一次：用专用管理员账号登录本站管理接口，读取当前默认存储和存储列表，
   校验配置里的每个桶都在 AxonHub 中存在、不是主数据库、是 S3、桶名一致；不一致就停下并告警。
2. 需要测量时，用只读密钥分段列举桶（ListObjectsV2，SigV4 签名），每次约 6.5 秒，进度存在插件 KV，
   直到列完才得到用量。用量低时少测：<50% 每 60 分钟、<80% 每 20 分钟、≥80% 每次检查都测。
3. 用量 ≥ `阈值 × switchRatio`（默认 95%）时，按配置顺序循环找下一个**状态 active、且用量 < `阈值 × targetMaxRatio`（默认 80%）**的桶
   （候选桶用量超过 30 分钟会先重新测量），调用 `updateDefaultDataStorage` 切换，再复查一次。
4. 切换和告警写进状态页记录，并可通过已有的 WebHook 目标发通知。

保护措施：

- 当前默认存储不在轮换列表（例如有人手动改了）→ 不接管，只告警。
- 所有候选桶都满或不可用 → 不切换，告警“请新增存储或清理旧数据”。
- 两次切换至少间隔 `cooldownMinutes`（默认 30 分钟）。
- 任一步出错（登录失败、列举 403 等）→ 不做任何切换，5 分钟后重试；同一告警 1 小时只发一次。
- 默认**演练模式**（`dryRun: true`）：只记录判断，不自动切换。确认测量正常后再关闭。

**没有请求就不会检查**：没有请求也就没有新载荷写入，所以不影响切换；但状态页的手动操作同样要等下一个请求经过才执行（约 10 秒）。

## 为什么要专用管理员账号

AxonHub 插件权限里没有 `write_settings` / `read_data_storages`，插件无法直接调用切换默认存储的接口。
本插件通过宿主代发请求（`ctx.fetch`）调用本站的 `/admin/auth/signin` 和 `/admin/graphql`，和外部运维脚本的做法相同。
建议单独建一个账号，只授予 `read_settings`、`write_settings`、`read_data_storages` 三个权限，审计日志也能和人工操作区分。

## 安装

1. 在 AxonHub「数据存储」里建好 2 个及以上 S3 存储，记下各自 ID。
2. 为每个桶准备一把**只有 ListBucket 权限**的只读密钥（AxonHub 接口不返回 S3 密钥）。
3. 在「插件」页从市场安装（或上传 `.axplugin`），授权：
   - 权限 `webhook`（只用于发通知，可不授）
   - 出站规则 `^https://[^/]+/admin/(auth/signin|graphql)$`：调用本站管理接口
   - 出站规则 `^https://[^/]+/[A-Za-z0-9._-]{0,63}$`：列举 S3 桶（路径形如 `https://端点/桶名` 或 `https://桶名.端点/`）
4. 填写配置后启用：

| 字段 | 说明 |
|---|---|
| `axonhubUrl` | 本站外部地址，如 `https://ai.example.com` |
| `adminEmail` / `adminPassword` | 专用管理员账号 |
| `storages` | JSON 数组，按轮换顺序，见下例 |
| `thresholdGb` | 单桶阈值，默认 10 |
| `switchRatio` / `targetMaxRatio` | 切换线 / 候选上限比例，默认 0.95 / 0.8 |
| `cooldownMinutes` | 两次切换最短间隔，默认 30 |
| `checkIntervalMinutes` | 检查间隔，默认 10 |
| `dryRun` | 演练模式，默认开启 |
| `webhookTarget` | 已有 WebHook 目标名，留空不通知 |

```json
[
  {"id": 2, "name": "载荷桶1", "endpoint": "https://<account>.r2.cloudflarestorage.com", "region": "auto",
   "bucket": "payload-1", "accessKeyId": "...", "secretAccessKey": "...", "pathStyle": true},
  {"id": 3, "name": "载荷桶2", "endpoint": "https://<account>.r2.cloudflarestorage.com", "region": "auto",
   "bucket": "payload-2", "accessKeyId": "...", "secretAccessKey": "...", "pathStyle": true}
]
```

`endpoint` 与 AxonHub 中该存储填写的一致；阿里云 OSS 等要求虚拟主机风格的填 `"pathStyle": false`。

## 状态页

侧栏「插件 → 载荷存储切桶」：当前默认存储、模式、各桶用量和测量时间、最近 40 条记录；
有 `write_plugins` 权限的用户可以对某个桶点「测量」或「设为默认」（手动切换不受演练模式限制）。

## 注意事项

- **阈值是软上限**：列举有延迟，切换前后仍有写入，所以默认在 95% 时切换；单桶硬配额请在对象存储侧另设。
- **列举费用**：每次列举 = 对象数 ÷ 1000 次 List 请求。
- **多实例 / 蓝绿升级**：AxonHub 用进程内存缓存系统设置时，切换只立即作用到接到调用的实例，其他实例等缓存过期。
- **只覆盖请求载荷**：视频存储是另一套设置，不在本插件范围内；本地目录（fs）存储无法从插件测量，不支持。
- 停用插件不会改动默认存储；要切回某个桶，在状态页点「设为默认」或在 AxonHub 后台手动设置。

## 开发

```bash
npm test                                             # 单元测试（Node 20+）
go install github.com/looplj/axonhub/cmd/pack-plugin@unstable
pack-plugin . -o ../bucket-rotate-0.1.0.axplugin     # 打包
```

## License

MIT
