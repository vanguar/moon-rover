import * as THREE from 'three';
import { isMobile } from '../config';
import { t } from '../i18n';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * Missions: what the player is doing, step by step. Each step has a briefing text,
 * an optional target on the ground (bearing and distance shown on screen) and a
 * completion test. Progress is saved per mission in localStorage.
 */
export interface MissionCtx {
  roverPos: THREE.Vector3;
  odometer: number;
  found: Set<string>;
  atBase: boolean;
  heli: { agl: number; phase: string; pos: THREE.Vector3; pad: THREE.Vector3; flights: number; maxDist: number } | null;
}

interface Step {
  key: string;
  target?: () => { x: number; z: number } | null;
  /** Arrival radius for steps that are done by reaching the target. */
  reach?: number;
  done: (c: MissionCtx) => boolean;
}

export type MissionKind = 'moon' | 'moon17' | 'mars' | 'pavonis' | 'pavonisHeli' | 'gale' | 'heli';

export class Missions {
  readonly id: string;
  private steps: Step[];
  index = 0;
  private panel = document.getElementById('mission');
  private arrow: HTMLElement | null = null;
  private text: HTMLElement | null = null;
  /** How to do the current step (keys, where to look) - a line under the task. */
  private hint: HTMLElement | null = null;
  private dist: HTMLElement | null = null;
  private nav = document.getElementById('navarrow');
  private navText = this.nav?.querySelector('span') ?? null;
  onStep?: (key: string, finished: boolean) => void;

  constructor(terrain: TerrainData, kind: MissionKind) {
    this.id = `mission-${kind}`;
    const s = terrain.meta.sites ?? {};
    const site = (k: string) => () => (s[k] ? { x: s[k].x, z: s[k].z } : null);
    const L = terrain.meta.landing;
    if (kind === 'moon') {
      this.steps = [
        { key: 'm_drive', done: (c) => c.odometer > 25 },
        { key: 'm_lrv', target: site('lrv'), done: (c) => c.found.has('lrv') },
        { key: 'm_alsep', target: site('alsep'), done: (c) => c.found.has('alsep') },
        { key: 'm_lm', target: site('lm'), done: (c) => c.found.has('lm') },
        { key: 'm_elbow', target: site('elbow'), done: (c) => c.found.has('elbow') },
        { key: 'm_spur', target: site('spur'), done: (c) => c.found.has('spur') },
        { key: 'm_stgeorge', target: site('stgeorge'), done: (c) => c.found.has('stgeorge') },
        { key: 'm_rille', target: site('rille'), done: (c) => c.found.has('rille') },
        { key: 'm_home', target: () => ({ x: L.x, z: L.z }), done: (c) => c.atBase },
      ];
    } else if (kind === 'moon17') {
      // Taurus-Littrow: the LM site, then the geology stations in the order of the real
      // EVA-2 (South Massif and back: 2, 4, 5) and EVA-3 (North Massif: 6, then 9).
      this.steps = [
        { key: 'm_drive', done: (c) => c.odometer > 25 },
        ...['lrv', 'alsep', 'flag', 'lm', 'st2', 'st4', 'st5', 'st6', 'st9'].map((id) => ({
          key: `m17_${id}`, target: site(id), done: (c: MissionCtx) => c.found.has(id),
        })),
        { key: 'm_home', target: () => ({ x: L.x, z: L.z }), done: (c) => c.atBase },
      ];
    } else if (kind === 'pavonis') {
      // Pavonis Mons: drive to the lip of the collapse pit (~95 m radius), photograph it.
      this.steps = [
        { key: 'r_drive', done: (c) => c.odometer > 30 },
        { key: 'p_rim', target: site('pit'), reach: 125, done: () => false },
        { key: 'p_photo', target: site('pit'), done: (c) => c.found.has('pit') },
        // Then Ingenuity (E): its own mission takes over, down into the opening.
        // Nothing to drive to: E works anywhere; the arrow shows the pit Ingenuity will fly into.
        { key: 'p_heli', target: site('cave'), done: () => false },
      ];
    } else if (kind === 'gale') {
      // Gale: across the clay-bearing trough of Glen Torridon to a layered butte of the
      // sulfate unit at the foot of Mount Sharp, and its layers photographed.
      this.steps = [
        { key: 'r_drive', done: (c) => c.odometer > 30 },
        { key: 'g_trough', target: site('trough'), reach: 40, done: () => false },
        { key: 'g_butte', target: site('butte'), reach: 150, done: () => false },
        { key: 'g_photo', target: site('butte'), done: (c) => c.found.has('butte') },
      ];
    } else if (kind === 'pavonisHeli') {
      // Ingenuity down through the skylight: over the opening, below its rim, then a
      // photograph of the debris pile inside.
      const cave = (terrain.meta as { cave?: { rimY: number } }).cave;
      const rim = cave ? cave.rimY : 0;
      this.steps = [
        { key: 'h_hover', done: (c) => !!c.heli && c.heli.agl > 2.5 },
        { key: 'ph_hole', target: site('cave'), reach: 12, done: () => false },
        { key: 'ph_down', target: site('cave'), done: (c) => !!c.heli && c.heli.pos.y < rim - 8 },
        { key: 'ph_photo', target: site('cave'), done: (c) => c.found.has('cave') },
        // Deep in the tube something lies on the floor...
        { key: 'ph_bones', target: site('bones'), done: (c) => c.found.has('bones') },
        // And home: out through the opening, landed by the rover (the arrow points at it).
        { key: 'ph_home', target: () => this.home, done: (c) => !!c.heli && c.heli.agl < 0.5 && Math.hypot(c.heli.pos.x - c.heli.pad.x, c.heli.pos.z - c.heli.pad.z) < 12 },
      ];
    } else if (kind === 'mars') {
      // Octavia E. Butler Landing; the delta front ~2 km to the west-northwest (Kodiak and
      // the scarp the rover reached in 2022), in the game window's coordinates.
      this.steps = [
        { key: 'r_drive', done: (c) => c.odometer > 30 },
        { key: 'r_field', target: () => ({ x: L.x + 14, z: L.z - 4 }), reach: 12, done: () => false },
        { key: 'r_delta', target: () => ({ x: L.x - 1900, z: L.z - 450 }), reach: 80, done: () => false },
        { key: 'r_home', target: () => ({ x: L.x, z: L.z }), reach: 25, done: () => false },
        // Second campaign: the real places of Perseverance's first year.
        { key: 'r_landing', target: site('landing'), done: (c) => c.found.has('landing') },
        { key: 'r_rochette', target: site('rochette'), done: (c) => c.found.has('rochette') },
        { key: 'r_kodiak', target: site('kodiak'), done: (c) => c.found.has('kodiak') },
        { key: 'r_scarp', target: site('scarp'), done: (c) => c.found.has('scarp') },
      ];
    } else {
      this.steps = [
        { key: 'h_hover', done: (c) => !!c.heli && c.heli.agl > 2.5 },
        { key: 'h_out', done: (c) => !!c.heli && c.heli.maxDist > 30 },
        { key: 'h_land', done: (c) => !!c.heli && c.heli.phase === 'landed' && c.heli.pos.distanceTo(c.heli.pad) < 4 },
        { key: 'h_auto', done: (c) => !!c.heli && c.heli.flights >= 2 && c.heli.phase === 'landed' },
      ];
    }
    try {
      this.index = Math.min(this.steps.length, Number(localStorage.getItem(this.id) ?? 0) || 0);
    } catch {
      this.index = 0;
    }
    this.buildPanel();
  }

  get finished(): boolean {
    return this.index >= this.steps.length;
  }

  get stepKey(): string {
    return this.finished ? `${this.id}_done` : this.steps[this.index].key;
  }

  /** Step text; phones get the touch-control wording where it differs. */
  private text_(key: string): string {
    if (isMobile) {
      const tk = t(`${key}_touch`);
      if (tk !== `${key}_touch`) return tk;
    }
    return t(key);
  }

  reset(): void {
    this.index = 0;
    this.save();
    this.render();
  }

  private save(): void {
    try {
      localStorage.setItem(this.id, String(this.index));
    } catch {
      /* storage unavailable */
    }
  }

  private buildPanel(): void {
    const p = this.panel;
    if (!p) return;
    p.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'mh';
    this.text = document.createElement('div');
    this.text.className = 'mt';
    this.hint = document.createElement('div');
    this.hint.className = 'mhint';
    const row = document.createElement('div');
    row.className = 'md';
    this.arrow = document.createElement('i');
    this.arrow.className = 'marrow';
    this.dist = document.createElement('span');
    row.append(this.arrow, this.dist);
    p.append(head, this.text, this.hint, row);
    this.render();
  }

  /** Re-render texts (step change, language change). */
  render(): void {
    if (!this.panel || !this.text) return;
    const head = this.panel.querySelector('.mh')!;
    head.textContent = `${t(`${this.id}_title`)} · ${Math.min(this.index + 1, this.steps.length)}/${this.steps.length}`;
    this.text.textContent = this.text_(this.stepKey);
    if (this.hint) {
      // Optional "<step>_hint" (and "<step>_hint_touch" on phones).
      const hk = `${this.stepKey}_hint`, h = this.text_(hk);
      this.hint.textContent = h === hk ? '' : h;
      this.hint.style.display = h === hk ? 'none' : '';
    }
  }

  /** Full briefing text for the overlay (mission goal + all steps with ticks). */
  briefing(): { title: string; intro: string; steps: { text: string; done: boolean; current: boolean }[] } {
    return {
      title: t(`${this.id}_title`),
      intro: t(`${this.id}_intro`),
      steps: this.steps.map((s, i) => ({ text: this.text_(s.key), done: i < this.index, current: i === this.index })),
    };
  }

  /** The helicopter's pad by the rover (for the way home). */
  private home: { x: number; z: number } | null = null;

  update(c: MissionCtx, cameraHeadingDeg: number): void {
    if (c.heli) this.home = { x: c.heli.pad.x, z: c.heli.pad.z };
    if (!this.finished) {
      const s = this.steps[this.index];
      const tg = s.target?.() ?? null;
      let ok = s.done(c);
      if (!ok && tg && s.reach !== undefined) ok = Math.hypot(tg.x - c.roverPos.x, tg.z - c.roverPos.z) < s.reach;
      if (ok) {
        this.index++;
        this.save();
        this.render();
        this.onStep?.(this.stepKey, this.finished);
      }
    }
    // Direction to the current target, relative to where the camera looks.
    const s = this.finished ? null : this.steps[this.index];
    const tg = s?.target?.() ?? null;
    if (!this.arrow || !this.dist) return;
    if (!tg) {
      this.arrow.style.visibility = 'hidden';
      this.dist.textContent = '';
      this.nav?.classList.add('off');
      return;
    }
    const dx = tg.x - c.roverPos.x, dz = tg.z - c.roverPos.z;
    const d = Math.hypot(dx, dz);
    let brg = (Math.atan2(dx, -dz) * 180) / Math.PI;
    if (brg < 0) brg += 360;
    this.arrow.style.visibility = 'visible';
    this.arrow.style.transform = `rotate(${brg - cameraHeadingDeg}deg)`;
    // Big translucent chevron on the road ahead, as in a car navigator.
    if (this.nav && this.navText) {
      const rel = ((brg - cameraHeadingDeg + 540) % 360) - 180;
      this.nav.classList.toggle('off', false);
      this.nav.style.setProperty('--rot', `${rel}deg`);
      this.nav.classList.toggle('near', d < 60);
      this.navText.textContent = d < 1000 ? `${d.toFixed(0)} ${t('hM')}` : `${(d / 1000).toFixed(1)} ${t('hKm')}`;
    }
    this.dist.textContent = `${d < 1000 ? `${d.toFixed(0)} ${t('hM')}` : `${(d / 1000).toFixed(2)} ${t('hKm')}`} · ${Math.round(brg).toString().padStart(3, '0')}°`;
  }

  /** Target of the current step (for the minimap). */
  target(): { x: number; z: number } | null {
    return this.finished ? null : (this.steps[this.index].target?.() ?? null);
  }
}
