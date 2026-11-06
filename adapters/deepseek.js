// DeepSeek 网页适配器。作为内容脚本运行，只负责"取数/写回"，
// 不处理正文归一化（交给 core.mjs 的 normalizeConversation，便于单测）。
//
// 接口依据（2026-11 核实）：chat.deepseek.com/api/v0
//   列表 GET  /chat_session/fetch_page?count=50[&lte_cursor.pinned=&lte_cursor.updated_at=]
//   正文 GET  /chat/history_messages?chat_session_id=
//   改名 POST /chat_session/update_title  {chat_session_id,title}
// 已知变更史：2026-09 正文从 content 移入 fragments[]；2026-10 游标 pinned 必须为布尔。
(() => {
  if (globalThis.__chatRenamerDeepSeek) return;
  globalThis.__chatRenamerDeepSeek = true;
  const CHANNEL = "chat-renamer/v1";
  const PLATFORM = "deepseek";
  const TITLE_MAX = 64;
  const BASE = "https://chat.deepseek.com/api/v0";
  // 该头决定接口返回的正文形态（content / fragments），跟随页面版本调整。
  const CLIENT_VERSION = "2.5.0";
  class BridgeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  function fail(code, message) { throw new BridgeError(code, message); }
  function validateId(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) fail("invalid", "聊天编号格式不正确");
  }
  function token() {
    let raw = null;
    try { raw = localStorage.getItem("userToken"); } catch { raw = null; }
    if (!raw) fail("auth", "请先在 DeepSeek 网页登录，再点击连接");
    try {
      const parsed = JSON.parse(raw);
      const value = parsed && typeof parsed === "object" ? parsed.value || parsed.token : parsed;
      if (typeof value === "string" && value) return value;
    } catch { /* 有些版本直接存裸字符串 */ }
    if (/^[\x21-\x7e]{8,}$/.test(raw)) return raw;
    fail("auth", "无法识别 DeepSeek 登录凭证，请刷新网页后重试");
  }
  function headers() {
    return {
      accept: "*/*",
      "content-type": "application/json",
      authorization: `Bearer ${token()}`,
      "x-client-platform": "web",
      "x-client-version": CLIENT_VERSION,
      "x-client-locale": "zh_CN",
      "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
      "x-app-version": "2025.04.25"
    };
  }
  async function request(path, { method = "GET", body } = {}) {
    // 鉴权失败的异常不能被网络分支吞掉，必须先把请求头取出来。
    const requestHeaders = headers();
    let response;
    try {
      response = await fetch(`${BASE}${path}`, {
        method, credentials: "include", cache: "no-store", redirect: "error",
        headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(25000)
      });
    } catch { fail("network", "DeepSeek 请求未能完成，写入结果可能未知，请先核对记录"); }
    if (!response.ok) {
      const hints = {401:"登录已过期，请刷新 DeepSeek 并重新连接",403:"DeepSeek 拒绝访问，请回到网页检查登录或验证；工具不会绕过验证",429:"DeepSeek 请求过于频繁，已暂停，请稍后再试"};
      fail(`http_${response.status}`, hints[response.status] || `DeepSeek 返回 HTTP ${response.status}，已暂停`);
    }
    const text = await response.text();
    let payload;
    try { payload = text.trim() ? JSON.parse(text) : {}; } catch { fail("format", "DeepSeek 返回格式已变化，已停止处理"); }
    if (payload && payload.code !== undefined && payload.code !== 0) {
      fail("business", `DeepSeek 返回错误：${payload.msg || `code ${payload.code}`}`);
    }
    return payload?.data ?? {};
  }
  function seconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number > 1e12 ? Math.round(number / 1000) : Math.round(number);
  }
  async function connect() {
    // 真实请求一次做接口自检：DeepSeek 数据形态变更频繁，宁可在连接时失败。
    const data = await request("/chat_session/fetch_page?count=1");
    if (!Array.isArray(data?.biz_data?.chat_sessions)) fail("format", "DeepSeek 列表接口已变化，暂时无法使用本工具");
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("deepseek:local-account"));
    const scope = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");
    return {platform:PLATFORM, scope, label:"DeepSeek 账号", titleMax:TITLE_MAX};
  }
  async function handle(message) {
    if (location.origin !== "https://chat.deepseek.com") fail("origin", "只允许在 DeepSeek 网页运行");
    if (message.op === "connect") return await connect();
    if (typeof message.scope !== "string" || !message.scope) fail("account", "请先连接当前账号");
    if (message.op === "list") {
      const cursor = message.cursor || null;
      const params = new URLSearchParams({ count: "50" });
      if (cursor && typeof cursor === "object") {
        if (typeof cursor.updated_at !== "number") fail("invalid", "分页位置不正确");
        params.set("lte_cursor.pinned", cursor.pinned ? "true" : "false");
        params.set("lte_cursor.updated_at", String(cursor.updated_at));
      } else if (cursor !== null && cursor !== undefined) fail("invalid", "分页位置不正确");
      const data = await request(`/chat_session/fetch_page?${params.toString()}`);
      const list = data?.biz_data?.chat_sessions;
      if (!Array.isArray(list)) fail("format", "聊天列表格式已变化，已停止处理");
      const items = list.map(session => {
        validateId(session?.id);
        if (typeof session.title !== "string") fail("format", "聊天标题格式已变化");
        return { id: session.id, title: session.title, updateTime: seconds(session.updated_at) };
      });
      const last = list[list.length - 1];
      const nextUpdated = last ? seconds(last.updated_at) : null;
      let nextCursor = null;
      if (data.biz_data.has_more && last && nextUpdated !== null) {
        nextCursor = { pinned: !!last.pinned, updated_at: nextUpdated };
        // 游标没有前进会导致管理器空转，宁可停下。
        if (cursor && cursor.updated_at === nextCursor.updated_at && !!cursor.pinned === nextCursor.pinned) nextCursor = null;
      }
      return { items, total: null, nextCursor };
    }
    if (message.op === "get") {
      validateId(message.id);
      const data = await request(`/chat/history_messages?chat_session_id=${encodeURIComponent(message.id)}`);
      const session = data?.biz_data?.chat_session;
      const messages = data?.biz_data?.chat_messages;
      if (!session || typeof session.title !== "string" || !Array.isArray(messages)) fail("format", "无法识别聊天内容，已停止处理");
      if (session.id && session.id !== message.id) fail("format", "返回聊天编号与请求不符");
      return { id: message.id, title: session.title, raw: { messages } };
    }
    if (message.op === "rename") {
      const { id, title, expectedTitle } = message;
      validateId(id);
      if (typeof title !== "string" || typeof expectedTitle !== "string" ||
          (message.restore !== true && (!title.trim() || Array.from(title).length > TITLE_MAX || /[\u0000-\u001f\u007f]/u.test(title)))) {
        fail("invalid", "标题无效");
      }
      const read = async () => {
        const data = await request(`/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`);
        const session = data?.biz_data?.chat_session;
        if (!session || typeof session.title !== "string") fail("format", "无法识别聊天内容，已停止处理");
        return session.title;
      };
      let before;
      try { before = await read(); }
      catch (error) { if (error.code === "http_404") fail("chat_missing", "该聊天不存在或不可访问，已跳过该条"); throw error; }
      if (before !== expectedTitle) fail("conflict", "原标题已被修改，已跳过；请重新扫描后再处理");
      await request("/chat_session/update_title", { method: "POST", body: { chat_session_id: id, title } });
      for (const delay of [0, 400, 1000]) {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        let after;
        try { after = await read(); }
        catch { fail("uncertain", "改名请求已发送，但读取结果失败；请先核对记录"); }
        if (after === title) return { title, verified: true };
      }
      fail("uncertain", "改名请求已发送，但重新读取尚未确认；已暂停，请核对记录");
    }
    fail("invalid", "不支持的操作");
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.channel !== CHANNEL || sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
    handle(message).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: { code: error.code || "unknown", message: error instanceof BridgeError ? error.message : "读取失败，未继续处理" } }));
    return true;
  });
})();
