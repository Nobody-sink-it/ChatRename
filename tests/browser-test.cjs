/* Isolated extension test. Every ChatGPT/model request is mocked; no user profile is opened. */
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
let playwright;
try{playwright=require('playwright');}catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
const {chromium}=playwright;
let expect;
try{({expect}=require('playwright/test'));}catch{({expect}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test')));}
const extension=path.resolve(__dirname,'..');
const fixtureTitles=['新聊天','主页视频建议','比较OpenTypeless与Typeless'];
const proposed=['学习平台｜分层辅导页面设计','个人网站｜硬件空间动画脚本','语音输入｜OpenTypeless与Typeless比较'];
const ids=['chat-0001','chat-0002','chat-0003'];

(async()=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'chatgpt-renamer-test-'));
  const fixtureExtension=path.join(temporary,'extension');
  await fs.mkdir(fixtureExtension);
  for(const file of ['manifest.json','background.js','manager.html','manager.css','manager.mjs','core.mjs','provider.mjs'])await fs.copyFile(path.join(extension,file),path.join(fixtureExtension,file));
  await fs.mkdir(path.join(fixtureExtension,'adapters'));
  for(const file of ['chatgpt.js','deepseek.js'])await fs.copyFile(path.join(extension,'adapters',file),path.join(fixtureExtension,'adapters',file));
  const manifest=JSON.parse(await fs.readFile(path.join(fixtureExtension,'manifest.json'),'utf8'));
  manifest.host_permissions.push('https://model.example/*','http://127.0.0.1/*'); // Fixture-only permissions, never shipped.
  await fs.writeFile(path.join(fixtureExtension,'manifest.json'),JSON.stringify(manifest));
  const executable=process.env.RENAMER_TEST_CHROMIUM||path.join(os.homedir(),'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe');
  const context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{executablePath:executable,headless:true,viewport:{width:1365,height:1000},args:[`--disable-extensions-except=${fixtureExtension}`,`--load-extension=${fixtureExtension}`]});
  const titles=new Map(ids.map((id,i)=>[id,fixtureTitles[i]]));
  const writes=[],modelBodies=[],errors=[];
  let failWriteId=null,holdWrite=null,writeStarted=false,manager,worker,localBridge,fixtureUser='fixture-user';
  const now=Date.now()/1000;
  const chat=id=>({conversation_id:id,title:titles.get(id),current_node:'reply',mapping:{
    root:{parent:null},question:{parent:'root',message:{id:'question',author:{role:'user'},content:{parts:[`PRIVATE_BODY_${id}：我希望讨论 ${proposed[ids.indexOf(id)]}，请帮助我分析。`]}}},
    reply:{parent:'question',message:{id:'reply',author:{role:'assistant'},content:{parts:['这里是讨论的具体方案与注意事项。']}}}
  }});
  await context.route('https://chatgpt.com/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/auth/session')return reply({accessToken:'FAKE_SESSION_TOKEN',user:{id:fixtureUser}});
    if(url.pathname==='/backend-api/conversations')return reply({items:ids.map(id=>({id,title:titles.get(id),create_time:now-1000,update_time:now})),total:ids.length});
    if(url.pathname.startsWith('/backend-api/conversation/')){
      const id=url.pathname.split('/').at(-1);
      if(!titles.has(id))return reply({error:'missing'},404);
      if(req.method()==='PATCH'){
        const body=req.postDataJSON();assert.deepEqual(Object.keys(body),['title']);
        const log=await worker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).flatMap(v=>v?.journal||[]));
        assert.ok(log.some(e=>e.id===id&&['prepared','restoring'].includes(e.state)),'remote write requires a durable prepared log');
        writes.push({id,title:body.title});
        if(holdWrite){writeStarted=true;await holdWrite;}
        if(failWriteId===id)return reply({error:'rate-limited'},429);
        titles.set(id,body.title);return reply({success:true});
      }
      return reply(chat(id));
    }
    return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><title>ChatGPT 测试夹具</title><body><h1>Isolated test fixture</h1></body></html>'});
  });
  await context.route('https://model.example/**',async route=>{
    const body=route.request().postDataJSON();modelBodies.push(body);
    const batch=JSON.parse(body.messages[1].content).conversations;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({titles:batch.map(r=>({id:r.id,title:proposed[ids.indexOf(r.id)]}))})}}]})});
  });
  try{
    worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).host;
    const source=await context.newPage();await source.goto('https://chatgpt.com/');
    const sourceId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'});return tabs[0].id;});
    await worker.evaluate(async()=>{
      await chrome.storage.local.set({'renamer-settings':{baseUrl:'https://model.example/v1/chat/completions',model:'test-only-model',rule:'准确概括正文'}});
      await chrome.storage.session.set({'renamer-api-key':'FAKE_MODEL_KEY'});
    });
    manager=await context.newPage();manager.on('pageerror',error=>errors.push(error.message));
    const managerUrl=`chrome-extension://${extensionId}/manager.html?source=${sourceId}`;
    await manager.goto(managerUrl);
    await manager.locator('#connect').click();await expect(manager.locator('#connectionBadge')).toHaveText('已连接');
    await manager.locator('#scan').click();await expect(manager.locator('#rows tr')).toHaveCount(3);await expect(manager.locator('#scan')).toBeEnabled();
    assert.equal(writes.length,0,'scan is read-only');
    await manager.locator('#generate').click();await expect(manager.locator('#rows .state.ready')).toHaveCount(3);await expect(manager.locator('#generate')).toBeEnabled();
    assert.equal(writes.length,0,'generation is read-only');assert.equal(modelBodies.length,1);
    assert.ok(JSON.stringify(modelBodies[0]).includes('PRIVATE_BODY_chat-0001'));
    assert.ok(!JSON.stringify(modelBodies[0]).includes('FAKE_SESSION_TOKEN'));
    const storedAfterGenerate=await worker.evaluate(async()=>await chrome.storage.local.get(null));
    assert.ok(!/PRIVATE_BODY|FAKE_MODEL_KEY|FAKE_SESSION_TOKEN/.test(JSON.stringify(storedAfterGenerate)));
    const artifacts=path.join(temporary,'validation');await fs.mkdir(artifacts,{recursive:true});
    await manager.screenshot({path:path.join(artifacts,'title-preview.png'),fullPage:true});
    await manager.locator('#apply').click();await expect(manager.locator('#confirmation')).toBeVisible();assert.equal(writes.length,0,'preview is read-only');
    await manager.locator('#confirmAction').click();await expect(manager.locator('#apply')).toBeEnabled();await manager.locator('#viewProcessed').click();await expect(manager.locator('#rows .state.applied')).toHaveCount(3);
    assert.deepEqual(ids.map(id=>titles.get(id)),proposed);
    const downloaded=manager.waitForEvent('download');await manager.locator('#exportBackup').click();const download=await downloaded;
    const backup=await fs.readFile(await download.path(),'utf8');
    assert.ok(backup.includes(fixtureTitles[0]));assert.ok(!/PRIVATE_BODY|FAKE_MODEL_KEY|FAKE_SESSION_TOKEN/.test(backup));
    await manager.locator('#restore').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#restore')).toBeEnabled();await manager.locator('#viewPending').click();await expect(manager.locator('#rows .state.restored')).toHaveCount(3);
    assert.deepEqual(ids.map(id=>titles.get(id)),fixtureTitles);
    await manager.reload();await manager.locator('#connect').click();await expect(manager.locator('#rows .state.restored')).toHaveCount(3);
    // A partial batch must stop at the first failure, leaving the remaining item untouched.
    failWriteId=ids[1];
    await manager.locator('#apply').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('过于频繁');await expect(manager.locator('#apply')).toBeEnabled();
    assert.equal(titles.get(ids[0]),proposed[0]);assert.equal(titles.get(ids[1]),fixtureTitles[1]);assert.equal(titles.get(ids[2]),fixtureTitles[2]);
    assert.equal(writes.length,8);failWriteId=null;
    await manager.locator('#reconcile').click();await expect(manager.locator('#status')).toContainText('已核对 1 条');await expect(manager.locator('#reconcile')).toBeEnabled();
    await manager.locator('#viewProcessed').click();await manager.locator('#restore').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('已恢复 1 条');await expect(manager.locator('#restore')).toBeEnabled();await manager.locator('#viewPending').click();
    // Cancel during a write completes that one write+verification, never starts the next.
    let release;holdWrite=new Promise(resolve=>release=resolve);writeStarted=false;const beforeStop=writes.length;
    await manager.locator('#apply').click();await manager.locator('#confirmAction').click();
    await expect.poll(()=>writeStarted).toBe(true);await manager.locator('#stop').click();release();holdWrite=null;
    await expect(manager.locator('#status')).toContainText('已停止后续操作');await expect(manager.locator('#apply')).toBeEnabled();assert.equal(writes.length,beforeStop+1);
    // A user-edited title is never silently overwritten, including on restore.
    titles.set(ids[0],'用户已手动修改');const beforeConflict=writes.length;
    await manager.locator('#viewProcessed').click();await manager.locator('#restore').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#restore')).toBeEnabled();await expect(manager.locator('#status')).toContainText('未恢复');assert.equal(writes.length,beforeConflict);await manager.locator('#viewPending').click();
    // No-key route: export actual excerpts, survive reload, validate JSON import without remote writes.
    await manager.locator('#skipCompleted').uncheck();
    await manager.locator('#scan').click();await expect(manager.locator('#scan')).toBeEnabled();
    await manager.locator('.manual summary').click();
    const taskDownload=manager.waitForEvent('download');await manager.locator('#exportTask').click();
    const taskText=await fs.readFile(await (await taskDownload).path(),'utf8');
    assert.ok(taskText.includes('PRIVATE_BODY_chat-0001'));assert.ok(!/FAKE_MODEL_KEY|FAKE_SESSION_TOKEN/.test(taskText));
    await expect(manager.locator('#exportTask')).toBeEnabled();
    await manager.reload();await manager.locator('#connect').click();await expect(manager.locator('#connectionBadge')).toHaveText('已连接');
    await manager.locator('.manual summary').click();await expect(manager.locator('#manualHint')).toContainText('等待本批 3 条');
    const hostileTitle='<img src=x onerror=alert(1)>';
    await manager.locator('#manualResult').fill(JSON.stringify({titles:ids.map((id,i)=>({id,title:i===0?hostileTitle:proposed[i]}))}));
    await manager.locator('#importTitles').click();await expect(manager.locator('#rows .state.ready')).toHaveCount(3);await expect(manager.locator('#importTitles')).toBeEnabled();
    assert.equal(writes.length,beforeConflict);assert.equal(modelBodies.length,1);assert.equal(await manager.locator('#rows img').count(),0);
    await manager.locator('#apply').click();await expect(manager.locator('#confirmRows')).toContainText(hostileTitle);assert.equal(await manager.locator('#confirmRows img').count(),0);
    await manager.locator('#confirmation button[value="cancel"]').last().click();await expect(manager.locator('#apply')).toBeEnabled();
    // A local storage failure prevents every server write.
    await manager.evaluate(()=>{globalThis.fixtureStorageSet=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=value=>Object.keys(value).some(key=>/^renamer-v\d+:/.test(key))?Promise.reject(new Error('模拟保存失败')):globalThis.fixtureStorageSet(value);});
    await manager.locator('#apply').click();
    try{await expect(manager.locator('#confirmation')).toBeVisible({timeout:3000});}catch{throw new Error(`Expected storage-failure preview; status: ${await manager.locator('#status').textContent()}`);}
    await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('模拟保存失败');await expect(manager.locator('#apply')).toBeEnabled();assert.equal(writes.length,beforeConflict);
    await manager.evaluate(()=>{chrome.storage.local.set=globalThis.fixtureStorageSet;});
    // Settings are explicit; saving does not send conversation content.
    await manager.locator('#settings summary').click();await manager.locator('#model').fill('another-configured-model');
    await manager.locator('#saveSettings').click();await expect(manager.locator('#status')).toContainText('模型设置已保存');assert.equal(modelBodies.length,1);
    await manager.locator('#clearKey').click();await expect(manager.locator('#apiKey')).toHaveValue('');
    assert.equal(await worker.evaluate(async()=>Object.hasOwn(await chrome.storage.session.get(null),'renamer-api-key')),false);
    // Actual loopback transport and extension permissions; Codex runner is injected, so this makes no paid model call.
    const {createBridge}=await import('../local-codex/server.mjs');let localCalls=0;
    const pairing='fixture-browser-pairing-code-12345';
    const localRequests=[];
    localBridge=createBridge({token:pairing,run:async input=>{localCalls++;localRequests.push(input);return {titles:input.rows.map(row=>({id:row.id,title:proposed[ids.indexOf(row.id)]+(input.rule?.startsWith('规则C')?'·C':'')})),model:'gpt-6-luna',reasoning:'high',requestedServiceTier:'fast'};}});
    await new Promise(resolve=>localBridge.server.listen(0,'127.0.0.1',resolve));
    await manager.locator('#backend').selectOption('codex-cli');
    await manager.locator('#bridgeUrl').fill(`http://127.0.0.1:${localBridge.server.address().port}`);await manager.locator('#bridgeKey').fill(pairing);
    await manager.locator('#saveCodex').click();await expect(manager.locator('#status')).toContainText('本机 Codex 连接已保存');
    await manager.locator('#generate').click();await expect(manager.locator('#status')).toContainText('生成完成');await expect(manager.locator('#generate')).toBeEnabled();
    assert.equal(localCalls,1);assert.equal(modelBodies.length,1);assert.equal(writes.length,beforeConflict);
    assert.ok(!JSON.stringify(await worker.evaluate(async()=>await chrome.storage.local.get(null))).includes(pairing));
    await manager.screenshot({path:path.join(artifacts,'codex-mode.png'),fullPage:true});
    // Fresh account scope for rule-based one-click workflow, with more than one model batch.
    fixtureUser='fixture-auto-user';ids.splice(0,ids.length,...Array.from({length:7},(_,i)=>`auto-000${i+1}`));
    fixtureTitles.splice(0,fixtureTitles.length,...ids.map((id,i)=>`旧聊天${i+1}`));proposed.splice(0,proposed.length,...ids.map((id,i)=>`主题${i+1}｜具体问题`));
    titles.clear();ids.forEach((id,i)=>titles.set(id,fixtureTitles[i]));
    await manager.locator('#connect').click();await expect(manager.locator('#rows tr')).toHaveCount(0);
    await manager.locator('#scan').click();await expect(manager.locator('#rows tr')).toHaveCount(7);await expect(manager.locator('#scan')).toBeEnabled();
    await manager.locator('#skipCompleted').check();
    await manager.locator('#rule').fill('规则A：简短中文主题与问题');await manager.locator('#rule').press('Tab');
    await manager.evaluate(()=>{const original=HTMLDialogElement.prototype.showModal;globalThis.fixtureDialogCount=0;HTMLDialogElement.prototype.showModal=function(){globalThis.fixtureDialogCount++;return original.call(this);};});
    const beforeAutoWrites=writes.length,beforeAutoCalls=localCalls;
    await manager.locator('#autoRun').click();await expect(manager.locator('#confirmText')).toContainText('7 条');assert.equal(writes.length,beforeAutoWrites);
    await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('自动处理完成',{timeout:30000});await expect(manager.locator('#autoRun')).toBeEnabled();
    assert.equal(localCalls,beforeAutoCalls+2);assert.deepEqual(localRequests.slice(-2).map(input=>input.rows.length),[5,2]);assert.equal(writes.length,beforeAutoWrites+7);
    await manager.locator('#viewProcessed').click();assert.equal(await manager.evaluate(()=>globalThis.fixtureDialogCount),1);assert.equal((await manager.locator('.rule-mark').allTextContents()).filter(text=>text==='当前规则已处理').length,7);
    await manager.locator('#autoRun').click();await expect(manager.locator('#status')).toContainText('已跳过 7 条');await expect(manager.locator('#autoRun')).toBeEnabled();assert.equal(localCalls,beforeAutoCalls+2);assert.equal(await manager.evaluate(()=>globalThis.fixtureDialogCount),1);
    // History survives reload and rescanning, with rule A still skipped.
    await manager.reload();await manager.locator('#connect').click();await expect(manager.locator('#connectionBadge')).toHaveText('已连接');
    await manager.locator('#scan').click();await expect(manager.locator('#scan')).toBeEnabled();await manager.locator('#viewProcessed').click();await manager.locator('#autoRun').click();await expect(manager.locator('#status')).toContainText('已跳过 7 条');await expect(manager.locator('#autoRun')).toBeEnabled();
    assert.equal(localCalls,beforeAutoCalls+2);
    // Rule B reruns every conversation even if its generated titles happen to match current titles.
    await manager.locator('#settings summary').click();await manager.locator('#rule').fill('规则B：换一套规则重新检查');await manager.locator('#rule').press('Tab');
    await manager.locator('#autoRun').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('自动处理完成',{timeout:30000});await expect(manager.locator('#autoRun')).toBeEnabled();
    assert.equal(localCalls,beforeAutoCalls+4);assert.equal(writes.length,beforeAutoWrites+7);await expect(manager.locator('#status')).toContainText('已符合规则 7 条');
    await manager.locator('#rule').fill('规则A：简短中文主题与问题');await manager.locator('#rule').press('Tab');
    await manager.locator('#autoRun').click();await expect(manager.locator('#status')).toContainText('已跳过 7 条');await expect(manager.locator('#autoRun')).toBeEnabled();assert.equal(localCalls,beforeAutoCalls+4);
    // Partial failure marks only confirmed writes; unknown operations must be reconciled before resume.
    await manager.locator('#rule').fill('规则C：主题与问题加C标记');await manager.locator('#rule').press('Tab');failWriteId=ids[2];
    await manager.locator('#autoRun').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('过于频繁',{timeout:20000});await expect(manager.locator('#autoRun')).toBeEnabled();
    assert.equal((await manager.locator('.rule-mark').allTextContents()).filter(text=>text==='当前规则已处理').length,2);
    await manager.locator('#viewPending').click();const beforeBlocked=localCalls;await manager.locator('#autoRun').click();await expect(manager.locator('#status')).toContainText('结果未知');await expect(manager.locator('#autoRun')).toBeEnabled();assert.equal(localCalls,beforeBlocked);
    failWriteId=null;await manager.locator('#reconcile').click();await expect(manager.locator('#status')).toContainText('已核对 1 条');await expect(manager.locator('#reconcile')).toBeEnabled();
    await manager.locator('#autoRun').click();await expect(manager.locator('#confirmText')).toContainText('1 条');await manager.locator('#confirmAction').click();
    await expect(manager.locator('#status')).toContainText('自动处理完成',{timeout:30000});await expect(manager.locator('#autoRun')).toBeEnabled();assert.equal(localRequests.at(-1).rows.length,1);
    await manager.locator('#viewProcessed').click();await manager.locator('#autoRun').click();await expect(manager.locator('#confirmText')).toContainText('4 条');await manager.locator('#confirmAction').click();
    await expect(manager.locator('#status')).toContainText('自动处理完成',{timeout:30000});await expect(manager.locator('#autoRun')).toBeEnabled();assert.equal(localRequests.at(-1).rows.length,4);
    assert.equal((await manager.locator('.rule-mark').allTextContents()).filter(text=>text==='当前规则已处理').length,7);
    // Restoring a completed rename clears that record's rule marker and permits it to run again.
    await manager.locator('#unselect').click();await manager.locator('#rows input[type=checkbox]').first().check();
    await manager.locator('#restore').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('已恢复 1 条');await expect(manager.locator('#restore')).toBeEnabled();
    await manager.locator('#viewPending').click();
    await expect(manager.locator('#ruleProgress')).toContainText('待处理 1 条');
    await manager.locator('#autoRun').click();await manager.locator('#confirmAction').click();await expect(manager.locator('#status')).toContainText('自动处理完成',{timeout:20000});await expect(manager.locator('#autoRun')).toBeEnabled();
    await manager.screenshot({path:path.join(artifacts,'auto-rules.png'),fullPage:true});
    await manager.locator('#resetRule').click();await expect(manager.locator('#ruleInfo')).toContainText('默认规则');
    await manager.locator('#settings summary').click();
    for(const width of [1365,768,390,320]){
      await manager.setViewportSize({width,height:1000});
      assert.equal(await manager.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,`page overflow at ${width}`);
    }
    await manager.setViewportSize({width:1365,height:1000});
    assert.deepEqual(errors,[]);
    const report={date:new Date().toISOString(),testType:'Isolated Chromium extension with mocked ChatGPT/model endpoints and actual loopback HTTP to a mocked Codex runner',assertions:['actual MV3 loading and messaging','scan and generate do not rename','AI results map to exact IDs','preview before mutation','write-ahead logs','server read-back','old-title backup excludes keys and bodies','restore and refresh persistence','429 halts partial batch','uncertain-operation reconciliation','stop completes only current write','manual-title conflict protection','manual no-key export and JSON import across reload','untrusted titles render as text','storage failure prevents writes','explicit provider settings and session key clearing','Codex mode uses authenticated loopback HTTP','one upfront confirmation covers 5+2 automatic batches','same rule skips without model calls after reload and rescan','different rule reruns; switching back retains prior markers','unchanged titles receive completion markers without writes','partial failure marks only confirmed writes; resume skips completed rows','restore clears rule completion and permits rerun','editable autosaved rule and reset to default','no bodies or secrets in durable storage','320/390/768/1365 responsive layout','no page errors'],realAccountMutations:0,paidModelCalls:0,passed:true};
    await fs.writeFile(path.join(artifacts,'browser-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }finally{await context.close();if(localBridge){localBridge.abortAll();localBridge.server.closeAllConnections();await new Promise(resolve=>localBridge.server.close(resolve));}assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));assert.ok(path.basename(temporary).startsWith('chatgpt-renamer-test-'));await fs.rm(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
