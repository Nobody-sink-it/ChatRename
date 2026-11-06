import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { normalizeDeepSeekMessages, normalizeConversation } from "../core.mjs";

const source = await fs.readFile(new URL("../adapters/deepseek.js", import.meta.url), "utf8");
const ID = "aaaaaaaa-1111-2222-3333-444444444444";
const BASE = "https://chat.deepseek.com/api/v0";

function harness({ title = "旧标题", token = JSON.stringify({ value: "TOKEN-SECRET-123" }),
  hasMore = false, business = null, httpStatus = 200, badList = false, omitSession = false } = {}) {
  let listener;
  let current = title;
  const calls = [];
  const chrome = { runtime: { id: "test-extension", getURL: p => `chrome-extension://test-extension/${p}`,
    onMessage: { addListener: fn => listener = fn } } };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const path = String(url).replace(BASE, "");
    if (httpStatus !== 200) return new Response("secret-body", { status: httpStatus });
    if (business) return json({ code: business, msg: "业务失败" });
    if (path.startsWith("/chat_session/fetch_page")) {
      if (badList) return json({ code: 0, data: { biz_data: {} } });
      return json({ code: 0, data: { biz_data: {
        chat_sessions: [{ id: ID, title: current, updated_at: 1762400000, pinned: false }], has_more: hasMore } } });
    }
    if (path.startsWith("/chat/history_messages")) {
      return json({ code: 0, data: { biz_data: {
        chat_session: omitSession ? null : { id: ID, title: current },
        chat_messages: [
          { id: "m1", role: "USER", content: "帮我改个名字" },
          { id: "m2", role: "ASSISTANT", fragments: [{ type: "THINK", content: "思考中" }, { type: "RESPONSE", content: "好的" }] },
          { id: "m3", role: "ASSISTANT", status: "in_progress", fragments: [] }
        ] } } });
    }
    if (path === "/chat_session/update_title") {
      current = JSON.parse(options.body).title;
      return json({ code: 0, data: { biz_data: { updated_at: 1762400100 } } });
    }
    return json({ code: 0, data: {} });
  };
  const context = vm.createContext({ chrome, fetch, crypto: webcrypto, TextEncoder, AbortSignal, URL, URLSearchParams, console, setTimeout,
    location: { origin: "https://chat.deepseek.com" },
    localStorage: { getItem: k => (k === "userToken" ? token : null) } });
  vm.runInContext(source, context);
  const send = (op, args = {}) => new Promise(resolve => {
    listener({ channel: "chat-renamer/v1", op, ...args },
      { id: "test-extension", url: "chrome-extension://test-extension/manager.html" }, resolve);
  });
  return { send, calls, getTitle: () => current, setTitle: v => current = v, listener: () => listener };
}

test("连接返回平台标识与标题上限，不泄露登录凭证", async () => {
  const h = harness(), reply = await h.send("connect");
  assert.equal(reply.ok, true);
  assert.equal(reply.data.platform, "deepseek");
  assert.equal(reply.data.titleMax, 64);
  assert.equal(reply.data.scope.length, 64);
  assert.doesNotMatch(JSON.stringify(reply), /TOKEN-SECRET-123/);
});

test("连接时先自检列表接口，形态变了就停下而不是静默继续", async () => {
  const h = harness({ badList: true });
  assert.equal((await h.send("connect")).error.code, "format");
});

test("缺少登录凭证时明确报鉴权错误", async () => {
  const h = harness({ token: null });
  assert.equal((await h.send("connect")).error.code, "auth");
});

test("401/403/业务错误码分别归类，且不回显服务器原文", async () => {
  for (const status of [401, 403]) {
    const h = harness({ httpStatus: status });
    const reply = await h.send("connect");
    assert.equal(reply.error.code, `http_${status}`);
    assert.doesNotMatch(JSON.stringify(reply), /secret-body/);
  }
  const h = harness({ business: 40001 });
  assert.equal((await h.send("connect")).error.code, "business");
});

test("列表按游标分页，游标用布尔 pinned，且不提供总数", async () => {
  const h = harness({ hasMore: true }), { data: { scope } } = await h.send("connect");
  const page = await h.send("list", { scope });
  assert.equal(page.ok, true);
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.items[0].title, "旧标题");
  assert.equal(page.data.items[0].updateTime, 1762400000);
  assert.equal(page.data.total, null);
  assert.deepEqual({ ...page.data.nextCursor }, { pinned: false, updated_at: 1762400000 });

  const second = await h.send("list", { scope, cursor: page.data.nextCursor });
  const url = decodeURIComponent(h.calls.at(-1).url);
  assert.match(url, /lte_cursor\.pinned=false/);
  assert.match(url, /lte_cursor\.updated_at=1762400000/);
  // 游标没有前进时必须停下，否则管理器会空转。
  assert.equal(second.data.nextCursor, null);
});

test("正文接口返回标题与原始消息，供 core 归一化", async () => {
  const h = harness(), { data: { scope } } = await h.send("connect");
  const reply = await h.send("get", { scope, id: ID });
  assert.equal(reply.data.title, "旧标题");
  assert.equal(reply.data.raw.messages.length, 3);
  const messages = normalizeConversation("deepseek", reply.data.raw);
  assert.deepEqual(messages.map(m => m.role), ["user", "assistant"]);
  assert.deepEqual(messages.map(m => m.text), ["帮我改个名字", "好的"]);
});

test("改名只提交标题，写前校验原标题，写后回读确认", async () => {
  const h = harness(), { data: { scope } } = await h.send("connect");
  const reply = await h.send("rename", { scope, id: ID, expectedTitle: "旧标题", title: "新标题" });
  assert.equal(reply.ok, true);
  assert.equal(h.getTitle(), "新标题");
  const writes = h.calls.filter(c => c.url.endsWith("/chat_session/update_title"));
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), { chat_session_id: ID, title: "新标题" });
});

test("标题已被手动修改时跳过，不发送写入请求", async () => {
  const h = harness(), { data: { scope } } = await h.send("connect");
  h.setTitle("用户手动改名");
  const reply = await h.send("rename", { scope, id: ID, expectedTitle: "旧标题", title: "新标题" });
  assert.equal(reply.error.code, "conflict");
  assert.equal(h.calls.filter(c => c.url.endsWith("/chat_session/update_title")).length, 0);
});

test("恢复允许空标题，普通改名仍校验长度与空值", async () => {
  const h = harness(), { data: { scope } } = await h.send("connect");
  assert.equal((await h.send("rename", { scope, id: ID, expectedTitle: "旧标题", title: "  " })).error.code, "invalid");
  assert.equal((await h.send("rename", { scope, id: ID, expectedTitle: "旧标题", title: "长".repeat(65) })).error.code, "invalid");
  assert.equal((await h.send("rename", { scope, id: ID, expectedTitle: "旧标题", title: "", restore: true })).ok, true);
});

test("拒绝伪造来源、非法编号与未知操作", async () => {
  const h = harness();
  assert.equal(h.listener()({ channel: "chat-renamer/v1", op: "connect" }, { id: "other", url: "https://evil.example" }, () => assert.fail()), false);
  const { data: { scope } } = await h.send("connect");
  assert.equal((await h.send("get", { scope, id: "../../secret" })).error.code, "invalid");
  assert.equal((await h.send("delete", { scope, id: ID })).error.code, "invalid");
});

test("正文形态变化时停止处理，不会拿标题冒充正文", async () => {
  const h = harness({ omitSession: true }), { data: { scope } } = await h.send("connect");
  assert.equal((await h.send("get", { scope, id: ID })).error.code, "format");
});

test("fragments 形态：跳过思考与工具片段，只取正文", () => {
  const messages = normalizeDeepSeekMessages({ messages: [
    { id: "1", role: "USER", fragments: [{ type: "REQUEST", content: "问题一" }] },
    { id: "2", role: "ASSISTANT", fragments: [
      { type: "THINK", content: "内部推理" },
      { type: "TOOL_CALL", content: "工具参数" },
      { type: "RESPONSE", content: "回答一" }] },
    { id: "3", role: "SYSTEM", content: "系统提示" },
    { id: "4", role: "ASSISTANT", status: "in_progress", content: "还没说完" }
  ] });
  assert.deepEqual(messages.map(m => m.text), ["问题一", "回答一"]);
  assert.throws(() => normalizeDeepSeekMessages({}));
});
