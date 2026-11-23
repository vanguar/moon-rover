import * as THREE from 'three';
import { addLights, approach, bakeByMaterial, Kit, materials, rigidWheel, RockerBogie, solarMaterial, V, wheelSlot, type RoverAnimState, type RoverModel } from './kit';

export const YUTU_WHEELS: [number, number][] = [[0.52, 0.55], [-0.52, 0.55], [0.52, 0], [-0.52, 0], [0.52, -0.55], [-0.52, -0.55]];
export const YUTU_R = 0.15;
export const YUTU_AXLE = -0.2;

/**
 * Yutu-2 (Chang'e 4, 2019, lunar far side): box body in gold MLI, two solar
 * wings (the left one folds over the deck for the lunar night), a mast with
 * the panoramic and navigation camera pairs and a high-gain antenna,
 * rocker-bogie suspension on six aluminium wheels.
 */
export function buildYutuModel(): RoverModel {
  const root = new THREE.Group();
  const k = new Kit(root);
  const M = materials();
  const cells = solarMaterial(10, 6, '#1a2c66', '#9aa2b2');
  cells.side = THREE.DoubleSide;

  // Body: 0.95 x 0.75 x 0.42 m, gold foil sides, white radiator top.
  k.box(0.75, 0.42, 0.95, M.goldFoil, 0, 0.21, 0);
  k.box(0.76, 0.02, 0.96, M.white, 0, 0.43, 0);
  k.box(0.6, 0.01, 0.5, M.mirror, 0, 0.445, -0.15);
  // Front: hazard cameras, infrared spectrometer window, ground-penetrating radar antennas under the belly.
  for (const sx of [0.15, -0.15]) {
    k.box(0.06, 0.05, 0.05, M.white, sx, 0.08, 0.49);
    k.add(new THREE.CircleGeometry(0.018, 12), M.lens, sx, 0.08, 0.516);
  }
  k.box(0.12, 0.08, 0.06, M.darkAnod, 0.0, 0.25, 0.5);
  k.box(0.5, 0.02, 0.3, M.alu, 0, -0.02, 0.2);
  k.box(0.5, 0.02, 0.3, M.alu, 0, -0.02, -0.25);

  // Solar wings: hinged on the body's upper long edges.
  const wingR = k.group(-0.38, 0.43, 0); // right side (-x)
  k.box(0.75, 0.012, 0.92, cells, -0.375, 0, 0, wingR);
  k.box(0.75, 0.006, 0.92, M.white, -0.375, -0.009, 0, wingR);
  const wingL = k.group(0.38, 0.43, 0);
  k.box(0.75, 0.012, 0.92, cells, 0.375, 0, 0, wingL);
  k.box(0.75, 0.006, 0.92, M.white, 0.375, -0.009, 0, wingL);

  // Mast: folding boom at the front, camera head (Pancam + Navcam pairs) and HGA.
  const mastBase = k.group(0, 0.44, 0.33);
  k.tube(V(0, 0, 0), V(0, 0.55, 0), 0.022, M.white, mastBase);
  const yaw = k.group(0, 0.57, 0, mastBase);
  const tilt = k.group(0, 0.04, 0, yaw);
  k.box(0.3, 0.07, 0.08, M.white, 0, 0, 0, tilt);
  for (const sx of [0.11, 0.05, -0.05, -0.11]) {
    const c = k.add(new THREE.CylinderGeometry(0.018, 0.018, 0.05, 12), M.black, sx, 0, 0.05, tilt);
    c.rotation.x = Math.PI / 2;
    k.add(new THREE.CircleGeometry(0.013, 12), M.lens, sx, 0, 0.076, tilt);
  }
  const hga = k.group(0.0, 0.62, -0.12, mastBase);
  k.tube(V(0, -0.1, 0.08), V(0, 0, 0), 0.01, M.alu, hga);
  const dish = k.add(new THREE.SphereGeometry(0.2, 20, 6, 0, Math.PI * 2, 0, 0.5), M.goldFoil, 0, 0, 0, hga);
  dish.scale.y = -1;
  (dish.material as THREE.Material).side = THREE.DoubleSide;
  const hgaPivot = hga;

  // Rocker-bogie: pivots at the body sides.
  const susp = k.group();
  const links = [
    new RockerBogie(susp, M.alu, M.anod, [0, 2, 4], V(0.43, 0.12, 0.12), 0.016, 0.16, 0.06),
    new RockerBogie(susp, M.alu, M.anod, [1, 3, 5], V(-0.43, 0.12, 0.12), 0.016, 0.16, 0.06),
  ];
  const wheels = YUTU_WHEELS.map(([x, z]) => {
    const wv = wheelSlot(root, x, YUTU_AXLE, z);
    rigidWheel(k, wv.spin, { r: YUTU_R, w: 0.15, rim: M.alu, hub: M.anod, grousers: 18, grouserH: 0.012, spokes: 6, outward: Math.sign(x), holes: true });
    bakeByMaterial(wv.spin, new Set());
    return wv;
  });
  const lights = addLights(k, root, M, [[0.28, 0.33, 0.5], [-0.28, 0.33, 0.5]], 60);
  bakeByMaterial(root, new Set<THREE.Object3D>([wingL, wingR, mastBase, susp, ...wheels.map((w) => w.steer)]));
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0, 0.0, 0.08);
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
      const lookYaw = st.preview ? Math.sin(st.time * 0.4) * 1.2 : st.lookYaw;
      const lookPitch = st.preview ? Math.sin(st.time * 0.3) * 0.25 - 0.1 : st.lookPitch;
      yaw.rotation.y = approach(yaw.rotation.y, lookYaw, 6, st.dt);
      tilt.rotation.x = approach(tilt.rotation.x, -lookPitch, 6, st.dt);
      // Right wing tilts toward the Sun; left wing opens (folded flat over the deck in the preview cycle).
      const fold = st.preview && Math.sin(st.time * 0.3) < -0.5 ? 1 : 0;
      wingL.rotation.z = approach(wingL.rotation.z, fold ? Math.PI * 0.98 : 0.05, 1.2, st.dt);
      wingR.rotation.z = approach(wingR.rotation.z, -0.35, 1.2, st.dt);
      hgaPivot.rotation.y = approach(hgaPivot.rotation.y, Math.sin(st.time * 0.07) * 0.4, 0.5, st.dt);
      hgaPivot.rotation.x = -0.5;
    },
  };
}
