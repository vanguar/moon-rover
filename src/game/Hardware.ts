import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';
import { applyWear } from '../rover/models/wear';
import { bakeByMaterial } from '../rover/models/kit';

type Add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => THREE.Mesh;

/** Materials and a placer that sets each part on the ground under it (relative to the central station). */
function kit(t: TerrainData, cx: number, cz: number) {
  const g = new THREE.Group();
  const m = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  const mat = {
    white: m({ color: 0xe6e4de, roughness: 0.55 }),
    mylar: m({ color: 0xe8e8ea, metalness: 1, roughness: 0.25 }),
    gold: m({ color: 0xd9a040, metalness: 1, roughness: 0.35 }),
    dark: m({ color: 0x2a2b2d, metalness: 0.6, roughness: 0.45 }),
    alu: m({ color: 0xb7babd, metalness: 0.85, roughness: 0.35 }),
    cable: m({ color: 0x8a5a32, roughness: 0.7, side: THREE.DoubleSide }),
    cubes: m({ color: 0x0b0d12, metalness: 0.9, roughness: 0.08 }),
  };
  const add: Add = (geo, material, x, y, z) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, t.height(cx + x, cz + z) - t.height(cx, cz) + y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  return { g, add, mat };
}
type Mat = ReturnType<typeof kit>['mat'];

/** Central station: electronics box, sunshield, helical antenna. */
function centralStation(add: Add, k: Mat): void {
  add(new THREE.BoxGeometry(0.6, 0.32, 0.45), k.white, 0, 0.2, 0);
  add(new THREE.BoxGeometry(0.72, 0.02, 0.55), k.mylar, 0, 0.62, 0);
  for (const [x, z] of [[-0.33, -0.25], [0.33, -0.25], [-0.33, 0.25], [0.33, 0.25]]) add(new THREE.CylinderGeometry(0.008, 0.008, 0.26), k.alu, x, 0.49, z);
  const ant = add(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 10), k.alu, 0.2, 0.95, -0.1);
  ant.rotation.z = 0.4;
}

/** SNAP-27 radioisotope generator: dark finned cylinder. */
function snap27(add: Add, k: Mat, p: THREE.Vector3): void {
  add(new THREE.CylinderGeometry(0.2, 0.2, 0.46, 20), k.dark, p.x, 0.42, p.z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const f = add(new THREE.BoxGeometry(0.2, 0.44, 0.012), k.dark, p.x + Math.cos(a) * 0.28, 0.42, p.z + Math.sin(a) * 0.28);
    f.rotation.y = -a;
  }
  add(new THREE.CylinderGeometry(0.05, 0.08, 0.2, 10), k.alu, p.x, 0.1, p.z);
}

/** Flat ribbon cables from the central station to each instrument. */
function cables(add: Add, k: Mat, to: THREE.Vector3[]): void {
  for (const p of to) {
    const len = Math.hypot(p.x, p.z);
    const c = add(new THREE.PlaneGeometry(0.04, len).rotateX(-Math.PI / 2), k.cable, p.x / 2, 0.012, p.z / 2);
    c.rotation.y = Math.atan2(p.x, p.z);
  }
}

function finish(g: THREE.Group, t: TerrainData, cx: number, cz: number): THREE.Group {
  bakeByMaterial(g, new Set());
  g.position.set(cx, t.height(cx, cz), cz);
  applyWear(g, { dust: { value: 0.35 }, dustColor: new THREE.Color(0.2, 0.195, 0.188), lowY: 0.15, rootInv: { value: new THREE.Matrix4().copy(new THREE.Matrix4().makeTranslation(cx, t.height(cx, cz), cz)).invert() } });
  return g;
}

/**
 * Apollo 15 ALSEP as deployed (layout after the ALSEP deployment map in the Apollo
 * 15 Preliminary Science Report, NASA SP-289; distances approximate). The laser
 * retro-reflector LRRR-300 stands apart, at its LROC position (Wagner et al. 2017:
 * 26.13333° N, 3.62837° E): ~42 m west and ~22 m south of the central station.
 */
export function buildAlsep(t: TerrainData, cx: number, cz: number): THREE.Group {
  const { g, add, mat: k } = kit(t, cx, cz);
  centralStation(add, k);
  const rtg = new THREE.Vector3(-2.6, 0, 1.2);
  snap27(add, k, rtg);
  // Passive seismometer under its aluminised-Mylar thermal shroud.
  const pse = new THREE.Vector3(3.2, 0, -3.8);
  add(new THREE.CircleGeometry(0.8, 32).rotateX(-Math.PI / 2), k.mylar, pse.x, 0.015, pse.z);
  add(new THREE.SphereGeometry(0.16, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), k.mylar, pse.x, 0.02, pse.z);
  // Magnetometer: central body and three booms with sensor heads.
  const lsm = new THREE.Vector3(-5, 0, -3);
  add(new THREE.BoxGeometry(0.25, 0.2, 0.25), k.gold, lsm.x, 0.35, lsm.z);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const boom = add(new THREE.CylinderGeometry(0.012, 0.012, 0.9), k.alu, lsm.x + Math.cos(a) * 0.45, 0.6, lsm.z + Math.sin(a) * 0.45);
    boom.rotation.set(0, -a, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), k.white, lsm.x + Math.cos(a) * 0.92, 0.6, lsm.z + Math.sin(a) * 0.92);
  }
  for (let i = 0; i < 3; i++) add(new THREE.CylinderGeometry(0.01, 0.01, 0.4), k.alu, lsm.x + Math.cos(i * 2.1) * 0.15, 0.17, lsm.z + Math.sin(i * 2.1) * 0.15);
  // Solar wind spectrometer: box on legs.
  const sws = new THREE.Vector3(4.8, 0, 2.2);
  add(new THREE.BoxGeometry(0.35, 0.3, 0.3), k.white, sws.x, 0.45, sws.z);
  add(new THREE.BoxGeometry(0.4, 0.02, 0.35), k.mylar, sws.x, 0.62, sws.z);
  // Laser ranging retro-reflector LRRR-300: tilted array of 300 fused-silica corner cubes.
  const lr = new THREE.Vector3(-42, 0, 22);
  const panel = add(new THREE.BoxGeometry(1.05, 0.06, 0.62), k.alu, lr.x, 0.42, lr.z);
  panel.rotation.x = -0.6;
  const cubes = add(new THREE.PlaneGeometry(1.0, 0.56), k.cubes, lr.x, 0.455, lr.z - 0.02);
  cubes.rotation.x = -0.6 - Math.PI / 2;
  add(new THREE.BoxGeometry(0.06, 0.4, 0.06), k.alu, lr.x - 0.4, 0.2, lr.z);
  add(new THREE.BoxGeometry(0.06, 0.4, 0.06), k.alu, lr.x + 0.4, 0.2, lr.z);
  cables(add, k, [rtg, pse, lsm, sws]);
  return finish(g, t, cx, cz);
}

/**
 * Apollo 17 ALSEP: every instrument at its surveyed position (Haase et al. 2018
 * control points, terrain.json "hardware"); shapes after the ALSEP photographs
 * (AS17-134-20500 and neighbours) and the Apollo 17 Preliminary Science Report
 * (NASA SP-330): LEAM, LACE, the gravimeter LSG under its parasol sunshade, the
 * seismic-profiling transmitter LSP, heat-flow electronics, the geophone module.
 * The four geophones are fist-sized and buried to the cable - not drawn.
 */
export function buildAlsep17(t: TerrainData, cx: number, cz: number, items: { type: string; x: number; z: number }[]): THREE.Group {
  const { g, add, mat: k } = kit(t, cx, cz);
  centralStation(add, k);
  const wired: THREE.Vector3[] = [];
  for (const it of items) {
    const p = new THREE.Vector3(it.x - cx, 0, it.z - cz);
    // Each box turned as it was set down by hand - none square to the map grid.
    const yaw = Math.sin(it.x * 3.17 + it.z * 1.73) * 0.5;
    const box = (w: number, h: number, d: number, m: THREE.Material, y: number) => {
      add(new THREE.BoxGeometry(w, h, d), m, p.x, y, p.z).rotation.y = yaw;
    };
    if (it.type === 'rtg') snap27(add, k, p);
    else if (it.type === 'leam') {
      // Lunar Ejecta and Meteorites: sensor box on a short stand.
      add(new THREE.CylinderGeometry(0.03, 0.04, 0.3, 8), k.alu, p.x, 0.15, p.z);
      box(0.33, 0.24, 0.3, k.white, 0.42);
      box(0.36, 0.02, 0.33, k.gold, 0.55);
    } else if (it.type === 'lace') {
      // Lunar Atmospheric Composition: mass-spectrometer box, radiator on top.
      box(0.4, 0.32, 0.36, k.white, 0.18);
      box(0.44, 0.015, 0.4, k.mylar, 0.35);
      add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 12), k.alu, p.x, 0.4, p.z);
    } else if (it.type === 'lsg') {
      // Surface gravimeter: drum under a parasol sunshade.
      add(new THREE.CylinderGeometry(0.15, 0.15, 0.35, 18), k.white, p.x, 0.18, p.z);
      add(new THREE.CylinderGeometry(0.01, 0.01, 0.18), k.alu, p.x, 0.43, p.z);
      add(new THREE.CylinderGeometry(0.42, 0.42, 0.012, 24), k.mylar, p.x, 0.52, p.z);
    } else if (it.type === 'lsp') {
      // Seismic profiling transmitter: low box and a whip antenna.
      box(0.3, 0.2, 0.25, k.white, 0.12);
      add(new THREE.CylinderGeometry(0.006, 0.006, 0.9), k.alu, p.x + 0.08, 0.65, p.z).rotation.z = 0.12;
    } else if (it.type === 'hfe') box(0.28, 0.16, 0.22, k.white, 0.09);
    else if (it.type === 'gm') box(0.24, 0.14, 0.2, k.gold, 0.08);
    else continue;
    wired.push(p);
  }
  cables(add, k, wired);
  return finish(g, t, cx, cz);
}
