/* Isolated v0.2 storage migration test. No real account or model calls. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
let pw;
try { pw = require('playwright'); } catch { pw = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
let expect;
try { ({expect} = require('playwright/test')); } catch { ({expect} = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test'))); }
const extension = path.resolve(__dirname, '..');

(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'renamer-migration-test-'));
  const ext = path.join(tmp, 'extension');
  await fs.mkdir(ext);
  for (const f of ['manifest.json','background.js','content.js','manager.html','manager.css','manager.mjs','core.mjs','provider.mjs']) await fs.copyFile(path.join(extension,f), path.join(ext,f));
  const manifest = JSON.parse(await fs.readFile(path.join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions.push('https://model.example/*');
  await fs.writeFile(path.join(ext, 'manifest.json'), JSON.stringify(manifest));
  const executablePath = process.env.RENAMER_TEST_CHROMIUM || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe');
  const context = await pw.chromium.launchPersistentContext(path.join(tmp, 'profile'), {executablePath, headless:true, args:[`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]});
  let title = '旧版已应用标题', modelCalls = 0, patchCalls = 0;
  const chatId='chat-0001', scope=createHash('sha256').update('fixture-user:personal').digest('hex');
  const now=new Date().toISOString();
  const legacy={key:'old-log-1',scope,id:chatId,fromTitle:'旧版原始标题',toTitle:title,state:'applied',createdAt:now,updatedAt:now};
  const legacyRow={id:chatId,oldTitle:legacy.fromTitle,currentTitle:title,newTitle:title,selected:true,status:'applied',updateTime:Date.now()/1000};
  const conversation=()=>({conversation_id:chatId,title,current_node:'q',mapping:{q:{parent:null,message:{id:'q',author:{role:'user'},content:{parts:['测试正文：整理旅行计划']}}}}});
  await context.route('https://chatgpt.com/**', async route => {
    const req=route.request(), url=new URL(req.url());
    const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if (url.pathname==='/api/auth/session') return reply({accessToken:'fixture-only-token',user:{id:'fixture-user'}});
    if (url.pathname==='/backend-api/conversations') return reply({items:[{id:chatId,title,update_time:Date.now()/1000}],total:1});
    if (url.pathname===`/backend-api/conversation/${chatId}`) {
      if (req.method()==='PATCH') { title=req.postDataJSON().title;patchCalls++;return reply({ok:true}); }
      return reply(conversation());
    }
    return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Test fixture</title>'});
  });
  await context.route('https://model.example/**', async route => {
    modelCalls++;
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({titles:[{id:chatId,title:'旅行｜行程安排'}]})}}]})});
  });
  try {
    const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).host;
    const source=await context.newPage();await source.goto('https://chatgpt.com/');
    const sourceId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://chatgpt.com/*'}))[0].id);
    // The exact legacy storage shape is loaded before the v0.3 manager runs.
    await worker.evaluate(async ({scope,legacy,legacyRow})=>{
      await chrome.storage.local.set({[`renamer-v1:${scope}`]:{rows:[legacyRow],journal:[legacy],manualIds:[]},'renamer-settings':{backend:'api',baseUrl:'https://model.example/v1/chat/completions',model:'fixture',rule:'规则A'}});
      await chrome.storage.session.set({'renamer-api-key':'fixture-key'});
    },{scope,legacy,legacyRow});
    const manager=await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/manager.html?source=${sourceId}`);
    await manager.locator('#connect').click();await expect(manager.locator('#connectionBadge')).toHaveText('已连接');
    await manager.locator('#viewProcessed').click();
    await expect(manager.locator('#rows .rule-mark')).toContainText('当前规则未处理');
    let record=await worker.evaluate(async scope=>(await chrome.storage.local.get(`renamer-v1:${scope}`))[`renamer-v1:${scope}`],scope);
    assert.equal(record.journal[0].fromTitle,legacy.fromTitle);assert.equal(record.journal[0].ruleId,undefined);
    // Old rename can still be restored from the unchanged original journal.
    await manager.locator('#restore').click();await manager.locator('#confirmAction').click();
    await expect(manager.locator('#status')).toContainText('已恢复 1 条');assert.equal(title,legacy.fromTitle);
    await manager.locator('#viewPending').click();
    await manager.locator('#scan').click();await expect(manager.locator('#scan')).toBeEnabled();
    // Under the current rule the old entry has no inferred completion.
    await expect(manager.locator('#ruleProgress')).toContainText('待处理 1 条');
    await manager.locator('#autoRun').click();await manager.locator('#confirmAction').click();
    await expect(manager.locator('#status')).toContainText('自动处理完成',{timeout:30000});assert.equal(modelCalls,1);assert.equal(title,'旅行｜行程安排');
    const writes=patchCalls;
    await manager.reload();await manager.locator('#connect').click();
    await manager.locator('#scan').click();await expect(manager.locator('#scan')).toBeEnabled();
    await manager.locator('#viewProcessed').click();
    await manager.locator('#autoRun').click();await expect(manager.locator('#status')).toContainText('已跳过 1 条');
    assert.equal(modelCalls,1);assert.equal(patchCalls,writes);
    // A prior success must not conceal an unresolved, newer restore attempt.
    await worker.evaluate(async ({scope,chatId})=>{
      const key=`renamer-v1:${scope}`,data=(await chrome.storage.local.get(key))[key];
      data.journal.push({key:'unfinished-restore-fixture',scope,id:chatId,fromTitle:'旧标题',toTitle:'旅行｜行程安排',state:'restoring',createdAt:'2099-01-01T00:00:00.000Z',updatedAt:'2099-01-01T00:00:00.000Z'});
      await chrome.storage.local.set({[key]:data});
    },{scope,chatId});
    await manager.locator('#connect').click();await manager.locator('#viewPending').click();
    await manager.locator('#autoRun').click();await expect(manager.locator('#status')).toContainText('结果未知');
    assert.equal(modelCalls,1);assert.equal(patchCalls,writes);
    await worker.evaluate(async scope=>{
      const key=`renamer-v1:${scope}`,data=(await chrome.storage.local.get(key))[key];
      const entry=data.journal.find(e=>e.key==='unfinished-restore-fixture');entry.state='not-applied';entry.updatedAt='2099-01-02T00:00:00.000Z';
      await chrome.storage.local.set({[key]:data});
    },scope);
    await manager.locator('#connect').click();await manager.locator('#viewPending').click();
    await manager.locator('#settings summary').click();await manager.locator('#rule').fill('规则B');await manager.locator('#rule').press('Tab');
    await manager.locator('#autoRun').click();await manager.locator('#confirmAction').click();
    await expect(manager.locator('#status')).toContainText('自动处理完成',{timeout:30000});assert.equal(modelCalls,2);
    assert.equal(patchCalls,writes,'identical resulting title must not be written again');
    record=await worker.evaluate(async scope=>(await chrome.storage.local.get(`renamer-v1:${scope}`))[`renamer-v1:${scope}`],scope);
    assert.ok(record.journal.some(e=>e.key===legacy.key&&e.state==='restored'));
    console.log('PASS legacy storage restored; unknown rule not inferred; same rule skips after reload; different rule reruns. Mock data only.');
  } finally {
    await context.close();
    if(path.dirname(path.resolve(tmp))!==path.resolve(os.tmpdir()) || !path.basename(tmp).startsWith('renamer-migration-test-')) throw new Error('unexpected temporary directory');
    await fs.rm(tmp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
