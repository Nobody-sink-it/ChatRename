import http from "node:http";
import {randomBytes,timingSafeEqual} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {runCodexBatch,validateBatch,CODEX_MODEL,CODEX_REASONING,CODEX_TIER} from "./runner.mjs";

const extensionOrigin = value => typeof value === "string" && /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const safeEqual = (a,b) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createBridge({token=randomBytes(24).toString("base64url"),run=runCodexBatch}={}) {
  let running=false;
  const jobs=new Set();
  const server=http.createServer(async(req,res)=>{
    const port=server.address()?.port;
    const host=`127.0.0.1:${port}`;
    const origin=req.headers.origin;
    const allowedOrigin=extensionOrigin(origin);
    const json=(status,value)=>{
      if(res.destroyed)return;
      res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff",...(allowedOrigin?{"access-control-allow-origin":origin,"vary":"Origin"}:{})});
      res.end(JSON.stringify(value));
    };
    // Exact Host checks prevent DNS rebinding. Public websites receive no CORS access.
    if(req.headers.host!==host)return json(403,{error:"只接受127.0.0.1本机请求"});
    if(origin&&!allowedOrigin&&origin!==`http://${host}`)return json(403,{error:"不允许此网页来源"});
    if(req.method==="GET"&&req.url==="/"){
      if(origin&&origin!==`http://${host}`)return json(403,{error:"请直接打开本机配对页面"});
      res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'","x-frame-options":"DENY","x-content-type-options":"nosniff"});
      return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 本机命名服务</title><style>body{max-width:660px;margin:70px auto;padding:24px;font:16px/1.8 system-ui;color:#243b2e;background:#f4f7f4}h1{font-size:27px}input{box-sizing:border-box;width:100%;padding:13px;font:16px monospace;border:1px solid #aabbaa;border-radius:7px}small{color:#596c60}code{background:#e3ebe3;padding:3px 6px}</style><h1>Codex 本机命名服务已启动</h1><p>模型：<code>${CODEX_MODEL}</code> · 思考：<code>${CODEX_REASONING}</code> · 请求档位：<code>${CODEX_TIER}</code></p><p>回到插件，选择「本机 Codex CLI」，填下面的地址和配对码，然后保存连接。</p><p>地址：<code>http://${host}</code></p><label>本次启动的配对码<input readonly value="${escape(token)}" aria-label="本次启动的配对码"></label><p><small>只在插件中粘贴此码。关闭服务后连接失效，重新启动会生成新码。服务仅监听本机，不提供任意命令执行接口。</small></p><p><small>正文节选通过已登录的 Codex CLI 发给 OpenAI，使用你的 Codex 额度；没有在本机运行模型。请保留启动窗口，结束时按 Ctrl+C。</small></p></html>`);
    }
    if(req.method==="OPTIONS"&&(req.url==="/rename"||req.url==="/health")){
      if(!allowedOrigin)return json(403,{error:"只允许浏览器扩展来源"});
      res.writeHead(204,{"access-control-allow-origin":origin,"access-control-allow-methods":"GET, POST, OPTIONS","access-control-allow-headers":"authorization, content-type","access-control-allow-private-network":"true","access-control-max-age":"300","vary":"Origin"});return res.end();
    }
    if(req.method==="GET"&&req.url==="/health"){
      if(origin&&!allowedOrigin)return json(403,{error:"只允许浏览器扩展来源"});
      if(!safeEqual(req.headers.authorization,`Bearer ${token}`))return json(401,{error:"本机配对码不正确或已过期"});
      return json(200,{ok:true,model:CODEX_MODEL,reasoning:CODEX_REASONING,requestedServiceTier:CODEX_TIER});
    }
    if(req.method!=="POST"||req.url!=="/rename")return json(404,{error:"不支持的接口"});
    if(!safeEqual(req.headers.authorization,`Bearer ${token}`))return json(401,{error:"本机配对码不正确或已过期，请打开配对页重新复制"});
    if(!req.headers["content-type"]?.startsWith("application/json"))return json(415,{error:"仅接受JSON命名任务"});
    if(running)return json(409,{error:"本机已有一个命名批次运行中，请等待结束"});
    const chunks=[];let size=0;
    try{
      for await(const chunk of req){size+=chunk.length;if(size>300000)return json(413,{error:"正文节选过大，请减少任务数量"});chunks.push(chunk);}
    }catch{return;}
    let input;
    try{input=validateBatch(JSON.parse(Buffer.concat(chunks).toString("utf8")));}
    catch{return json(400,{error:"命名任务格式不正确，只接受1–5条正文节选和命名规则"});}
    // Lock is checked again after async body parsing to avoid simultaneous requests.
    if(running)return json(409,{error:"本机已有一个命名批次运行中，请等待结束"});
    const controller=new AbortController();
    const cancel=()=>{if(!res.writableEnded)controller.abort();};res.on("close",cancel);
    running=true;jobs.add(controller);
    try{const result=await run(input,{signal:controller.signal});json(200,result);}
    catch(error){
      const body = {error:error.message||"Codex处理失败"};
      if (!controller.signal.aborted && error.code === "title_output_invalid") body.code = error.code;
      json(controller.signal.aborted?499:502,body);
    }
    finally{running=false;jobs.delete(controller);res.off("close",cancel);}
  });
  server.headersTimeout=10000;server.requestTimeout=20000;
  return {server,token,abortAll:()=>jobs.forEach(job=>job.abort())};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.RENAMER_PORT||18183);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error("RENAMER_PORT需为1024–65535之间的端口");
  const bridge=createBridge();
  bridge.server.on("error",error=>{console.error(error.code==="EADDRINUSE"?`端口${port}已被占用；不会结束其他程序。请设置RENAMER_PORT后重启。`:"本机服务启动失败");process.exitCode=1;});
  bridge.server.listen(port,"127.0.0.1",()=>{
    console.log(`Codex 本机命名服务：http://127.0.0.1:${port}/`);
    console.log(`模型 ${CODEX_MODEL} | reasoning ${CODEX_REASONING} | requested tier ${CODEX_TIER}`);
    console.log("在浏览器打开上面的地址查看配对码。只在本机运行，按Ctrl+C停止。");
  });
  const shutdown=()=>{bridge.abortAll();bridge.server.close();};
  process.once("SIGINT",shutdown);process.once("SIGTERM",shutdown);
}
