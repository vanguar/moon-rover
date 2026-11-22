import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface RoverModel {
  root: THREE.Group;
  wheels: THREE.Group[];
  cockpitAnchor: THREE.Object3D;
  lights: THREE.SpotLight[];
  setHeadlights(on: boolean): void;
  setSteering(a: number): void;
}

/** A six-wheeled lunar rover, local frame +z forward, +x left, +y up. */
export function buildRoverModel(): RoverModel {
  const root = new THREE.Group();

  // Metals are PBR: bright specular glints from the unfiltered sun.
  const alu = new THREE.MeshStandardMaterial({ color: 0xa8acb0, metalness: 0.85, roughness: 0.38 });
  const darkAlu = new THREE.MeshStandardMaterial({ color: 0x55595e, metalness: 0.7, roughness: 0.5 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd9a443, metalness: 1, roughness: 0.22 });
  const silverFoil = new THREE.MeshStandardMaterial({ color: 0xe8e8ea, metalness: 1, roughness: 0.12, side: THREE.DoubleSide });
  const fender = new THREE.MeshStandardMaterial({ color: 0x7f8c99, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x5d6b78, metalness: 0, roughness: 0.9 });
  const black = new THREE.MeshStandardMaterial({ color: 0x18191b, metalness: 0.3, roughness: 0.6 });
  const mesh = new THREE.MeshStandardMaterial({ color: 0xb59b6a, metalness: 0.9, roughness: 0.45 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff2d8, emissiveIntensity: 0 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Chassis: tubular frame + floor pan.
  add(new THREE.BoxGeometry(1.7, 0.08, 3.1), darkAlu, 0, -0.12, 0);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.08, 0.1, 3.3), alu, sx * 0.86, -0.08, 0);
  for (const z of [-1.55, -0.6, 0.6, 1.55]) add(new THREE.BoxGeometry(1.8, 0.07, 0.07), alu, 0, -0.06, z);

  // Forward chassis: gold-foil insulated electronics boxes.
  add(new THREE.BoxGeometry(1.2, 0.32, 0.7), gold, 0, 0.1, 1.15);
  add(new THREE.BoxGeometry(0.5, 0.18, 0.45), silverFoil, 0.35, 0.34, 1.2);
  // Aft chassis: tool rack / sample bags.
  add(new THREE.BoxGeometry(1.4, 0.45, 0.6), gold, 0, 0.17, -1.3);
  add(new THREE.BoxGeometry(1.2, 0.1, 0.55), alu, 0, 0.45, -1.3);

  // Seats (two crew stations).
  for (const sx of [0.42, -0.42]) {
    add(new THREE.BoxGeometry(0.55, 0.06, 0.55), fabric, sx, 0.22, -0.3);
    const back = add(new THREE.BoxGeometry(0.55, 0.55, 0.05), fabric, sx, 0.5, -0.6);
    back.rotation.x = 0.25;
    add(new THREE.BoxGeometry(0.04, 0.3, 0.5), alu, sx + 0.29, 0.35, -0.3);
    add(new THREE.BoxGeometry(0.04, 0.3, 0.5), alu, sx - 0.29, 0.35, -0.3);
  }

  // Control & display console on a post between the seats.
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.42), alu, 0, 0.32, 0.5);
  const console_ = add(new THREE.BoxGeometry(0.36, 0.22, 0.06), black, 0, 0.58, 0.52);
  console_.rotation.x = -0.6;
  for (let i = 0; i < 3; i++) {
    const d = add(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 16), alu, -0.1 + i * 0.1, 0.6, 0.5);
    d.rotation.x = Math.PI / 2 - 0.6;
  }
  // T-handle hand controller in front of the driver (left seat).
  const stick = new THREE.Group();
  stick.position.set(0.22, 0.42, 0.05);
  root.add(stick);
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.22), black, 0, 0.11, 0, stick);
  const tbar = add(new THREE.CylinderGeometry(0.018, 0.018, 0.16), black, 0, 0.22, 0, stick);
  tbar.rotation.z = Math.PI / 2;

  // High-gain umbrella antenna on a mast (mirror-like mesh -> sun glints).
  add(new THREE.CylinderGeometry(0.025, 0.025, 1.3), alu, -0.62, 0.8, -1.05);
  const dish = add(new THREE.ConeGeometry(0.48, 0.16, 24, 1, true), silverFoil, -0.62, 1.52, -1.08);
  dish.rotation.set(-1.0, 0.4 + Math.PI, 0);
  add(new THREE.CylinderGeometry(0.012, 0.012, 0.3), alu, -0.62, 1.55, -1.0).rotation.x = 1.0;
  // Low-gain helical antenna.
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.6), silverFoil, -0.78, 0.6, 1.4);
  // TV camera on its mast.
  add(new THREE.CylinderGeometry(0.02, 0.02, 0.8), alu, -0.3, 0.6, 1.45);
  add(new THREE.BoxGeometry(0.18, 0.14, 0.28), silverFoil, -0.3, 1.05, 1.5);

  // Wheels with fenders.
  const wheelPos: [number, number][] = [[1.0, 1.25], [-1.0, 1.25], [1.0, 0], [-1.0, 0], [1.0, -1.25], [-1.0, -1.25]];
  const tire = new THREE.CylinderGeometry(0.41, 0.41, 0.23, 28, 1, true);
  tire.rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.14, 0.14, 0.26, 16);
  hub.rotateZ(Math.PI / 2);
  const chevron = new THREE.BoxGeometry(0.2, 0.02, 0.05);
  const spokeGeo = new THREE.BoxGeometry(0.02, 0.7, 0.03);
  const wheels: THREE.Group[] = [];
  wheelPos.forEach(([x, z]) => {
    const steer = new THREE.Group();
    steer.position.set(x, -0.35, z);
    root.add(steer);
    const spin = new THREE.Group();
    steer.add(spin);
    add(tire, mesh, 0, 0, 0, spin);
    add(hub, alu, 0, 0, 0, spin);
    // Titanium chevron treads.
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      const c = add(chevron, alu, 0, Math.cos(a) * 0.415, Math.sin(a) * 0.415, spin);
      c.rotation.x = -a;
    }
    for (let k = 0; k < 3; k++) {
      const s = add(spokeGeo, darkAlu, 0, 0, 0, spin);
      s.rotation.x = (k / 3) * Math.PI;
    }
    wheels.push(steer);
    // Fender over the wheel (fixed to chassis).
    const f = add(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 20, 1, true, -Math.PI * 0.45, Math.PI * 0.9), fender, x, -0.25, z);
    f.rotation.set(0, 0, Math.PI / 2);
  });

  // Headlights: two lamps at the front with spot lights.
  const lights: THREE.SpotLight[] = [];
  for (const sx of [0.55, -0.55]) {
    add(new THREE.BoxGeometry(0.16, 0.1, 0.06), black, sx, 0.32, 1.56);
    const lens = add(new THREE.CircleGeometry(0.045, 16), lampMat, sx, 0.32, 1.595);
    lens.castShadow = false;
    const l = new THREE.SpotLight(0xfff2d8, 0, 120, 0.5, 0.55, 2);
    l.position.set(sx, 0.32, 1.6);
    l.target.position.set(sx * 1.6, -1.0, 22);
    l.castShadow = false;
    root.add(l, l.target);
    lights.push(l);
  }

  // Merge static parts per material (hundreds of meshes -> a handful of draw calls).
  const dynamic = new Set<THREE.Object3D>([stick, ...wheels]);
  bakeByMaterial(root, dynamic);
  for (const w of wheels) bakeByMaterial(w.children[0], new Set());

  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0.42, 1.18, -0.3);
  root.add(cockpitAnchor);

  return {
    root,
    wheels,
    cockpitAnchor,
    lights,
    setHeadlights(on: boolean) {
      for (const l of lights) l.intensity = on ? 140 : 0;
      lampMat.emissiveIntensity = on ? 6 : 0;
    },
    setSteering(a: number) {
      stick.rotation.z = -a * 0.6;
    },
  };
}

/** Replace mesh descendants of `group` (outside `skip` subtrees) by one merged mesh per material. */
function bakeByMaterial(group: THREE.Object3D, skip: Set<THREE.Object3D>): void {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const victims: THREE.Mesh[] = [];
  const visit = (o: THREE.Object3D) => {
    if (skip.has(o)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m !== group) {
      const g = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      if (!g.index) return;
      const mat = m.material as THREE.Material;
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat)!.push(g);
      victims.push(m);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of group.children) visit(c);
  for (const v of victims) v.parent?.remove(v);
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos.map((g) => (g.getAttribute('uv') ? g : withUv(g))), false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function withUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}
