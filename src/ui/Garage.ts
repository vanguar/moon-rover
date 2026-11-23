import { t } from '../i18n';
import { roversFor, type RoverId, type RoverSpec } from '../rover/specs';
import type { WorldId } from '../world';
import { PhotoFx } from './PhotoFx';
import { RoverPreview } from './RoverPreview';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

/**
 * Rover selection on the title screen: the world switch (Moon / Mars), a rail
 * of cards with living photographs, and the detail view — the animated photo
 * or the 3D model with its moving parts — with the rover's real specs.
 */
export class Garage {
  private cards = new Map<RoverId, { el: HTMLButtonElement; fx: PhotoFx }>();
  private bigFx = new Map<RoverId, PhotoFx>();
  private preview = new RoverPreview();
  private view: 'photo' | '3d' = 'photo';
  private raf = 0;
  private running = false;
  private hover: RoverId | null = null;
  private frame = 0;
  selected: RoverSpec;

  constructor(
    private world: WorldId,
    selected: RoverId,
    private onSelect: (s: RoverSpec) => void,
    private onWorld: (w: WorldId) => void,
  ) {
    const list = roversFor(world);
    this.selected = list.find((r) => r.id === selected) ?? list[0];
    const base = import.meta.env.BASE_URL;
    const rail = $('#rail');
    rail.innerHTML = '';
    rail.classList.toggle('three', list.length === 3);
    for (const spec of list) {
      const el = document.createElement('button');
      el.className = 'rcard';
      el.dataset.id = spec.id;
      const ph = document.createElement('div');
      ph.className = 'rc-ph';
      const fx = new PhotoFx(`${base}rovers/${spec.photo.file}`, spec.photo.parts, world, 320, 200);
      ph.appendChild(fx.canvas);
      const txt = document.createElement('div');
      txt.className = 'rc-txt';
      txt.innerHTML = '<b></b><small></small>';
      el.append(ph, txt);
      el.addEventListener('click', () => this.select(spec));
      el.addEventListener('pointerenter', () => { this.hover = spec.id; fx.replay(); });
      el.addEventListener('pointerleave', () => { if (this.hover === spec.id) this.hover = null; });
      rail.appendChild(el);
      this.cards.set(spec.id, { el, fx });
    }
    $('#d-3d').appendChild(this.preview.canvas);
    document.querySelectorAll<HTMLButtonElement>('.vtab').forEach((b) =>
      b.addEventListener('click', () => this.setView(b.dataset.v as 'photo' | '3d')),
    );
    if (!this.preview.available) document.querySelector<HTMLElement>('.vtab[data-v="3d"]')!.style.display = 'none';
    document.querySelectorAll<HTMLButtonElement>('.world').forEach((b) => {
      b.classList.toggle('on', b.dataset.world === world);
      b.addEventListener('click', () => {
        if (b.dataset.world !== this.world) this.onWorld(b.dataset.world as WorldId);
      });
    });
    this.select(this.selected, true);
  }

  private setView(v: 'photo' | '3d'): void {
    this.view = v;
    document.querySelectorAll<HTMLElement>('.vtab').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    $('#d-photo').classList.toggle('on', v === 'photo');
    $('#d-3d').classList.toggle('on', v === '3d');
    if (v === 'photo') this.bigFx.get(this.selected.id)?.replay();
  }

  select(spec: RoverSpec, initial = false): void {
    const changed = spec !== this.selected || initial;
    this.selected = spec;
    for (const [id, c] of this.cards) c.el.classList.toggle('on', id === spec.id);
    let fx = this.bigFx.get(spec.id);
    if (!fx) {
      fx = new PhotoFx(`${import.meta.env.BASE_URL}rovers/${spec.photo.file}`, spec.photo.parts, this.world, 960, 600);
      this.bigFx.set(spec.id, fx);
    }
    const host = $('#d-photo');
    host.innerHTML = '';
    host.appendChild(fx.canvas);
    fx.active = true;
    fx.replay();
    this.preview.setRover(spec, this.world);
    this.updateTexts();
    if (changed && !initial) this.onSelect(spec);
  }

  /** (Re)write all language-dependent text. */
  updateTexts(): void {
    for (const [id, c] of this.cards) {
      c.el.querySelector('b')!.textContent = t(`r_${id}`);
      const spec = roversFor(this.world).find((r) => r.id === id)!;
      c.el.querySelector('small')!.textContent = `${t(`c_${spec.country}`)} · ${spec.year}`;
    }
    const s = this.selected;
    $('#d-name').textContent = t(`r_${s.id}`);
    $('#d-meta').textContent = `${t(`c_${s.country}`)} · ${s.year}`;
    $('#d-desc').textContent = t(`r_${s.id}_desc`);
    const num = (v: number, d = 0) => v.toLocaleString(document.documentElement.lang, { maximumFractionDigits: d });
    const rows: [string, string][] = [
      [t('sMass'), `${num(s.real.massKg, 1)} ${t('uKg')}`],
      [t('sLength'), `${num(s.real.lengthM, 2)} ${t('hM')}`],
      [t('sWheels'), `${s.real.wheels}${s.skid ? ` · ${t('sSkid')}` : ''}`],
      [t('sPower'), t(`r_${s.id}_power`)],
      [t('sRealSpeed'), `${num(s.real.speedKmh, s.real.speedKmh < 1 ? 3 : 0)} ${t('hKmh')}`],
      [t('sGameSpeed'), `${num(s.maxSpeed * 3.6, 0)} ${t('hKmh')}`],
      [t('sDistance'), s.real.distanceKm !== undefined ? `${num(s.real.distanceKm, 1)} ${t('hKm')}` : t('sActive')],
      [t('sView'), t(s.crew ? 'sViewCrew' : 'sViewCam')],
    ];
    const dl = $('#d-specs');
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
    const cr = $('#d-credit');
    cr.innerHTML = '';
    const a = document.createElement('a');
    a.href = s.photo.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${t('photo')}: ${s.photo.credit} · ${s.photo.license}`;
    cr.appendChild(a);
    $('#v-tag').textContent = `${t('archive')} · ${s.id.toUpperCase()}-${s.year}`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame++;
      const big = this.bigFx.get(this.selected.id);
      if (this.view === 'photo') big?.draw(now);
      else this.preview.render(now);
      // Rail cards: the hovered/selected card animates fully; the others tick slowly.
      for (const [id, c] of this.cards) {
        const act = id === this.hover || id === this.selected.id;
        c.fx.active = act;
        if (act || this.frame % 4 === 0) c.fx.draw(now);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
