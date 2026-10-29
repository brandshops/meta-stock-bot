// Runs the Meta Stock Checker extension inside Chrome on GitHub and pushes results to WordPress.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ext = path.resolve('ext');
const key = process.env.WP_KEY || '';
const files = fs.readdirSync('.').filter(f => /^meta-stock-backup.*\.json$/i.test(f)).sort();
let cfg = null;
if (files.length) {
  const j = JSON.parse(fs.readFileSync(files[files.length - 1], 'utf8'));
  cfg = j.data || j;
  console.log('Using settings file', files[files.length - 1]);
} else console.log('No settings file found: running a small test with default settings');
(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/prof', { headless: false, args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext, '--no-sandbox'] });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const id = sw.url().split('/')[2];
  console.log('Extension loaded', id);
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGE ERROR', e.message));
  await page.goto('chrome-extension://' + id + '/dashboard.html');
  await page.waitForTimeout(1500);
  await page.evaluate(async ([c, k]) => {
    const cur = (await chrome.storage.local.get('msc')).msc || {};
    const o = c ? c : cur;
    o.settings = Object.assign({}, o.settings || {}, { wpKey: k, wpUrl: (o.settings && o.settings.wpUrl) || 'https://aiglasses.ae', autoMig: 1, autoPush: true, listen: true });
    o.results = {};
    await chrome.storage.local.set({ msc: o });
  }, [cfg, key]);
  await page.goto('chrome-extension://' + id + '/dashboard.html');
  await page.waitForTimeout(2000);
  if (!cfg) await page.evaluate(() => { S.selCountries = ['AE', 'IN', 'GB']; S.selProducts = S.selProducts.slice(0, 3); });
  const plan = await page.evaluate(() => ({ products: S.selProducts.length, countries: S.selCountries.length, wp: S.settings.wpUrl }));
  console.log('Plan', JSON.stringify(plan));
  const t0 = Date.now();
  const prog = setInterval(async () => { try { console.log('progress', await page.evaluate(() => Object.keys(S.results).length), 'rows,', Math.round((Date.now() - t0) / 60000), 'min'); } catch (e) {} }, 120000);
  await page.evaluate(async () => { await runChecks(true); });
  clearInterval(prog);
  const sum = await page.evaluate(() => { const c = {}; Object.values(S.results).forEach(r => { c[r.status] = (c[r.status] || 0) + 1; }); return c; });
  console.log('RESULT STATUS COUNTS', JSON.stringify(sum));
  const ok = await page.evaluate(async () => { const r = await wpPush(true); return r + ' | ' + (S.settings.wpLast || ''); });
  console.log('RESULT PUSH', ok);
  await page.waitForTimeout(3000);
  await ctx.close();
})().catch(e => { console.log('FAILED', e.message); process.exit(1); });
