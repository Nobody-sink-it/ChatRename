import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { namingPrompt, parseSuggestions, validateId, validateTitle } from "../core.mjs";

export const CODEX_MODEL = "gpt-6-luna";
export const CODEX_REASONING = "high";
export const CODEX_TIER = "fast";
export const CODEX_TIMEOUT_MS = 180000;

export function validateBatch(value) {
  const rows = value?.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5) throw new Error("每次只允许1–5条命名任务");
  const seen = new Set();
  const clean = rows.map(row => {
    validateId(row?.id);
    if (seen.has(row.id)) throw new Error("命名任务含重复编号");
    seen.add(row.id);
    if (typeof row.oldTitle !== "string" || typeof row.excerpt !== "string" || !row.excerpt.trim() || row.excerpt.length > 12000) throw new Error("标题或正文节选格式不正确");
    return { id: row.id, oldTitle: row.oldTitle, excerpt: row.excerpt };
  });
  if (value.rule !== undefined && (typeof value.rule !== "string" || value.rule.length > 2000)) throw new Error("命名规则最多2000字符");
  return { rows: clean, rule: value.rule };
}

export function buildCodexArgs(schemaPath, workdir) {
  return ["--no-daemon", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
    "--sandbox", "read-only", "--model", CODEX_MODEL,
    "-c", `model_reasoning_effort=${JSON.stringify(CODEX_REASONING)}`,
    "-c", `service_tier=${JSON.stringify(CODEX_TIER)}`,
    "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
    "--disable", "shell_tool", "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
    "--disable", "browser_use", "--disable", "computer_use", "--disable", "multi_agent", "--disable", "memories",
    "--disable", "image_generation", "--disable", "view_image", "--disable", "skill_search",
    "--enable", "skip_host_skill_discovery", "--disable", "workspace_dependencies",
    "--output-schema", schemaPath, "--json", "--color", "never", "--cd", workdir, "-"];
}

export function parseCodexEvents(stdout, rows) {
  const events = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
    try { return JSON.parse(line); } catch { throw new Error("Codex 返回了无法识别的事件格式"); }
  });
  const failed = events.some(e => ["turn.failed", "error"].includes(e.type));
  if (failed || !events.some(e => e.type === "turn.completed")) throw new Error("Codex 未完成本批任务；请检查账号额度、模型与快速模式权限");
  const harmlessFeatureWarning = e => e.item?.type === "error" && /^Under-development features enabled: skip_host_skill_discovery\./.test(e.item.message || "");
  const toolEvents = events.filter(e => e.type?.startsWith("item.") && e.item?.type && !["agent_message", "reasoning", "plan_update"].includes(e.item.type) && !harmlessFeatureWarning(e));
  if (toolEvents.length) throw new Error(`命名任务出现非文字事件（${Array.from(new Set(toolEvents.map(e=>e.item.type))).join(",")}），本批结果已拒绝`);
  const final = events.filter(e => e.type === "item.completed" && e.item?.type === "agent_message").at(-1)?.item?.text;
  if (typeof final !== "string") throw new Error("Codex 未返回最终标题结果");
  const titles = parseSuggestions(final, rows);
  return { titles: rows.map(row => ({id: row.id, title: validateTitle(titles.get(row.id))})),
    usage: events.findLast(e => e.type === "turn.completed")?.usage || null };
}

async function cleanup(directory) {
  // This is our own mkdtemp directory, never a user-selected or arbitrary path.
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("chatgpt-renamer-codex-")) throw new Error("临时目录清理范围检查失败");
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function runCodexBatch(input, { signal, executable = process.env.RENAMER_CODEX_EXE || "codex", timeoutMs = CODEX_TIMEOUT_MS, spawnImpl = spawn, diagnosticsCallback } = {}) {
  const {rows,rule} = validateBatch(input);
  const directory = await mkdtemp(path.join(tmpdir(), "chatgpt-renamer-codex-"));
  const schemaPath = path.join(directory, "output.schema.json");
  const schema = {type:"object",properties:{titles:{type:"array",items:{type:"object",properties:{id:{type:"string"},title:{type:"string"}},required:["id","title"],additionalProperties:false}}},required:["titles"],additionalProperties:false};
  await writeFile(schemaPath, JSON.stringify(schema));
  const messages = namingPrompt(rows, rule);
  const prompt = `${messages[0].content}\n这是纯文字转换任务，禁止使用任何工具、读取文件、联网搜索、运行命令或改动聊天。仅根据以下JSON数据生成标题。\n${messages[1].content}`;
  const started = Date.now();
  let child, childFinished = Promise.resolve();
  try {
    const stdout = await new Promise((resolve,reject) => {
      if (signal?.aborted) return reject(new Error("本批命名已停止"));
      let output = "", diagnostics = "", settled = false, timer;
      const finish = (error,value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort",onAbort);
        error ? reject(error) : resolve(value);
      };
      const stop = message => {child?.kill();finish(new Error(message));};
      const onAbort = () => stop("本批命名已停止；未返回的结果不会应用");
      // No shell interpolation: all arguments are fixed, and conversation data only enters stdin.
      child = spawnImpl(executable, buildCodexArgs(schemaPath,directory), {shell:false,windowsHide:true,cwd:directory,stdio:["pipe","pipe","pipe"]});
      childFinished = new Promise(resolve=>{child.once("close",resolve);child.once("error",resolve);});
      signal?.addEventListener("abort",onAbort,{once:true});
      timer=setTimeout(()=>stop("Codex 命名超过180秒，已停止本批；不会自动换模型或降级"),timeoutMs);
      child.on("error",()=>finish(new Error("无法启动 Codex CLI，请确认已安装、已登录，且启动脚本能找到 codex.exe")));
      child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
      child.stdout.on("data",chunk=>{output+=chunk;if(Buffer.byteLength(output)>1000000)stop("Codex 输出异常过大，本批已停止");});
      child.stderr.on("data",chunk=>{diagnostics=(diagnostics+chunk).slice(-30000);});
      child.on("close",code=>{
        if (code !== 0) {
          const hint = /not supported|not available|model.*not found|invalid.*model/i.test(diagnostics+output) ? "指定模型或快速模式不受当前账号支持" : /rate.?limit|usage.?limit|quota/i.test(diagnostics+output) ? "账号额度不足或被限流" : "CLI执行失败，请检查登录、网络或运行环境";
          finish(new Error(`Codex ${hint}（退出码${code}）；没有自动切换模型`));
        } else finish(null,output);
      });
      child.stdin.on("error",()=>{});child.stdin.end(prompt,"utf8");
    });
    diagnosticsCallback?.(stdout);
    const result = parseCodexEvents(stdout,rows);
    return {...result,model:CODEX_MODEL,reasoning:CODEX_REASONING,requestedServiceTier:CODEX_TIER,elapsedMs:Date.now()-started};
  } finally {
    if(child && child.exitCode === null && !child.killed)child.kill();
    let cleanupTimer;
    await Promise.race([childFinished,new Promise(resolve=>{cleanupTimer=setTimeout(resolve,2000);})]);
    clearTimeout(cleanupTimer);
    await cleanup(directory);
  }
}
