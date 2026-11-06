/* Isolated MV3 acceptance: all account, model and chat endpoints are fixtures. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
let pw, expect;
try { pw = require('playwright'); } catch { pw = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
try { ({expect} = require('playwright/test')); } catch { ({expect} = require(path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test'))); }
const root = path.resolve(__dirname, '..');
const ids = ['chat-0001','chat-0002','chat-0003'];
const original = ['无文字的聊天','正常聊天甲','正常聊天乙'];
const proposed = ['生成标题一','生成标题二','生成标题三'];

async function scenario(kind) {
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'renamer-individual-test-'));
  const ext=path.join(temporary,'extension'); await fs.mkdir(ext);
  for (const f of ['manifest.json','background.js','manager.html','manager.css','manager.mjs','core.mjs','provider.mjs']) await fs.copyFile(path.join(root,f),path.join(ext,f));
  await fs.mkdir(path.join(ext,'adapters'));
  for (const f of ['chatgpt.js','deepseek.js']) await fs.copyFile(path.join(root,'adapters',f),path.join(ext,'adapters',f));
  const manifest=JSON.parse(await fs.readFile(path.join(ext,'manifest.json'),'utf8'));
  manifest.host_permissions.push('https://model.example/*');
  await fs.writeFile(path.join(ext,'manifest.json'),JSON.stringify(manifest));
  const executablePath=process.env.RENAMER_TEST_CHROMIUM||path.join(os.homedir(),'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe');
  const context=await pw.chromium.launchPersistentContext(path.join(temporary,'profile'),{executablePath,headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
  const titles=new Map(ids.map((id,i)=>[id,original[i]])), writes=[], requested=[], reads=new Map();
  let worker, failRate=true, failWrite=true;
  const now=Date.now()/1000;
  const conversation=id=>({conversation_id:id,title:titles.get(id),current_node:'q',mapping:{q:{parent:null,message:{id:'q',author:{role:'user'},content:{parts:['single','manual'].includes(kind)&&id===ids[0]?[]:[`虚构正文 ${id}`]}}}}});
  await context.route('https://chatgpt.com/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(url.pathname==='/api/auth/session') return reply({accessToken:'fixture-token-only',user:{id:'fixture-user'}});
    if(url.pathname==='/backend-api/conversations')return reply({items:ids.map(id=>({id,title:titles.get(id),create_time:now,update_time:now})),total:ids.length});
    if(url.pathname.startsWith('/backend-api/conversation/')) {
      const id=url.pathname.split('/').at(-1);
      if(kind==='rate'&&failRate&&id===ids[1]&&req.method()==='GET')return reply({error:'rate limit'},429);
      if(['restore_missing','reconcile_missing'].includes(kind)&&id===ids[0]&&req.method()==='GET')return reply({error:'missing'},404);
      if(req.method()==='PATCH') {
        const log=await worker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).flatMap(x=>x?.journal||[]));
        assert.ok(log.some(e=>e.id===id&&['prepared','restoring'].includes(e.state)),'write-ahead record precedes PATCH');
        writes.push(id);
        if(kind==='uncertain'&&id===ids[1]&&failWrite) return route.abort('failed');
        titles.set(id,req.postDataJSON().title);return reply({ok:true});
      }
      reads.set(id,(reads.get(id)||0)+1);
      if(kind==='prewrite_missing'&&id===ids[1]&&reads.get(id)>=2)return reply({error:'missing'},404);
      if(kind==='postwrite_missing'&&id===ids[1]&&writes.includes(id))return reply({error:'missing'},404);
      return reply(conversation(id));
    }
    return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Fixture</title>'});
  });
  await context.route('https://model.example/**',async route=>{
    const batch=JSON.parse(route.request().postDataJSON().messages[1].content).conversations;
    requested.push(batch.map(row=>row.id));
    if(kind.startsWith('output_retry') && batch.length>1)
      return route.fulfill({json:{choices:[{message:{content:'{"titles":[]}'}}]}});
    if(kind==='output_retry' && batch[0].id===ids[1])
      return route.fulfill({json:{choices:[{message:{content:'{"titles":[]}'}}]}});
    if(kind==='output_retry_rate' && batch[0].id===ids[1])
      return route.fulfill({status:429,json:{error:'fixture rate limit'}});
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({titles:batch.map(row=>({id:row.id,title:proposed[ids.indexOf(row.id)]}))})}}]})});
  });
  try {
    worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extId=new URL(worker.url()).host;
    const source=await context.newPage();await source.goto('https://chatgpt.com/');
    const sourceId=await worker.evaluate(async()=> (await chrome.tabs.query({url:'https://chatgpt.com/*'}))[0].id);
    await worker.evaluate(async()=>{
      await chrome.storage.local.set({'renamer-settings':{backend:'api',baseUrl:'https://model.example/v1/chat/completions',model:'fixture-model',rule:'规则A'}});
      await chrome.storage.session.set({'renamer-api-key':'fixture-key'});
    });
    const manager=await context.newPage(), pageErrors=[];
    manager.on('pageerror',error=>pageErrors.push(error.message));
    await manager.goto(`chrome-extension://${extId}/manager.html?source=${sourceId}`);
    await manager.locator('#connect').click();await expect(manager.locator('#connectionBadge')).toHaveText('已连接');
    await manager.locator('#scan').click();await expect(manager.locator('#rows tr')).toHaveCount(3);await expect(manager.locator('#scan')).toBeEnabled();
    if(kind==='single') {
      const suggestion=manager.locator('#rows tr').filter({hasText:original[0]}).locator('.title-edit');
      await suggestion.fill('旧建议');
      await suggestion.press('Tab');
      await expect(manager.locator('#rows tr').filter({hasText:original[0]}).locator('.state')).toHaveText('待检查');
    }
    if(kind==='manual') {
      await manager.locator('.manual summary').click();
      const pending=manager.waitForEvent('download');await manager.locator('#exportTask').click();
      const text=await fs.readFile(await (await pending).path(),'utf8');
      assert.ok(!text.includes(ids[0]));assert.ok(text.includes(ids[1]));assert.ok(text.includes(ids[2]));
      assert.deepEqual(writes,[]);console.log('PASS manual: skips one unsupported body; exports remaining');return;
    }
    if(['restore_missing','restore_conflict','restore_stop','reconcile_missing'].includes(kind)) {
      await worker.evaluate(async({ids,original,kind})=>{
        const all=await chrome.storage.local.get(null), key=Object.keys(all).find(k=>k.startsWith('renamer-v2:')||k.startsWith('renamer-v1:'));
        const data=all[key], scope=key.startsWith('renamer-v2:')?key.split(':').slice(2).join(':'):key.slice('renamer-v1:'.length);
        for(let i=0;i<2;i++){
          const restoring=kind==='reconcile_missing';
          data.journal.push({key:'fixture-journal-'+i,scope,id:ids[i],fromTitle:`恢复标题${i}`,toTitle:original[i],state:restoring?'uncertain':'applied',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});
          data.rows[i].status=restoring?'uncertain':'applied';data.rows[i].currentTitle=original[i];
        }
        await chrome.storage.local.set({[key]:data});
      },{ids,original,kind});
      await manager.locator('#connect').click();
      if(kind==='reconcile_missing') {
        await manager.locator('#reconcile').click();await expect(manager.locator('#reconcile')).toBeEnabled({timeout:15000});
        const entries=await worker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).flatMap(x=>x?.journal||[]));
        assert.equal(entries.find(e=>e.id===ids[0]).state,'uncertain');
        assert.equal(entries.find(e=>e.id===ids[1]).state,'applied');
        assert.deepEqual(writes,[]);console.log('PASS reconcile_missing: missing item stays unresolved; other item reconciled');return;
      }
      if(kind==='restore_conflict') titles.set(ids[0],'用户已修改');
      if(kind==='restore_stop') await manager.evaluate(()=>{
        const originalSet=chrome.storage.local.set.bind(chrome.storage.local);let release;
        globalThis.fixtureHold=new Promise(resolve=>release=resolve);globalThis.fixtureRelease=release;globalThis.fixtureWaiting=false;
        chrome.storage.local.set=async value=>{const rows=Object.values(value).flatMap(v=>v?.journal||[]);if(!globalThis.fixtureWaiting&&rows.some(e=>e.state==='restoring')){globalThis.fixtureWaiting=true;await globalThis.fixtureHold;}return originalSet(value);};
      });
      await manager.locator('#viewProcessed').click();await manager.locator('#restore').click();
      await expect(manager.locator('#confirmation')).toBeVisible();await manager.locator('#confirmAction').click();
      if(kind==='restore_stop') {await expect.poll(()=>manager.evaluate(()=>globalThis.fixtureWaiting)).toBe(true);await manager.locator('#stop').click();await manager.evaluate(()=>globalThis.fixtureRelease());}
      await expect(manager.locator('#restore')).toBeEnabled({timeout:15000});
      const entries=await worker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).flatMap(x=>x?.journal||[]));
      if(kind==='restore_stop') {assert.deepEqual(writes,[],'stopping while persisting a restore must prevent PATCH');console.log('PASS restore_stop: no write after stop');return;}
      assert.equal(entries.find(e=>e.id===ids[0]).state,'applied');assert.equal(entries.find(e=>e.id===ids[1]).state,'restored');
      assert.deepEqual(writes,[ids[1]]);console.log(`PASS ${kind}: skip individual prewrite failure and restore next`);return;
    }
    if(kind==='apply_stop') await manager.evaluate(()=>{
      const originalSet=chrome.storage.local.set.bind(chrome.storage.local);let release;
      globalThis.fixtureHold=new Promise(resolve=>release=resolve);globalThis.fixtureRelease=release;globalThis.fixtureWaiting=false;
      chrome.storage.local.set=async value=>{const rows=Object.values(value).flatMap(v=>v?.journal||[]);if(!globalThis.fixtureWaiting&&rows.some(e=>e.state==='prepared')){globalThis.fixtureWaiting=true;await globalThis.fixtureHold;}return originalSet(value);};
    });
    if(kind==='filtered') {
      await manager.locator('#filter').fill(original[1]);
      await expect(manager.locator('#rows tr')).toHaveCount(1);
    }
    await manager.locator('#autoRun').click();await manager.locator('#confirmAction').click();
    if(kind==='apply_stop') {await expect.poll(()=>manager.evaluate(()=>globalThis.fixtureWaiting)).toBe(true);await manager.locator('#stop').click();await manager.evaluate(()=>globalThis.fixtureRelease());}
    await expect(manager.locator('#autoRun')).toBeEnabled({timeout:35000});
    if(kind==='apply_stop') {
      assert.deepEqual(writes,[],'stopping while persisting an apply must prevent PATCH');
    } else if(kind==='single') {
      assert.deepEqual(requested,[[ids[1],ids[2]]],'model receives only conversations with valid text');
      assert.deepEqual(writes,[ids[1],ids[2]],'one unsupported item does not block remaining valid chats');
      assert.equal(titles.get(ids[0]),original[0]);assert.equal(titles.get(ids[1]),proposed[1]);assert.equal(titles.get(ids[2]),proposed[2]);
      await expect(manager.locator('#rows')).toContainText(original[0]);
      await expect(manager.locator('#rows .state')).toHaveText('无可用文字');
      await expect(manager.locator('#rows .title-edit')).toHaveValue('');
      await expect(manager.locator('#rows')).not.toContainText(original[1]);
      await expect(manager.locator('#rows')).not.toContainText(original[2]);
      await manager.locator('#viewProcessed').click();
      await expect(manager.locator('#rows')).toContainText(original[1]);await expect(manager.locator('#rows')).toContainText(original[2]);
      await expect(manager.locator('#rows')).not.toContainText(original[0]);
      const screenshot=temporary+'-processed.png';await manager.screenshot({path:screenshot,fullPage:true});console.log(`SCREENSHOT ${screenshot}`);
      // Restore one processed item via the same extension; other restored data stays intact.
      await manager.locator('#unselect').click();
      await manager.locator('#rows tr').filter({hasText:original[1]}).locator('input[type=checkbox]').check();
      await manager.locator('#restore').click();await expect(manager.locator('#confirmation')).toBeVisible();await manager.locator('#confirmAction').click();
      await expect(manager.locator('#restore')).toBeEnabled({timeout:15000});assert.equal(titles.get(ids[1]),original[1]);
      await manager.locator('#viewPending').click();await expect(manager.locator('#rows')).toContainText(original[1]);
      await manager.reload();await manager.locator('#connect').click();await manager.locator('#viewProcessed').click();
      await expect(manager.locator('#rows')).toContainText(original[2]);
    } else if(kind==='output_retry') {
      assert.deepEqual(requested,[ids,[ids[0]],[ids[1]],[ids[2]]]);
      assert.deepEqual(writes,[ids[0],ids[2]]);
      await expect(manager.locator('#rows')).toContainText('单条标题生成失败：标题数量不符，预期 1 条，收到 0 条');
    } else if(kind==='output_retry_rate') {
      assert.deepEqual(requested,[ids,[ids[0]],[ids[1]]]);
      assert.deepEqual(writes,[],'rate limit during fallback stops the batch before any write');
      await expect(manager.locator('#status')).toContainText('429');
    } else if(kind==='filtered') {
      assert.deepEqual(requested,[[ids[1]]],'hidden selected chats are not sent to the model');
      assert.deepEqual(writes,[ids[1]],'only the visible selected chat is renamed');
      assert.equal(titles.get(ids[0]),original[0]);assert.equal(titles.get(ids[2]),original[2]);
      await manager.locator('#filter').fill('');
      await expect(manager.locator('#rows')).toContainText(original[0]);await expect(manager.locator('#rows')).toContainText(original[2]);
    } else if(kind==='prewrite_missing') {
      assert.deepEqual(writes,[ids[0],ids[2]],'chat missing before PATCH is skipped and later chats still run');
      assert.equal(titles.get(ids[1]),original[1]);assert.equal(titles.get(ids[2]),proposed[2]);
    } else if(kind==='postwrite_missing') {
      assert.deepEqual(writes,[ids[0],ids[1]],'chat missing on readback stops before the next write');
      assert.equal(titles.get(ids[2]),original[2]);
      const stored=await worker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).flatMap(x=>x?.journal||[]));
      assert.ok(stored.some(e=>e.id===ids[1]&&e.state==='uncertain'),'post-PATCH 404 remains uncertain');
    } else if(kind==='rate') {
      assert.deepEqual(writes,[],'global rate limit aborts before writes');
      assert.deepEqual(requested,[],'rate-limited read cannot be silently treated as a per-row failure');
      await expect(manager.locator('#status')).toContainText('频繁');
    } else if(kind==='uncertain') {
      assert.deepEqual(writes,[ids[0],ids[1]],'unknown write stops before later chats');
      assert.equal(titles.get(ids[2]),original[2]);
      const stored=await worker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).flatMap(x=>x?.journal||[]));
      assert.ok(stored.some(e=>e.id===ids[1]&&e.state==='uncertain'),'uncertain write must remain available for reconciliation');
    }
    assert.deepEqual(pageErrors,[]);
    console.log(`PASS ${kind}: isolated extension and mock endpoints`);
  } finally {
    await context.close();
    if(path.dirname(path.resolve(temporary))!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('renamer-individual-test-')) throw new Error('unexpected temporary path');
    await fs.rm(temporary,{recursive:true,force:true});
  }
}
(async()=>{for(const mode of (process.argv.length>2?process.argv.slice(2):['single','output_retry','output_retry_rate','filtered','prewrite_missing','postwrite_missing','rate','uncertain','manual','reconcile_missing','restore_missing','restore_conflict','apply_stop','restore_stop'])) await scenario(mode);})().catch(error=>{console.error(error);process.exitCode=1;});
