# 载荷存储切桶（AxonHub 插件）

当 AxonHub 当前默认的载荷存储（S3 桶）接近阈值时，自动把默认数据存储切到下一个桶。
历史请求仍按记录里的 `data_storage_id` 从原桶读取和清理，**不迁移数据、不改 AxonHub 代码、不重启**。

**典型用法：多个 Cloudflare R2 桶轮流用满免费 10G 额度。** 在 AxonHub 里建好几个 R2 存储（每个桶 10G 免费），
插件在当前桶快到 10G 时自动切到下一个还有空间的桶，全程不用手动改设置。

> English summary: Reads the S3 data storages already configured in AxonHub and switches the default payload storage
> to the next one (in the order you choose) before the current bucket reaches a size threshold — e.g. rotating several
> Cloudflare R2 buckets within the 10 GB free tier. Old requests keep reading from their original bucket. Includes a status page.

- 插件 ID：`jinyuliu.bucket-rotate`
- 需要 AxonHub `^1.0.0`（插件系统，`pluginApiVersion: 1`）
- 支持任何 S3 协议的对象存储：Cloudflare R2、AWS S3、MinIO、阿里云 OSS、腾讯云 COS 等

## 工作方式

插件没有定时器，所以用 `request.completed` 事件当时钟：每个 VM 至少间隔 10 秒才处理一次，
再用一个短期 KV 锁避免并发。每次只做一小步，保证在 10 秒钩子超时内完成：

1. 每隔 `checkIntervalMinutes`（默认 10 分钟）检查一次：用专用管理员账号登录本站管理接口，
   **自动读取 AxonHub 里已配置的数据存储**（名称、桶名、端点、区域），按「轮换顺序」排出轮换列表。
   轮换顺序留空时，使用全部非主库的 S3 存储，按 ID 排序。
2. 需要测量时，用只读密钥分段列举桶（ListObjectsV2，SigV4 签名），每次约 6.5 秒，进度存在插件 KV，
   直到列完才得到用量。用量低时少测：<50% 每 60 分钟、<80% 每 20 分钟、≥80% 每次检查都测。
3. 用量 ≥ `阈值 × switchRatio`（默认 95%）时，按顺序循环找下一个**状态 active、且用量 < `阈值 × targetMaxRatio`（默认 80%）**的桶
   （候选桶用量超过 30 分钟会先重新测量），调用 `updateDefaultDataStorage` 切换，再复查一次。
4. 切换和告警写进状态页记录，并可通过已有的 WebHook 目标发通知。

保护措施：

- 当前默认存储不在轮换列表（例如有人手动改成了别的存储）→ 不接管，只告警。
- 轮换顺序里的名称找不到、是主库、不是 S3、没有密钥 → 停下并告警，不切换。
- 所有候选桶都满或不可用 → 不切换，告警“请新增存储或清理旧数据”。
- 两次切换至少间隔 `cooldownMinutes`（默认 30 分钟）。
- 任一步出错（登录失败、列举 403 等）→ 不做任何切换，5 分钟后重试；同一告警 1 小时只发一次。
- 默认**演练模式**（`dryRun: true`）：只记录判断，不自动切换。确认测量正常后再关闭。
- 只读密钥只在内存里使用，不写入插件 KV（状态页能读到 KV）。

**没有请求就不会检查**：没有请求也就没有新载荷写入，所以不影响切换；但状态页的手动操作同样要等下一个请求经过才执行（约 10 秒）。

## 为什么还要填只读密钥

AxonHub 的管理接口能返回存储的桶名、端点、区域，但**不返回 S3 密钥**，插件无法用它去统计桶的用量，
所以需要另外填一把**只读**密钥（只需要列举对象的权限）。多数情况下一把密钥就够：

- **Cloudflare R2**：在 R2 →「管理 API 令牌」创建一个令牌，权限选 **对象读（Object Read only）**，
  作用范围选这几个载荷桶（或全部桶），把得到的 Access Key ID / Secret Access Key 填进插件。所有桶共用这一把。
- 个别桶在另一个账号、不能共用时，在「个别桶的单独密钥」里填 `存储名称=AccessKeyID:SecretKey`，多条用分号分隔。

## 为什么要专用管理员账号

AxonHub 插件权限里没有 `write_settings` / `read_data_storages`，插件无法直接读取存储列表或切换默认存储。
本插件通过宿主代发请求（`ctx.fetch`）调用本站的 `/admin/auth/signin` 和 `/admin/graphql`，和外部运维脚本的做法相同。
建议单独建一个账号，只授予 `read_settings`、`write_settings`、`read_data_storages` 三个权限，审计日志也能和人工操作区分。

## 安装

1. 在 AxonHub「数据存储」里建好 2 个及以上 S3 存储（例如 R2-1、R2-2、R2-3，每个对应一个 R2 桶）。
2. 准备一把只读密钥（见上一节）。
3. 在「插件」页从市场安装（或上传 `.axplugin`），授权：
   - 权限 `webhook`（只用于发通知，可不授）
   - 出站规则 `^https://[^/]+/admin/(auth/signin|graphql)$`：调用本站管理接口
   - 出站规则 `^https://[^/]+/[A-Za-z0-9._-]{0,63}$`：列举 S3 桶（路径形如 `https://端点/桶名` 或 `https://桶名.端点/`）
4. 填写配置后启用：

| 字段 | 说明 |
|---|---|
| AxonHub 地址 `axonhubUrl` | 本站外部地址，如 `https://ai.example.com` |
| 专用管理员 `adminEmail` / `adminPassword` | 见上文 |
| 轮换顺序 `rotationOrder` | 数据存储的名称或 ID，逗号分隔，如 `R2-1, R2-2, R2-3`；留空 = 全部非主库 S3 存储按 ID |
| 只读密钥 `accessKeyId` / `secretAccessKey` | 所有桶共用 |
| 单独密钥 `extraCredentials` | 可选，`存储名称=AK:SK; 存储名称2=AK:SK` |
| 单桶阈值 `thresholdGb` | 默认 10（R2 免费额度） |
| `switchRatio` / `targetMaxRatio` | 切换线 / 候选上限比例，默认 0.95 / 0.8 |
| `cooldownMinutes` | 两次切换最短间隔，默认 30 |
| `checkIntervalMinutes` | 检查间隔，默认 10 |
| `dryRun` | 演练模式，默认开启 |
| `webhookTarget` | 已有 WebHook 目标名，留空不通知 |

### Cloudflare R2 免费 10G 推荐配置

- 每个桶在 AxonHub 里单独建一个 S3 存储：端点 `https://<账号ID>.r2.cloudflarestorage.com`，区域 `auto`，路径风格开启。
- `thresholdGb = 10`、`switchRatio = 0.95`（约 9.5G 切换）、`targetMaxRatio = 0.8`。
- 桶都快满时插件会告警，再新建一个 R2 桶加进 AxonHub 和轮换顺序即可；也可以清理旧桶后让它重新进入轮换。
- R2 的 List 请求属于 A 类操作（免费额度每月 100 万次），每次测量 = 对象数 ÷ 1000 次请求。

## 状态页

侧栏「插件 → 载荷存储切桶」：当前默认存储、模式、按顺序排列的轮换存储及用量和测量时间、未参与轮换的存储、最近 40 条记录；
有 `write_plugins` 权限的用户可以对某个桶点「测量」或「设为默认」（手动切换不受演练模式限制）。

## 从 0.1.x 升级

0.2.0 起不再需要填写 `storages` JSON：存储列表从 AxonHub 自动读取，配置里只填轮换顺序和只读密钥。
升级后请在设置里补填 `rotationOrder`（可留空）和 `accessKeyId` / `secretAccessKey`。

## 注意事项

- **阈值是软上限**：列举有延迟，切换前后仍有写入，所以默认在 95% 时切换；单桶硬配额请在对象存储侧另设。
- **多实例 / 蓝绿升级**：AxonHub 用进程内存缓存系统设置时，切换只立即作用到接到调用的实例，其他实例等缓存过期。
- **只覆盖请求载荷**：视频存储是另一套设置，不在本插件范围内；本地目录（fs）存储无法从插件测量，不支持。
- 停用插件不会改动默认存储；要切回某个桶，在状态页点「设为默认」或在 AxonHub 后台手动设置。

## 开发

```bash
npm test                                             # 单元测试（Node 20+）
go install github.com/looplj/axonhub/cmd/pack-plugin@unstable
pack-plugin . -o ../bucket-rotate-0.2.0.axplugin     # 打包
```

## License

MIT
