import * as THREE from 'three';
import { lang, t } from '../i18n';
import type { TerrainData } from '../terrain/TerrainData';

/**
 * Real places and hardware of Apollo 15 at their LROC / IAU coordinates
 * (terrain.json "sites"). Photograph one in photo mode (F) from within its radius
 * to open its card: an archive NASA frame taken there and a short fact; found
 * sites go into the journal (saved in localStorage).
 */
export interface Site {
  id: string;
  x: number;
  z: number;
  /** Photograph from within this distance, m. */
  radius: number;
  photo: string;
  frame: string;
}

const PHOTOS: Record<string, { file: string; frame: string; radius: number }> = {
  lm: { file: 'lm.jpg', frame: 'AS15-88-11866', radius: 60 },
  alsep: { file: 'alsep.jpg', frame: 'AS15-87-11847', radius: 50 },
  lrv: { file: 'lrv.jpg', frame: 'AS15-82-11121', radius: 40 },
  elbow: { file: 'elbow.jpg', frame: 'AS15-85-11398…11407 (pan)', radius: 180 },
  stgeorge: { file: 'stgeorge.jpg', frame: 'AS15-85-11451', radius: 1100 },
  spur: { file: 'spur.jpg', frame: 'AS15-90-12227', radius: 120 },
};

const KEY = 'moon-rover-journal';

export class Discoveries {
  readonly sites: Site[] = [];
  found = new Set<string>();
  onFound?: (s: Site) => void;
  private card = document.getElementById('card');

  constructor(terrain: TerrainData) {
    const base = import.meta.env.BASE_URL;
    for (const [id, s] of Object.entries(terrain.meta.sites ?? {})) {
      const p = PHOTOS[id];
      if (!p) continue;
      this.sites.push({ id, x: s.x, z: s.z, radius: p.radius, photo: `${base}photos/${p.file}`, frame: p.frame });
    }
    try {
      const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
      for (const id of v) this.found.add(id);
    } catch {
      /* storage unavailable */
    }
    this.card?.addEventListener('pointerdown', () => this.hideCard());
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.found]));
    } catch {
      /* storage unavailable */
    }
  }

  /** The site the camera is photographing: in range and near the centre of the view. */
  inView(camera: THREE.Camera, exclude?: string): Site | null {
    const p = camera.position;
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    let best: Site | null = null, bestDot = 0.93;
    for (const s of this.sites) {
      if (s.id === exclude) continue;
      const d = new THREE.Vector3(s.x - p.x, 0, s.z - p.z);
      const dist = d.length();
      if (dist > s.radius) continue;
      // Big features (craters) count when looked at from anywhere inside them.
      const dot = dist < 15 ? 1 : d.normalize().dot(new THREE.Vector3(fwd.x, 0, fwd.z).normalize());
      if (dot > bestDot) {
        best = s;
        bestDot = dot;
      }
    }
    return best;
  }

  /** A photograph was taken: discover what is in it. */
  photograph(camera: THREE.Camera, exclude?: string): Site | null {
    const s = this.inView(camera, exclude);
    if (!s) return null;
    const isNew = !this.found.has(s.id);
    this.found.add(s.id);
    this.save();
    this.showCard(s);
    if (isNew) this.onFound?.(s);
    return s;
  }

  showCard(s: Site): void {
    const c = this.card;
    if (!c) return;
    c.innerHTML = '';
    const img = document.createElement('img');
    img.src = s.photo;
    img.alt = s.frame;
    const box = document.createElement('div');
    const h = document.createElement('h3');
    h.textContent = t(`site_${s.id}`);
    const p = document.createElement('p');
    p.textContent = t(`site_${s.id}_fact`);
    const cr = document.createElement('small');
    cr.textContent = `NASA ${s.frame} · ${lang() === 'ru' ? 'общественное достояние' : 'public domain'} · ${t('cardClose')}`;
    box.append(h, p, cr);
    c.append(img, box);
    c.classList.remove('hidden');
  }

  hideCard(): void {
    this.card?.classList.add('hidden');
  }

  /** Journal markup for the menu. */
  renderJournal(el: HTMLElement): void {
    el.innerHTML = '';
    for (const s of this.sites) {
      const on = this.found.has(s.id);
      const row = document.createElement('button');
      row.className = `jrow${on ? ' on' : ''}`;
      const img = document.createElement('img');
      if (on) img.src = s.photo;
      const txt = document.createElement('span');
      txt.innerHTML = `<b>${on ? t(`site_${s.id}`) : '???'}</b><small>${on ? s.frame : t('jHint')}</small>`;
      row.append(img, txt);
      if (on) row.addEventListener('click', () => this.showCard(s));
      el.append(row);
    }
    const n = document.createElement('div');
    n.className = 'jcount';
    n.textContent = `${t('jFound')}: ${this.found.size} / ${this.sites.length}`;
    el.prepend(n);
  }
}
