# 多平台适配可行性调研（P0）

调研时间：2026-11-06。目的：在动手改架构前，确认除 ChatGPT 之外哪些平台**能真正写入标题**，以及每家的鉴权与数据形态差异。

调研方法：检索公开实现（含在页面内运行的浏览器脚本、反向代理客户端）+ 官方站点形态确认。**未登录任何真实账号**，因此全部结论标注为「已验证」或「待实测」。

## 一、结论矩阵

| 平台 | 标题写入 | 会话列表 | 正文读取 | 鉴权 | 状态 | 预计工作量 |
|---|---|---|---|---|---|---|
| ChatGPT | `PATCH /backend-api/conversation/{id}` | `GET /backend-api/conversations` | 对话树 | `/api/auth/session` 取 token | 已上线 | — |
| DeepSeek | `POST /api/v0/chat_session/update_title` | `GET /api/v0/chat_session/fetch_page` | `GET /api/v0/chat/history_messages` | `localStorage.userToken` | **已验证** | 1 天 |
| Claude | 同路径 `PATCH`/`PUT`，或 `POST /api/rename_chat` | `/api/organizations/{org}/chat_conversations` | 同路径下的 messages | 页面 Cookie（同源自动携带） | **待实测**（动词未定） | 1–1.5 天 |
| 豆包 / Kimi / 元宝 / 通义 / ChatGLM / Z.ai | 各家内部接口，形态未知 | 同左 | 同左 | 各家不同 | 待调研 | 1–2 天/家 |
| Gemini | 网页端无标题概念，无改名入口 | — | — | — | **不可行** | — |
| WorkBuddy | 官网只提供桌面端/移动端下载，无网页版对话入口 | — | — | — | **不可行**（当前形态） | — |

## 二、DeepSeek：可直接实现

三份独立实现互相印证：

- `calendar0917/DeepseekWeb-enhance`（Tampermonkey，**在页面内运行**，与我们的场景完全一致）
- `NIyueeE/ds-free-api`、`TQZHR/deepseek2api`（服务端代理）

### 接口规格

基址 `https://chat.deepseek.com/api/v0`

| 操作 | 请求 |
|---|---|
| 列表 | `GET /chat_session/fetch_page?count=50`，翻页加 `lte_cursor.pinned`、`lte_cursor.updated_at` |
| 正文 | `GET /chat/history_messages?chat_session_id={id}` |
| 改名 | `POST /chat_session/update_title`，体 `{chat_session_id, title}` |

统一请求头：

```
Content-Type: application/json
Authorization: Bearer {token}
X-App-Version: 2025.04.25
```

### 鉴权

`localStorage.userToken`，值可能是 JSON 包装（取 `.value` / `.token`）也可能是裸字符串，需要兜底解析。另有 `__tea_cache_tokens_` 前缀的缓存键，可作为二次兜底。

**不需要** Proof-of-Work 头：PoW 只作用于对话生成类接口，会话管理类接口不受影响。

### 返回信封

`{ code: 0, data: { biz_data: {...} } }`，`code !== 0` 即业务失败（需与 HTTP 状态码分开判断）。

### 已知的两个坑（来自脚本注释，均发生在 2026 年内）

1. **2026-09**：`chat_messages` 不再带顶层 `content`，正文移入 `fragments[]`，需要拼接。旧代码会读到空正文。
2. **2026-10**：分页游标 `pinned` 必须是布尔字符串 `"true"/"false"`，传 `"1"/"0"` 直接 HTTP 400。

这两条正是"适配器必须能自检、失败要停"的直接理由：同一家平台半年内改过两次数据形态。

## 三、Claude：路径已确认，动词待定

- 删除已确认：`DELETE /api/organizations/{orgId}/chat_conversations/{conversationId}`，`credentials: include`，同源请求无需读 Cookie。（`urzeye/ophel` `src/adapters/claude.ts`）
- 组织 ID 获取：`GET /api/organizations`（`credentials: include`），失败再依次读 `localStorage` 的 `lastActiveOrg`、`activeOrg`、`organizationId`、`lastActiveOrganization`、`LSS-lastActiveOrg`。
- 改名候选（按优先级实测）：
  1. `PATCH /api/organizations/{org}/chat_conversations/{id}`，体 `{"name": "新标题"}`
  2. 同路径 `PUT`，体同上
  3. `POST /api/rename_chat`，体 `{conversation_uuid, organization_uuid, title}`（旧版方案，`Explosion-Scratch/claude-unofficial-api`）

注意点：Claude 的标题字段叫 `name` 而不是 `title`；同一路径的 `DELETE` 在 ophel 里需要**两种请求体变体依次重试**（无体 → `{uuid, name}`）才能稳定，说明该接口对请求体敏感，改名接口大概率也需要类似的变体兜底。

## 四、架构约束（调研推导出的三条硬性要求）

1. **归一化必须放在适配器内**。ChatGPT 是对话树（`mapping` + `current_node`，有分支），DeepSeek 是线性数组，Claude 是另一套。`core.mjs` 只能接收统一后的 `{role, text}[]`，不能再假定树结构。
2. **标题长度上限必须下放到适配器**。当前 `MAX_TITLE = 64` 是 ChatGPT 的约束，各家不同，且要传进模型提示词，否则批量应用会集中失败。
3. **每个适配器要有健康自检**。启动时拉一页列表探测，失败明确提示"该平台接口可能已变"，而不是静默写坏。DeepSeek 一年内两次改形态，这个机制不是可选项。

## 五、参考实现：Ophel 的代价

`urzeye/ophel`（1011 stars，GPL-3.0，今日仍在更新）支持 15 个平台，是最接近的多平台参照。三个可复用判断：

1. **它做分类的方式是本地存储**：`src/stores/folders-store.ts`、`src/stores/tags-store.ts`，不碰平台端分组能力。这印证了"本地标签库"是可行且成熟的做法。
2. **它不做 API 改名**：全仓库检索 `update_title` 无结果。改名这件事在 Ophel 里没有实现，说明我们的定位（API 批量改名）是差异化的，也说明这条路的复杂度确实更高。
3. **维护成本可视化**：每个平台一份 `*-adapter-config-hotfix-matrix.md`，DeepSeek 单独一份的 `configVersion` 已到 2，需要热修的选择器字段覆盖输入框、发送、停止、会话列表、消息、滚动、大纲、导出、网络监控等十余类。这是纯 DOM 路线的代价——我们走 API 路线，字段少得多，但换来的是"接口随时可能变"。

## 六、下一步

1. 用真实登录态对 Claude 做 15 分钟试探（三种动词按序试一条测试会话），确认改名可用性。
2. 确认后再动 `adapters/` 重构；未确认前不要把 Claude 排进工期。
3. DeepSeek 可直接进 P2，规格已足够实现，无需再逆向。
