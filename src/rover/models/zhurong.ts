import * as THREE from 'three';
import { addLights, approach, bakeByMaterial, Kit, materials, rigidWheel, RockerBogie, solarMaterial, V, wheelSlot, type RoverAnimState, type RoverModel } from './kit';

export const ZHURONG_WHEELS: [number, number][] = [[0.78, 0.72], [-0.78, 0.72], [0.78, 0], [-0.78, 0], [0.78, -0.72], [-0.78, -0.72]];
export const ZHURONG_R = 0.15;
export const ZHURONG_AXLE = -0.36;

/**
 * Zhurong (Tianwen-1, 2021, Utopia Planitia): 240 kg, four deep-blue solar
 * wings that open like a butterfly, a mast with the navigation/terrain cameras
 * and the multispectral camera at the front, a heat-collecting window on the
 * deck, active suspension on six wheels.
 */
export function buildZhurongModel(): RoverModel {
  const root = new THREE.Group();
  const k = new Kit(root);
  const M = materials();
  const cells = solarMaterial(8, 12, '#122a7a', '#6d7a96');
  cells.side = THREE.DoubleSide;
  const body = new THREE.MeshStandardMaterial({ color: 0xe6e4df, metalness: 0.2, roughness: 0.5 });

  k.box(0.95, 0.42, 1.25, body, 0, 0.21, 0);
  k.box(0.96, 0.03, 1.26, M.mirror, 0, 0.43, 0);
  // Collector windows (n-undecane heat storage) on the deck.
  for (const sx of [0.22, -0.22]) k.box(0.3, 0.025, 0.36, new THREE.MeshStandardMaterial({ color: 0x9fb4c8, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.8 }), sx, 0.46, -0.32);
  // Front instrument bay, red "Chinese flag" decal on the back.
  k.box(0.7, 0.2, 0.05, M.goldFoil, 0, 0.18, 0.64);
  k.box(0.18, 0.12, 0.01, M.red, 0, 0.3, -0.63);

  // Four wings: two on each side, hinged at the deck edges (front pair and rear pair).
  const wings: THREE.Group[] = [];
  for (const [sx, z] of [[1, 0.32], [-1, 0.32], [1, -0.32], [-1, -0.32]] as const) {
    const h = k.group(sx * 0.48, 0.45, z);
    k.box(0.82, 0.012, 0.6, cells, sx * 0.41, 0, 0, h);
    k.box(0.82, 0.006, 0.6, M.white, sx * 0.41, -0.009, 0, h);
    wings.push(h);
  }
  // Mast with the camera head and the high-gain dish.
  const mastBase = k.group(0, 0.45, 0.48);
  k.tube(V(0, 0, 0), V(0, 0.78, 0), 0.03, body, mastBase);
  const yaw = k.group(0, 0.82, 0, mastBase);
  const tilt = k.group(0, 0, 0, yaw);
  k.box(0.34, 0.12, 0.12, body, 0, 0, 0, tilt);
  for (const sx of [0.12, 0.05, -0.05, -0.12]) {
    const c = k.add(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 12), M.black, sx, 0, 0.07, tilt);
    c.rotation.x = Math.PI / 2;
    k.add(new THREE.CircleGeometry(0.016, 12), M.lens, sx, 0, 0.096, tilt);
  }
  const hga = k.group(-0.3, 0.6, -0.4);
  k.tube(V(0, -0.15, 0), V(0, 0, 0), 0.015, M.alu, hga);
  const dish = k.add(new THREE.SphereGeometry(0.22, 20, 6, 0, Math.PI * 2, 0, 0.55), M.white, 0, 0.08, 0, hga);
  dish.scale.y = -1;

  const susp = k.group();
  const links = [
    new RockerBogie(susp, M.alu, M.anod, [0, 2, 4], V(0.6, 0.1, 0.15), 0.025, 0.2, 0.08),
    new RockerBogie(susp, M.alu, M.anod, [1, 3, 5], V(-0.6, 0.1, 0.15), 0.025, 0.2, 0.08),
  ];
  const wheels = ZHURONG_WHEELS.map(([x, z]) => {
    const wv = wheelSlot(root, x, ZHURONG_AXLE, z);
    rigidWheel(k, wv.spin, { r: ZHURONG_R, w: 0.2, rim: M.alu, hub: M.anod, grousers: 24, grouserH: 0.012, chevron: 0.35, spokes: 6, outward: Math.sign(x) });
    bakeByMaterial(wv.spin, new Set());
    return wv;
  });
  const lights = addLights(k, root, M, [[0.3, 0.25, 0.68], [-0.3, 0.25, 0.68]], 70);
  bakeByMaterial(root, new Set<THREE.Object3D>([...wings, mastBase, hga, susp, ...wheels.map((w) => w.steer)]));

  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0, 0, 0.1);
  tilt.add(cockpitAnchor);
  return {
    root,
    wheels,
    cockpitAnchor,
    lights: lights.lights,
    setHeadlights: lights.set,
    setSteering() {},
    animate(st: RoverAnimState) {
      for (const l of links) l.update(st.wheelLocal);
      yaw.rotation.y = approach(yaw.rotation.y, st.preview ? Math.sin(st.time * 0.4) * 1.3 : st.lookYaw, 5, st.dt);
      tilt.rotation.x = approach(tilt.rotation.x, -(st.preview ? Math.sin(st.time * 0.31) * 0.25 - 0.1 : st.lookPitch), 5, st.dt);
      // Butterfly wings: fully open (slightly raised) normally; the preview folds and opens them.
      const open = st.preview ? 0.5 + 0.5 * Math.sin(st.time * 0.35) : 1;
      wings.forEach((w, i) => {
        const s = i % 2 === 0 ? 1 : -1;
        const target = s * (Math.PI * 0.92 * (1 - open) + 0.12);
        w.rotation.z = approach(w.rotation.z, target, 1.5, st.dt);
        // The rear wings tilt more (the real rover's are angled back).
        w.rotation.x = approach(w.rotation.x, i >= 2 ? -0.08 : 0.04, 1.5, st.dt);
      });
      hga.rotation.x = -0.7 + Math.sin(st.time * 0.05) * 0.1;
    },
  };
}
