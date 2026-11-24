// Frame-time probe: drives forward for a while and reports frame pacing and hitches.
// Usage: node tools/probe.mjs [url] [seconds]   (dev server must be running)
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/moon-rover/?world=moon';
const secs = Number(process.argv[3] ?? 12);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL ?? 'chrome',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForSelector('#start', { state: 'visible', timeout: 120000 });
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log('GPU:', gpu);
await page.click('#start'); await page.waitForTimeout(600); if (await page.isVisible('#brief')) await page.click('#b-ok');
if (process.env.NODET) await page.evaluate(() => { window.game.detail = null; window.game.terrainR.uniforms.uDetRect.value.w = 0; });
if (process.env.EXP) await page.evaluate((e) => { const g = window.game; if (e === 'hw') g.scene.children.filter((o) => o.isGroup && o !== g.rover.object && o.children.length > 0 && o.position.distanceTo(g.rover.object.position) < 400 && o.position.distanceTo(g.rover.object.position) > 5).forEach((o) => { o.visible = false; }); if (e === 'lit') g.updateEnergy = () => {}; if (e === 'shadow') g.renderer.shadowMap.enabled = false; if (e === 'norover') g.rover.object.visible = false; if (e === 'nosky') g.sky.group.visible = false; if (e === 'nopanel') g.rover.model.panel.group.visible = false; if (e === 'noalpha') g.rover.object.traverse((o) => { if (o.material && (o.material.alphaMap || o.material.alphaTest)) o.visible = false; }); if (e === 'nocast') g.rover.object.traverse((o) => { o.castShadow = false; }); }, process.env.EXP);
if (process.env.TS) await page.evaluate((s) => { window.game.timeScale = Number(s); }, process.env.TS);
await page.waitForTimeout(1500);
await page.evaluate(() => {
  const w = window;
  w.__ft = [];
  let last = performance.now();
  const tick = (t) => { w.__ft.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
await page.keyboard.down('KeyW');
await page.waitForTimeout(secs * 1000);
await page.keyboard.up('KeyW');
const r = await page.evaluate(() => {
  const ft = window.__ft.slice(5);
  const s = [...ft].sort((a, b) => a - b);
  const g = window.game;
  return {
    frames: ft.length, mean: ft.reduce((a, b) => a + b, 0) / ft.length,
    p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], p99: s[Math.floor(s.length * 0.99)], max: s[s.length - 1],
    hitches: ft.filter((x) => x > 50).length, stats: g.stats, speed: g.rover.speed,
  };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: process.env.SHOT ?? 'probe.png' });
await browser.close();
