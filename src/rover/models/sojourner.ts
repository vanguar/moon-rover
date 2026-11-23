import * as THREE from 'three';
import { addLights, approach, bakeByMaterial, Kit, materials, rigidWheel, RockerBogie, solarMaterial, V, wheelSlot, type RoverAnimState, type RoverModel } from './kit';

export const SOJOURNER_WHEELS: [number, number][] = [[0.2, 0.25], [-0.2, 0.25], [0.2, -0.03], [-0.2, -0.03], [0.2, -0.25], [-0.2, -0.25]];
export const SOJOURNER_R = 0.065;
export const SOJOURNER_AXLE = -0.1;

/**
 * Sojourner (Mars Pathfinder, 1997): the first Mars rover, 11.5 kg, 65 cm long.
 * Warm electronics box under a 0.22 m² GaAs solar panel, whip antenna, APXS
 * spectrometer on its deployment mechanism at the back, stereo cameras and laser
 * hazard stripes at the front, rocker-bogie on six cleated steel wheels.
 */
export function buildSojournerModel(): RoverModel {
  const root = new THREE.Group();
  const k = new Kit(root);
  const M = materials();
  const cells = solarMaterial(12, 8, '#2a3050', '#8d93a3');

  k.box(0.28, 0.1, 0.42, M.goldFoil, 0, 0.05, 0);
  k.box(0.3, 0.012, 0.44, M.white, 0, 0.106, 0);
  // Solar panel on short posts, overhanging the body.
  const panel = k.group(0, 0.125, -0.01);
  k.box(0.46, 0.008, 0.58, cells, 0, 0, 0, panel);
  k.box(0.47, 0.004, 0.59, M.alu, 0, -0.006, 0, panel);
  for (const [x, z] of [[0.12, 0.18], [-0.12, 0.18], [0.12, -0.18], [-0.12, -0.18]]) k.tube(V(x, 0.1, z), V(x, 0.12, z), 0.006, M.alu);
  // Front: stereo cameras and laser stripers.
  for (const sx of [0.06, -0.06]) {
    k.box(0.03, 0.025, 0.02, M.black, sx, 0.07, 0.215);
    k.add(new THREE.CircleGeometry(0.008, 10), M.lens, sx, 0.07, 0.2255);
  }
  k.box(0.18, 0.012, 0.012, M.red, 0, 0.035, 0.216);
  // Whip antenna (front left).
  const whip = k.group(0.1, 0.13, 0.15);
  k.tube(V(0, 0, 0), V(0, 0.3, 0), 0.0035, M.titanium, whip, 6);
  k.add(new THREE.SphereGeometry(0.007, 8, 6), M.black, 0, 0.3, 0, whip);
  // APXS on its deployment arm at the back.
  const apxs = k.group(0, 0.06, -0.22);
  k.tube(V(0, 0, 0), V(0, -0.05, -0.06), 0.006, M.alu, apxs);
  k.add(new THREE.CylinderGeometry(0.02, 0.02, 0.04, 12), M.white, 0, -0.06, -0.07, apxs);

  const susp = k.group();
  const links = [
    new RockerBogie(susp, M.alu, M.anod, [0, 2, 4], V(0.155, 0.03, 0.06), 0.006, 0.05, 0.02),
    new RockerBogie(susp, M.alu, M.anod, [1, 3, 5], V(-0.155, 0.03, 0.06), 0.006, 0.05, 0.02),
  ];
  const wheels = SOJOURNER_WHEELS.map(([x, z]) => {
    const wv = wheelSlot(root, x, SOJOURNER_AXLE, z);
    rigidWheel(k, wv.spin, { r: SOJOURNER_R, w: 0.079, rim: M.alu, hub: M.anod, grousers: 14, grouserH: 0.008, spokes: 5, outward: Math.sign(x) });
    bakeByMaterial(wv.spin, new Set());
    return wv;
  });
  const lights = addLights(k, root, M, [[0.1, 0.035, 0.22], [-0.1, 0.035, 0.22]], 18);
  bakeByMaterial(root, new Set<THREE.Object3D>([whip, apxs, susp, ...wheels.map((w) => w.steer)]));

  // Driver's view: the front stereo cameras, 0.2 m above the ground.
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0, 0.075, 0.23);
  root.add(cockpitAnchor);
  let sway = 0, swayV = 0;
  return {
    root,
    wheels,
    cockpitAnchor,
    lights: lights.lights,
    setHeadlights: lights.set,
    setSteering() {},
    animate(st: RoverAnimState) {
      for (const l of links) l.update(st.wheelLocal);
      // Whip antenna: damped spring excited by acceleration and bumps.
      const kick = st.preview ? Math.sin(st.time * 2.3) * 0.6 : st.speed * 0.4;
      swayV += (-sway * 60 - swayV * 2.5 + kick * 6) * st.dt;
      sway += swayV * st.dt;
      whip.rotation.x = THREE.MathUtils.clamp(sway, -0.4, 0.4);
      whip.rotation.z = Math.sin(st.time * 1.7) * 0.03;
      apxs.rotation.x = approach(apxs.rotation.x, st.parked || st.preview ? -0.9 : 0, 1.5, st.dt);
    },
  };
}
