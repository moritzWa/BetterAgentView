// PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-landing-browser.cjs
// Run under heavy-job.py. Uses headless Chromium only; never plays audio.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '../site');
const output = process.env.LANDING_SHOTS || path.resolve(__dirname, '../target/landing-review');
const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4'};
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const bytes = await fs.readFile(file);
    res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream'}).end(bytes);
  } catch { res.writeHead(404).end('Not found'); }
});

(async () => {
  await fs.mkdir(output,{recursive:true});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = process.env.LANDING_URL || `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await chromium.launch({headless:true, args:['--mute-audio']});
    const context = await browser.newContext({permissions:['clipboard-read','clipboard-write'], reducedMotion:'reduce'});
    for (const [name,width,height] of [['desktop',1440,1000],['mobile',390,844],['small-mobile',320,740],['tablet',820,1180]]) {
      const page = await context.newPage();
      await page.setViewportSize({width,height});
      const errors = [];
      page.on('pageerror',error => errors.push(error.message));
      page.on('response',response => { if(response.status()>=400 && response.url().startsWith(url)) errors.push(`${response.status()} ${response.url()}`); });
      await page.goto(url,{waitUntil:'networkidle'});
      await page.locator('img').evaluateAll(images=>images.forEach(image=>image.loading='eager'));
      await page.waitForFunction(()=>[...document.images].every(image=>image.complete && image.naturalWidth>0));
      assert.equal(await page.locator('video').count(),1);
      assert.equal(await page.locator('video').evaluate(video=>video.paused && !video.autoplay),true);
      assert.equal(await page.locator('.github-button').isVisible(),true);
      assert.equal(await page.locator('.github-button').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(21, 22, 27)');
      assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`${name}: horizontal overflow`);
      await page.screenshot({path:path.join(output,`${name}-hero.png`)});
      await page.getByRole('button',{name:'By status',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#dashboard-preview').complete);
      assert.match(await page.locator('#dashboard-preview').getAttribute('src'),/status.webp/);
      await page.getByRole('button',{name:'Work only',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#dashboard-preview').complete);
      assert.match(await page.locator('#view-description').textContent(),/keep running/);
      await page.getByRole('button',{name:'By directory',exact:true}).click();
      await page.getByRole('tab',{name:'Windows',exact:true}).click();
      assert.match(await page.locator('#cmd').textContent(),/install.ps1/);
      await page.getByRole('tab',{name:'Windows',exact:true}).press('ArrowRight');
      assert.match(await page.locator('#cmd').textContent(),/cargo install/);
      await page.getByRole('tab',{name:'macOS / Linux',exact:true}).click();
      await page.getByRole('button',{name:'Copy install command'}).click();
      await page.waitForFunction(()=>document.getElementById('copy-status').textContent.includes('copied'));
      assert.match(await page.locator('#copy-status').textContent(),/copied/);
      assert.match(await page.evaluate(()=>navigator.clipboard.readText()),/install.sh/);
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:path.join(output,`${name}-full.png`),fullPage:true});
      assert.deepEqual(errors,[],`${name}: browser errors`);
      await page.close();
    }
    await context.close();
    console.log(`PASS: desktop, mobile, small mobile and tablet. Grouping, install tabs, keyboard tab navigation, clipboard, local assets and no autoplay. Screenshots: ${output}`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
