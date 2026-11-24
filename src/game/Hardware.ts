import * as THREE from 'three';
import type { TerrainData } from '../terrain/TerrainData';
import { applyWear } from '../rover/models/wear';
import { bakeByMaterial } from '../rover/models/kit';

/**
 * Apollo 15 ALSEP as deployed (layout after the ALSEP deployment map in the Apollo
 * 15 Preliminary Science Report, NASA SP-289; distances approximate). The laser
 * retro-reflector LRRR-300 stands apart, at its LROC position (Wagner et al. 2017:
 * 26.13333° N, 3.62837° E): ~42 m west and ~22 m south of the central station.
 */
export function buildAlsep(t: TerrainData, cx: number, cz: number): THREE.Group {
  const g = new THREE.Group();
  const m = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  const white = m({ color: 0xe6e4de, roughness: 0.55 });
  const mylar = m({ color: 0xe8e8ea, metalness: 1, roughness: 0.25 });
  const gold = m({ color: 0xd9a040, metalness: 1, roughness: 0.35 });
  const dark = m({ color: 0x2a2b2d, metalness: 0.6, roughness: 0.45 });
  const alu = m({ color: 0xb7babd, metalness: 0.85, roughness: 0.35 });
  const cable = m({ color: 0x8a5a32, roughness: 0.7, side: THREE.DoubleSide });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, t.height(cx + x, cz + z) - t.height(cx, cz) + y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  // Central station: electronics box, sunshield, helical antenna.
  add(new THREE.BoxGeometry(0.6, 0.32, 0.45), white, 0, 0.2, 0);
  add(new THREE.BoxGeometry(0.72, 0.02, 0.55), mylar, 0, 0.62, 0);
  for (const [x, z] of [[-0.33, -0.25], [0.33, -0.25], [-0.33, 0.25], [0.33, 0.25]]) add(new THREE.CylinderGeometry(0.008, 0.008, 0.26), alu, x, 0.49, z);
  const ant = add(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 10), alu, 0.2, 0.95, -0.1);
  ant.rotation.z = 0.4;
  // SNAP-27 radioisotope generator: dark finned cylinder.
  const rtg = new THREE.Vector3(-2.6, 0, 1.2);
  add(new THREE.CylinderGeometry(0.2, 0.2, 0.46, 20), dark, rtg.x, 0.42, rtg.z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const f = add(new THREE.BoxGeometry(0.2, 0.44, 0.012), dark, rtg.x + Math.cos(a) * 0.28, 0.42, rtg.z + Math.sin(a) * 0.28);
    f.rotation.y = -a;
  }
  add(new THREE.CylinderGeometry(0.05, 0.08, 0.2, 10), alu, rtg.x, 0.1, rtg.z);
  // Passive seismometer under its aluminised-Mylar thermal shroud.
  const pse = new THREE.Vector3(3.2, 0, -3.8);
  add(new THREE.CircleGeometry(0.8, 32).rotateX(-Math.PI / 2), mylar, pse.x, 0.015, pse.z);
  add(new THREE.SphereGeometry(0.16, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mylar, pse.x, 0.02, pse.z);
  // Magnetometer: central body and three booms with sensor heads.
  const lsm = new THREE.Vector3(-5, 0, -3);
  add(new THREE.BoxGeometry(0.25, 0.2, 0.25), gold, lsm.x, 0.35, lsm.z);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const boom = add(new THREE.CylinderGeometry(0.012, 0.012, 0.9), alu, lsm.x + Math.cos(a) * 0.45, 0.6, lsm.z + Math.sin(a) * 0.45);
    boom.rotation.set(0, -a, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), white, lsm.x + Math.cos(a) * 0.92, 0.6, lsm.z + Math.sin(a) * 0.92);
  }
  for (let i = 0; i < 3; i++) add(new THREE.CylinderGeometry(0.01, 0.01, 0.4), alu, lsm.x + Math.cos(i * 2.1) * 0.15, 0.17, lsm.z + Math.sin(i * 2.1) * 0.15);
  // Solar wind spectrometer: box on legs.
  const sws = new THREE.Vector3(4.8, 0, 2.2);
  add(new THREE.BoxGeometry(0.35, 0.3, 0.3), white, sws.x, 0.45, sws.z);
  add(new THREE.BoxGeometry(0.4, 0.02, 0.35), mylar, sws.x, 0.62, sws.z);
  // Laser ranging retro-reflector LRRR-300: tilted array of 300 fused-silica corner cubes.
  const lr = new THREE.Vector3(-42, 0, 22);
  const panel = add(new THREE.BoxGeometry(1.05, 0.06, 0.62), alu, lr.x, 0.42, lr.z);
  panel.rotation.x = -0.6;
  const cubes = add(new THREE.PlaneGeometry(1.0, 0.56), m({ color: 0x0b0d12, metalness: 0.9, roughness: 0.08 }), lr.x, 0.455, lr.z - 0.02);
  cubes.rotation.x = -0.6 - Math.PI / 2;
  add(new THREE.BoxGeometry(0.06, 0.4, 0.06), alu, lr.x - 0.4, 0.2, lr.z);
  add(new THREE.BoxGeometry(0.06, 0.4, 0.06), alu, lr.x + 0.4, 0.2, lr.z);
  // Flat ribbon cables from the central station to each instrument.
  for (const p of [rtg, pse, lsm, sws]) {
    const d = new THREE.Vector3(p.x, 0, p.z);
    const len = d.length();
    const c = add(new THREE.PlaneGeometry(0.04, len).rotateX(-Math.PI / 2), cable, p.x / 2, 0.012, p.z / 2);
    c.rotation.y = Math.atan2(p.x, p.z);
  }
  bakeByMaterial(g, new Set());
  g.position.set(cx, t.height(cx, cz), cz);
  applyWear(g, { dust: { value: 0.35 }, dustColor: new THREE.Color(0.2, 0.195, 0.188), lowY: 0.15, rootInv: { value: new THREE.Matrix4().copy(new THREE.Matrix4().makeTranslation(cx, t.height(cx, cz), cz)).invert() } });
  return g;
}
