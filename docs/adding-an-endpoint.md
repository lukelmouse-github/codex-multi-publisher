# 新增一个发布端点

本文说明如何在当前实现中新增一个真正可运行的 publisher endpoint。只实现 `PublisherEndpoint` 类还不够：还要把它接入 Registry、配置、上下文构造、prepare 报告和 CLI 流程，并为副作用与恢复语义编写测试。

以下示例使用虚构的 `example-draft`，不对应任何真实平台。

## 1. 先定义端点边界

编码前先回答四个问题：

1. 端点创建的是公开内容、私有草稿，还是更新已有内容？
2. prepare 能安全读取哪些目标基线，哪些信息只有 publish 才能远程验证？
3. 远端是否提供幂等键或安全的状态查询接口？
4. 哪些中间结果可以恢复，哪些失败必须标为 `partial` 或 `outcome_unknown`？

据此声明 capabilities：

```ts
readonly capabilities = {
  draft: true,
  publish: false,
  update: false,
  imageUpload: true,
  status: false,
} as const;
```

不要为了“接口看起来完整”把不具备的能力标成 `true`。特别是远端没有可靠查询契约时，`status` 应明确返回 unsupported。

## 2. 实现真实接口

接口位于 [`types.ts`](../.agents/skills/publish-article/scripts/src/types.ts)：

```ts
export interface PublisherEndpoint {
  readonly id: string;
  readonly capabilities: EndpointCapabilities;

  preflight(
    article: ArticlePackage,
    context: EndpointContext,
  ): Promise<Record<string, unknown>>;

  prepare(
    article: ArticlePackage,
    context: EndpointContext,
  ): Promise<PreparedPublication>;

  publish(
    prepared: PreparedPublication,
    confirmation: string,
    context: EndpointContext,
  ): Promise<PublishReceipt>;

  status(
    receipt: PublishReceipt,
    context: EndpointContext,
  ): Promise<Record<string, unknown>>;
}
```

在 `scripts/src/endpoints/example-draft.ts` 中创建实现。建议先定义端点专属 prepared 类型：

```ts
import path from "node:path";
import { digestCanonical } from "../canonical-json";
import { PublishError } from "../errors";
import {
  createIdempotencyKey,
  verifyConfirmationToken,
  writeReceiptAtomic,
} from "../receipts";
import type {
  ArticlePackage,
  EndpointContext,
  PreparedPublication,
  PublisherEndpoint,
  PublishReceipt,
} from "../types";

const ENDPOINT_ID = "example-draft";

interface PreparedExamplePublication extends PreparedPublication {
  destination: string;
  providerVersion: string;
}
```

端点扩展字段必须是发布时重新验证所需的稳定事实。不要保存凭证、访问密钥、绝对回调地址或其他秘密。

## 3. 解析并验证 EndpointContext

`EndpointContext.options` 是 `Record<string, unknown>`，端点不能直接假设字段类型。集中编写 `readOptions()`：

```ts
interface ExampleOptions {
  artifactRoot: string;
  destination: string;
  providerVersion: string;
  confirmationSecret?: string;
}

function readOptions(context: EndpointContext): ExampleOptions {
  const raw = context.options;
  const artifactRoot = typeof raw.artifactRoot === "string"
    ? path.resolve(raw.artifactRoot)
    : "";
  const destination = typeof raw.destination === "string"
    ? raw.destination.trim()
    : "";
  const providerVersion = typeof raw.providerVersion === "string"
    ? raw.providerVersion.trim()
    : "";

  if (!artifactRoot) {
    throw new PublishError("E_EXAMPLE_ARTIFACT", "artifactRoot is required", {
      kind: "precondition",
    });
  }
  if (!destination || !providerVersion) {
    throw new PublishError("E_EXAMPLE_OPTIONS", "destination and providerVersion are required", {
      kind: "precondition",
    });
  }

  return {
    artifactRoot,
    destination,
    providerVersion,
    confirmationSecret: typeof raw.confirmationSecret === "string"
      ? raw.confirmationSecret
      : undefined,
  };
}
```

还应验证：

- artifact 位于本次 run 的受控目录内；
- 目录和文件不是逃逸符号链接；
- artifact 归属于当前 `articleId + revision`；
- 目标 ID 使用规范格式；
- provider/runtime 与锁定版本一致；
- 配置中的 mode 没有把草稿端点升级为公开发布。

## 4. preflight 必须只读

`preflight()` 可以：

- 检查本地工具和版本；
- 校验非敏感配置是否完整；
- 读取不会产生副作用的远端 metadata；
- 验证权限声明或执行提供方明确支持的 dry-run；
- 返回诊断信息。

`preflight()` 不可以：

- 上传图片或附件；
- 创建、修改或删除远端资源；
- 修改正式工作树或 Git index；
- 获取并缓存会改变发布语义的临时产物；
- 把凭证写进返回值、日志或运行目录。

如果提供方的“校验接口”本身会创建资源，它只能放在 publish 阶段。

## 5. prepare 生成确定性的端点计划

端点应先复用一个内部只读检查函数，再构造 options、baseline、render 和 actions：

```ts
async prepare(
  article: ArticlePackage,
  context: EndpointContext,
): Promise<PreparedExamplePublication> {
  const options = readOptions(context);
  const inspected = await inspectPreflight(article, context);

  const renderDigest = await digestFrozenArtifact(options.artifactRoot);
  const optionsDigest = digestCanonical({
    destination: options.destination,
    providerVersion: options.providerVersion,
    providerIdentity: inspected.providerIdentity,
  });
  const actions = [
    {
      id: "validate-frozen-artifact",
      description: "Validate the exact frozen artifact again",
      sideEffect: false,
    },
    {
      id: "create-private-draft",
      description: "Create one private draft",
      sideEffect: true,
    },
  ];

  const planCore = {
    schemaVersion: 1 as const,
    endpoint: ENDPOINT_ID,
    articleId: article.articleId,
    packageRevision: article.revision,
    optionsDigest,
    renderDigest,
    actions,
    destination: options.destination,
    providerVersion: options.providerVersion,
  };

  return {
    ...planCore,
    planDigest: digestCanonical(planCore),
    artifactRoot: options.artifactRoot,
  };
}
```

规则：

- `optionsDigest` 必须覆盖目标、发布选项、账号或目标身份摘要、提供方版本等会改变语义的输入。
- `baselineDigest` 用于绑定会变化的目标状态；仅在端点能安全观察基线时添加。
- `renderDigest` 必须覆盖 publish 实际读取的所有 payload 和素材字节。
- `actions` 必须完整列出确认后会发生的副作用。
- `planDigest` 对 plan core 做 canonical digest。
- 绝对 artifact 路径不应替代 renderDigest，也不应成为跨机器确认意图的一部分。

## 6. publish 在副作用前重新验证

publish 的开头至少执行：

```ts
async publish(
  input: PreparedPublication,
  confirmation: string,
  context: EndpointContext,
): Promise<PublishReceipt> {
  const prepared = assertPreparedExample(input);
  const options = readOptions(context);

  verifyConfirmationToken(
    confirmation,
    prepared,
    options.confirmationSecret,
  );

  const article = context.options.article as ArticlePackage | undefined;
  if (
    !article
    || article.articleId !== prepared.articleId
    || article.revision !== prepared.packageRevision
  ) {
    throw new PublishError("E_ARTICLE_CONTEXT", "ArticlePackage changed after confirmation", {
      kind: "conflict",
    });
  }

  if (await digestFrozenArtifact(options.artifactRoot) !== prepared.renderDigest) {
    throw new PublishError("E_EXAMPLE_RENDER_STALE", "Frozen artifact changed after confirmation", {
      kind: "conflict",
    });
  }

  // 然后检查已有 receipt/journal，再执行第一个远端副作用。
}
```

如果端点绑定了 baseline 或 provider identity，也必须在这里重新读取并比较。任何不一致都应在副作用前以 `conflict` 结束。

### Receipt 构造

```ts
function receiptFor(
  prepared: PreparedPublication,
  state: PublishReceipt["state"],
  sideEffects: Array<Record<string, unknown>>,
  extra: Pick<Partial<PublishReceipt>, "checkpoint" | "statusLocator" | "error"> = {},
): PublishReceipt {
  const idempotencyKey = createIdempotencyKey(prepared);
  return {
    schemaVersion: 1,
    receiptId: digestCanonical({
      idempotencyKey,
      state,
      checkpoint: extra.checkpoint ?? null,
    }),
    endpoint: ENDPOINT_ID,
    articleId: prepared.articleId,
    packageRevision: prepared.packageRevision,
    planDigest: prepared.planDigest,
    idempotencyKey,
    state,
    checkpoint: extra.checkpoint,
    sideEffects,
    statusLocator: extra.statusLocator,
    error: extra.error,
  };
}
```

用 `writeReceiptAtomic()` 写入本次 run 的 `receipts/<endpoint-id>.json`。远端可能已产生副作用后，如果 receipt 写入失败，不能假装整次发布没有发生；应保留 durable lock 或 journal，并把结果提升为需要人工检查的状态。

## 7. 设计 checkpoint 与幂等行为

端点至少区分以下路径：

| 情况 | Receipt | 后续行为 |
| --- | --- | --- |
| 已知尚未产生副作用 | `failed` + `not_applied` | 修复条件后重新 prepare 或由用户重试 |
| 中间步骤已完成且可恢复 | `prepared` / `committed` + checkpoint | 只继续剩余步骤 |
| 已产生部分副作用 | `partial` | 按 checkpoint 恢复或人工清理 |
| 远端结果不可判定 | `outcome_unknown` | 先检查远端，禁止自动重试 |
| 已完整成功 | 端点成功状态 | 返回原 receipt，禁止重复创建 |

如果提供方没有幂等键，应在本地保存 fingerprint journal，并在相同 fingerprint 再次执行前检查它。journal 只能降低重复风险，不能替代远端幂等保证。

自动重试必须同时满足：

```text
retryable = true
outcome = not_applied
```

“网络错误”“超时”或“响应无法解析”通常不能证明 `not_applied`。

## 8. status 只报告可验证事实

有安全查询契约时，使用 receipt 中绑定的 locator 查询并比较远端状态；没有时：

```ts
async status(receipt: PublishReceipt): Promise<Record<string, unknown>> {
  return {
    state: receipt.state,
    supported: false,
    reason: "provider has no safe status lookup contract",
  };
}
```

不要通过标题搜索、模糊时间匹配或页面抓取猜测资源身份，也不要把本地成功回执描述成“已实时确认远端仍存在”。

## 9. 注册端点

在 [`cli.ts`](../.agents/skills/publish-article/scripts/src/cli.ts) 的 `createRegistry()` 中注册 factory：

```ts
function createRegistry(): PublisherRegistry {
  return new PublisherRegistry()
    .register("blog-git", () => new BlogGitEndpoint())
    .register("wechat-draft-baoyu", () => new WechatDraftEndpoint())
    .register("example-draft", () => new ExampleDraftEndpoint());
}
```

Registry 会拒绝：

- 空 ID；
- 重复 ID；
- factory 返回的 `endpoint.id` 与注册 ID 不一致；
- 未注册的 driver。

## 10. 接入配置和 CLI 编排

当前 CLI 仍有 driver-specific integration，因此新增端点还需要四处接线。

### 10.1 配置 schema

在 `config/endpoints.json` 中声明用户可选择的 target：

```json
{
  "schemaVersion": 1,
  "defaultTargets": ["blog", "example"],
  "endpoints": {
    "example": {
      "driver": "example-draft",
      "mode": "draft",
      "destination": "<destination-alias>"
    }
  }
}
```

配置文件只保存非敏感别名和模式。凭证必须通过私有配置或进程环境注入。

同时扩展 `EndpointConfiguration` 的类型，避免新字段只存在于 JSON 而没有类型约束。

### 10.2 EndpointContext

在 `endpointContext()` 中把配置、ArticlePackage 和冻结 artifact 映射成端点 options。这里应：

- 验证 configured driver 与 prepared endpoint 一致；
- 拒绝非法 mode；
- 只传递本端点需要的字段；
- 不把凭证复制到 prepared plan。

### 10.3 commandPrepare

`commandPrepare()` 当前分别装载 Blog 和微信 render record。新端点必须新增对应分支：

1. 读取自己的 render record；
2. 验证 `articleRevision`；
3. 将 artifact 限定在本次 run 的固定 render 目录；
4. 重新验证冻结候选；
5. 调用 endpoint.prepare；
6. 把 prepared plan 加入 `endpointPlans`；
7. 向准备报告提供 preview、diff、素材或其他可审阅信息。

不要只注册 factory，却让 prepare 无法生成计划。

### 10.4 commandPublish 与 commandStatus

这两个命令会按 `publication-plan.json` 中的 endpoint ID 解析 factory，但仍依赖 `endpointContext()` 构造正确上下文。新增端点后至少验证：

- publish 能拿到同一冻结 artifact；
- stale plan 会在第一个副作用前失败；
- status 能读取对应 receipt；
- 一个端点失败时，其他端点 receipt 不会被覆盖。

## 11. 准备报告

扩展 [`PrepareReportDetails`](../.agents/skills/publish-article/scripts/src/prepare-report.ts) 和 `renderPrepareReport()`，让用户在确认前看到：

- 目标的非敏感别名；
- preview 或 scoped diff；
- 待处理素材数量；
- 工具链或 renderer 版本；
- 每个只读动作与副作用动作；
- 端点最终只创建草稿、公开发布还是更新已有内容。

报告中不得包含凭证、确认令牌原文、远端私有资源标识或未经脱敏的提供方错误正文。

## 12. 错误与结果映射

统一使用 `PublishError`：

```ts
throw new PublishError("E_EXAMPLE_AUTH", "Provider authentication failed", {
  kind: "auth",
  retryable: false,
  outcome: "not_applied",
});
```

选择 `kind` 和 `outcome` 时分别判断原因与副作用：

| 场景 | kind | outcome | 建议 receipt |
| --- | --- | --- | --- |
| 本地输入非法 | `validation` | `not_applied` | `failed` |
| 缺少工具或配置 | `precondition` | `not_applied` | `failed` |
| 确认后候选或目标变化 | `conflict` | `not_applied` | `failed` |
| 鉴权在副作用前失败 | `auth` | `not_applied` | `failed` |
| 提供方限流且能证明未应用 | `rate_limit` | `not_applied` | `failed` |
| 一个附件成功、后续步骤失败 | `transient` 或 `provider_rejected` | `partial` | `partial` |
| 超时且无法确认远端结果 | `outcome_unknown` | `unknown` | `outcome_unknown` |
| 提供方明确返回完整成功 | 无 error | `applied` | 端点成功状态 |

不要根据异常类型直接假设 outcome。例如同样是网络中断，发生在请求发送前可能是 `not_applied`，发生在请求发送后通常是 `unknown`。

## 13. 测试步骤

### 13.1 Registry 单元测试

- 注册后 `list()` 返回排序后的 ID。
- 重复注册失败。
- 未知 ID 失败。
- factory 返回错误 ID 时失败。

### 13.2 preflight / prepare 测试

- preflight 不调用任何有副作用的 provider 方法。
- 相同 ArticlePackage、候选、配置和基线生成相同 planDigest。
- 修改任一候选字节会改变 renderDigest。
- 修改目标、provider identity 或工具版本会改变 optionsDigest。
- 修改安全基线会改变 baselineDigest。
- prepared plan 不包含凭证和绝对源路径。
- actions 完整标记 `sideEffect`。

### 13.3 publish 测试

- 错误确认令牌在第一个副作用前失败。
- ArticlePackage revision 变化时失败。
- render、options、baseline 或 provider identity 漂移时失败。
- happy path 只执行计划中的副作用并写成功 receipt。
- 已有成功 receipt 时重复调用不再次创建资源。
- 已知未应用失败写 `failed/not_applied`。
- 部分成功写 `partial` 并保留已发生的 sideEffects。
- 超时或响应不确定写 `outcome_unknown`，再次调用不能盲目重试。
- checkpoint 恢复只执行尚未完成的步骤。
- receipt 写入使用原子替换；敏感字段不会进入 receipt。

### 13.4 status 测试

- 有可靠查询接口时比较 receipt locator 与远端结果。
- 目标身份变化时拒绝查询或返回 conflict。
- 没有安全查询契约时稳定返回 `supported: false`。
- status 本身不修改远端。

### 13.5 CLI 集成测试

- 配置 target 能解析为正确 driver。
- `prepare --targets <new-target>` 生成报告和聚合确认。
- `publish` 使用同一 endpoint plan 和冻结 artifact。
- `status` 找到正确 receipt 文件。
- 多端点计划中每个端点生成独立 receipt。
- 未选择新 target 时不执行其 preflight 或 publish。

### 13.6 运行验证

```bash
cd .agents/skills/publish-article/scripts
bun run typecheck
bun test
```

如果端点涉及外部服务，默认测试应使用 fake provider 或本地受控 remote。真实 smoke test 必须：

- 使用专用测试目标；
- 明确展示副作用并取得确认；
- 从创建最小资源开始；
- 不自动执行公开发布；
- 保存脱敏后的 receipt；
- 对 `partial` 和 `outcome_unknown` 准备人工处置步骤。

## 14. 完成检查清单

- [ ] endpoint ID 唯一且与 Registry 注册一致
- [ ] capabilities 与真实能力一致
- [ ] preflight / prepare 无目标副作用
- [ ] prepared plan 绑定 revision、options、render、baseline 和 actions
- [ ] publish 在副作用前复核确认与所有摘要
- [ ] receipt、checkpoint 和幂等策略覆盖失败恢复
- [ ] outcome_unknown 禁止盲目重试
- [ ] status 不猜测远端状态
- [ ] 配置、EndpointContext、prepare 报告和 CLI 均已接线
- [ ] 凭证与私有资源标识不会进入 Git、报告或回执
- [ ] typecheck、单元测试和 CLI 集成测试通过
