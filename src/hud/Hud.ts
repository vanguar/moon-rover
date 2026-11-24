import { world } from '../world';
import { t } from '../i18n';
import type { Rover } from '../rover/Rover';
import type { TerrainData } from '../terrain/TerrainData';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Cockpit instrument panel (HTML/canvas overlay). */
export class Hud {
  private att: HTMLCanvasElement;
  private hdg: HTMLCanvasElement;
  private map: HTMLCanvasElement;
  private els = {
    speed: $('#h-speed'),
    alt: $('#h-alt'),
    slope: $('#h-slope'),
    odo: $('#h-odo'),
    hdgVal: $('#h-hdg'),
    batt: $('#h-batt'),
    battBar: $('#h-batt-bar'),
    power: $('#h-power'),
    solar: $('#h-solar'),
    roll: $('#h-roll'),
    pitch: $('#h-pitch'),
    warn: $('#h-warn'),
    lights: $('#h-lights'),
    fps: $('#h-fps'),
    coords: $('#h-coords'),
  };
  private trail: number[] = [];
  private lastTrail = { x: Infinity, z: Infinity };
  private mapTimer = 0;
  private mapImg: CanvasImageSource | null = null;
  private slopeN = [0, 1, 0];
  warningLevel = 0; // 0 none, 1 caution, 2 danger
  atBase = false;
  /** Current mission target and the mission sites (found ones are ticked). */
  target: { x: number; z: number } | null = null;
  sites: { x: number; z: number; found: boolean }[] = [];
  private wasLit = true;
  private shadowFlash = 0;

  private elec = document.getElementById('h-elec');
  private range = document.getElementById('h-range');

  constructor(private terrain: TerrainData) {
    this.att = $('#h-att');
    this.hdg = $('#h-hdgtape');
    this.map = $('#h-map');
  }

  /** Mars weather for warnings and the minimap (null on the Moon). */
  weather: { wind: number; tau: number; storm: number; devilDist: number; devils: { x: number; z: number; r: number; s: number }[] } | null = null;
  /** Label of the landing-site marker on the minimap. */
  siteLabel = 'LM';

  setMapImage(img: CanvasImageSource): void {
    // Pre-scale the ortho to a small canvas for cheap minimap drawing.
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    c.getContext('2d')!.drawImage(img, 0, 0, 1024, 1024);
    this.mapImg = c;
  }

  update(dt: number, rover: Rover, fps: number): void {
    const p = rover.object.position;
    const { roll, pitch, heading } = rover.attitude();
    const ter = this.terrain;
    const e = this.els;

    e.speed.textContent = (Math.abs(rover.speed) * 3.6).toFixed(1);
    const altAbs = p.y + ter.meta.minHeight;
    e.alt.textContent = `${altAbs.toFixed(0)}`;
    ter.normal(p.x, p.z, this.slopeN, 1.5);
    const slope = (Math.acos(Math.min(1, this.slopeN[1])) * 180) / Math.PI;
    e.slope.textContent = slope.toFixed(1);
    e.odo.textContent = (rover.odometer / 1000).toFixed(2);
    e.hdgVal.textContent = `${Math.round(heading).toString().padStart(3, '0')}°`;
    const pct = rover.battery * 100;
    e.batt.textContent = pct.toFixed(pct < 10 ? 1 : 0);
    e.battBar.style.width = `${pct}%`;
    e.battBar.style.background = pct < 15 ? '#ff4b3e' : pct < 35 ? '#ffb020' : '#58d68d';
    e.power.textContent = Math.round(rover.power + rover.solar).toString();
    e.solar.textContent = Math.round(rover.solar).toString();
    if (this.elec) this.elec.textContent = rover.elecTemp.toFixed(0);
    if (this.range) this.range.textContent = rover.rangeKm.toFixed(1);
    e.roll.textContent = `${roll.toFixed(0)}°`;
    e.pitch.textContent = `${pitch.toFixed(0)}°`;
    e.lights.classList.toggle('on', rover.headlights);
    e.fps.textContent = fps.toFixed(0);
    const Rb = world().radius;
    const lat = ter.meta.centerLat - (p.z / Rb) * (180 / Math.PI);
    const lon = ter.meta.centerLon + (p.x / (Rb * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    e.coords.textContent = `${lat.toFixed(4)}°N ${lon.toFixed(4)}°E`;

    // Warnings.
    const warns: string[] = [];
    let level = 0;
    if (Math.abs(roll) > 30) { warns.push(`${t('wRoll')} ${Math.abs(roll).toFixed(0)}°`); level = 2; }
    else if (Math.abs(roll) > 22) { warns.push(t('wRoll')); level = Math.max(level, 1); }
    if (Math.abs(pitch) > 30) { warns.push(`${t('wPitch')} ${Math.abs(pitch).toFixed(0)}°`); level = 2; }
    // Entering shadow: flash the warning; while in shadow keep a caution.
    if (rover.sunLit < 0.5 && this.wasLit) this.shadowFlash = 4;
    this.wasLit = rover.sunLit >= 0.5;
    this.shadowFlash = Math.max(0, this.shadowFlash - dt);
    if (rover.sunLit < 0.5) { warns.push(t('wShadow')); level = Math.max(level, this.shadowFlash > 0 ? 2 : 1); }
    if (rover.heater) { warns.push(`${t('wCold')} ${rover.elecTemp.toFixed(0)}°C`); level = Math.max(level, 1); }
    if (rover.elecTemp > 85) { warns.push(`${t('wHot')} ${rover.elecTemp.toFixed(0)}°C`); level = Math.max(level, 1); }
    if (this.atBase) warns.push(t('wBase'));
    if (rover.battery <= 0) { warns.push(t('wBattEmpty')); level = 2; }
    else if (rover.battery < 0.15) { warns.push(t('wBattLow')); level = Math.max(level, 1); }
    if (!ter.inside(p.x, p.z)) { warns.push(t('wOutside')); level = Math.max(level, 1); }
    if (Math.abs(roll) > 100) warns.push(t('wReset'));
    if (rover.parkBrake && rover.motorLoadFactor === 0 && Math.abs(rover.speed) < 0.05) warns.push(t('wPark'));
    const wx = this.weather;
    if (wx) {
      if (wx.storm > 0.5) { warns.push(`${t('wStorm')} τ ${wx.tau.toFixed(1)} · ${wx.wind.toFixed(0)} ${t('hMs')}`); level = Math.max(level, 1); }
      if (wx.devilDist < 150) { warns.push(`${t('wDevil')} ${Math.max(0, wx.devilDist).toFixed(0)} ${t('hM')}`); level = Math.max(level, 1); }
      if (rover.panelDust > 0.3) warns.push(`${t('wPanelDust')} ${(rover.panelDust * 100).toFixed(0)} %`);
    }
    this.warningLevel = level;
    e.warn.textContent = warns.join(' · ');
    e.warn.className = level === 2 ? 'danger' : level === 1 ? 'caution' : '';

    this.drawAttitude(roll, pitch);
    this.drawHeading(heading);

    if (Math.hypot(p.x - this.lastTrail.x, p.z - this.lastTrail.z) > 4) {
      this.trail.push(p.x, p.z);
      if (this.trail.length > 8000) this.trail.splice(0, 2);
      this.lastTrail = { x: p.x, z: p.z };
    }
    this.mapTimer -= dt;
    if (this.mapTimer <= 0) {
      this.mapTimer = 0.1;
      this.drawMap(p.x, p.z, heading);
    }
  }

  private fit(c: HTMLCanvasElement): CanvasRenderingContext2D {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  private drawAttitude(roll: number, pitch: number): void {
    const c = this.att;
    if (!c.clientWidth) return;
    const g = this.fit(c);
    const w = c.clientWidth, h = c.clientHeight, r = Math.min(w, h) / 2 - 2;
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(w / 2, h / 2);
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.clip();
    g.rotate((-roll * Math.PI) / 180);
    const ppd = r / 35; // pixels per degree of pitch
    const off = pitch * ppd;
    g.fillStyle = '#1d3b5c';
    g.fillRect(-2 * r, -2 * r + off, 4 * r, 2 * r);
    g.fillStyle = '#5a4630';
    g.fillRect(-2 * r, off, 4 * r, 2 * r);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-2 * r, off);
    g.lineTo(2 * r, off);
    g.stroke();
    g.font = `${Math.max(8, r * 0.16)}px monospace`;
    g.fillStyle = '#fff';
    g.textAlign = 'left';
    for (let d = -30; d <= 30; d += 10) {
      if (!d) continue;
      const y = off - d * ppd;
      g.beginPath();
      g.moveTo(-r * 0.25, y);
      g.lineTo(r * 0.25, y);
      g.stroke();
      g.fillText(String(Math.abs(d)), r * 0.3, y + 3);
    }
    g.restore();
    // Fixed aircraft symbol & roll scale.
    g.save();
    g.translate(w / 2, h / 2);
    g.strokeStyle = '#ffcc33';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(-r * 0.55, 0);
    g.lineTo(-r * 0.18, 0);
    g.lineTo(-r * 0.1, r * 0.08);
    g.moveTo(r * 0.55, 0);
    g.lineTo(r * 0.18, 0);
    g.lineTo(r * 0.1, r * 0.08);
    g.stroke();
    g.strokeStyle = Math.abs(roll) > 30 ? '#ff4b3e' : '#ddd';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(0, 0, r - 1, 0, Math.PI * 2);
    g.stroke();
    for (const d of [-60, -30, -20, -10, 0, 10, 20, 30, 60]) {
      const a = ((d - 90) * Math.PI) / 180;
      const l = d % 30 === 0 ? 0.14 : 0.08;
      g.strokeStyle = Math.abs(d) === 30 ? '#ff4b3e' : '#ddd';
      g.beginPath();
      g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      g.lineTo(Math.cos(a) * r * (1 - l), Math.sin(a) * r * (1 - l));
      g.stroke();
    }
    // Roll pointer.
    g.rotate((-roll * Math.PI) / 180);
    g.fillStyle = '#ffcc33';
    g.beginPath();
    g.moveTo(0, -r * 0.84);
    g.lineTo(-r * 0.06, -r * 0.72);
    g.lineTo(r * 0.06, -r * 0.72);
    g.fill();
    g.restore();
  }

  private drawHeading(heading: number): void {
    const c = this.hdg;
    if (!c.clientWidth) return;
    const g = this.fit(c);
    const w = c.clientWidth, h = c.clientHeight;
    g.clearRect(0, 0, w, h);
    const ppd = w / 90;
    g.strokeStyle = '#cfd8dc';
    g.fillStyle = '#cfd8dc';
    g.font = `${Math.max(9, h * 0.38)}px monospace`;
    g.textAlign = 'center';
    g.lineWidth = 1;
    const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let d = Math.floor(heading - 50); d <= heading + 50; d++) {
      if (d % 5) continue;
      const x = w / 2 + (d - heading) * ppd;
      const dd = ((d % 360) + 360) % 360;
      g.beginPath();
      g.moveTo(x, h);
      g.lineTo(x, h - (dd % 10 === 0 ? h * 0.35 : h * 0.18));
      g.stroke();
      if (dd % 30 === 0) g.fillText(names[dd] ?? String(dd / 10), x, h * 0.42);
    }
    g.fillStyle = '#ffcc33';
    g.beginPath();
    g.moveTo(w / 2, h * 0.5);
    g.lineTo(w / 2 - 5, h);
    g.lineTo(w / 2 + 5, h);
    g.fill();
  }

  private drawMap(x: number, z: number, heading: number): void {
    const c = this.map;
    if (!c.clientWidth) return;
    const g = this.fit(c);
    const w = c.clientWidth, h = c.clientHeight;
    const t = this.terrain;
    const span = 900; // metres across
    const s = w / span;
    g.fillStyle = '#111';
    g.fillRect(0, 0, w, h);
    if (this.mapImg) {
      // Map image covers the DTM window; px per metre at 1024 px / sizeX.
      const k = 1024 / t.meta.sizeX;
      const sx = (x - span / 2 + t.halfX) * k, sz = (z - span / 2 * (h / w) + t.halfZ) * k;
      g.globalAlpha = 0.9;
      g.drawImage(this.mapImg, sx, sz, span * k, span * (h / w) * k, 0, 0, w, h);
      g.globalAlpha = 1;
    }
    const toX = (wx: number) => w / 2 + (wx - x) * s;
    const toY = (wz: number) => h / 2 + (wz - z) * s;
    // DTM boundary.
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.strokeRect(toX(-t.halfX), toY(-t.halfZ), t.meta.sizeX * s, t.meta.sizeZ * s);
    // Landing site (LM Falcon).
    const lx = toX(t.meta.landing.x), lz = toY(t.meta.landing.z);
    g.fillStyle = '#ffcc33';
    g.font = '10px sans-serif';
    g.fillText(this.siteLabel, lx + 5, lz + 3);
    g.fillRect(lx - 2, lz - 2, 4, 4);
    // Mission sites: found = filled, not yet = ring.
    for (const st of this.sites) {
      g.strokeStyle = g.fillStyle = st.found ? 'rgba(120,230,140,0.95)' : 'rgba(255,255,255,0.7)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(toX(st.x), toY(st.z), 3.5, 0, Math.PI * 2);
      if (st.found) g.fill();
      else g.stroke();
    }
    // Current target: pulsing ring, or an edge arrow when it is off the map.
    if (this.target) {
      const tx = toX(this.target.x), ty = toY(this.target.z);
      const pulse = 5 + 2 * Math.sin(performance.now() / 250);
      g.strokeStyle = '#ffc46b';
      g.lineWidth = 2;
      if (tx > 6 && tx < w - 6 && ty > 6 && ty < h - 6) {
        g.beginPath();
        g.arc(tx, ty, pulse, 0, Math.PI * 2);
        g.stroke();
      } else {
        const a = Math.atan2(ty - h / 2, tx - w / 2);
        const r = Math.min(w, h) / 2 - 8;
        const ex = w / 2 + Math.cos(a) * r, ey = h / 2 + Math.sin(a) * r;
        g.save();
        g.translate(ex, ey);
        g.rotate(a);
        g.fillStyle = '#ffc46b';
        g.beginPath();
        g.moveTo(7, 0);
        g.lineTo(-4, -5);
        g.lineTo(-4, 5);
        g.fill();
        g.restore();
      }
    }
    // Dust devils.
    if (this.weather) {
      for (const d of this.weather.devils) {
        if (d.s < 0.1) continue;
        g.strokeStyle = `rgba(255,190,120,${0.4 + 0.5 * d.s})`;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(toX(d.x), toY(d.z), Math.max(3, d.r * s), 0, Math.PI * 2);
        g.stroke();
      }
    }
    // Trail.
    if (this.trail.length >= 4) {
      g.strokeStyle = '#4fc3f7';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(toX(this.trail[0]), toY(this.trail[1]));
      for (let i = 2; i < this.trail.length; i += 2) g.lineTo(toX(this.trail[i]), toY(this.trail[i + 1]));
      g.lineTo(w / 2, h / 2);
      g.stroke();
    }
    // Rover arrow.
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate((heading * Math.PI) / 180);
    g.fillStyle = '#ff5252';
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(5, 6);
    g.lineTo(0, 3);
    g.lineTo(-5, 6);
    g.fill();
    g.restore();
    g.fillStyle = '#fff';
    g.font = 'bold 10px sans-serif';
    g.fillText('N', w - 12, 12);
  }
}
