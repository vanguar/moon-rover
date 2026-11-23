import * as THREE from 'three';
import { addLights, approach, bakeByMaterial, Kit, materials, rigidWheel, RockerBogie, V, wheelSlot, type RoverAnimState, type RoverModel } from './kit';

export const MSL_WHEELS: [number, number][] = [[1.1, 1.05], [-1.1, 1.05], [1.1, 0.05], [-1.1, 0.05], [1.1, -0.95], [-1.1, -0.95]];
export const MSL_AXLE = -0.4;

/**
 * Curiosity (MSL, 2012) and Perseverance (Mars 2020): car-sized nuclear rovers.
 * Warm electronics box with the MMRTG fin-cylinder at the back, Remote Sensing
 * Mast (ChemCam / SuperCam, Mastcam(-Z), Navcams), high-gain antenna, five-joint
 * robotic arm with its turret, rocker-bogie on six aluminium wheels with titanium
 * spoke flexures; the four corner wheels steer.
 */
export function buildMslModel(variant: 'curiosity' | 'perseverance'): RoverModel {
  const perse = variant === 'perseverance';
  const R = perse ? 0.2625 : 0.25;
  const root = new THREE.Group();
  const k = new Kit(root);
  const M = materials();
  const deck = new THREE.MeshStandardMaterial({ color: perse ? 0xd8d2c6 : 0xb9b2a4, metalness: 0.25, roughness: 0.6 });
  const dusty = new THREE.MeshStandardMaterial({ color: 0xc9a98a, metalness: 0.15, roughness: 0.75 });
  const rtgMat = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, metalness: 0.55, roughness: 0.45 });

  // Warm Electronics Box: 1.1 m wide, 1.9 m long.
  k.box(1.12, 0.52, 1.85, deck, 0, 0.26, 0);
  k.box(1.14, 0.03, 1.87, M.white, 0, 0.535, 0);
  k.box(1.1, 0.06, 0.4, M.darkAnod, 0, 0.02, 0.75);
  // Deck instruments: SAM / CheMin inlets, sample hardware, calibration targets, UHF antenna.
  k.box(0.4, 0.12, 0.35, M.white, 0.25, 0.6, -0.3);
  k.box(0.3, 0.08, 0.25, dusty, -0.25, 0.59, 0.1);
  k.box(0.12, 0.04, 0.12, M.gold, 0.3, 0.57, 0.45);
  k.add(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 12), M.white, -0.42, 0.63, -0.7);
  if (perse) {
    // Adaptive caching assembly and the sample tube bay along the belly front.
    k.box(0.6, 0.18, 0.3, M.white, -0.1, 0.1, 0.94);
    k.box(0.5, 0.02, 0.5, M.black, 0, -0.01, -0.3);
  }
  // High-gain antenna (flat hexagon on a gimbal) on the rear left deck.
  const hgaBase = k.group(0.38, 0.6, -0.45);
  k.add(new THREE.CylinderGeometry(0.05, 0.06, 0.18, 10), M.anod, 0, 0.09, 0, hgaBase);
  const hga = k.group(0, 0.2, 0, hgaBase);
  const hex = k.add(new THREE.CylinderGeometry(0.15, 0.15, 0.04, 6), M.white, 0, 0, 0, hga);
  hex.rotation.x = Math.PI / 2;
  // Low-gain antenna and the rover's "Morse code" calibration panel.
  k.add(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 10), M.white, 0.1, 0.7, -0.75);

  // MMRTG: inclined cylinder with eight radiator fins.
  const rtg = k.group(0, 0.45, -1.1);
  rtg.rotation.x = 0.55;
  k.add(new THREE.CylinderGeometry(0.17, 0.17, 0.66, 16), rtgMat, 0, 0, 0, rtg);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const f = k.box(0.01, 0.62, 0.17, rtgMat, Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25, rtg);
    f.rotation.y = -a;
  }
  // Heat-exchanger plates on the rear.
  k.box(1.0, 0.35, 0.03, M.alu, 0, 0.3, -0.94);

  // Remote Sensing Mast at the front right: 2.1 m above ground.
  const mastBase = k.group(-0.4, 0.55, 0.78);
  k.add(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 12), M.white, 0, 0.05, 0, mastBase);
  const mastYaw = k.group(0, 0.1, 0, mastBase);
  k.add(new THREE.CylinderGeometry(0.045, 0.05, 0.85, 12), M.white, 0, 0.43, 0, mastYaw);
  const headYaw = k.group(0, 0.9, 0, mastYaw);
  const head = k.group(0, 0, 0, headYaw);
  // ChemCam/SuperCam body: the big box with a round telescope.
  k.box(0.26, 0.22, 0.3, M.white, 0, 0.06, -0.02, head);
  const tel = k.add(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 20), M.black, 0, 0.08, 0.14, head);
  tel.rotation.x = Math.PI / 2;
  k.add(new THREE.CircleGeometry(perse ? 0.055 : 0.045, 20), M.lens, 0, 0.08, 0.161, head);
  // Mastcam(-Z) pair and the Navcam pairs.
  for (const sx of [0.09, -0.09]) {
    k.box(0.07, 0.07, 0.12, M.darkAnod, sx, -0.09, 0.05, head);
    k.add(new THREE.CircleGeometry(0.022, 14), M.lens, sx, -0.09, 0.111, head);
  }
  for (const sx of [0.17, 0.12, -0.12, -0.17]) {
    k.box(0.04, 0.04, 0.06, M.black, sx, -0.02, 0.07, head);
    k.add(new THREE.CircleGeometry(0.012, 10), M.lens, sx, -0.02, 0.101, head);
  }
  if (perse) k.add(new THREE.CylinderGeometry(0.015, 0.015, 0.25, 8), M.white, 0.12, 0.3, -0.1, head); // SuperCam microphone boom/weather sensor

  // Robotic arm: shoulder at the front, stowed folded across the front.
  const armBase = k.group(0.35, 0.3, 1.0);
  const sh = k.group(0, 0, 0, armBase);
  k.add(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 12), M.white, 0, 0, 0, sh).rotation.z = Math.PI / 2;
  const upper = k.group(0, 0, 0, sh);
  k.tube(V(0, 0, 0), V(-0.8, 0.0, 0.08), 0.04, M.white, upper);
  const elbow = k.group(-0.8, 0, 0.08, upper);
  k.add(new THREE.SphereGeometry(0.06, 12, 8), M.white, 0, 0, 0, elbow);
  k.tube(V(0, 0, 0), V(0.55, 0.15, 0.1), 0.035, M.white, elbow);
  const wrist = k.group(0.55, 0.15, 0.1, elbow);
  const turret = k.group(0, 0, 0, wrist);
  k.add(new THREE.CylinderGeometry(0.16, 0.16, 0.2, 10), perse ? M.white : M.anod, 0, 0, 0, turret);
  k.add(new THREE.CylinderGeometry(0.02, 0.02, perse ? 0.35 : 0.2, 8), M.titanium, 0, -0.2, 0.12, turret);
  k.box(0.1, 0.12, 0.1, M.gold, 0.14, 0, 0, turret);

  // Rocker-bogie (with the differential bar across the deck).
  const susp = k.group();
  const links = [
    new RockerBogie(susp, M.titanium, M.darkAnod, [0, 2, 4], V(0.66, 0.2, 0.3), 0.04, 0.36, 0.1),
    new RockerBogie(susp, M.titanium, M.darkAnod, [1, 3, 5], V(-0.66, 0.2, 0.3), 0.04, 0.36, 0.1),
  ];
  k.tube(V(-0.6, 0.6, 0.35), V(0.6, 0.6, 0.35), 0.02, M.titanium);

  const wheels = MSL_WHEELS.map(([x, z]) => {
    const wv = wheelSlot(root, x, MSL_AXLE, z);
    rigidWheel(k, wv.spin, {
      r: R, w: 0.4, rim: M.alu, hub: M.titanium, grousers: perse ? 48 : 24, grouserH: 0.0075 * 2,
      chevron: perse ? 0.12 : 0.45, spokes: 6, curvedSpokes: true, outward: Math.sign(x), holes: !perse,
    });
    bakeByMaterial(wv.spin, new Set());
    return wv;
  });
  const lights = addLights(k, root, M, [[0.3, 0.2, 0.95], [-0.3, 0.2, 0.95]], 100);
  bakeByMaterial(root, new Set<THREE.Object3D>([hgaBase, mastBase, armBase, susp, ...wheels.map((w) => w.steer)]));

  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0, -0.02, 0.12);
  head.add(cockpitAnchor);

  let armT = 0;
  return {
    root,
    wheels,
    cockpitAnchor,
    lights: lights.lights,
    setHeadlights: lights.set,
    setSteering() {},
    animate(st: RoverAnimState) {
      for (const l of links) l.update(st.wheelLocal);
      const yawT = st.preview ? Math.sin(st.time * 0.35) * 1.4 : st.lookYaw;
      const pitchT = st.preview ? Math.sin(st.time * 0.27) * 0.3 - 0.15 : st.lookPitch;
      mastYaw.rotation.y = approach(mastYaw.rotation.y, yawT, 5, st.dt);
      head.rotation.x = approach(head.rotation.x, -pitchT, 5, st.dt);
      // Arm: unstows to place the turret on the ground ahead when parked a while (and in the preview).
      armT = approach(armT, st.parked || st.preview ? (st.preview ? 0.5 + 0.5 * Math.sin(st.time * 0.4) : 1) : 0, 0.8, st.dt);
      sh.rotation.y = -armT * 1.2;
      sh.rotation.z = armT * 0.35;
      elbow.rotation.y = armT * 1.6;
      wrist.rotation.x = armT * 0.9;
      turret.rotation.y = st.time * 0.3 * armT;
      hga.rotation.x = approach(hga.rotation.x, -0.6 + Math.sin(st.time * 0.05) * 0.2, 0.3, st.dt);
      hgaBase.rotation.y = approach(hgaBase.rotation.y, 0.8 + Math.sin(st.time * 0.04) * 0.3, 0.3, st.dt);
    },
  };
}
