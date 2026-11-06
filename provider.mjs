import { namingPrompt, parseSuggestions, providerEndpoint, TitleOutputError } from "./core.mjs";

export function codexBridgeEndpoint(value = "http://127.0.0.1:18183") {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("请填写本机 Codex 服务地址"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || !["", "/", "/rename"].includes(url.pathname)) throw new Error("Codex 服务只允许 http://127.0.0.1:端口 形式的本机地址");
  url.pathname = "/rename";
  return url;
}

export async function generateTitles({ rows, backend = "api", bridgeUrl, bridgeKey, baseUrl, apiKey, model, rule, signal, fetchImpl = fetch }) {
  // The old title is context for the model, not the restoration record. Bound only
  // the transmitted copy so a huge title cannot exceed the local HTTP body limit.
  rows = rows.map(row => typeof row.oldTitle === "string" ? {...row, oldTitle: Array.from(row.oldTitle).slice(0, 300).join("")} : row);
  if (backend === "codex-cli") return await generateCodexTitles({rows,bridgeUrl,bridgeKey,rule,signal,fetchImpl});
  if (!model?.trim()) throw new Error("请填写模型名称");
  const endpoint = providerEndpoint(baseUrl);
  const timeout = AbortSignal.timeout(60000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(endpoint.href, {
      method: "POST", credentials: "omit", redirect: "error", cache: "no-store", signal: combined,
      headers: { "content-type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: model.trim(), messages: namingPrompt(rows, rule), stream: false })
    });
  } catch (error) {
    if (combined.aborted) throw new Error("生成已停止或请求超过60秒，请检查结果后重试");
    throw new Error("模型连接失败，请检查地址、网络与该站点授权");
  }
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}，本批次未生成；请检查额度、密钥或模型名称`);
  let data;
  try { data = await response.json(); } catch { throw new Error("模型服务未返回JSON响应"); }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("模型返回格式不兼容，需要 Chat Completions 格式");
  return parseSuggestions(content, rows);
}

async function generateCodexTitles({rows,bridgeUrl,bridgeKey,rule,signal,fetchImpl}) {
  const endpoint=codexBridgeEndpoint(bridgeUrl);
  if(!bridgeKey?.trim())throw new Error("请打开本机服务配对页，复制本次配对码并保存连接");
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(190000)]):AbortSignal.timeout(190000);
  let response;
  try{
    response=await fetchImpl(endpoint.href,{method:"POST",credentials:"omit",redirect:"error",cache:"no-store",signal:combined,
      headers:{"content-type":"application/json",Authorization:`Bearer ${bridgeKey.trim()}`},body:JSON.stringify({rows,rule})});
  }catch{
    if(combined.aborted)throw new Error("Codex命名已停止或超过等待时间，本批不会应用");
    throw new Error("未能连接本机 Codex 服务，请先运行启动脚本，再检查地址与本机站点授权");
  }
  let data;
  try{data=await response.json();}catch{throw new Error("本机 Codex 服务返回格式不正确");}
  if(!response.ok){
    const message = data?.error || `本机服务返回 HTTP ${response.status}`;
    if (response.status === 502 && data?.code === "title_output_invalid") throw new TitleOutputError(message);
    throw new Error(message);
  }
  if(data.model!=="gpt-6-luna"||data.reasoning!=="high"||data.requestedServiceTier!=="fast")throw new Error("本机服务的模型参数不匹配，本批结果已拒绝");
  return parseSuggestions(data,rows);
}
