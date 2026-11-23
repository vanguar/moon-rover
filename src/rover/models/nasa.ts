import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { dataUrl } from '../../version';
import { approach, type RoverAnimState, type RoverModel, type WheelVisual } from './kit';

/**
 * Official NASA 3D models (NASA 3D Resources, github.com/nasa/NASA-3D-Resources,
 * free for any use): the Apollo Lunar Module, Perseverance and Ingenuity. They are
 * loaded once (Draco-compressed glTF) and cloned; rover wheels are split out of the
 * merged wheel mesh so each one spins and steers with the physics.
 */
const BASE = import.meta.env.BASE_URL;
const cache = new Map<string, Promise<GLTF>>();
const ready = new Map<string, GLTF>();
let loader: GLTFLoader | null = null;

export type NasaModel = 'lm' | 'perseverance' | 'ingenuity';

export function loadNasaModel(name: NasaModel): Promise<GLTF> {
  let p = cache.get(name);
  if (!p) {
    if (!loader) {
      const draco = new DRACOLoader();
      draco.setDecoderPath(`${BASE}draco/`);
      loader = new GLTFLoader();
      loader.setDRACOLoader(draco);
    }
    p = loader.loadAsync(dataUrl(`${BASE}models/${name}.glb`)).then((g) => {
      ready.set(name, g);
      return g;
    });
    cache.set(name, p);
  }
  return p;
}

export function nasaModel(name: NasaModel): GLTF | undefined {
  return ready.get(name);
}

function prepare(o: THREE.Object3D): void {
  o.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const s = mat as THREE.MeshStandardMaterial;
      // Vacuum / thin air: reflections come from the environment map (sunlit ground, black sky).
      if (s.isMeshStandardMaterial) s.envMapIntensity = 1;
    }
  });
}

/** Apollo LM (both stages, as at the end of the EVAs), real size: 7.0 m tall, 9.4 m across the footpads. */
export function buildLunarModule(): THREE.Object3D | null {
  const g = nasaModel('lm');
  if (!g) return null;
  const o = g.scene.clone(true);
  o.scale.setScalar(1.42);
  prepare(o);
  return o;
}

/**
 * Perseverance wheel centres in the chassis frame (x left, z forward), measured on
 * the NASA model (clusters of the merged wheel mesh); used by the physics spec.
 */
export const PERSE_GLB_WHEELS: [number, number][] = [
  [1.15, 1.07], [-1.15, 1.07], [1.15, 0.04], [-1.15, 0.04], [1.15, -1.13], [-1.15, -1.13],
];
export const PERSE_GLB_AXLE = -0.4;
const PERSE_WHEEL_Y = 0.2625; // wheel centre above the model's ground plane

/** Split every mesh under `src` into per-wheel geometries (triangles nearest each centre). */
function splitWheels(src: THREE.Object3D, centres: THREE.Vector3[], radius: number): THREE.Group[] {
  const out = centres.map(() => new THREE.Group());
  src.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  src.traverse((m) => {
    if ((m as THREE.Mesh).isMesh) meshes.push(m as THREE.Mesh);
  });
  for (const mesh of meshes) {
    const geo = mesh.geometry.index ? mesh.geometry : mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const idx = geo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const mw = mesh.matrixWorld;
    const buckets: number[][] = centres.map(() => []);
    const keep: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
      const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
      let best = -1, bd = radius * radius;
      for (let k = 0; k < centres.length; k++) {
        const w = centres[k];
        const d = (cx - w.x) ** 2 + (cy - w.y) ** 2 + (cz - w.z) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      if (best >= 0) buckets[best].push(i0, i1, i2);
      else keep.push(i0, i1, i2);
    }
    const make = (list: number[], offset: THREE.Vector3) => {
      const g = new THREE.BufferGeometry();
      const p = new Float32Array(list.length * 3);
      const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
      const n = nrm ? new Float32Array(list.length * 3) : null;
      const u = uv ? new Float32Array(list.length * 2) : null;
      const nm = new THREE.Matrix3().getNormalMatrix(mw);
      const v = new THREE.Vector3();
      list.forEach((vi, j) => {
        v.fromBufferAttribute(pos, vi).applyMatrix4(mw).sub(offset);
        p.set([v.x, v.y, v.z], j * 3);
        if (n && nrm) {
          v.fromBufferAttribute(nrm, vi).applyMatrix3(nm).normalize();
          n.set([v.x, v.y, v.z], j * 3);
        }
        if (u && uv) u.set([uv.getX(vi), uv.getY(vi)], j * 2);
      });
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      if (n) g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      if (u) g.setAttribute('uv', new THREE.BufferAttribute(u, 2));
      return new THREE.Mesh(g, mesh.material);
    };
    buckets.forEach((list, k) => {
      if (list.length) out[k].add(make(list, centres[k]));
    });
    // The rest of this mesh (suspension parts that share it) stays on the chassis.
    if (keep.length) {
      const rest = make(keep, new THREE.Vector3());
      rest.name = `${mesh.name}-rest`;
      src.parent?.add(rest);
    }
    mesh.removeFromParent();
  }
  return out;
}

/** Perseverance from the NASA model; null until the model is loaded. */
export function buildPerseveranceGlb(): RoverModel | null {
  const g = nasaModel('perseverance');
  if (!g) return null;
  const root = new THREE.Group();
  const body = new THREE.Group();
  const scene = g.scene.clone(true);
  // Give the clone its own geometries so the wheel split never touches the cached model.
  scene.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry = mesh.geometry.clone();
  });
  body.add(scene);
  // Model ground plane → chassis frame: wheel centres at the physics axle height.
  body.position.y = PERSE_GLB_AXLE - PERSE_WHEEL_Y;
  root.add(body);
  prepare(scene);
  scene.updateMatrixWorld(true);

  const centres = PERSE_GLB_WHEELS.map(([x, z]) => new THREE.Vector3(x, PERSE_WHEEL_Y, z));
  const wheelNode = scene.getObjectByName('Wheels_objs');
  const parts = wheelNode ? splitWheels(wheelNode, centres, 0.42) : centres.map(() => new THREE.Group());
  const wheels: WheelVisual[] = PERSE_GLB_WHEELS.map(([x, z], i) => {
    const steer = new THREE.Group();
    steer.position.set(x, PERSE_GLB_AXLE, z);
    const spin = new THREE.Group();
    spin.add(parts[i]);
    steer.add(spin);
    root.add(steer);
    return { steer, spin };
  });

  // Remote Sensing Mast head: pans and tilts with the driver's view.
  const headPivot = new THREE.Group();
  const head = scene.getObjectByName('head');
  const mz = scene.getObjectByName('Mastcam_Z_cams');
  const nav = scene.getObjectByName('NavCams');
  headPivot.position.set(0.0, 1.2, 0.27);
  scene.add(headPivot);
  scene.updateMatrixWorld(true);
  for (const o of [head, mz, nav]) if (o) headPivot.attach(o);
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0.06, 0.05, 0.12);
  headPivot.add(cockpitAnchor);

  let pan = 0, tilt = 0;
  return {
    root,
    wheels,
    cockpitAnchor,
    lights: [],
    setHeadlights: () => undefined,
    setSteering: () => undefined,
    animate(s: RoverAnimState) {
      pan = approach(pan, s.lookYaw, 4, s.dt);
      tilt = approach(tilt, s.lookPitch, 4, s.dt);
      headPivot.rotation.set(0, pan, 0);
      headPivot.rotation.x = -tilt * 0.6;
      if (s.preview) {
        for (const w of wheels) w.spin.rotation.x += s.dt * 0.8;
      }
    },
  };
}

/** Ingenuity: the two coaxial rotors are separate nodes and spin in opposite directions. */
export function buildIngenuity(): { root: THREE.Object3D; rotors: [THREE.Object3D, THREE.Object3D] } | null {
  const g = nasaModel('ingenuity');
  if (!g) return null;
  const root = g.scene.clone(true);
  prepare(root);
  const r1 = root.getObjectByName('rotors_01')!, r2 = root.getObjectByName('rotors_02')!;
  return { root, rotors: [r1, r2] };
}

/** Ingenuity as a garage model (preview: the rotors turn slowly). */
export function buildIngenuityModel(): RoverModel {
  const root = new THREE.Group();
  const m = buildIngenuity();
  if (m) root.add(m.root);
  const anchor = new THREE.Object3D();
  anchor.position.set(0, 0.15, 0.1);
  root.add(anchor);
  return {
    root,
    wheels: [],
    cockpitAnchor: anchor,
    lights: [],
    setHeadlights: () => undefined,
    setSteering: () => undefined,
    animate(s: RoverAnimState) {
      if (m) {
        m.rotors[0].rotation.y += s.dt * 1.5;
        m.rotors[1].rotation.y -= s.dt * 1.5;
      }
    },
  };
}
