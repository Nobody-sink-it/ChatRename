(() => {
  if (globalThis.__chatgptRenamerBridge) return;
  globalThis.__chatgptRenamerBridge = true;
  const CHANNEL = "chatgpt-renamer/v1";
  let cachedSession = null;
  class BridgeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  function fail(code, message) { throw new BridgeError(code, message); }
  function validateId(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) fail("invalid", "聊天编号格式不正确");
  }
  function accountId() {
    const raw = localStorage.getItem("_account");
    if (!raw) return "personal";
    let value;
    try { value = JSON.parse(raw); } catch { value = raw; }
    if (value === "personal" || value === null) return "personal";
    if (typeof value === "string" && /^[\w-]{8,150}$/.test(value)) return value;
    fail("account", "无法识别当前工作区，请切回个人工作区后重试");
  }
  async function jsonRequest(path, options = {}, allowEmpty = false) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", cache: "no-store", redirect: "error",
        ...options, signal: AbortSignal.timeout(25000) });
    } catch { fail("network", "ChatGPT 请求未能完成，写入结果可能未知，请先核对记录"); }
    if (!response.ok) {
      if (response.status === 404 && options.method === "GET" && /^\/backend-api\/conversation\/[a-zA-Z0-9_-]+$/.test(path)) fail("chat_missing", "该聊天不存在或不可访问，已跳过该条");
      const hints = {401:"登录已过期，请刷新 ChatGPT 并重新连接",403:"ChatGPT 拒绝访问，请回到网页检查登录或验证；工具不会绕过验证",404:"聊天或接口不存在，可能是权限或网页接口已变化",429:"ChatGPT 请求过于频繁，已暂停，请稍后再试"};
      fail(`http_${response.status}`, hints[response.status] || `ChatGPT 返回 HTTP ${response.status}，已暂停`);
    }
    const text = await response.text();
    if (!text.trim() && allowEmpty) return {};
    try { return JSON.parse(text); } catch { fail("format", "ChatGPT 返回格式已变化，已停止处理"); }
  }
  async function session(force = false) {
    const account = accountId();
    if (!force && cachedSession && cachedSession.account === account && Date.now() - cachedSession.at < 30000) return cachedSession;
    const data = await jsonRequest("/api/auth/session");
    if (typeof data?.accessToken !== "string" || !data.accessToken || typeof data?.user?.id !== "string") fail("auth", "无法读取有效登录状态，请先在 ChatGPT 网页登录");
    const identity = `${data.user.id}:${account}`;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    const scope = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");
    cachedSession = { token: data.accessToken, scope, account, at: Date.now(), label: account === "personal" ? "个人工作区" : "团队工作区" };
    return cachedSession;
  }
  async function api(path, options, expectedScope) {
    const s = await session(true);
    if (s.scope !== expectedScope) fail("account", "账号或工作区已切换，请重新连接；没有继续写入");
    const headers = { accept:"application/json", Authorization: `Bearer ${s.token}`, "content-type":"application/json" };
    if (s.account !== "personal") headers["chatgpt-account-id"] = s.account;
    try { return await jsonRequest(path, { ...options, headers }, options?.method === "PATCH"); }
    catch(error) { if (error.code === "http_401") cachedSession = null; throw error; }
  }
  async function get(id, scope) {
    validateId(id);
    const data = await api(`/backend-api/conversation/${encodeURIComponent(id)}`, {method:"GET"}, scope);
    if (!data || typeof data.title !== "string" || !data.mapping || typeof data.mapping !== "object") fail("format", "无法识别聊天内容，已停止处理");
    if (data.conversation_id && data.conversation_id !== id) fail("format", "返回聊天编号与请求不符");
    return data;
  }
  async function handle(message) {
    if (location.origin !== "https://chatgpt.com") fail("origin", "只允许在 ChatGPT 网页运行");
    if (message.op === "connect") {
      const s = await session(true);
      return {scope:s.scope,label:s.label};
    }
    if (typeof message.scope !== "string" || !message.scope) fail("account", "请先连接当前账号");
    if (message.op === "list") {
      const offset = message.offset;
      if (!Number.isInteger(offset) || offset < 0 || offset > 100000) fail("invalid", "分页位置不正确");
      const data = await api(`/backend-api/conversations?offset=${offset}&limit=50&order=updated`, {method:"GET"}, message.scope);
      if (!Array.isArray(data?.items) || !Number.isInteger(data.total) || data.total < 0) fail("format", "聊天列表格式已变化，已停止处理");
      const items = data.items.map(item => {
        validateId(item.id);
        if (typeof item.title !== "string") fail("format", "聊天标题格式已变化");
        return { id:item.id,title:item.title,createTime:item.create_time,updateTime:item.update_time };
      });
      return {items,total:data.total};
    }
    if (message.op === "get") return await get(message.id, message.scope);
    if (message.op === "rename") {
      const {id,title,expectedTitle} = message;
      validateId(id);
      if (typeof title !== "string" || typeof expectedTitle !== "string" || (message.restore !== true && (!title.trim() || Array.from(title).length > 128 || /[\u0000-\u001f\u007f]/u.test(title)))) fail("invalid", "标题无效");
      const before = await get(id,message.scope);
      if (before.title !== expectedTitle) fail("conflict", "原标题已被修改，已跳过；请重新扫描后再处理");
      await api(`/backend-api/conversation/${encodeURIComponent(id)}`, {method:"PATCH", body:JSON.stringify({title})}, message.scope);
      for (const delay of [0,400,1000]) {
        if (delay) await new Promise(resolve=>setTimeout(resolve,delay));
        let after;
        try { after = await get(id,message.scope); }
        catch { fail("uncertain", "改名请求已发送，但读取结果失败；请先核对记录"); }
        if (after.title === title) return {title,verified:true};
      }
      fail("uncertain", "改名请求已发送，但重新读取尚未确认；已暂停，请核对记录");
    }
    fail("invalid", "不支持的操作");
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if (message?.channel !== CHANNEL || sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
    handle(message).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:{code:error.code||"unknown",message:error instanceof BridgeError?error.message:"读取失败，未继续处理"}}));
    return true;
  });
})();
