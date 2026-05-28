# Startup Leads 开发规格（最终版）

本版基于 `startup-leads-spec.md` 的资深工程师审查与三轮决策修订（详见 `startup-leads-spec-v2.md` 英文版）。变更点集中在：YC 推迟、HN 走官方 API、引入 domain 别名表、HTTP fetch 抽象层、Feishu 客户端接口化、报告拆两阶段、隐私清理命令、scorer 版本化与若干数据模型修复。

文末附 “相对 v1 的变更对照表”。

## 目的

构建一个 local-first 的命令行工具，用于发现高质量求职线索，把所有采集到的证据存在本地，只把"审核就绪"的公司级机会推送到飞书多维表格做人工审核。

系统优化目标是：线索质量、来源可追溯性、人工审核友好。它不自动发起触达、不推断私人联系方式，v1 不依赖任何需要登录的抓取。

## 产品范围

### 目标用户

中文母语的求职者，方向覆盖：后端工程、AI 应用工程、AI 基础设施、AI native、海外机会、开发者工具。CLI 本身用英文；飞书审核工作区的视图名用中文。

### v1 目标

- 单次手动运行采集最多 50 家候选公司。
- 优先新鲜、可执行的职位与联系人，而不是广覆盖。
- 所有原始结果落本地，包括低分、过期、重复、失败、被排除的记录。
- 只把合格的"公司级"线索推送到飞书供人工审核。
- 模块化设计，方便后续添加新数据源与自动化。

### 明确不做的事（Non-Goals）

- 不做任何自动触达。
- 不自动发送简历或求职信。
- 不做邮箱猜测或推断。
- v1 不做任何需要登录的抓取（含 YC Work at a Startup、LinkedIn、即刻、小红书、微博、X）。
- 不收集私人电话或泄露数据。
- 默认不归档完整 HTML。
- v1 不做简历个性化匹配。
- v1 不做中文社区数据源（即刻 / 小红书 / 微博）。中文支持仅限"品牌名归一化表"，让 "ByteDance" 与 "字节跳动" 能正确去重。
- 不做工作签证资格的自动推断；由用户在飞书人工审核。

## 线索策略

### 公司筛选标准

正向信号：

- 后端、AI 应用、AI 基础设施、开发者工具或相关方向的工程岗位。
- AI native、AI infra、海外、工具型产品方向。
- 远程、混合、可搬迁、对中国时区友好。
- 公开证据来自官方招聘页、HN、YC、GitHub 或公司官网。

硬性排除：

- 强制要求用户无法满足的本地工作授权。
- 强制 onsite 在无法接受的地点。
- 没有清晰产品形态，或疑似空壳/垃圾公司。
- 纯中介/外包，除非明显有意思。
- 信息超过 6 个月且无官方证据印证仍在招。
- 博彩、成人、灰产营销、投机加密、发薪日贷款、数据中介、侵入式监控类产品。
- 联系信息仅来自禁止或高风险来源。

### 新鲜度

按数据源能提供的最佳日期评估：

- `fresh`：30 天内发布/更新。
- `usable`：31 天到 6 个月。
- `stale`：超过 6 个月。
- `unknown`：没有可靠日期，但数据源公开展示该职位。

飞书推送资格：

- `fresh` 与 `usable`：在未过期 / 未拉黑 / 未被规则排除时可推。
- `stale`：永不推送。
- `unknown`：**默认不推送**。当 careers 页 enricher（Phase 5）在公司官网上找到同名归一化职位时，自动提升为 `usable`。未被提升则只留本地。

这条规则替代了 v1 里含糊的"selected unknown 可推"，避免在本地流水线里需要人工裁决。

### 联系人策略

允许的来源：

- 公司官网、团队页、招聘页、联系页。
- 个人主页上展示的公开职业邮箱。
- 公开的 LinkedIn / X / GitHub / 个人主页 URL。
- 招聘页公开的 HR 或招聘经理信息。
- GitHub profile 上本人明示的邮箱。

联系人优先级：

1. 创始人、CTO、工程负责人、AI 负责人、后端负责人、招聘经理。
2. 相关工程经理或目标团队工程师。
3. 招聘 / 人才 / HR。
4. 通用招聘邮箱或申请表。

联系人风险等级：

- `low`：官方或直接公开的职业来源。
- `medium`：公开 profile 或较旧来源，需确认。
- `high`：弱第三方来源或身份存疑。
- `blocked`：禁止来源。

v1 不做邮箱推断。推断邮箱不得入库。

### 本地数据保留策略（PIPL / GDPR 姿态）

- 本地存储是 source of truth，默认无限期保留。
- 必须提供 `startup-leads purge` 命令按需清理：
  - `purge --older-than 180d`：删除 `row_updated_at` 早于阈值的公司/职位/联系人。
  - `purge --risk blocked,high`：删除指定风险等级的联系人。
  - `purge --company <domain>`：删除一家公司及其所有从属记录。
- `contacts.source_id` 与 `contacts.retrieved_at` 非空；upsert 时拒绝无来源的孤立联系人。
- `risk_level=blocked` 的联系人不写入 `contacts`；仅可记录在 `sources` 表用于审计。

## 数据模型

SQLite 是 source of truth。JSONL 记录每次 run 的快照。CSV 用于人工查看。飞书只是审核工作区。

### 核心表

#### `companies`

- `id`
- `name`
- `normalized_name`
- `description`
- `direction_tags` *（见下方枚举）*
- `excluded`
- `exclusion_reason`
- `row_created_at`
- `row_updated_at`

说明：`domain` 与 `website_url` 拆到 `company_domains` 表（见下）。一家公司允许有多个域名；主域名在 `companies.primary_domain_id` 做反范式以便查询。

#### `company_domains`

- `id`
- `company_id`
- `domain` *（唯一）*
- `is_primary` *（bool）*
- `source_id` *（这个域名是从哪学到的）*
- `row_created_at`

公司 upsert 的去重规则：

1. 若传入 `domain` 命中 `company_domains.domain`，合并到对应公司。
2. 否则 `normalized_name` 命中 `companies.normalized_name`，合并，并把新 domain 作为非主别名加入。
3. 否则创建新公司。若 `domain` 存在则其 `is_primary=true`。
4. 若 `normalized_name` 命中多家公司，仍创建新公司，但新行标记 `needs_review=true`，由用户后续手动裁决。

#### `jobs`

- `id`
- `company_id`
- `title`
- `normalized_title`
- `job_url`
- `location`
- `remote_policy`
- `source_posted_at` *（来自数据源，可空）*
- `source_updated_at` *（来自数据源，可空）*
- `freshness_status`
- `source_id`
- `row_created_at`
- `row_updated_at`

唯一键：优先 `job_url`；fallback 为 `company_id + normalized_title + location`。

（修复 v1 里 `updated_at` 字段重复出现的问题，明确区分来源时间戳与本地行元数据。）

#### `contacts`

- `id`
- `company_id`
- `name`
- `title`
- `contact_type`
- `value`
- `profile_url`
- `source_id`
- `risk_level`
- `manual_review_required`
- `usage_status`
- `priority_rank`
- `row_created_at`
- `row_updated_at`

唯一键：优先 `profile_url`；其次 `value`；最后 `company_id + normalized_name + title`。

#### `sources`

- `id`
- `source_type`
- `source_url`
- `source_title`
- `retrieved_at`
- `published_at`
- `content_hash`
- `evidence_snippet`
- `fetch_status`
- `parse_status`
- `error_code`
- `error_message`

#### `runs`

v2 新增。让 run 级报告不必扫 JSONL。

- `id` *（与 JSONL 里的 `run_id` 一致）*
- `started_at`
- `finished_at`
- `source` *（或 `multi`）*
- `limit`
- `status` *（`completed` / `partial` / `failed`）*
- `error_summary`

#### `lead_scores`

- `id`
- `company_id`
- `score`
- `job_match_score`
- `direction_score`
- `freshness_score`
- `contact_score`
- `actionability_score`
- `match_reason` *（JSON，见下）*
- `decision`
- `scorer_version` *（semver 字符串，必填）*
- `created_at`

`match_reason` JSON 结构：

```json
[
  { "component": "job_match", "points": 28, "evidence_source_id": 142, "note": "title:'Backend Engineer' matches role pattern" },
  { "component": "freshness", "points": 15, "evidence_source_id": 142, "note": "posted 5 days ago" }
]
```

决策值（`decision`）：

- `accepted_for_feishu`
- `local_only`
- `stale`
- `blocked_contact`
- `duplicate`
- `needs_review`
- `excluded_by_rule`

#### `push_events`

- `id`
- `company_id`
- `sink`
- `external_app_token`
- `external_table_id`
- `external_record_id`
- `status`
- `payload_hash`
- `attempt_count`
- `last_attempt_at`
- `pushed_at`
- `error_message`

新增 `attempt_count` + `last_attempt_at`，让重试可审计、退避可调试。

### 方向标签枚举

`direction_tags` 是逗号分隔的字符串，取值来自固定枚举（定义在 `src/types/direction-tags.ts`）：

```
backend | ai-app | ai-infra | ai-native | devtools | overseas | remote-friendly | china-timezone
```

未识别的 tag 在写入时拒绝。新增 tag 如果改变评分权重，必须 bump `scorer_version`。

### 品牌名归一化表

静态文件 `src/normalizers/brand-aliases.json`：

```json
{ "字节跳动": "bytedance", "智谱": "zhipu", "DeepSeek": "deepseek" }
```

用于 `normalized_name` 计算；v1 自带约 20 条种子条目，人工维护。

### JSONL 快照

每次采集 run 写一个 JSONL 文件到 `data/runs/<run_id>.jsonl`。

每行包含：

- `run_id`
- `source`
- `source_url`
- `retrieved_at`
- `status`
- `normalized_payload`
- `evidence`
- `errors`

默认不存完整 HTML。Debug 模式（`--debug-cache`）可临时把原始页面缓存到 `data/cache/`，保留期固定 7 天。

## 评分

100 分制，规则化，可解释。

- 职位匹配：35 分。
- 方向匹配：25 分。
- 新鲜度：15 分。
- 联系人质量：15 分。
- 可执行性：10 分。

飞书推送阈值：

- `score >= 70`：在不过期 / 不被拉黑 / 不被排除时可推。
- `50-69`：本地候补池。
- `< 50`：仅本地。

scorer 必须输出结构化 `match_reason`（见数据模型）与各分项。

每条 `lead_scores` 必须打上 `scorer_version`。报告与飞书视图必须能按 `scorer_version` 过滤，让历史分数在规则变更后仍可解读。v1 用 semver，bump 规则：

- patch：bug 修复，不影响分数。
- minor：权重或阈值变动，但规则结构不变。
- major：结构性变化（新增/移除分项）。

## HTTP Fetch 抽象层

（v2 新增。Phase 0.5 实现，所有 collector 与 enricher 都消费它。）

`src/http/` 提供一个 `HttpClient` 接口：

- 默认 User-Agent：`startup-leads/<version> (+local research tool)`。
- 默认超时：10s。
- 全局 QPS 上限：1 req/s（可通过环境变量调整）。
- 重试策略：429 与 5xx 指数退避（1s、2s、4s），最多 3 次。
- 测试中用 `nock`（或等价工具）拦截所有请求。

推迟到 v2：per-host 限流、`robots.txt` 解析、ETag/304 缓存。

## 飞书多维表格集成

### 配置与密钥

本地配置文件：`~/.config/startup-leads/config.json`，文件权限 `0600`。结构：

```json
{
  "feishu": {
    "app_token": "...",
    "table_id": "...",
    "app_id": "...",
    "app_secret": "...",
    "field_mapping": { "Company": "fldXXXX", "Domain": "fldYYYY" }
  }
}
```

规则：

- 任何字段都可被环境变量覆盖（`STARTUP_LEADS_FEISHU_APP_SECRET` 等），方便 CI 使用。
- access token 用 `app_id` + `app_secret` 现取现用，绝不落盘。
- token 过期 / 刷新由 `FeishuClient` 内部处理。

### Provisioning

```bash
startup-leads feishu provision --name "Job Leads"
startup-leads feishu provision --name "Job Leads" --dry-run
```

Provisioning 会：

- 新建一个飞书多维表格 app。
- 新建一张名为 `Job Leads` 的表。
- 创建必需字段。
- 创建审核向视图。
- 把返回的 `app_token`、`table_id`、字段 ID 持久化到本地配置。

实现优先用 `lark-cli` 的 shortcut 命令；不覆盖的操作回落到 `lark-cli api`。能力缺口在 Phase 7 设计阶段用 `lark-cli base --help` 现场确认，而不是写到实现时再排查。

### 飞书客户端抽象

所有飞书调用走 `src/feishu/client.ts` 中定义的 `FeishuClient` 接口。两种实现：

- `LarkCliFeishuClient`：生产用；封装 `lark-cli` 子进程与 HTTP fallback。
- `InMemoryFeishuClient`：测试 fake；用 JS Map 模拟表/记录，是单元测试默认值。

可选的集成测试（`bun test --integration`）在存在 `STARTUP_LEADS_FEISHU_APP_SECRET` 时切到真实客户端；CI 不跑这条。

### 飞书表结构

一条飞书记录代表一家公司机会。

字段：`Company`、`Website`、`Domain`、`Direction Tags`、`Top Jobs`、`Remote / Location`、`Freshness`、`Score`、`Scorer Version`、`Match Reason`、`Recommended Contacts`、`Contact Risk`、`Sources`、`Status`、`Last Checked At`、`Local ID`、`Review Notes`。

（新增 `Scorer Version`，让历史记录可比对。）

视图：`待审核`、`可接洽`、`已接洽`、`过期/不合适`、`全部线索`。

### 推送行为

```bash
startup-leads push-feishu --min-score 70 --dry-run
startup-leads push-feishu --min-score 70
```

规则：

- 推荐写入前先 dry-run。
- Upsert 顺序：先按 `Local ID` 查；找不到再按 `Domain` 查；都找不到才 create。这避免上一轮 push 在写入 `external_record_id` 之前超时导致的双写。
- 只推送公司级记录。
- 包含 1-3 条 top jobs 与 1-3 条推荐联系人。排序是确定性的：jobs 按 `freshness_status` 然后 `source_posted_at` 倒序；contacts 按 `priority_rank` 然后 `risk_level`。
- 所有 push 尝试写 `push_events`，重试时递增 `attempt_count`。
- `stale`、`blocked`、`excluded_by_rule` 不推送。

## CLI 接口

初始命令集：

```bash
startup-leads collect --limit 50
startup-leads export csv
startup-leads feishu provision --name "Job Leads" [--dry-run]
startup-leads push-feishu --min-score 70 --dry-run
startup-leads push-feishu --min-score 70
startup-leads report [--run <id>]
startup-leads purge --older-than 180d
startup-leads purge --risk blocked,high
startup-leads purge --company <domain>
```

未来兼容命令：

```bash
startup-leads collect --source hn_who_is_hiring --limit 20
startup-leads collect --source yc_work_at_startup --limit 20
startup-leads feishu status
startup-leads rescore --scorer-version 1.1.0
startup-leads scheduler install
```

## 数据源策略

v1 实现优先级：

1. **HN Who is Hiring collector**：主要发现源。
2. **官方 careers 页 enricher**：既丰富已有线索，又作为 `unknown` 记录的新鲜度验证器。
3. **GitHub 组织/项目 enricher**：补充公开 profile 联系人。

v2 / 推迟项：

- **YC Work at a Startup**：当前站点要求登录，与"不登录抓取"非目标冲突。等公开列表接口确认或范围放宽再考虑。
- **Wellfound**：完全推迟到 v1 验证后。
- **LinkedIn / 即刻 / 小红书 / 微博 / X**：推迟；未来可能作为低频公开 profile enricher，不做登录抓取。

### HN 实现要点

- 通过 Algolia 找到每月 "Ask HN: Who is Hiring?" 帖子：`https://hn.algolia.com/api/v1/search?query=Who is hiring&tags=story,author_whoishiring`。
- 通过 Firebase API 拉帖子及评论树：`https://hacker-news.firebaseio.com/v0/item/<id>.json`。
- 这避开了 HTML 抓取、分页与 `news.ycombinator.com` 限流。
- 只解析评论文本，结构信息来自 JSON。

## 架构

技术栈：TypeScript、ES modules、bun。SQLite 用 `bun:sqlite`。

模块划分：

- `src/cli/`：命令定义与参数解析。
- `src/http/`：共享 HTTP 客户端、QPS 限流、重试与退避。
- `src/collectors/`：各数据源 collector。
- `src/enrichers/`：careers、GitHub、公开 profile enrichment。
- `src/normalizers/`：domain、公司名、职位标题、地点、远程策略、品牌名归一化。
- `src/storage/`：SQLite 仓储、迁移、JSONL writer、CSV exporter。
- `src/scoring/`：评分、新鲜度、排除、决策规则、scorer 版本常量。
- `src/contacts/`：联系人提取、排序、风险分类。
- `src/feishu/`：`FeishuClient` 接口、`lark-cli` 实现、in-memory fake、provisioning、字段映射、upsert、dry-run 渲染。
- `src/reporting/`：run 报告与质量汇总。
- `src/config/`：配置文件读取、环境变量覆盖、schema 校验。
- `src/types/`：共享 DTO、领域类型、方向标签枚举。

所有外部副作用（网络、飞书、`data/` 之外的文件系统）都藏在接口后面，让单测可以离线跑。

关键接口：

```ts
export interface HttpClient {
  get(url: string, opts?: HttpOptions): Promise<HttpResponse>;
}

export interface Collector {
  readonly source: string;
  collect(input: CollectInput): Promise<CollectedLead[]>;
}

export interface LeadRepository {
  upsertCollectedLead(lead: CollectedLead): Promise<StoredLeadResult>;
  listPushCandidates(input: PushCandidateQuery): Promise<CompanyLead[]>;
}

export interface FeishuClient {
  provision(input: ProvisionInput): Promise<ProvisionResult>;
  upsertCompanyLead(lead: CompanyLead): Promise<PushResult>;
  findRecordByLocalId(localId: string): Promise<FeishuRecord | null>;
  findRecordByDomain(domain: string): Promise<FeishuRecord | null>;
}
```

## TDD 实施计划

小而垂直地迭代。每个切片先写失败测试，再做最小实现，再 refactor。

### Phase 0：项目骨架

目标：工具链与测试 harness。

先写测试：CLI binary 能打印 help；TS build 通过；bun 下能跑一个 trivial 单测。

实现：`package.json`、`tsconfig.json`、ESLint、test setup、`src/cli/index.ts`。

完成判据：`bun test`、`bun run typecheck`、`bun run lint` 全部通过。

### Phase 0.5：HTTP Fetch 层

（v2 新增。）

目标：在任何 collector 需要网络之前，先有一个共享 `HttpClient`。

先写测试：

- 默认 UA / 超时被正确应用。
- 全局 QPS 限流让超阈调用排队。
- 429 / 503 用指数退避重试，最多 3 次。
- 其它 4xx 立即抛出，不重试。
- 测试用 `nock` 拦截；`bun test` 期间无真实网络请求。

实现：`src/http/HttpClient.ts` + 实现 + 限流器。

### Phase 1：领域类型与评分

目标：纯规则，无网络无数据库。

先写测试：

- 后端、AI 应用、infra、tooling 类标题评分正确。
- AI native、AI infra、overseas、tooling 标签评分正确。
- 新鲜度状态映射到预期分值。
- 过期或被排除的记录不能 `accepted_for_feishu`。
- 联系人 blocked 阻止飞书 push。
- `score >= 70` → `accepted_for_feishu`。
- `50-69` → `local_only` 或 `needs_review`。
- `< 50` → `local_only`。
- `scorer_version` 常量打在每条结果上。
- `match_reason` 是结构化数组（含 component、points、evidence_source_id）。

实现：领域 DTO、方向标签枚举、新鲜度评估器、排除评估器、联系人风险分类器、lead scorer。

完成判据：评分确定且无 IO 依赖。

### Phase 2：SQLite 存储

目标：把本地存储变成 source of truth。

先写测试：

- migrations 创建所有表，含 `company_domains`、`runs`、修正后的 `jobs`。
- 公司 upsert 去重顺序：`company_domains.domain` → `normalized_name` → 新行。
- 职位 upsert 按 URL 去重，fallback 复合键。
- 联系人 upsert 按 `profile_url` → `value` → 复合键去重。
- 缺 `source_id` 的联系人被拒。
- `risk_level=blocked` 的联系人不入 `contacts`。
- sources 表保留 evidence snippet 与 error。
- 失败的 fetch / parse 也被保留。
- push 候选排除 stale / blocked / excluded。
- run 开始时写入 `runs` 行，结束时收尾。
- `purge --older-than` / `--risk` / `--company` 各自删对的行，且不破坏引用完整性。

实现：SQLite 连接、迁移、仓储、临时文件 test DB factory。

### Phase 3：JSONL 与 CSV 导出

先写测试：

- JSONL writer 每条采集结果一行。
- JSONL 不含原始 HTML。
- JSONL 的 `run_id` 与 `runs` 行一致。
- CSV 导出包含审核友好字段，含 `scorer_version`。
- 空数据集能正常导出。

实现：snapshot writer、CSV exporter、`startup-leads export csv`。

### Phase 4：HN Collector

先写测试：

- Algolia 搜索能正确定位月度帖子（fixture）。
- Firebase 拉取返回评论树（fixture）。
- Parser 从评论 fixture 中提取公司、岗位描述、地点、远程线索、联系人/profile 链接、源 URL、evidence。
- 缺失日期映射到 `unknown`。
- 异常评论记录 `parse_failed`。
- 遵守 `--limit`。
- 使用共享 `HttpClient`（不能直接 `fetch`）。

实现：HN 发现（Algolia）、HN 拉取（Firebase）、评论 parser、collector。

### Phase 4.5：最小报告

（v2 新增；完整报告留在 Phase 9。）

目标：每次 `collect` 都打出一屏质量信号，让 Phase 5-7 调参可观测。

先写测试：

- 按 `run_id` 报告候选数、入库数、去重数、fetch 失败数、parse 失败数。
- 零结果 run 也能正常输出。

实现：最小 `startup-leads report --run <id>`，`collect` 后自动调用。

### Phase 5：Careers 页 Enricher

（从 v1 的 Phase 6a 提前；它同时承担 `unknown → usable` 新鲜度验证。）

先写测试：

- 通过路径探测或 sitemap 发现 `/careers`、`/jobs`、`/work-with-us`。
- careers 页含匹配的归一化职位时，把 `freshness_status` 从 `unknown` 提升为 `usable`。
- 永不创建推断联系人。
- enricher 是 additive：不覆盖更强的来源。
- 使用共享 `HttpClient`。

实现：careers 发现、页面 parser、enrichment writer。

### Phase 6：GitHub Enricher

先写测试：

- 从 GitHub 组织拿到低/中风险公开 profile 联系人。
- 每家公司最多 1-3 条推荐联系人。
- 永不推断邮箱（不做 `<user>@<company>` 这种猜测）。
- 处理未登录限流（60 req/h）：退避并把剩余项标记 `enrichment_deferred`。
- 可选的 `GITHUB_TOKEN` 环境变量提升限额。

实现：GitHub 组织/profile enrichment、联系人 ranker。

### Phase 7：飞书 Mock + Provisioning

先写测试：

- `InMemoryFeishuClient` 表/字段/记录的 create/read/update round-trip。
- Provision 针对 fake 构造预期的 Base app/table/field/view 操作。
- Provision 把返回的 `app_token`、`table_id`、字段 ID 写入 config writer。
- 失败的 provision 报错明确，不会假装成功。
- Dry-run provision 打印将要执行的操作但不真写。
- Config writer 落 `0600` 文件权限，且支持环境变量覆盖。

实现：`FeishuClient` 接口、`InMemoryFeishuClient`、`LarkCliFeishuClient` 骨架、config writer、`startup-leads feishu provision`。

本阶段末做一次针对真实飞书的人工 smoke。

### Phase 8：飞书 Push

顺序：payload mapper → 候选查询 → upsert 流程。（mapper 是契约，驱动查询形状。）

先写测试：

- mapper 对典型公司生成文档化 payload（golden fixture）。
- mapper 把 jobs / contacts 确定性截断到前 3。
- mapper 输出含 `scorer_version` 与 `Local ID`。
- 候选查询只返回 `score >= min-score` 且非 stale / blocked / excluded。
- Dry-run 显示完整 payload 且不写 `push_events`。
- 真 push 按 `Local ID` → `Domain` → create 顺序 upsert。
- push 记录 success / failure 事件，含 `attempt_count`。
- stale / blocked / excluded / 低于阈值的记录被跳过。

实现：payload mapper、候选查询、飞书 upsert 流程、`startup-leads push-feishu`。

### Phase 9：完整报告

先写测试：

- 报告新增：accepted 数、excluded 数、stale 数、duplicate 数、含联系人比例、unknown 新鲜度比例、分数分布桶、`scorer_version` 分组。
- 零记录能处理。
- 报告可针对单个 run 或在一个时间窗口内聚合多个 run。

实现：报告聚合器、终端渲染。

### Phase 10：端到端 Smoke

（v2 新增。作为发布门槛。）

先写测试：

- 一次脚本化 run：HN fixture → SQLite → 评分 → CSV → `InMemoryFeishuClient` dry-run payload 与 golden 文件 diff。
- 第二次 run 是幂等的（无重复插入、无重复 push payload）。
- `purge --older-than 0d` 把数据库清回 migrations baseline。

实现：`scripts/e2e.sh`，通过 `bun run e2e` 调用。

## 验收标准

v1 完成的判据：

- `startup-leads collect --limit 50` 把采集结果落本地。
- SQLite 含所有 accepted / rejected / failed / stale / duplicate 记录。
- 每次 run 都写 JSONL 快照，且 `runs` 表与之对应。
- CSV 导出可用，包含 `scorer_version`。
- 评分与排除决策通过结构化 `match_reason` 可解释。
- `startup-leads feishu provision --name "Job Leads"` 能创建飞书 Base 结构。
- `startup-leads push-feishu --min-score 70 --dry-run` 能预览记录。
- `startup-leads push-feishu --min-score 70` 只写合格的公司级线索，重试幂等。
- `startup-leads purge` 支持三种文档化模式。
- 不存在自动触达。
- 不存在邮箱推断。
- `bun test`、`bun run typecheck`、`bun run lint`、`bun run e2e` 在本地与 GitHub Actions CI 均通过。（v1 不设覆盖率门槛。）

## 开放决策

- `lark-cli` 的 shortcut 是否覆盖所有 Base provisioning 需求，还是部分回落到 `lark-cli api`。Phase 7 开始时用 `lark-cli base --help` 现场确认。
- 当前月 HN 结果太少时，是否扩展到上一个月。v1 默认只取当前月，预留 `--include-prev-month` 标志。
- 品牌别名表是否只人工维护，还是接受社区 PR。v1 默认人工维护，种子约 20 条。

## 相对 v1 的变更对照

| 领域 | v1 | 最终版 |
|------|----|--------|
| YC 数据源 | Phase 5 collector | 推迟到 v2（与"不登录抓取"冲突）|
| HN 拉取方式 | 未指定 | Algolia + Firebase JSON API |
| 公司去重 | 仅 `domain` 唯一 | `company_domains` 别名表 + `normalized_name` 兜底 |
| `jobs.updated_at` | 列了两次 | 拆为 `source_updated_at` + `row_updated_at` |
| Run 元数据 | 仅 JSONL | 新增 `runs` SQL 表 + JSONL |
| 评分版本 | 无 | `lead_scores.scorer_version` + 飞书 `Scorer Version` 列 |
| `match_reason` | 自由文本 | 结构化 JSON 数组 |
| `push_events` | 无重试元数据 | `attempt_count` + `last_attempt_at` |
| Push upsert | 按 `Domain` | `Local ID` → `Domain` → create |
| `unknown` 新鲜度 | "selected unknown 可推" | 默认不推；careers enricher 验证后升级为 `usable` |
| 联系人 | 无保留策略 | `purge` 命令 + 来源非空 + blocked 不入库 |
| HTTP 层 | 未指定 | `src/http/`，含 UA / 超时 / QPS / 指数退避（Phase 0.5）|
| 飞书客户端 | 直接调 `lark-cli` | `FeishuClient` 接口 + `InMemoryFeishuClient` fake（Phase 7）|
| 飞书配置 | 未指定 | `~/.config/startup-leads/config.json`，`0600` + 环境变量覆盖 |
| 报告时机 | 仅 Phase 9 | Phase 4.5 最小报告 + Phase 9 完整报告 |
| Phase 划分 | 0-9 | 0、0.5、1-5、6、7、8、9、10（新增 E2E smoke）|
| 中文源 | 未规划 | v1 不做；只做品牌名归一化 |
| CI | 未指定 | GitHub Actions 跑 `bun test/typecheck/lint/e2e`，无覆盖率门槛 |
