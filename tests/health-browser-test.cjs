/* Actual Chromium extension -> loopback bridge /health, no paid calls or real data. */
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
let playwright,expect;
try{playwright=require('playwright');}catch{playwright=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));}
try{({expect}=require('playwright/test'));}catch{({expect}=require(path.join(os.homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/test')));}
(async()=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'renamer-health-test-')),ext=path.join(tmp,'extension');await fs.mkdir(ext);
  const src=path.resolve(__dirname,'..');
  for(const name of ['manifest.json','background.js','manager.html','manager.css','manager.mjs','core.mjs','provider.mjs'])await fs.copyFile(path.join(src,name),path.join(ext,name));
  await fs.mkdir(path.join(ext,'adapters'));
  for(const name of ['chatgpt.js','deepseek.js'])await fs.copyFile(path.join(src,'adapters',name),path.join(ext,'adapters',name));
  const manifest=JSON.parse(await fs.readFile(path.join(ext,'manifest.json'),'utf8'));
  manifest.host_permissions.push('http://127.0.0.1/*'); // Simulate the user-granted optional permission.
  await fs.writeFile(path.join(ext,'manifest.json'),JSON.stringify(manifest));
  const {createBridge}=await import('../local-codex/server.mjs');let modelCalls=0;
  const token='fixture-pairing-token-never-real';
  const bridge=createBridge({token,run:async()=>{modelCalls++;throw Error('should not call model');}});
  const observations=[];
  bridge.server.on('request',req=>{if(req.url==='/health') observations.push({method:req.method,origin:req.headers.origin,authorization:req.headers.authorization});});
  await new Promise(resolve=>bridge.server.listen(0,'127.0.0.1',resolve));
  const port=bridge.server.address().port;
  const executablePath=process.env.RENAMER_TEST_CHROMIUM||path.join(os.homedir(),'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe');
  let context;
  try{
    context=await playwright.chromium.launchPersistentContext(path.join(tmp,'profile'),{executablePath,headless:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),extensionId=new URL(worker.url()).host;
    await worker.evaluate(async ({port,token})=>{
      await chrome.storage.local.set({'renamer-settings':{backend:'codex-cli',bridgeUrl:`http://127.0.0.1:${port}`,rule:'规则'}});
      await chrome.storage.session.set({'renamer-bridge-key':token});
    },{port,token});
    const page=await context.newPage();await page.goto(`chrome-extension://${extensionId}/manager.html`);
    await page.locator('#checkConnection').click();
    try{await expect(page.locator('#localStatus')).toContainText('服务已响应，配对码有效');}catch(error){console.error('Observed requests:',observations.map(({method,origin})=>({method,origin:origin||'(absent)'})));throw error;}
    await expect(page.locator('#cliStatus')).toContainText('尚未验证');
    const get=observations.find(o=>o.method==='GET');
    assert.ok(get,'browser sent actual GET to loopback');
    // Chromium extension pages with granted host permission may omit Origin.
    assert.ok(!get.origin||get.origin===`chrome-extension://${extensionId}`);
    assert.equal(get.authorization,`Bearer ${token}`);assert.equal(modelCalls,0);
    await worker.evaluate(async()=>chrome.storage.session.set({'renamer-bridge-key':'fixture-wrong-pairing-code'}));
    await page.reload();await page.locator('#checkConnection').click();
    await expect(page.locator('#localStatus')).toContainText('配对码错误或已过期');
    await expect(page.locator('#cliStatus')).toContainText('尚未验证');assert.equal(modelCalls,0);
    await new Promise(resolve=>bridge.server.close(resolve));
    await page.locator('#checkConnection').click();
    await expect(page.locator('#localStatus')).toContainText('无法连接本机服务');assert.equal(modelCalls,0);
    console.log('PASS actual Chromium extension health GET: Origin, valid/wrong token, unavailable service, and no CLI/model call.');
  }finally{
    if(context)await context.close();
    if(bridge.server.listening){bridge.abortAll();bridge.server.closeAllConnections();await new Promise(resolve=>bridge.server.close(resolve));}
    if(path.dirname(path.resolve(tmp))!==path.resolve(os.tmpdir())||!path.basename(tmp).startsWith('renamer-health-test-'))throw Error('unexpected temporary directory');
    await fs.rm(tmp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
