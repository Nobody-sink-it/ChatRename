import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import { webcrypto } from "node:crypto";
const source=await fs.readFile(new URL("../adapters/chatgpt.js",import.meta.url),"utf8");

function harness({failure=null,changeOnVerify=false,sessionFailure=null,before404=false,verify404=false}={}){
  let listener,title="原标题",account="personal",user="user-a",getCount=0;
  const calls=[];
  const chrome={runtime:{id:"test-extension",getURL:p=>`chrome-extension://test-extension/${p}`,onMessage:{addListener:fn=>listener=fn}}};
  const fetch=async(path,options)=>{
    calls.push({path,options});
    if(path==="/api/auth/session")return sessionFailure?new Response('',{status:sessionFailure}):Response.json({accessToken:"NEVER_EXPORT_TOKEN",user:{id:user}});
    if(failure&&path.includes("backend-api"))return new Response("secret-body",{status:failure});
    if(path.startsWith("/backend-api/conversations?"))return Response.json({items:[{id:"chat-0001",title}],total:1});
    if(options.method==="PATCH"){title=JSON.parse(options.body).title;return new Response(null,{status:204});}
    getCount++;
    if(before404 || (verify404 && getCount>1))return new Response('',{status:404});
    return Response.json({conversation_id:"chat-0001",title:changeOnVerify&&getCount>1?"another-title":title,mapping:{root:{parent:null}},current_node:"root"});
  };
  const context=vm.createContext({chrome,fetch,crypto:webcrypto,TextEncoder,AbortSignal,URL,console,setTimeout,location:{origin:"https://chatgpt.com"},localStorage:{getItem:()=>JSON.stringify(account)}});
  vm.runInContext(source,context);
  const send=(op,args={})=>new Promise(resolve=>{
    listener({channel:"chat-renamer/v1",op,...args},{id:"test-extension",url:"chrome-extension://test-extension/manager.html"},resolve);
  });
  return {send,calls,getTitle:()=>title,setTitle:value=>title=value,switchAccount:()=>user="user-b",listener:()=>listener};
}
test("连接只返回哈希标识，不泄露会话凭证",async()=>{
  const h=harness(),reply=await h.send("connect");assert.equal(reply.ok,true);assert.equal(reply.data.scope.length,64);assert.doesNotMatch(JSON.stringify(reply),/NEVER_EXPORT_TOKEN|user-a/);
});
test("改名只发送title字段，并读取服务器确认，支持204响应",async()=>{
  const h=harness(),{data:{scope}}=await h.send("connect");
  const reply=await h.send("rename",{scope,id:"chat-0001",expectedTitle:"原标题",title:"新标题"});
  assert.equal(reply.ok,true);assert.equal(h.getTitle(),"新标题");
  const writes=h.calls.filter(c=>c.options.method==="PATCH");assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body),{title:"新标题"});
  assert.equal(h.calls.filter(c=>c.path==="/backend-api/conversation/chat-0001"&&c.options.method==="GET").length,2);
});
test("特殊原标题可改名和按原样恢复，新标题仍受校验",async()=>{
  for(const original of ["", "旧".repeat(400), "旧标题 ✨ (｡･ω･｡)\n第二行"]) {
    const h=harness(),{data:{scope}}=await h.send("connect");h.setTitle(original);
    assert.equal((await h.send("rename",{scope,id:"chat-0001",expectedTitle:original,title:"新标题"})).ok,true);
    assert.equal((await h.send("rename",{scope,id:"chat-0001",expectedTitle:"新标题",title:original,restore:true})).ok,true);
    assert.equal(h.getTitle(),original);
    assert.equal((await h.send("rename",{scope,id:"chat-0001",expectedTitle:original,title:"\n"})).error.code,"invalid");
  }
});
test("标题在扫描后变化则跳过，不覆盖用户手动修改",async()=>{
  const h=harness(),{data:{scope}}=await h.send("connect");h.setTitle("用户手动改名");
  const reply=await h.send("rename",{scope,id:"chat-0001",expectedTitle:"原标题",title:"新标题"});
  assert.equal(reply.ok,false);assert.equal(reply.error.code,"conflict");assert.equal(h.calls.filter(c=>c.options.method==="PATCH").length,0);
});
test("切换登录账号后不使用旧任务读写",async()=>{
  const h=harness(),{data:{scope}}=await h.send("connect");h.switchAccount();
  const reply=await h.send("rename",{scope,id:"chat-0001",expectedTitle:"原标题",title:"新标题"});
  assert.equal(reply.error.code,"account");assert.equal(h.calls.filter(c=>c.path.includes("backend-api")).length,0);
});
test("403/429停止，不重试写入，不回显服务器敏感内容",async()=>{
  for(const failure of [403,429]){
    const h=harness({failure}),{data:{scope}}=await h.send("connect");
    const reply=await h.send("rename",{scope,id:"chat-0001",expectedTitle:"原标题",title:"新标题"});
    assert.equal(reply.error.code,`http_${failure}`);assert.equal(h.calls.filter(c=>c.options.method==="PATCH").length,0);assert.doesNotMatch(JSON.stringify(reply),/secret-body/);
  }
});
test("写后验证失败只标记未知，不重复发送PATCH",async()=>{
  const h=harness({changeOnVerify:true}),{data:{scope}}=await h.send("connect");
  const reply=await h.send("rename",{scope,id:"chat-0001",expectedTitle:"原标题",title:"新标题"});
  assert.equal(reply.error.code,"uncertain");assert.equal(h.calls.filter(c=>c.options.method==="PATCH").length,1);
});
test("404 仅具体聊天读取视为单条缺失；会话端点404是全局错误",async()=>{
  const session=harness({sessionFailure:404});assert.equal((await session.send('connect')).error.code,'http_404');
  const h=harness({before404:true}),{data:{scope}}=await h.send('connect');
  const result=await h.send('rename',{scope,id:'chat-0001',expectedTitle:'原标题',title:'新标题'});
  assert.equal(result.error.code,'chat_missing');assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,0);
});
test("PATCH后读取404必须标记未知，不能当成未写入或自动跳过",async()=>{
  const h=harness({verify404:true}),{data:{scope}}=await h.send('connect');
  const result=await h.send('rename',{scope,id:'chat-0001',expectedTitle:'原标题',title:'新标题'});
  assert.equal(result.error.code,'uncertain');assert.equal(h.calls.filter(c=>c.options.method==='PATCH').length,1);
});
test("拒绝网页伪造消息和任意操作/编号",async()=>{
  const h=harness();
  assert.equal(h.listener()({channel:"chat-renamer/v1",op:"connect"},{id:"other",url:"https://evil.example"},()=>assert.fail()),false);
  const {data:{scope}}=await h.send("connect");
  assert.equal((await h.send("get",{scope,id:"../../secret"})).error.code,"invalid");
  assert.equal((await h.send("delete",{scope,id:"chat-0001"})).error.code,"invalid");
});
