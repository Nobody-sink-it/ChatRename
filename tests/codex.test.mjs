import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import http from "node:http";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {access} from "node:fs/promises";
import {buildCodexArgs,parseCodexEvents,validateBatch,runCodexBatch} from "../local-codex/runner.mjs";
import {createBridge} from "../local-codex/server.mjs";
import {generateTitles,codexBridgeEndpoint} from "../provider.mjs";

const rows=[{id:"fiction-0001",oldTitle:"新聊天",excerpt:"这是一段虚构正文"}];
const result={titles:[{id:rows[0].id,title:"聊天整理｜批量命名"}],model:"gpt-6-luna",reasoning:"high",requestedServiceTier:"fast"};
const extensionOrigin='chrome-extension://'+'a'.repeat(32);
const events=()=>[{type:"thread.started",thread_id:"fictional"},{type:"item.completed",item:{type:"agent_message",text:JSON.stringify({titles:result.titles})}},{type:"turn.completed",usage:{input_tokens:100,output_tokens:20}}];

test("CLI固定模型、high和fast，只读且禁止shell，不把聊天插入命令",()=>{
  const args=buildCodexArgs("output.schema.json","temporary-workdir");
  assert.equal(args[args.indexOf("--model")+1],"gpt-6-luna");assert.ok(args.includes('model_reasoning_effort="high"'));assert.ok(args.includes('service_tier="fast"'));
  assert.ok(args.includes("read-only"));assert.ok(args.includes("--ephemeral"));assert.ok(args.includes("--ignore-user-config"));assert.ok(args.includes("shell_tool"));assert.equal(args.at(-1),"-");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});
function fakeChild(){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.killed=false;
  child.kill=()=>{child.killed=true;setImmediate(()=>{child.exitCode=-1;child.emit("close",-1);});return true;};
  return child;
}
test("运行器通过stdin传递数据，成功后清理自己的临时目录",async()=>{
  let stdin="",launch;
  const output=await runCodexBatch({rows},{spawnImpl:(executable,args,options)=>{
    launch={executable,args,options};const child=fakeChild();child.stdin.on("data",chunk=>stdin+=chunk.toString("utf8"));
    child.stdin.on("finish",()=>setImmediate(()=>{child.stdout.end(events().map(JSON.stringify).join("\n"));child.exitCode=0;child.emit("close",0);}));return child;
  }});
  assert.equal(output.model,"gpt-6-luna");assert.equal(launch.options.shell,false);assert.ok(stdin.includes(rows[0].excerpt));assert.ok(!launch.args.join(" ").includes(rows[0].excerpt));
  await assert.rejects(access(launch.options.cwd));
});
test("停止或超时会结束CLI子进程，并等待退出后清理",async()=>{
  for(const abort of [true,false]){
    const controller=new AbortController();let child,directory;
    const promise=runCodexBatch({rows},{signal:controller.signal,timeoutMs:30,spawnImpl:(executable,args,options)=>{directory=options.cwd;child=fakeChild();if(abort)setImmediate(()=>controller.abort());return child;}});
    await assert.rejects(promise,/停止|超过/);assert.equal(child.killed,true);assert.equal(child.exitCode,-1);await assert.rejects(access(directory));
  }
});
test("拒绝过量、重复或格式异常的命名任务",()=>{
  assert.throws(()=>validateBatch({rows:[]}));assert.throws(()=>validateBatch({rows:Array(6).fill(rows[0])}));assert.throws(()=>validateBatch({rows:[rows[0],rows[0]]}));
  assert.throws(()=>validateBatch({rows:[{...rows[0],excerpt:"x".repeat(12001)}]}));
  assert.deepEqual(validateBatch({rows,command:"do not execute me",model:"another-model"}).rows,rows);
  assert.equal(validateBatch({rows:[{...rows[0],oldTitle:"旧".repeat(400)}]}).rows[0].oldTitle.length,400);
});
test("Codex事件必须完成且结果编号完整，工具活动和失败被拒绝",()=>{
  assert.deepEqual(parseCodexEvents(events().map(JSON.stringify).join("\n"),rows).titles,result.titles);
  assert.throws(()=>parseCodexEvents(events().slice(0,-1).map(JSON.stringify).join("\n"),rows));
  const withTool=[...events(),{type:"item.completed",item:{type:"command_execution",command:"echo never"}}];
  assert.throws(()=>parseCodexEvents(withTool.map(JSON.stringify).join("\n"),rows));
  const withWarning=[{type:"item.completed",item:{type:"error",message:"Under-development features enabled: skip_host_skill_discovery. warning"}},...events()];
  assert.deepEqual(parseCodexEvents(withWarning.map(JSON.stringify).join("\n"),rows).titles,result.titles);
  const withError=[{type:"item.completed",item:{type:"error",message:"model not supported"}},...events()];
  assert.throws(()=>parseCodexEvents(withError.map(JSON.stringify).join("\n"),rows));
});
test("插件只能请求127.0.0.1本机桥接，且结果参数必须匹配",async()=>{
  for(const address of ["https://example.com","http://localhost:18183","http://127.0.0.1:18183/arbitrary","http://127.0.0.1:18183/?token=bad"])assert.throws(()=>codexBridgeEndpoint(address));
  let options;
  const output=await generateTitles({backend:"codex-cli",rows,bridgeKey:"TEST_PAIR_CODE",bridgeUrl:"http://127.0.0.1:18183",fetchImpl:async(url,config)=>{assert.equal(url,"http://127.0.0.1:18183/rename");options=config;return Response.json(result);}});
  assert.equal(output.get(rows[0].id),result.titles[0].title);assert.deepEqual(JSON.parse(options.body).rows,rows);assert.equal(options.credentials,"omit");
  await assert.rejects(generateTitles({backend:"codex-cli",rows,bridgeKey:"TEST",fetchImpl:async()=>Response.json({...result,model:"different-model"})}),/参数不匹配/);
});
test("超长原标题仅截取发送给模型的副本，原始数据保持不变",async()=>{
  const original="旧".repeat(100000), input=[{...rows[0],oldTitle:original}]; let sent;
  await generateTitles({backend:"codex-cli",rows:input,bridgeKey:"TEST",fetchImpl:async(_url,config)=>{sent=JSON.parse(config.body);return Response.json(result);}});
  assert.equal(sent.rows[0].oldTitle.length,300);assert.equal(input[0].oldTitle,original);
});

async function serve(t,run=async()=>result){
  const bridge=createBridge({token:"fixture-pairing-token-only",run});
  bridge.server.listen(0,"127.0.0.1");await once(bridge.server,"listening");
  t.after(async()=>{bridge.abortAll();bridge.server.closeAllConnections();await new Promise(resolve=>bridge.server.close(resolve));});
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const request=(body={rows},headers={})=>fetch(base+"/rename",{method:"POST",headers:{Origin:extensionOrigin,"content-type":"application/json",Authorization:`Bearer ${bridge.token}`,...headers},body:JSON.stringify(body)});
  return {...bridge,base,request};
}
test("Codex 标题数量不符时，浏览器收到可隔离的结果错误", async t => {
  const bridge = await serve(t, async () => parseCodexEvents(events().map(JSON.stringify).join("\n"), [...rows, {...rows[0], id:"fiction-0002"}]));
  await assert.rejects(generateTitles({backend:"codex-cli", rows, bridgeUrl:bridge.base, bridgeKey:bridge.token}),
    {code:"title_output_invalid", message:"标题数量不符，预期 2 条，收到 1 条"});
});
test("健康检查要求扩展来源和配对码，不运行模型或泄漏配对码",async t=>{
  let calls=0;const h=await serve(t,async()=>{calls++;return result;});
  const headers={Origin:extensionOrigin,Authorization:`Bearer ${h.token}`};
  const ok=await fetch(h.base+'/health',{headers});assert.equal(ok.status,200);
  const body=await ok.json();assert.deepEqual(body,{ok:true,model:'gpt-6-luna',reasoning:'high',requestedServiceTier:'fast'});
  assert.ok(!JSON.stringify(body).includes(h.token));assert.equal(calls,0);
  assert.equal((await fetch(h.base+'/health',{headers:{Origin:extensionOrigin}})).status,401);
  assert.equal((await fetch(h.base+'/health',{headers:{Origin:extensionOrigin,Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await fetch(h.base+'/health',{headers:{Authorization:`Bearer ${h.token}`}})).status,200);
  assert.equal((await fetch(h.base+'/health')).status,401);
  assert.equal((await fetch(h.base+'/health',{headers:{Origin:'https://evil.example',Authorization:`Bearer ${h.token}`}})).status,403);
  const preflight=await fetch(h.base+'/health',{method:'OPTIONS',headers:{Origin:extensionOrigin}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),extensionOrigin);
  assert.equal((await fetch(h.base+'/health',{method:'OPTIONS',headers:{Origin:'https://evil.example'}})).status,403);
});
test("本机HTTP通路：身份校验、来源限制、正文节选与固定模型响应",async t=>{
  let received;
  const h=await serve(t,async input=>{received=input;return result;});
  assert.equal((await h.request({rows},{Authorization:"Bearer wrong"})).status,401);
  assert.equal((await h.request({rows},{Origin:"https://evil.example"})).status,403);
  const reboundStatus=await new Promise((resolve,reject)=>{
    const request=http.request(h.base+"/rename",{method:"POST",headers:{Host:"evil.example","content-type":"application/json",Authorization:`Bearer ${h.token}`}},response=>{response.resume();resolve(response.statusCode);});
    request.on("error",reject);request.end(JSON.stringify({rows}));
  });
  assert.equal(reboundStatus,403);
  assert.equal((await h.request({rows:[]})).status,400);
  const response=await h.request();assert.equal(response.status,200);assert.deepEqual((await response.json()).titles,result.titles);assert.deepEqual(received.rows,rows);
  assert.equal(response.headers.get("access-control-allow-origin"),extensionOrigin);
  const cors=await fetch(h.base+"/rename",{method:"OPTIONS",headers:{Origin:extensionOrigin}});assert.equal(cors.status,204);
  const pair=await fetch(h.base+"/");assert.ok(pair.headers.get("content-security-policy").includes("frame-ancestors 'none'"));assert.match(await pair.text(),/本次启动的配对码/);
  assert.equal((await fetch(h.base+"/",{headers:{Origin:"https://evil.example"}})).status,403);
});
test("同一时刻只运行一批，第二个请求不会另起CLI",async t=>{
  let release,started;const ready=new Promise(resolve=>started=resolve);const gate=new Promise(resolve=>release=resolve);let calls=0;
  const h=await serve(t,async()=>{calls++;started();await gate;return result;});
  const first=h.request();await ready;
  assert.equal((await h.request()).status,409);assert.equal(calls,1);release();assert.equal((await first).status,200);
});
test("客户端停止时取消本机任务，不继续运行后台批次",async t=>{
  let started;const ready=new Promise(resolve=>started=resolve);let canceled=false;
  const h=await serve(t,async(input,{signal})=>{started();await new Promise(resolve=>signal.addEventListener("abort",()=>{canceled=true;resolve();},{once:true}));throw new Error("cancelled");});
  const controller=new AbortController();
  const pending=fetch(h.base+"/rename",{method:"POST",headers:{"content-type":"application/json",Authorization:`Bearer ${h.token}`},body:JSON.stringify({rows}),signal:controller.signal});
  await ready;controller.abort();await assert.rejects(pending);
  for(let i=0;i<30&&!canceled;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(canceled,true);
});
