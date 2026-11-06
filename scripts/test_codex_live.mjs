import {runCodexBatch} from "../local-codex/runner.mjs";
import {writeFile} from "node:fs/promises";

const result=await runCodexBatch({rows:[
  {id:"fiction-0001",oldTitle:"新聊天",excerpt:"[1 user] 我想把AI聊天按正文自动重命名，批量预览后再应用，保留旧标题用于恢复。\n[2 assistant] 可以用浏览器插件读取聊天，调用本机Codex CLI生成新标题，再由插件写回。"},
  {id:"fiction-0002",oldTitle:"问题",excerpt:"[1 user] 为什么窗函数能减轻频谱泄漏？矩形窗和汉宁窗有什么区别？\n[2 assistant] 不同窗函数会影响主瓣宽度与旁瓣高度，要权衡频率分辨率和泄漏抑制。"}
]},{diagnosticsCallback:stdout=>{
  const diagnostics=stdout.split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {};}}).filter(e=>e.item?.type==="error"||e.type==="error");
  if(diagnostics.length)console.log(JSON.stringify({diagnostics},null,2));
}});
await writeFile(new URL("../validation/codex-live-report.json",import.meta.url),JSON.stringify({date:new Date().toISOString(),input:"Two fictional conversations; no user history",...result},null,2));
console.log(JSON.stringify(result,null,2));
