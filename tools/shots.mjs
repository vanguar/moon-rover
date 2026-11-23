// Reference shots: renders the game from the viewpoints of Apollo 15 photographs
// (docs/shots.json) and saves side-by-side pairs to docs/comparisons/.
// Usage: npm run shots [-- name ...]   (dev server must be running: npm run dev)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const views = JSON.parse(readFileSync('docs/shots.json', 'utf8'));
const only = process.argv.slice(2);
const base = process.env.URL ?? 'http://localhost:5173/moon-rover/';
const out = process.env.OUT ?? 'docs/comparisons';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL ?? 'chrome',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}?world=moon&shots=1`);
await page.waitForSelector('#start', { state: 'visible', timeout: 180000 });
await page.click('#start');
await page.waitForTimeout(800);
await page.addStyleTag({ content: '#hud,#toolbar,#touch,#menu,.toast,#radio{display:none!important}' });

for (const v of views) {
  if (only.length && !only.includes(v.name)) continue;
  await page.evaluate((v) => {
    const g = window.game;
    const s = g.terrain.meta.sites;
    const site = v.site ? s[v.site] : { x: 0, z: 0 };
    const x = site.x + (v.dx ?? 0), z = site.z + (v.dz ?? 0);
    if (v.time && g.setTime) g.setTime(Date.parse(v.time), 0);
    g.debugCam = { x, z, h: v.h ?? 1.7, az: v.az, pitch: v.pitch ?? -8, fov: v.fov ?? 48 };
    g.rover.object.visible = !!v.rover;
    if (v.rover) g.rover.placeAt(x + v.rover[0], z + v.rover[1], v.rover[2] ?? 0);
  }, v);
  // Let terrain chunks, rocks and shadows settle around the new viewpoint.
  await page.waitForFunction(() => window.game.isReady(), null, { timeout: 60000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const shot = `${out}/${v.name}_game.jpg`;
  await page.screenshot({ path: shot, type: 'jpeg', quality: 88 });
  const ref = `raw_data/ref/${v.ref}.jpg`;
  if (existsSync(ref)) {
    execFileSync('python', ['tools/pair.py', ref, shot, `${out}/${v.name}.jpg`, v.ref, v.note ?? '']);
  }
  console.log('shot', v.name);
}
await browser.close();
