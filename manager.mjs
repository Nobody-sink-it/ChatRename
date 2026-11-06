import { TITLE_RULE, validateTitle, validateId, extractMessages, buildExcerpt, namingPrompt, parseSuggestions, prepareEntry, reconcileEntry, providerEndpoint, backupDocument, parseBackup, namingRule, ruleCompletion, planNaming } from "./core.mjs";
import { generateTitles, codexBridgeEndpoint } from "./provider.mjs";

const $ = id => document.getElementById(id);
const states = { pending:"待生成", ready:"待检查", applied:"已应用", unchanged:"已符合规则", restored:"已恢复", no_text:"无可用文字", error:"失败", conflict:"标题冲突", uncertain:"待核对" };
let rows = [], journal = [], scope = "", label = "", sourceTabId = null;
let busy = false, stopRequested = false, controller = null, manualIds = [];
let settings = {backend:"codex-cli",bridgeUrl:"http://127.0.0.1:18183",baseUrl:"",model:"",rule:TITLE_RULE}, apiKey = "", bridgeKey = "";
let currentRule = null, defaultRuleId = "", manualRule = null;
let lastCodexSuccess = false, localCheck = "尚未检查", connectionRevision = 0;
let currentView = "pending";
let pendingEdit = Promise.resolve();
const bodyCache = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
const status = (text,error=false) => { $("status").textContent=text; $("status").classList.toggle("error",error); };
const storageKey = () => `renamer-v1:${scope}`;

function rowTitle(row) { return row.currentTitle ?? row.oldTitle; }
function isProcessed(row) {
  if (["no_text","error","conflict","uncertain"].includes(row.status)) return false;
  const history = journal.filter(e=>e.scope===scope && e.id===row.id);
  const latest = history.reduce((a,b)=>!a || (b.updatedAt||"") >= (a.updatedAt||"") ? b : a, null);
  return !!latest && ["applied","unchanged"].includes(latest.state) && rowTitle(row)===latest.toTitle;
}
function inCurrentView(row) { return isProcessed(row) === (currentView === "processed"); }
function weakTitle(title) { return /^(新聊天|新对话|开始对话|问题|你好|对话|new chat|hello(?: greeting)?|audio check|分支\s*[·:：-]\s*.*)$/i.test(title.trim()) || title.trim().length < 5; }
function visibleRows() {
  const query = $("filter").value.trim().toLocaleLowerCase();
  return rows.filter(r => inCurrentView(r) && (!$("weakOnly").checked || weakTitle(r.oldTitle)) && (!query || `${r.oldTitle} ${r.newTitle||""}`.toLocaleLowerCase().includes(query)));
}
function render() {
  const tbody = $("rows"); tbody.replaceChildren();
  const visible = visibleRows();
  for (const row of visible) {
    const tr = document.createElement("tr");
    const choiceCell = document.createElement("td");
    const choice = document.createElement("input"); choice.type="checkbox"; choice.checked=!!row.selected;
    choice.disabled=busy; choice.setAttribute("aria-label",`选择 ${row.oldTitle}`);
    choice.addEventListener("change",()=>{row.selected=choice.checked;updateCounts();persist().catch(showError);});
    choiceCell.append(choice);
    const oldCell = document.createElement("td"), link = document.createElement("a"), date = document.createElement("small");
    link.href=`https://chatgpt.com/c/${encodeURIComponent(row.id)}`;link.target="_blank";link.rel="noopener";link.textContent=row.oldTitle;
    date.textContent=formatDate(row.updateTime);oldCell.append(link,date);
    if (row.currentTitle && row.currentTitle !== row.oldTitle) { const small=document.createElement("small");small.textContent=`当前：${row.currentTitle}`;oldCell.append(small); }
    const newCell = document.createElement("td"), input = document.createElement("input");
    input.className="title-edit";input.value=row.newTitle||"";input.placeholder="生成后可在这里修改";input.maxLength=128;input.disabled=busy;
    input.setAttribute("aria-label",`建议标题 ${row.oldTitle}`);
    input.addEventListener("change",()=>{
      pendingEdit=(async()=>{try {row.newTitle=validateTitle(input.value);const rule=await saveCurrentRule();row.suggestionRuleId=rule.id;row.suggestionRuleText=rule.text;row.status="ready";row.error="";await persist();render();}
      catch(error){showError(error);input.value=row.newTitle||"";}})();
    });
    newCell.append(input);
    if(row.excerptInfo){const small=document.createElement("small");small.textContent=row.excerptInfo;newCell.append(small);}
    const stateCell = document.createElement("td"), badge=document.createElement("span");
    badge.className=`state ${row.status||"pending"}`;badge.textContent=states[row.status]||states.pending;stateCell.append(badge);
    const ruleMark=document.createElement("small");ruleMark.className="rule-mark";
    ruleMark.textContent=currentRule&&ruleCompletion(journal,scope,row.id,currentRule.id)?"当前规则已处理":"当前规则未处理";stateCell.append(ruleMark);
    if(row.error){const detail=document.createElement("small");detail.textContent=row.error;stateCell.append(detail);}
    tr.append(choiceCell,oldCell,newCell,stateCell);tbody.append(tr);
  }
  $("empty").hidden=visible.length>0;
  $("empty").querySelector("span").textContent=rows.length?(currentView==="processed"?"没有符合条件的已处理聊天":"没有符合条件的待处理聊天"):"从一批聊天开始";
  $("viewPending").setAttribute("aria-pressed",String(currentView==="pending"));$("viewProcessed").setAttribute("aria-pressed",String(currentView==="processed"));
  $("countPending").textContent=String(rows.filter(r=>!isProcessed(r)).length);$("countProcessed").textContent=String(rows.filter(isProcessed).length);
  $("connectionBadge").textContent=scope?"已连接":"尚未连接";
  $("connectionBadge").classList.toggle("connected",!!scope);
  $("chatStatus").textContent=scope?`最近一次连接成功：${label}（未持续检测）`:"尚未连接，请选择标签页并点击连接";
  $("localStatus").textContent=settings.backend!=="codex-cli"?"当前使用云端 API":localCheck;
  $("cliStatus").textContent=settings.backend!=="codex-cli"?"当前未使用 Codex":lastCodexSuccess?"本页面此前 Codex 调用成功（未持续检测）":"尚未验证；保存配对码不等于已登录";
  $("accountLabel").textContent=scope?`${label} · ${scope.slice(0,8)}`:"请先在浏览器登录 ChatGPT";
  $("modelSummary").textContent=settings.backend==="codex-cli"?"Codex CLI · gpt-6-luna · high · fast":settings.model?`${settings.model} · ${new URL(settings.baseUrl).host}`:"尚未配置 · 也可使用下方免 Key 批处理";
  $("manualHint").textContent=manualIds.length?`等待本批 ${manualIds.length} 条标题结果`:"";
  updateCounts();
  for(const id of ["connect","refreshTabs","sourceTab","backend","bridgeUrl","bridgeKey","saveCodex","openBridge","checkConnection","saveSettings","clearKey","baseUrl","model","apiKey","rule","resetRule","skipCompleted","days","scanLimit","scan","autoRun","generate","apply","restore","reconcile","importBackup","copyTask","exportTask","importTitles","selectVisible","unselect","viewPending","viewProcessed"]) $(id).disabled=busy;
  $("stop").disabled=!busy;
  if(!scope){for(const id of ["scan","autoRun","generate","apply","restore","reconcile","copyTask","exportTask","importTitles","exportBackup","importBackup"]) $(id).disabled=true;}
  else $("exportBackup").disabled=false;
}
function updateCounts(){
  $("counts").textContent=`本视图 ${rows.filter(inCurrentView).length} 条 · 显示 ${visibleRows().length} 条 · 显示中已选 ${visibleRows().filter(r=>r.selected).length} 条`;$("journalCount").textContent=`${journal.filter(e=>e.state==="applied").length} 条可恢复记录`;
  if(currentRule){const plan=planNaming(visibleRows(),journal,scope,currentRule.id,$("skipCompleted").checked);$("ruleInfo").textContent=`${currentRule.id===defaultRuleId?"默认规则":"自定义规则"} · ${currentRule.id.slice(0,16)}`;$("ruleProgress").textContent=`显示中所选待处理 ${plan.pending.length} 条 · 按当前规则跳过 ${plan.skipped.length} 条`;}
  const count=state=>rows.filter(r=>state.includes(r.status)).length;
  $("progressSummary").textContent=rows.length?`当前列表状态：待生成 ${count(["pending"])} · 待检查 ${count(["ready"])} · 已应用 ${count(["applied"])} · 已符合规则 ${count(["unchanged"])} · 无可用文字 ${count(["no_text"])} · 失败或待核对 ${count(["error","conflict","uncertain"])}。按规则跳过数以所选聊天为准。`:"扫描后显示当前列表的处理状态。";
}
function formatDate(value){ const time=typeof value==="number"?value*1000:Date.parse(value);return Number.isFinite(time)?new Date(time).toLocaleString("zh-CN",{dateStyle:"medium",timeStyle:"short"}):"更新时间未知"; }
function showError(error){status(error?.message||"操作失败，请检查连接后重试",true);}
async function persist(){
  if(!scope)return;
  const savingScope=scope;
  return navigator.locks.request(`chatgpt-renamer:storage:${savingScope}`,async()=>{
  if(scope!==savingScope)throw new Error("账号已切换，未保存当前操作");
  const existing=(await chrome.storage.local.get(storageKey()))[storageKey()];
  const merged=new Map((existing?.journal||[]).map(e=>[e.key,e]));
  for(const e of journal){const prev=merged.get(e.key);if(!prev||prev.updatedAt<=e.updatedAt)merged.set(e.key,e);}
  journal=Array.from(merged.values());
  const safeRows=rows.map(r=>({id:r.id,oldTitle:r.oldTitle,newTitle:r.newTitle||"",currentTitle:r.currentTitle||"",updateTime:r.updateTime,
    selected:!!r.selected,status:r.status||"pending",error:r.error||"",excerptInfo:r.excerptInfo||"",suggestionRuleId:r.suggestionRuleId||"",suggestionRuleText:r.suggestionRuleText||""}));
  await chrome.storage.local.set({[storageKey()]:{rows:safeRows,journal,manualIds,manualRule}});
  });
}
async function refreshTabs(){
  const tabs=await chrome.tabs.query({url:"https://chatgpt.com/*"});
  const previous=Number($("sourceTab").value)||Number(new URL(location.href).searchParams.get("source"));
  $("sourceTab").replaceChildren();
  if(!tabs.length){const option=new Option("未找到 ChatGPT 标签页，请先打开网页","");$("sourceTab").append(option);return;}
  tabs.forEach(tab=>$("sourceTab").append(new Option(tab.title||"ChatGPT",String(tab.id))));
  if(tabs.some(t=>t.id===previous))$("sourceTab").value=String(previous);
}
async function bridge(op,args={}){
  if(!sourceTabId)throw new Error("请先连接 ChatGPT 标签页");
  let reply;
  try{reply=await chrome.tabs.sendMessage(sourceTabId,{channel:"chatgpt-renamer/v1",op,scope,...args});}
  catch{throw new Error("与 ChatGPT 标签页的连接已断开，请刷新网页后重新连接");}
  if(!reply?.ok){const error=new Error(reply?.error?.message||"ChatGPT 返回异常");error.code=reply?.error?.code;throw error;}
  return reply.data;
}
async function connect(){
  sourceTabId=Number($("sourceTab").value);
  if(!sourceTabId)throw new Error("请先打开并登录 https://chatgpt.com");
  // Static scripts cover normal installs; injection also supports already-open tabs.
  await chrome.scripting.executeScript({target:{tabId:sourceTabId},files:["content.js"]});
  const connected=await bridge("connect");
  if(typeof connected?.scope!=="string")throw new Error("账号连接失败");
  scope=connected.scope;label=connected.label;bodyCache.clear();
  const saved=(await chrome.storage.local.get(storageKey()))[storageKey()];
  rows=saved?.rows||[];journal=saved?.journal||[];manualIds=saved?.manualIds||[];manualRule=saved?.manualRule||null;
  status(`已连接${label}。可以扫描聊天，或继续上次未完成的标题整理。`);render();
}
async function runJob(fn){
  if(busy)return;
  busy=true;stopRequested=false;controller=new AbortController();render();
  try{
    await navigator.locks.request(`chatgpt-renamer:${scope||"connect"}`,{ifAvailable:true},async lock=>{
      if(!lock)throw new Error("另一个重命名助手页面正在处理，请先停止那个页面");
      await pendingEdit;
      if(scope){const latest=(await chrome.storage.local.get(storageKey()))[storageKey()];const merged=new Map(journal.map(e=>[e.key,e]));for(const e of latest?.journal||[]){if(!merged.has(e.key)||merged.get(e.key).updatedAt<=e.updatedAt)merged.set(e.key,e);}journal=Array.from(merged.values());}
      await fn();
    });
  }catch(error){showError(error);}
  finally{busy=false;controller=null;render();}
}
function selected(){const chosen=visibleRows().filter(r=>r.selected);if(!chosen.length)throw new Error("请先在当前视图显示的聊天中选择");return chosen;}
async function scan(){
  const limit=Number($("scanLimit").value),days=Number($("days").value),cutoff=days?Date.now()/1000-days*86400:0;
  const old=new Map(rows.map(r=>[r.id,r]));const found=new Map();let offset=0,total=0;
  while(found.size<limit&&!stopRequested){
    const page=await bridge("list",{offset});total=page.total;
    if(!page.items.length)break;
    let allOld=true;
    for(const item of page.items){
      const time=typeof item.updateTime==="number"?item.updateTime:Date.parse(item.updateTime)/1000;
      if(!Number.isFinite(time)||time>=cutoff)allOld=false;
      if(cutoff&&Number.isFinite(time)&&time<cutoff)continue;
      if(found.size>=limit)break;
      const previous=old.get(item.id);
      const currentMatches=previous&&rowTitle(previous)===item.title;
      found.set(item.id,currentMatches?{...previous,updateTime:item.updateTime}:{id:item.id,oldTitle:item.title,newTitle:"",currentTitle:item.title,updateTime:item.updateTime,selected:true,status:"pending"});
    }
    offset+=page.items.length;status(`已读取 ${offset}/${total} 条，范围内找到 ${found.size} 条…`);
    if(offset>=total||allOld)break;
    await pause(650);
  }
  rows=Array.from(found.values());manualIds=[];manualRule=null;bodyCache.clear();await persist();
  status(`${stopRequested?"已停止扫描，保留已读取结果。":"扫描完成。"}本次 ${rows.length} 条；账号列表返回总数 ${total}。项目内或归档聊天是否覆盖取决于网页接口，不代表账号全部聊天。`);
}
async function readExcerpt(row){
  try {
  if(bodyCache.has(row.id))return {...bodyCache.get(row.id),oldTitle:rowTitle(row)};
  const conversation=await bridge("get",{id:row.id});
  if(conversation.title!==rowTitle(row)){
    row.status="conflict";row.error="标题已变化，请重新扫描";
    const error=new Error(`“${row.oldTitle}”的标题已变化，请重新扫描`);error.code="conflict";throw error;
  }
  const messages=extractMessages(conversation);
  if(!messages.length){const error=new Error("没有可用于命名的文字正文；图片和语音不会被自动识别");error.code="no_text";throw error;}
  const excerpt=buildExcerpt(messages);
  row.excerptInfo=`当前分支 ${excerpt.totalMessages} 条文字消息 · ${excerpt.truncated?"节选":"完整文字"}`;
  const result={id:row.id,oldTitle:rowTitle(row),excerpt:excerpt.text};
  bodyCache.set(row.id,result);return result;
  } catch(error) {
    row.status=error.code==="no_text"?"no_text":error.code==="conflict"?"conflict":"error";
    row.error=error.message||"读取失败";
    if (row.status === "no_text") {
      row.newTitle = "";
      row.excerptInfo = "";
    }
    await persist();render();
    const detail=new Error(`读取“${row.oldTitle || "（无标题）"}”失败：${row.error}。请检查该聊天或取消选择后继续。`);detail.code=error.code;throw detail;
  }
}
async function saveCurrentRule(){
  const rule=await namingRule($("rule").value);
  settings={...settings,rule:rule.text};currentRule=rule;
  await chrome.storage.local.set({"renamer-settings":settings});
  return {...rule};
}
function namingPlan(rule){
  selected();const plan=planNaming(visibleRows(),journal,scope,rule.id,$("skipCompleted").checked);
  if(plan.unresolved.length)throw new Error(`有 ${plan.unresolved.length} 条聊天的上次操作结果未知，请先点击‘核对未完成操作’，再继续。`);
  return plan;
}
async function modelConnection(){
  const isCodex=settings.backend==="codex-cli";
  if(isCodex&&!bridgeKey){$("settings").open=true;throw new Error("先启动本机Codex服务，填配对码并保存连接；也可使用下方免 Key 批处理");}
  if(!isCodex&&(!settings.baseUrl||!settings.model)){$("settings").open=true;throw new Error("先配置模型 API；没有 Key 可展开下方的免 Key 批处理");}
  const endpoint=isCodex?codexBridgeEndpoint(settings.bridgeUrl):providerEndpoint(settings.baseUrl);
  if(!await chrome.permissions.contains({origins:[permissionPattern(endpoint)]}))throw new Error("请先保存并授权所选模型连接");
  return {isCodex,endpoint};
}
async function generateBatch(batch,rule,connection,offset,total){
  const input=[], readyRows=[];
  for(let index=0;index<batch.length;index++){
    const row=batch[index];if(stopRequested)return null;status(`正在读取正文 ${offset+index+1}/${total}…`);
    try { input.push(await readExcerpt(row));readyRows.push(row); }
    catch(error) { if(!["no_text","conflict","chat_missing"].includes(error.code))throw error; }
    await pause(300);
  }
  if(stopRequested)return null;
  if(!input.length)return [];
  status(`正在生成标题 ${offset+1}–${offset+batch.length}/${total}；${connection.isCodex?"由本机 Codex CLI 调用 gpt-6-luna（high / fast）":"正文节选将发送到 "+connection.endpoint.host}…`);
  const generated = [];
  async function request(inputRows, targetRows) {
    let suggestions;
    try {
      suggestions = await generateTitles({rows:inputRows,...settings,rule:rule.text,apiKey,bridgeKey,signal:controller.signal});
    } catch (error) {
      if (stopRequested) return;
      if (error.code === "title_output_invalid" && targetRows.length > 1) throw error;
      const invalidOutput = error.code === "title_output_invalid";
      lastCodexSuccess = false;
      for (const row of targetRows) {
        row.status = "error";
        row.error = invalidOutput ? `单条标题生成失败：${error.message}` : `本批生成失败：${error.message}`;
        if (invalidOutput) row.newTitle = "";
      }
      await persist();
      render();
      if (!invalidOutput) throw error;
      return;
    }
    if (stopRequested) return;
    if (connection.isCodex) {
      lastCodexSuccess = true;
      localCheck = "最近一次生成成功（未持续检测）";
    }
    for (const row of targetRows) {
      row.newTitle = suggestions.get(row.id);
      row.status = "ready";
      row.error = "";
      row.suggestionRuleId = rule.id;
      row.suggestionRuleText = rule.text;
      generated.push(row);
    }
    await persist();
    render();
  }
  try {
    await request(input, readyRows);
  } catch (error) {
    if (error.code !== "title_output_invalid") throw error;
    for (let i = 0; i < input.length && !stopRequested; i++) {
      status(`本批模型结果未通过校验，正在逐条重试 ${i+1}/${input.length}…`);
      await request([input[i]], [readyRows[i]]);
    }
  }
  return stopRequested ? null : generated;
}
async function generate(){
  const rule=await saveCurrentRule(),plan=namingPlan(rule),chosen=plan.pending;
  if(!chosen.length){status(`当前规则已处理全部所选聊天，已跳过 ${plan.skipped.length} 条。`);return;}
  const connection=await modelConnection();bodyCache.clear();
  let completed=0,failed=0;
  for(let i=0;i<chosen.length&&!stopRequested;i+=5){
    const batch=chosen.slice(i,i+5),generated=await generateBatch(batch,rule,connection,i,chosen.length);if(generated===null)break;
    completed+=generated.length;failed+=batch.length-generated.length;await pause(500);
  }
  status(`${stopRequested?"已停止。":"生成完成。"}已保存 ${completed} 条标题建议，单条失败 ${failed} 条，尚未改动 ChatGPT 标题。`);
}
function permissionPattern(url){return `${url.protocol}//${url.hostname}/*`;}
async function saveSettings(){
  connectionRevision++;
  if($("backend").value==="codex-cli"){
    const endpoint=codexBridgeEndpoint($("bridgeUrl").value),pairing=$("bridgeKey").value.trim();
    if(!/^[A-Za-z0-9_-]{24,100}$/.test(pairing))throw new Error("请打开本机配对页复制本次启动的配对码");
    if(!await chrome.permissions.request({origins:[permissionPattern(endpoint)]}))throw new Error("未授权本机站点，设置尚未保存");
    currentRule=await namingRule($("rule").value);
    if(settings.backend!=="codex-cli" || settings.bridgeUrl!==endpoint.origin || bridgeKey!==pairing)lastCodexSuccess=false;
    settings={...settings,backend:"codex-cli",bridgeUrl:endpoint.origin,rule:currentRule.text};bridgeKey=pairing;localCheck="已保存配对码，尚未检查";
    await chrome.storage.local.set({"renamer-settings":settings});await chrome.storage.session.set({"renamer-bridge-key":bridgeKey});
    status("本机 Codex 连接已保存：gpt-6-luna / high / fast。点击生成后才发送所选正文。");render();return;
  }
  const endpoint=providerEndpoint($("baseUrl").value);
  const model=$("model").value.trim(),rule=$("rule").value.trim()||TITLE_RULE;
  if(!model)throw new Error("请填写模型名称");
  if(!await chrome.permissions.request({origins:[permissionPattern(endpoint)]}))throw new Error("未授权该 API 站点，设置尚未保存");
  currentRule=await namingRule(rule);settings={...settings,backend:"api",baseUrl:endpoint.href,model,rule:currentRule.text};apiKey=$("apiKey").value.trim();
  await chrome.storage.local.set({"renamer-settings":settings});
  await chrome.storage.session.set({"renamer-api-key":apiKey});
  status(`模型设置已保存。生成时将正文节选发送到 ${endpoint.host}；现在不会发送任何聊天。`);render();
}
function confirmation(items,kind,rule=null){
  if(!items.length)throw new Error(kind==="restore"?"所选聊天没有可恢复的已应用记录":"所选聊天没有需要应用的新标题");
  $("confirmTitle").textContent=kind==="auto"?"确认后自动完成全部所选":kind==="restore"?"恢复上一次标题":"检查本次新标题";
  $("confirmText").textContent=kind==="auto"?`将按当前规则自动生成并应用 ${items.length} 条标题，范围为${label}。只在这里确认一次，内部每5条一批，不会逐批再次确认。`:`将${kind==="restore"?"恢复":"修改"} ${items.length} 条聊天标题，范围为${label}。`;
  $("confirmAction").textContent=kind==="auto"?"确认并自动完成":kind==="restore"?"确认恢复":"确认应用";
  $("confirmNote").textContent=kind==="auto"?`本次规则：${rule.text}。成功后按此规则标记；失败或停止时保留已完成结果，可随时停止。`:"应用前逐条核对当前标题，成功后重新读取确认。遇到异常即暂停，原文内容不会修改。";
  $("confirmRows").replaceChildren();
  (kind==="auto"?items.slice(0,20):items).forEach(item=>{const div=document.createElement("div");div.className="confirm-row";const old=document.createElement("span"),arrow=document.createElement("span"),next=document.createElement("strong");old.textContent=item.fromTitle;arrow.textContent="→";next.textContent=item.toTitle;div.append(old,arrow,next);$("confirmRows").append(div);});
  if(kind==="auto"&&items.length>20){const extra=document.createElement("p");extra.textContent=`以及其余 ${items.length-20} 条所选聊天`;$("confirmRows").append(extra);}
  const dialog=$("confirmation");dialog.returnValue="";dialog.showModal();
  return new Promise(resolve=>dialog.addEventListener("close",()=>resolve(dialog.returnValue==="confirm"),{once:true}));
}
async function apply(){
  const rule=await saveCurrentRule(),chosen=namingPlan(rule).pending.filter(r=>r.newTitle);
  verifySuggestionRule(chosen,rule);
  if(!await confirmation(chosen.map(r=>({fromTitle:rowTitle(r),toTitle:r.newTitle})),"apply"))return;
  const result=await applyRows(chosen,rule);
  status(`${stopRequested?"已停止后续操作。":"应用完成。"}${result.applied} 条已写回并重新读取确认，${result.unchanged} 条已符合规则，${result.failed} 条标题冲突。回到 ChatGPT 刷新可查看。`);
}
function verifySuggestionRule(chosen,rule){
  if(chosen.some(row=>row.suggestionRuleId!==rule.id))throw new Error("部分标题建议不属于当前规则或来自旧版本，请按当前规则重新生成，再应用。");
}
async function appendEntry(entry){
  journal.push(entry);
  try{await persist();}catch(error){journal=journal.filter(e=>e.key!==entry.key);throw error;}
}
async function applyRows(chosen,rule){
  verifySuggestionRule(chosen,rule);
  let applied=0,unchanged=0,failed=0;
  for(let i=0;i<chosen.length&&!stopRequested;i++){
    const row=chosen[i],target=validateTitle(row.newTitle),before=rowTitle(row);
    const meta={ruleId:rule.id,ruleText:rule.text,ruleCompleted:false};
    if(before===target){
      let data;
      try{data=await bridge("get",{id:row.id});}catch(error){if(error.code!=="chat_missing")throw error;row.status="error";row.error=error.message;failed++;await persist();render();continue;}
      if(data.title!==before){row.status="conflict";row.error="原标题已变化，请重新扫描";failed++;await persist();render();continue;}
      const now=new Date().toISOString();await appendEntry({key:crypto.randomUUID(),scope,id:row.id,fromTitle:before,toTitle:target,state:"unchanged",createdAt:now,updatedAt:now,...meta,ruleCompleted:true});
      row.status="unchanged";row.error="";unchanged++;await persist();render();continue;
    }
    const entry={...prepareEntry({...row,oldTitle:before},scope),...meta};
    await appendEntry(entry); // The write-ahead log must be durable before modification.
    if(stopRequested){entry.state="not-applied";entry.updatedAt=new Date().toISOString();await persist();break;}
    status(`正在应用 ${i+1}/${chosen.length}：${entry.toTitle}`);
    try{
      await bridge("rename",{id:entry.id,expectedTitle:entry.fromTitle,title:entry.toTitle});
      entry.state="applied";entry.ruleCompleted=true;row.currentTitle=entry.toTitle;row.status="applied";row.error="";applied++;
    }catch(error){entry.state=error.code==="conflict"?"conflict":error.code==="chat_missing"?"not-applied":"uncertain";row.status=entry.state==="not-applied"?"error":entry.state;row.error=error.message;entry.updatedAt=new Date().toISOString();await persist();if(entry.state!=="uncertain"){failed++;render();continue;}const detail=new Error(`应用“${row.oldTitle || "（无标题）"}”失败：${error.message}。请先点击‘核对未完成操作’。`);detail.code=error.code;throw detail;}
    entry.updatedAt=new Date().toISOString();await persist();render();await pause(1100);
  }
  return {applied,unchanged,failed};
}
async function autoRun(){
  const rule=await saveCurrentRule(),plan=namingPlan(rule),chosen=plan.pending;
  if(!chosen.length){status(`当前规则已处理全部所选聊天，已跳过 ${plan.skipped.length} 条；没有调用模型，也没有改名。`);return;}
  const connection=await modelConnection();
  if(!await confirmation(chosen.map(row=>({fromTitle:rowTitle(row),toTitle:"按当前规则自动生成并应用"})),"auto",rule))return;
  bodyCache.clear();let applied=0,unchanged=0,failed=0;
  for(let i=0;i<chosen.length&&!stopRequested;i+=5){
    const batch=chosen.slice(i,i+5);
    const generated=await generateBatch(batch,rule,connection,i,chosen.length);if(generated===null)break;
    failed+=batch.length-generated.length;
    const result=await applyRows(generated,rule);applied+=result.applied;unchanged+=result.unchanged;failed+=result.failed;
    if(!stopRequested)await pause(500);
  }
  status(`${stopRequested?"已停止后续操作。":"自动处理完成。"}已应用 ${applied} 条，已符合规则 ${unchanged} 条，单条失败 ${failed} 条，同规则跳过 ${plan.skipped.length} 条。`);
}
async function reconcile(){
  let count=0,missing=0;
  for(const entry of journal.filter(e=>["prepared","uncertain","restoring"].includes(e.state))){
    if(stopRequested)break;
    let data;
    try{data=await bridge("get",{id:entry.id});}catch(error){
      if(error.code!=="chat_missing")throw error;
      const row=rows.find(r=>r.id===entry.id);if(row){row.status="uncertain";row.error="聊天暂不可访问，未能核对；其他记录继续核对";}
      missing++;await persist();render();continue;
    }
    entry.state=entry.state==="restoring"?(data.title===entry.fromTitle?"restored":data.title===entry.toTitle?"applied":"conflict"):reconcileEntry(entry,data.title);
    if(entry.ruleId){if(entry.state==="applied")entry.ruleCompleted=true;else if(["restored","not-applied"].includes(entry.state))entry.ruleCompleted=false;}
    entry.updatedAt=new Date().toISOString();
    const row=rows.find(r=>r.id===entry.id);
    if(row){row.currentTitle=data.title;row.status=entry.state==="not-applied"?"ready":entry.state;row.error=entry.state==="conflict"?"当前标题与记录不一致":"";}
    count++;await persist();render();await pause(500);
  }
  status(`已核对 ${count} 条未完成操作，${missing} 条聊天不可访问、仍待核对；未发送改名请求。`);
}
async function restore(){
  const ids=new Set(selected().map(r=>r.id)),latest=new Map();
  if(journal.some(e=>e.scope===scope && ids.has(e.id) && ["prepared","uncertain","restoring"].includes(e.state)))throw new Error("所选聊天存在未完成操作，请先点击‘核对未完成操作’，再尝试恢复。");
  for(const entry of journal){if(ids.has(entry.id)&&entry.state==="applied"){const old=latest.get(entry.id);if(!old || (entry.updatedAt||"") >= (old.updatedAt||""))latest.set(entry.id,entry);}}
  const entries=Array.from(latest.values()).reverse();
  if(!await confirmation(entries.map(e=>({fromTitle:e.toTitle,toTitle:e.fromTitle})),"restore"))return;
  let done=0,failed=0;
  for(const entry of entries){
    if(stopRequested)break;
    entry.state="restoring";entry.updatedAt=new Date().toISOString();await persist();
    if(stopRequested){entry.state="applied";entry.updatedAt=new Date().toISOString();await persist();break;}
    status(`正在恢复 ${done+1}/${entries.length}…`);
    try{
      await bridge("rename",{id:entry.id,expectedTitle:entry.toTitle,title:entry.fromTitle,restore:true});
      entry.state="restored";if(entry.ruleId)entry.ruleCompleted=false;entry.updatedAt=new Date().toISOString();
      const row=rows.find(r=>r.id===entry.id);if(row){row.currentTitle=entry.fromTitle;row.status="restored";row.error="";}done++;
    }catch(error){
      if(["chat_missing","conflict"].includes(error.code)){
        entry.state="applied";entry.updatedAt=new Date().toISOString();
        const row=rows.find(r=>r.id===entry.id);if(row){row.status=error.code==="conflict"?"conflict":"error";row.error=error.code==="conflict"?"当前标题已变化，未恢复；请重新扫描":"聊天不存在或不可访问，未发送恢复请求";}
        failed++;await persist();render();continue;
      }
      entry.updatedAt=new Date().toISOString();await persist();throw error;
    }
    await persist();render();await pause(1100);
  }
  status(`已恢复 ${done} 条标题并重新读取确认，${failed} 条未恢复，请查看各条状态。`);
}
function download(name,text,type="application/json"){
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
async function prepareManual(downloadFile){
  const rule=await saveCurrentRule(),plan=namingPlan(rule),chosen=plan.pending;if(!chosen.length){status(`当前规则已处理全部所选聊天，已跳过 ${plan.skipped.length} 条。`);return;}
  if(chosen.length>10)throw new Error("免 Key 每批最多10条，请先减少选择；API 模式可自动分批");
  bodyCache.clear();
  const input=[];let failed=0;
  for(let i=0;i<chosen.length;i++){const row=chosen[i];if(stopRequested)break;status(`正在准备正文 ${i+1}/${chosen.length}…`);try{input.push(await readExcerpt(row));}catch(error){if(!["no_text","conflict","chat_missing"].includes(error.code))throw error;failed++;}await pause(300);}
  if(stopRequested)return;
  if(!input.length)throw new Error(`没有可用于命名的聊天；${failed} 条单独失败，请检查待处理列表。`);
  manualIds=input.map(r=>r.id);manualRule=rule;await persist();
  const prompt=namingPrompt(input,rule.text).map(m=>`${m.role.toUpperCase()}\n${m.content}`).join("\n\n");
  if(downloadFile)download("聊天命名任务.txt",prompt,"text/plain;charset=utf-8");else await navigator.clipboard.writeText(prompt);
  status(`${downloadFile?"已导出":"已复制"} ${input.length} 条命名任务，${failed} 条单独失败。任务包含聊天文字节选，交给你选择的 AI 后，将 JSON 结果粘贴回来。`);
}
async function importTitles(){
  if(!manualIds.length)throw new Error("请先复制或导出一批命名任务");
  if(!manualRule?.id)throw new Error("旧批次没有记录命名规则，请重新导出命名任务");
  const chosen=manualIds.map(id=>rows.find(r=>r.id===id));if(chosen.some(r=>!r))throw new Error("聊天列表已变化，请重新生成任务");
  const suggestions=parseSuggestions($("manualResult").value,chosen);
  for(const row of chosen){row.newTitle=suggestions.get(row.id);row.status="ready";row.error="";row.suggestionRuleId=manualRule.id;row.suggestionRuleText=manualRule.text;}
  manualIds=[];manualRule=null;await persist();render();status(`已导入 ${chosen.length} 条建议。检查标题后点击‘预览并应用’。`);
}
function on(id,fn,job=false){$(id).addEventListener("click",()=>{if(job)runJob(fn);else Promise.resolve().then(fn).catch(showError);});}
on("refreshTabs",refreshTabs);on("connect",connect,true);on("saveSettings",saveSettings);on("saveCodex",saveSettings);
on("openBridge",()=>chrome.tabs.create({url:codexBridgeEndpoint($("bridgeUrl").value).origin+"/"}));
on("checkConnection",async()=>{
  const revision=++connectionRevision, backend=settings.backend, address=settings.bridgeUrl, pairing=bridgeKey;
  const current=()=>revision===connectionRevision && settings.backend===backend && settings.bridgeUrl===address && bridgeKey===pairing;
  if(settings.backend!=="codex-cli"){localCheck="当前使用云端 API";render();return;}
  if(!bridgeKey){localCheck="请先启动服务并保存配对码";render();return;}
  const endpoint=codexBridgeEndpoint(address);
  const permitted=await chrome.permissions.contains({origins:[permissionPattern(endpoint)]});
  if(!current())return;
  if(!permitted){localCheck="尚未授权本机地址，请先保存连接";render();return;}
  try{
    const response=await fetch(`${endpoint.origin}/health`,{method:"GET",headers:{Authorization:`Bearer ${pairing}`},credentials:"omit",cache:"no-store",redirect:"error",signal:AbortSignal.timeout(5000)});
    let result;
    if(response.status===401)result="服务可访问，但配对码错误或已过期";
    else if(response.ok){const data=await response.json();result=data.ok===true?"服务已响应，配对码有效（未测试 CLI）":"服务响应异常，请检查版本";}
    else result=`服务返回 HTTP ${response.status}，请检查服务版本`;
    if(!current())return;localCheck=result;
  }catch{if(!current())return;localCheck="无法连接本机服务，请检查服务是否启动与本机授权";}
  render();
});
on("showHelp",()=>{$("settings").open=true;status("连接步骤：先启动本机命名服务，再打开配对页复制本次配对码并保存；另需登录 Codex CLI。服务重启后需重新配对。",true);});
$("backend").addEventListener("change",()=>{connectionRevision++;$("codexFields").hidden=$("backend").value!=="codex-cli";$("cloudFields").hidden=$("backend").value!=="api";});
for(const id of ["bridgeUrl","bridgeKey"])$(id).addEventListener("input",()=>{connectionRevision++;});
on("clearKey",async()=>{apiKey="";$("apiKey").value="";await chrome.storage.session.remove("renamer-api-key");status("已清除本次浏览器会话中的模型密钥。");});
on("scan",scan,true);on("autoRun",autoRun,true);on("generate",generate,true);on("apply",apply,true);on("reconcile",reconcile,true);on("restore",restore,true);
on("resetRule",async()=>{$("rule").value=TITLE_RULE;await saveCurrentRule();render();status("已恢复默认规则，并按默认规则重新显示处理标记。");});
$("rule").addEventListener("change",()=>{pendingEdit=saveCurrentRule().then(render).catch(showError);});
$("skipCompleted").addEventListener("change",()=>{settings={...settings,skipCompleted:$("skipCompleted").checked};chrome.storage.local.set({"renamer-settings":settings}).then(render).catch(showError);});
on("stop",()=>{stopRequested=true;controller?.abort();status("正在停止。当前写入和校验完成后停止，已完成结果会保留。");});
on("viewPending",()=>{currentView="pending";render();});on("viewProcessed",()=>{currentView="processed";render();});
on("selectVisible",async()=>{visibleRows().forEach(r=>r.selected=true);await persist();render();});on("unselect",async()=>{rows.filter(inCurrentView).forEach(r=>r.selected=false);await persist();render();});
on("exportBackup",()=>download(`聊天标题备份-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify(backupDocument(scope,rows,journal),null,2)));
on("importBackup",()=>$("backupFile").click());
$("backupFile").addEventListener("change",()=>runJob(async()=>{
  const file=$("backupFile").files[0];if(!file)return;
  if(file.size>10000000)throw new Error("备份文件过大");
  const entries=parseBackup(await file.text(),scope),existing=new Map(journal.map(e=>[e.key,e]));
  for(const e of entries){if(e.ruleId&&(await namingRule(e.ruleText)).id!==e.ruleId)throw new Error("备份中的命名规则与标记不一致，未导入");}
  for(const e of entries){if(!existing.has(e.key))existing.set(e.key,e);}
  journal=Array.from(existing.values());await persist();$("backupFile").value="";status(`已导入恢复记录。导入不会修改 ChatGPT；选择对应聊天后可恢复。`);
}));
on("copyTask",()=>prepareManual(false),true);on("exportTask",()=>prepareManual(true),true);on("importTitles",importTitles,true);
$("filter").addEventListener("input",render);$("weakOnly").addEventListener("change",render);
async function init(){
  const saved=(await chrome.storage.local.get("renamer-settings"))["renamer-settings"];
  if(saved){try{if(saved.backend==="codex-cli")codexBridgeEndpoint(saved.bridgeUrl);else providerEndpoint(saved.baseUrl);settings={...settings,...saved,backend:saved.backend||"api"};}catch{}}
  apiKey=(await chrome.storage.session.get("renamer-api-key"))["renamer-api-key"]||"";
  bridgeKey=(await chrome.storage.session.get("renamer-bridge-key"))["renamer-bridge-key"]||"";
  $("baseUrl").value=settings.baseUrl;$("model").value=settings.model;$("rule").value=settings.rule;$("apiKey").value=apiKey;
  $("backend").value=settings.backend;$("bridgeUrl").value=settings.bridgeUrl;$("bridgeKey").value=bridgeKey;
  defaultRuleId=(await namingRule(TITLE_RULE)).id;currentRule=await namingRule(settings.rule);$("skipCompleted").checked=settings.skipCompleted!==false;
  $("codexFields").hidden=settings.backend!=="codex-cli";$("cloudFields").hidden=settings.backend!=="api";
  await refreshTabs();render();
}
init().catch(showError);
