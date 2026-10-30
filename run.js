// Runs the Meta Stock Checker extension inside Chrome on GitHub and pushes results to WordPress.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ext = path.resolve('ext');
const key = process.env.WP_KEY || '';
const mode = process.env.MODE === 'quick' ? 'quick' : 'full';
const api = 'https://aiglasses.ae/wp-json/aig-stock/v1';
const files = fs.readdirSync('.').filter(f => /^meta-stock-backup.*\.json$/i.test(f)).sort();
let cfg = null;
if (files.length) {
  const j = JSON.parse(fs.readFileSync(files[files.length - 1], 'utf8'));
  cfg = j.data || j;
  console.log('Using settings file', files[files.length - 1]);
} else console.log('No settings file found: running a small test with default settings');
(async () => {
  try {
    const r = await fetch(api + '/config', { headers: { 'X-AIG-Key': key } });
    const j = await r.json();
    if (j && j.config && j.config.settings) { cfg = j.config; console.log('Using settings saved in WordPress'); }
    else console.log('No settings in WordPress yet (HTTP ' + r.status + '), using the uploaded file');
  } catch (e) { console.log('Could not read WordPress settings:', e.message, '- using the uploaded file'); }
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
  if (mode === 'quick') {
    const n = await page.evaluate(() => {
      const known = allProducts().map(p => p[0]), h = (S.settings.hourly || []).filter(x => known.indexOf(x) !== -1);
      const rest = S.selProducts.filter(x => h.indexOf(x) === -1), k = Math.floor(Date.now() / 3600000), size = 12;
      const slice = []; for (let i = 0; i < Math.min(size, rest.length); i++) slice.push(rest[(k * size + i) % rest.length]);
      S.selProducts = h.filter((x, i) => i % 3 === k % 3).concat(slice);
      return S.selProducts.length;
    });
    if (!n) { console.log('QUICK: nothing to do'); await ctx.close(); return; }
    console.log('QUICK run:', n, 'products');
  }
  const plan = await page.evaluate(() => ({ products: S.selProducts.length, countries: S.selCountries.length, wp: S.settings.wpUrl }));
  console.log('Plan', JSON.stringify(plan));
  const t0 = Date.now();
  const prog = setInterval(async () => { try { console.log('progress', await page.evaluate(() => Object.keys(S.results).length), 'rows,', Math.round((Date.now() - t0) / 60000), 'min'); } catch (e) {} }, 120000);
  await page.evaluate(async () => { await runChecks(true); });
  clearInterval(prog);
  const sum = await page.evaluate(() => { const c = {}; Object.values(S.results).forEach(r => { c[r.status] = (c[r.status] || 0) + 1; }); return c; });
  console.log('RESULT STATUS COUNTS', JSON.stringify(sum));
  const bad = await page.evaluate(() => { const b = {}; Object.values(S.results).forEach(r => { if (r.status === 'ERROR' || r.status === 'NOT_FOUND') b[r.slug] = (b[r.slug] || 0) + 1; }); return b; });
  console.log('RESULT ERROR PRODUCTS', Object.keys(bad).length, JSON.stringify(bad).slice(0, 3000));
  const ok = await page.evaluate(async () => { const r = await wpPush(true); return r + ' | ' + (S.settings.wpLast || ''); });
  console.log('RESULT PUSH', ok);
  await page.waitForTimeout(3000);
  await ctx.close();
})().catch(e => { console.log('FAILED', e.message); process.exit(1); });
