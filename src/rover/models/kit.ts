import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { InstrumentPanel } from '../InstrumentPanel';

/** Per-frame state the models animate from (mast, arms, suspension links, solar wings). */
export interface RoverAnimState {
  dt: number;
  time: number;
  /** Signed ground speed, m/s. */
  speed: number;
  /** Steering angle of the front wheels, rad. */
  steer: number;
  /** Camera look offset in the mast/cab view, rad. */
  lookYaw: number;
  lookPitch: number;
  /** Stationary with brakes on (deploy instruments, open lids). */
  parked: boolean;
  /** Wheel centres in the chassis frame (from physics or the rest pose). */
  wheelLocal: THREE.Vector3[];
  /** Turntable preview in the menu: show off all moving parts. */
  preview: boolean;
}

export interface WheelVisual {
  steer: THREE.Group;
  spin: THREE.Group;
  /** LRV wire-mesh tyre deformation uniforms (only the LRV has them). */
  uniforms?: { uCenter: { value: THREE.Vector3 }; uDown: { value: THREE.Vector3 }; uDefl: { value: number } };
  blurMat?: THREE.MeshBasicMaterial;
  chevronMat?: THREE.MeshStandardMaterial;
}

export interface RoverModel {
  root: THREE.Group;
  wheels: WheelVisual[];
  /** Eye point: the driver's seat or the mast camera. */
  cockpitAnchor: THREE.Object3D;
  lights: THREE.SpotLight[];
  panel?: InstrumentPanel;
  setHeadlights(on: boolean): void;
  setSteering(a: number): void;
  animate(s: RoverAnimState): void;
}

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

/** Common spacecraft materials (PBR; metals reflect the scene environment). */
export function materials() {
  const m = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  return {
    alu: m({ color: 0xb9bdc1, metalness: 0.9, roughness: 0.35 }),
    anod: m({ color: 0x6e7378, metalness: 0.7, roughness: 0.45 }),
    darkAnod: m({ color: 0x2c2f33, metalness: 0.6, roughness: 0.5 }),
    gold: m({ color: 0xe0a94a, metalness: 1, roughness: 0.2 }),
    goldFoil: m({ color: 0xd8a040, metalness: 1, roughness: 0.38 }),
    mylar: m({ color: 0xf2f2f4, metalness: 1, roughness: 0.1 }),
    white: m({ color: 0xe9e7e2, metalness: 0, roughness: 0.55 }),
    cream: m({ color: 0xd9d2c2, metalness: 0.1, roughness: 0.6 }),
    mirror: m({ color: 0xffffff, metalness: 1, roughness: 0.03 }),
    black: m({ color: 0x141516, metalness: 0.2, roughness: 0.7 }),
    lens: m({ color: 0x0c1218, metalness: 0.4, roughness: 0.04 }),
    titanium: m({ color: 0x8d8f93, metalness: 0.85, roughness: 0.4 }),
    copper: m({ color: 0xb87333, metalness: 1, roughness: 0.3 }),
    red: m({ color: 0xa8322a, roughness: 0.6 }),
  };
}
export type Mats = ReturnType<typeof materials>;

/** Photovoltaic panel texture: cells in a grid with bus bars. */
export function solarTexture(cellsX: number, cellsY: number, base: string, line: string): THREE.CanvasTexture {
  const t = canvasTex(256, 256, (g) => {
    g.fillStyle = line;
    g.fillRect(0, 0, 256, 256);
    const cw = 256 / cellsX, ch = 256 / cellsY;
    for (let j = 0; j < cellsY; j++)
      for (let i = 0; i < cellsX; i++) {
        const sh = 0.85 + ((i * 7 + j * 13) % 5) * 0.04;
        g.fillStyle = base;
        g.globalAlpha = sh;
        g.fillRect(i * cw + 1, j * ch + 1, cw - 2, ch - 2);
        g.globalAlpha = 0.35;
        g.fillStyle = '#c8d4e8';
        g.fillRect(i * cw + 1, j * ch + ch * 0.5, cw - 2, 1);
      }
    g.globalAlpha = 1;
  });
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function solarMaterial(cellsX: number, cellsY: number, base = '#1b2a55', line = '#8c96a8'): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: solarTexture(cellsX, cellsY, base, line), metalness: 0.55, roughness: 0.22 });
}

/** Builder bound to a parent: mesh placement and tubes between two points. */
export class Kit {
  constructor(public parent: THREE.Object3D) {}

  add(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = this.parent): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0, parent?: THREE.Object3D): THREE.Mesh {
    return this.add(new THREE.BoxGeometry(w, h, d), mat, x, y, z, parent);
  }

  tube(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, parent?: THREE.Object3D, seg = 8): THREE.Mesh {
    const d = new THREE.Vector3().subVectors(b, a);
    const m = this.add(new THREE.CylinderGeometry(r, r, d.length(), seg), mat, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, parent);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
  }

  group(x = 0, y = 0, z = 0, parent: THREE.Object3D = this.parent): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  }
}

/** A strut drawn between two moving points (suspension links). */
export class Link {
  readonly mesh: THREE.Mesh;
  private static geo = new THREE.CylinderGeometry(1, 1, 1, 10);
  private static up = new THREE.Vector3(0, 1, 0);
  private d = new THREE.Vector3();
  constructor(parent: THREE.Object3D, mat: THREE.Material, private r: number, private rz = r) {
    this.mesh = new THREE.Mesh(Link.geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.scale.setScalar(1e-4);
    parent.add(this.mesh);
  }
  set(a: THREE.Vector3, b: THREE.Vector3): void {
    this.d.subVectors(b, a);
    const len = this.d.length();
    this.mesh.position.addVectors(a, b).multiplyScalar(0.5);
    this.mesh.scale.set(this.r, Math.max(len, 1e-4), this.rz);
    this.mesh.quaternion.setFromUnitVectors(Link.up, this.d.divideScalar(Math.max(len, 1e-6)));
  }
}

/**
 * Rocker-bogie suspension links for one side: the rocker pivots on the body,
 * carries the front wheel and the bogie pivot; the bogie carries the middle and
 * rear wheels. Joint positions follow the physical wheel centres each frame.
 */
export class RockerBogie {
  private links: Link[] = [];
  private hubs: THREE.Mesh[] = [];
  private t = Array.from({ length: 5 }, () => new THREE.Vector3());
  constructor(
    parent: THREE.Object3D,
    mat: THREE.Material,
    jointMat: THREE.Material,
    private idx: [number, number, number], // front, middle, rear wheel indices
    private pivot: THREE.Vector3, // rocker pivot on the body
    r: number,
    /** Height of the link attachment above the wheel centre. */
    private hubUp: number,
    private bogieRise = 0.12,
  ) {
    for (let i = 0; i < 10; i++) this.links.push(new Link(parent, mat, i < 4 ? r : r * 0.8));
    for (let i = 0; i < 2; i++) {
      const h = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.9, r * 1.9, r * 3.2, 14), jointMat);
      h.rotation.z = Math.PI / 2;
      h.castShadow = true;
      parent.add(h);
      this.hubs.push(h);
    }
  }

  update(w: THREE.Vector3[]): void {
    const pv = this.pivot;
    const [f, m, r, bp] = this.t;
    const top = (i: number, out: THREE.Vector3) => out.set(pv.x, w[i].y + this.hubUp, w[i].z);
    top(this.idx[0], f);
    top(this.idx[1], m);
    top(this.idx[2], r);
    // Bogie pivot: above the middle of the middle/rear hubs.
    bp.addVectors(m, r).multiplyScalar(0.5);
    bp.y += this.bogieRise;
    this.links[0].set(pv, f);
    this.links[1].set(pv, bp);
    this.links[2].set(bp, m);
    this.links[3].set(bp, r);
    // Drive housings down to the axle height, then the axle stub out to the wheel.
    const mid = this.t[4];
    for (let k = 0; k < 3; k++) {
      const i = this.idx[k];
      mid.set(pv.x, w[i].y, w[i].z);
      this.links[4 + k].set(k === 0 ? f : k === 1 ? m : r, mid);
      this.links[7 + k].set(mid, w[i]);
    }
    this.hubs[0].position.copy(pv);
    this.hubs[1].position.copy(bp);
  }
}

/** Generic rigid wheel: rim cylinder, tread grousers, hub, spokes. Built along the X axis. */
export function rigidWheel(
  k: Kit,
  parent: THREE.Object3D,
  opt: {
    r: number;
    w: number;
    rim: THREE.Material;
    hub: THREE.Material;
    grousers: number;
    grouserH: number;
    /** Chevron angle of the grousers (0 = straight across). */
    chevron?: number;
    spokes?: number;
    curvedSpokes?: boolean;
    outward: number;
    holes?: boolean;
  },
): void {
  const { r, w } = opt;
  const tyre = new THREE.CylinderGeometry(r - opt.grouserH, r - opt.grouserH, w, 48, 1, true);
  tyre.rotateZ(Math.PI / 2);
  const t = k.add(tyre, opt.rim, 0, 0, 0, parent);
  (t.material as THREE.Material).side = THREE.DoubleSide;
  // Grousers: thin plates across the tread (or chevrons).
  const parts: THREE.BufferGeometry[] = [];
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < opt.grousers; i++) {
    const a = (i / opt.grousers) * Math.PI * 2;
    if (opt.chevron) {
      for (const s of [-1, 1]) {
        const g = new THREE.BoxGeometry(w * 0.53, opt.grouserH, 0.008 + r * 0.01);
        g.rotateY(s * opt.chevron);
        g.translate(s * w * 0.24, r - opt.grouserH / 2, s * -Math.sin(opt.chevron) * w * 0.12);
        parts.push(g.applyMatrix4(m4.makeRotationX(a)));
      }
    } else {
      const g = new THREE.BoxGeometry(w, opt.grouserH, 0.006 + r * 0.012);
      g.translate(0, r - opt.grouserH / 2, 0);
      parts.push(g.applyMatrix4(m4.makeRotationX(a)));
    }
  }
  k.add(mergeGeometries(parts)!, opt.rim, 0, 0, 0, parent);
  // Wheel face: disc with optional curved spokes (flexures, as on Curiosity/Perseverance).
  const face = opt.outward * w * 0.18;
  const hubR = r * 0.22;
  const hub = new THREE.CylinderGeometry(hubR, hubR, w * 0.5, 18);
  hub.rotateZ(Math.PI / 2);
  k.add(hub, opt.hub, -opt.outward * w * 0.05, 0, 0, parent);
  const ns = opt.spokes ?? 6;
  for (let i = 0; i < ns; i++) {
    const a = (i / ns) * Math.PI * 2;
    if (opt.curvedSpokes) {
      const pts: THREE.Vector3[] = [];
      for (let s = 0; s <= 6; s++) {
        const u = s / 6;
        const rr = hubR + (r - opt.grouserH - hubR) * u;
        const aa = a + Math.sin(u * Math.PI) * 0.45;
        pts.push(new THREE.Vector3(face, Math.cos(aa) * rr, Math.sin(aa) * rr));
      }
      k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, r * 0.025, 6), opt.hub, 0, 0, 0, parent);
    } else {
      k.tube(V(face, Math.cos(a) * hubR, Math.sin(a) * hubR), V(face, Math.cos(a) * (r - opt.grouserH), Math.sin(a) * (r - opt.grouserH)), r * 0.03, opt.hub, parent);
    }
  }
  if (opt.holes) {
    // Lightening holes / JPL Morse-code pattern band suggestion: dark spots around the tread.
    const hole = new THREE.CircleGeometry(r * 0.05, 8);
    const hp: THREE.BufferGeometry[] = [];
    for (let i = 0; i < opt.grousers; i++) {
      const a = ((i + 0.5) / opt.grousers) * Math.PI * 2;
      const g = hole.clone();
      g.rotateY(Math.PI / 2);
      g.rotateZ(Math.PI / 2);
      g.translate(0, r - opt.grouserH + 0.002, 0);
      hp.push(g.applyMatrix4(m4.makeRotationX(a)));
    }
    k.add(mergeGeometries(hp)!, new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1, side: THREE.DoubleSide }), 0, 0, 0, parent);
  }
}

/** Replace mesh descendants of `group` (outside `skip` subtrees) by one merged mesh per material. */
export function bakeByMaterial(group: THREE.Object3D, skip: Set<THREE.Object3D>): void {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const victims: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    if (skip.has(o)) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh !== group) {
      let geo = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld));
      if (!geo.index) geo = indexed(geo);
      const mat = mesh.material as THREE.Material;
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat)!.push(normalizeAttrs(geo));
      victims.push(mesh);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of group.children) visit(c);
  for (const v of victims) v.parent?.remove(v);
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  g.setIndex(Array.from({ length: n }, (_, i) => i));
  return g;
}

/** Keep only position/normal/uv so differently built geometries can merge. */
function normalizeAttrs(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

/** Work lights (a game concession on the robotic rovers too). */
export function addLights(k: Kit, root: THREE.Object3D, mats: Mats, pts: [number, number, number][], intensity: number) {
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff2d8, emissiveIntensity: 0 });
  const lights: THREE.SpotLight[] = [];
  for (const [x, y, z] of pts) {
    k.box(0.07, 0.05, 0.04, mats.black, x, y, z - 0.02, root);
    const l = k.add(new THREE.CircleGeometry(0.022, 12), lampMat, x, y, z + 0.001, root);
    l.castShadow = false;
    const s = new THREE.SpotLight(0xfff2d8, 0, 80, 0.55, 0.5, 2);
    s.position.set(x, y, z + 0.02);
    s.target.position.set(x * 1.5, y - 1.2, z + 18);
    s.castShadow = false;
    root.add(s, s.target);
    lights.push(s);
  }
  return {
    lights,
    set(on: boolean) {
      for (const l of lights) l.intensity = on ? intensity : 0;
      lampMat.emissiveIntensity = on ? 6 : 0;
    },
  };
}

/** Wheel visual (steer group positioned by physics, spin group holding the wheel mesh). */
export function wheelSlot(root: THREE.Object3D, x: number, y: number, z: number): WheelVisual {
  const steer = new THREE.Group();
  steer.position.set(x, y, z);
  root.add(steer);
  const spin = new THREE.Group();
  steer.add(spin);
  return { steer, spin };
}

/** Exponential approach helper for animated joints. */
export function approach(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}
