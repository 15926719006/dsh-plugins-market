# DevOps 链接 → 编号 + 标题（参考实现）

给 `@local/session-rename` 用的独立参考实现：从会话文本里找出 devops 链接，再只读地问平台「这条记录的编号和标题是什么」。
不依赖 DSH，纯 ESM，`node:` 内置模块之外零依赖。

- 提取：`findDevopsRefs(text)` —— 纯函数，不联网。
- 解析：`resolveDevopsTitle(ref, credentials, fetchImpl?, options?)` —— 一次只读请求，失败静默 `null`。
- 凭据：`loadDevopsCredentials()` —— 按固定优先级从环境/凭据文件读，token 不进代码、不进日志。

调研依据：本机 233 个会话日志（`~/.dsh/sessions/*/*/session.v4.jsonl.zstd`，用 `/opt/homebrew/bin/zstd -dc` 扫出 1150 处 `devops.ronhan.com`）+ 2026-11-10 用真实 API Key 对平台做的只读验证。

## 快速开始

```bash
cd /tmp/devops-lookup
npm test                 # 39 个单测，全 mock，不联网
npm run test:live        # 12 个真机测试，只读访问平台
node verify-live.mjs     # 打印每条真实链接解析出的「编号 标题」
```

```js
import { findDevopsRefs, primaryDevopsRef, resolveDevopsTitle, loadDevopsCredentials, formatDevopsPrefix } from './src/index.mjs'

const refs = findDevopsRefs(transcript)            // 顺序 = 首次出现顺序，已去重
const credentials = loadDevopsCredentials()
const resolved = await resolveDevopsTitle(primaryDevopsRef(refs), credentials)
// { number: 'RO-20261027-008', title: '收银台支付结果倒计时不跳转修复及 returnUrl 兜底' }
formatDevopsPrefix(resolved)
// 'RO-20261027-008 收银台支付结果倒计时不跳转修复及 returnUrl 兜底'
```

## 一、链接形态清单（真实日志里出现的，按次数排序）

平台换过一次路由，两种形态并存，都必须认。`H` = `https://devops.ronhan.com`。

| 出现次数 | 形态 | kind | 真实样本 |
|---|---|---|---|
| 85+ | `H/#demand/<RO>?mode=edit` | demand | `H/#demand/RO-20261027-008?mode=edit` |
| 45+ | `H/#demand/<RO>` | demand | `H/#demand/RO-20261020-018` |
| 少量 | `H/#demand/<RO>?mode=edit&from=%23personal-todo` | demand | 待办列表点进来的带来源参数 |
| 少量 | `H/#/demand/<RO>` | demand | 老 hash 路由多一个 `/` |
| 14 | `H/demand/<RO>` | demand | path 路由形态 |
| 28 | `H/#task/<T>` | task | `H/#task/T-20261026-016` |
| 10 | `H/task/<T>`（可带 `#task-management`） | task | `H/task/T-20261023-012`、`H/task/T-20261026-016#task-management` |
| 7 | `H/task/<19 位数字 id>` | task | `H/task/373000146054680576` |
| 少量 | `H/task/detail/<数字 id>` | task | 老路由 + 登录回跳里常见 |
| 4 | `H/#release/<RO>` | release | `H/#release/RO-20260922-001` |
| 少量 | `H/#release/order/<RO>?mode=edit` | release | |
| 12+ | `H/release/order/detail?orderId=<RO>` | release | `H/release/order/detail?orderId=RO-20261020-018` |
| 少量 | `H/release/order/detail/<RO>` | release | |
| 6 | `H/project-management/<P>`、`H/#project-management/<P>` | project | `H/#project-management/P-20260908-001` |
| 2 | `H/subtask/<RO>-S<nn>` | subtask | `H/subtask/RO-20260911-026-S04` |
| 少量 | `H/login?redirect=%2Ftask%2F…` | 同目标 | 未登录点链接留下的地址，里面 URL 编码着真实目标 |
| 0（未见） | `H/#defect/<BUG-…>`、`H/issue/<ON3-…>` | defect / issue | 日志里没有真实出现；平台有这两种记录和对应接口，故按同样规则兼容 |

其它细节都已覆盖：

- `#` 是路由的一部分，不是锚点（`?mode=edit` 在 `#` 后面），不能简单丢掉 fragment。
- 链接后面常直接跟中文标点（`）。`、`，`），不能算进 URL。
- Markdown 链接 `[文字](URL)` 的 `)` 不能算进 URL。
- `RO-…` 既是需求单编号、又是发布单编号 —— **只能靠路由区分**（`#release/` vs `#demand/`）；纯文号的 `RO-…` 按需求单处理。
- 子任务 `RO-20260911-026-S04` 必须整体识别，不能切成父需求 `RO-20260911-026`。
- 纯文号（没有链接）也提取：`RO-`/`T-`/`P-`/`BUG-`/`ON3-` 的形态极不容易误判；19 位纯数字**不**从散文里提取（会误伤订单号），只从 URL 路径里提取。

## 二、每种形态的只读 API 与字段（全部实测，2026-11-10）

认证：`Authorization: Bearer rhk_…` + `Content-Type: application/json`；信封 `{respCode, respMsg, data, traceId}`，成功 `respCode === "20000"`。

| kind | 请求 | 编号字段 | 标题字段 | 实测结果 |
|---|---|---|---|---|
| demand | `GET /api/devops/demand/detail/<RO>` | `data.order.orderId` | `data.order.title` | `RO-20261027-008` → 「收银台支付结果倒计时不跳转修复及 returnUrl 兜底」 |
| demand 兜底 | `POST /api/devops/demand/query` `{pageNum,pageSize,orderId}` | `data.list[0].orderId` | `data.list[0].title` | 平台按 `orderId` 过滤有效 |
| release | `POST /api/devops/release/order/detail` `{orderId}` | `data.orderId` | `data.title` | `RO-20261020-018` → 「PAYPRO - PayPal能力接入」 |
| release 兜底 | `POST /api/devops/release/order/query` `{pageNum,pageSize,orderId}` | `data.records[0].orderId` | `data.records[0].title` | 按 `orderId` 过滤有效 |
| task | `GET /api/devops/task/detail/<taskNo 或 19 位 id>` | `data.taskNo` | `data.name` | **两种入参都通**：`T-20261026-016` 与 `373000146054680576` 同样返回 |
| defect | `GET /api/devops/defect/detail/<BUG-no>` | `data.defectNo` | `data.name` | `BUG-20261022-006` → 「paymentlink订阅页面的billing amount…」 |
| issue | `GET /api/devops/issue/query?key=<ON3-no>` | `data.key` | `data.summary` | `ON3-66776` → 「googlepay 收银台支付出现两次 fistname和lastname…」 |
| project | `GET /api/devops/project/detail/<P-no>` | `data.projectNo` | `data.name` | `P-20260908-001` → 「PPOW整合一期」 |
| subtask | `GET /api/devops/subtask/detail/<RO-…-S04>` | `data.subtaskNo` | `data.name` | `RO-20260911-026-S04` → 「前后端联调与自测…」 |

**task 通过 taskNo 查询的结论**：不需要「先 taskNo → id」这步。`GET /task/detail/<taskNo>` 直接可用；而 `POST /task/list` 会**忽略** `taskNo` 过滤（传 `{"taskNo":"T-20261026-016"}` 返回的是任意第一条），所以 list 路线不可用。URL 里是数字 id 时直接 `detail` 即可，两条路都通。

## 三、失败码（决定降级行为）

| 情况 | HTTP | respCode | 备注 |
|---|---|---|---|
| key 无效 | 401 | `40100`「API Key 不存在」 | |
| 任务不存在 | 404 | `40400`「任务不存在：taskNo=…」 | |
| 缺陷不存在 | 404 | `40400`「缺陷不存在：defectNo=…」 | 数字 id 传进来也是这个错 |
| 专项不存在 | 404 | `40400`「专项不存在」 | |
| 发布单不存在 | 404 | `40004`「发布单 … 不存在」 | 注意不是 40400 |
| Issue 不存在 | 404 | `ISSUE_NOT_FOUND` | **respCode 不是数字**，只能 `!== '20000'` 判断 |
| **需求不存在** | **500** | **空 body** | 唯一返回非 JSON 的读接口 → 必须走 `demand/query` 兜底 |
| 接口未对 API Key 白名单 | — | `40300` | 本次用到的接口全在白名单内 |

参考实现把以上**全部**收敛成 `null`，不抛异常。

## 四、凭据读取顺序（token 不进代码/仓库/日志）

`loadDevopsCredentials()` 按顺序取第一个有 token 的来源：

1. 环境变量 `DEVOPS_TOKEN`（或别名 `DEVOPS_API_KEY`）+ `DEVOPS_BASE_URL`
2. `$DEVOPS_CREDENTIALS_FILE` 指向的 JSON `{ "base_url", "token" }`
3. `~/.config/agents/credentials/devops.json`（JSON，同上）
4. `~/.config/agents/credentials/onerway-devops.env`（`DEVOPS_BASE_URL=…`、`DEVOPS_API_KEY=…`，支持引号/注释）

规则：某个来源存在但读不动/不是合法 JSON → 跳过，不致命；全都没有 → `token: ''`，`resolveDevopsTitle` 直接返回 `null` 且**不发任何请求**。`describeCredentials()` 只回 `{baseUrl, hasToken, source}`，用于诊断，绝不回 token。

本机验证：`source=file:~/.config/agents/credentials/devops.json`、`hasToken=true`、`baseUrl=https://devops.ronhan.com`；同时 `whoami`（`GET /api/devops/api-key/list`）返回 `20000`，key 名 `nemo-agent`、到期 2027-09-21。两个文件里的 token 是同一把（47 字符 `rhk_` 前缀）。

## 五、文件与测试

```
/tmp/devops-lookup/
├── src/
│   ├── index.mjs                # 桶文件，导出全部
│   ├── devops-refs.mjs          # findDevopsRefs / parseDevopsUrl / primaryDevopsRef（纯函数）
│   ├── devops-resolve.mjs       # resolveDevopsTitle / resolveFirstDevopsTitle / formatDevopsPrefix
│   └── devops-credentials.mjs   # loadDevopsCredentials / describeCredentials
├── test/
│   ├── refs.test.mjs            # 13 个：真实链接形态、去重顺序、标点/markdown、误报、子任务
│   ├── resolve.test.mjs         # 17 个：成功/各自失败码/500 空 body 兜底/超时/无凭据/网络错
│   ├── credentials.test.mjs     #  9 个：四级优先级、坏文件跳过、脱敏、本机凭据可用
│   └── live.test.mjs            # 13 个：真机只读（默认跳过）
├── samples.mjs                  # 真实样本清单（链接 → 期望编号/标题片段）
├── verify-live.mjs              # 人工核对脚本
└── package.json
```

结果：

- `npm test` → **52 tests / 39 pass / 13 skipped / 0 fail**（跳过的就是 live 那 13 个）。
- `npm run test:live` → **13 tests / 13 pass / 0 fail**，实测输出（节选）：

```
RO-20261027-008 收银台支付结果倒计时不跳转修复及 returnUrl 兜底
T-20261026-016   前端组 AI 工具使用规范落地：AI 工作链路与记忆 Skill 体系建设
ON3-66776        googlepay 收银台支付出现两次 fistname和lastname…
BUG-20261022-006 paymentlink订阅页面的billing amount，金额显示了首期扣款金额…
P-20260908-001   PPOW整合一期
```

单请求耗时实测 35–120 ms（首请求冷启动 100 ms 左右），5 s 超时只是保险。

## 六、已知边界与降级策略

1. **defect 只有数字 id 时无法解析**。`defect/detail` 只认 `BUG-no`（数字 id → `40400 缺陷不存在`），而 `defect/list` **忽略所有过滤条件**（传 `defectNo`/`id` 都返回别的一条），所以只能翻页扫全表。参考实现选择**直接返回 `null`**（不发请求）：为了一次改名扫全表不划算。当前日志里也没出现过数字 id 的 defect 链接。需要时可用 `POST /defect/list` 分页 + 客户端过滤，代价 5–20 次请求，建议只在后台低频场景用。
2. **只有编号没有链接**：`findDevopsRefs` 会提取纯文号 → `resolveDevopsTitle('RO-20261023-040')` 走 demand 路线可用；`T-…`/`BUG-…`/`ON3-…`/`P-…` 同样可用。纯 19 位数字**不**从散文提取（容易误伤订单号），需要时显式传 `{kind:'task', ref}`。
3. **顶端标题歧义**：`RO-…` 同时是需求单号和发布单号，靠路由区分；纯文号按需求单。两者标题通常一致（同一条需求生成的发布单继承标题），实测 `RO-20261020-018` 两种路线都给「PAYPRO - PayPal能力接入」。
4. **标题可能很长**（实测最长 60+ 汉字）。拼进会话标题时要截断并计入标题字节预算；建议平台标题截到 ~60 字符，若「编号 + 标题」本身就超预算就整段放弃前缀，只留模型总结。
5. **平台抖动/超时**：5 s 超时、任何异常 → `null` → 标题退化为纯模型总结，绝不让改名失败。
6. **会话很长时链接可能不在被送给模型的 transcript 里**（见下节）。
7. **多链接**：`resolveFirstDevopsTitle` 按出现顺序最多试 3 条，命中即停（1–2 次请求）；全部失败 → `null`。
8. **只读保证**：模块里只有上面表格里的 `GET`/`POST .../query|list|detail` 读接口，没有任何 `create/update/transition/revoke`；调研期间也没有调用过 `--raw` 或写接口。

## 七、给 Lead 的集成建议（本仓库未改插件）

插件 Host 侧是 ESM（`index.js`），可直接把 `src/` 三个文件复制进插件（例如 `devops-link.js` + `devops-resolve.js`），无需第三方依赖。

契约：

```js
findDevopsRefs(text) -> Array<{kind, ref, url|null, source:'url'|'text'}>
primaryDevopsRef(refs) -> ref|null            // 优先「真链接且非纯数字 id」
resolveDevopsTitle(refLike, credentials, fetchImpl?, {timeoutMs}?) -> {number, title}|null
resolveFirstDevopsTitle(refs, credentials, fetchImpl?, {limit=3, timeoutMs}) -> {number, title, kind, ref, url}|null
formatDevopsPrefix({number, title}) -> '编号 标题'
loadDevopsCredentials({env?, home?}) -> {baseUrl, token, source}
describeCredentials(credentials) -> {baseUrl, hasToken, source}   // 可安全打日志
```

三个注意点：

1. **扫描范围**：插件现在的 `buildTranscript` 只留「首条人类消息 + 最近 8 条」、上限 8192 字节；如果用户在中段贴过链接，链接可能已经不在 transcript 里。建议：先扫送给模型的 transcript（与总结口径一致），没有再退回扫全量事件文本（可只取 `text` 字段、加个 ~512 KB 上限，或从新到旧扫到第一个 devops 链接就停）。这比模型看到的窗口大，但只做一次正则，成本可忽略。
2. **失败即退化**：`resolveDevopsTitle` 已保证不抛异常、无 token 不发请求；Host 侧直接 `await` 即可，不需要 try/catch，也不要因为 `null` 而改变原有改名流程。
3. **token 不要进日志**：日志/错误里只放 `describeCredentials()` 的结果；插件配置里也不要出现 token，凭据交给 `loadDevopsCredentials()`（若 Host 沙箱禁 `node:fs`，则改为由插件配置注入 `{baseUrl, token}`，`resolveDevopsTitle` 本身不碰 fs）。
