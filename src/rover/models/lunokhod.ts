import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addLights, approach, bakeByMaterial, Kit, materials, solarMaterial, V, wheelSlot, type RoverAnimState, type RoverModel } from './kit';

export const LUNOKHOD_WHEELS: [number, number][] = [
  [0.8, 1.1], [-0.8, 1.1], [0.8, 0.37], [-0.8, 0.37], [0.8, -0.37], [-0.8, -0.37], [0.8, -1.1], [-0.8, -1.1],
];
export const LUNOKHOD_R = 0.255;
export const LUNOKHOD_AXLE = -0.3;

/**
 * Lunokhod-1 (1970): pressurised magnesium "tub" on an eight-wheel chassis, each
 * wheel with its own motor; the convex lid carries solar cells on its inside and
 * opens for charging; polonium-210 heater at the back, laser retroreflector and
 * TV cameras at the front, narrow-beam helical antenna aimed at Earth, and the
 * free-rolling ninth wheel that measured distance.
 */
export function buildLunokhodModel(): RoverModel {
  const root = new THREE.Group();
  const k = new Kit(root);
  const M = materials();
  const tubMat = new THREE.MeshStandardMaterial({ color: 0xd9d5cc, metalness: 0.35, roughness: 0.45 });
  const radiator = new THREE.MeshStandardMaterial({ color: 0xe8e8ea, metalness: 0.9, roughness: 0.15 });
  const cells = solarMaterial(14, 14, '#1d2c64', '#6c7790');
  cells.side = THREE.DoubleSide;

  // ---- Chassis frame and wheel levers.
  for (const sx of [-0.62, 0.62]) k.tube(V(sx, -0.1, -1.2), V(sx, -0.1, 1.2), 0.03, M.alu);
  for (const z of [-1.2, -0.37, 0.37, 1.2]) k.tube(V(-0.62, -0.1, z), V(0.62, -0.1, z), 0.025, M.alu);
  for (const [x, z] of LUNOKHOD_WHEELS) {
    const s = Math.sign(x);
    k.tube(V(s * 0.62, -0.1, z), V(s * 0.72, LUNOKHOD_AXLE, z), 0.028, M.alu);
    k.add(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 12), M.anod, s * 0.66, -0.12, z).rotation.z = Math.PI / 2;
  }

  // ---- Instrument compartment: truncated cone tub, wider at the top.
  const tub = new THREE.LatheGeometry(
    [V(0.001, 0, 0), V(0.72, 0, 0), V(0.86, 0.25, 0), V(1.02, 0.62, 0), V(1.08, 0.72, 0), V(0.001, 0.72, 0)].map((v) => new THREE.Vector2(v.x, v.y)),
    40,
  );
  const tubM = k.add(tub, tubMat, 0, -0.02, 0);
  tubM.scale.set(0.78, 1, 1.0);
  // Equipment bands and bolted rings.
  k.add(new THREE.TorusGeometry(1.05, 0.02, 6, 48), M.alu, 0, 0.66, 0).rotation.x = Math.PI / 2;
  k.add(new THREE.TorusGeometry(0.8, 0.018, 6, 48), M.alu, 0, 0.2, 0).rotation.x = Math.PI / 2;
  root.children[root.children.length - 1].scale.set(0.78, 1, 1);
  root.children[root.children.length - 2].scale.set(0.78, 1, 1);
  // Radiator disc on top of the tub (dissipates heat when the lid is open).
  k.add(new THREE.CylinderGeometry(1.0, 1.0, 0.03, 40), radiator, 0, 0.715, 0).scale.set(0.78, 1, 1);

  // ---- Lid: shallow dome, hinged at the rear edge; solar cells inside.
  const hinge = k.group(0, 0.74, -1.02);
  const lid = new THREE.Group();
  lid.position.set(0, 0, 1.02);
  hinge.add(lid);
  // Shallow spherical cap: 2.6 m radius, 1.01 m rim radius, 0.2 m high.
  const dome = new THREE.SphereGeometry(2.6, 40, 6, 0, Math.PI * 2, 0, 0.4);
  dome.translate(0, -2.6 * Math.cos(0.4), 0);
  const outer = k.add(dome, tubMat, 0, 0, 0, lid);
  outer.scale.set(0.8, 1, 1.05);
  // Cells face down when the lid is closed (onto the radiator), toward the Sun when open.
  const inner = new THREE.CircleGeometry(2.6 * Math.sin(0.4) * 0.97, 40);
  inner.rotateX(Math.PI / 2);
  const panel = k.add(inner, cells, 0, -0.004, 0, lid);
  panel.scale.set(0.8, 1, 1.05);
  k.add(new THREE.TorusGeometry(2.6 * Math.sin(0.4), 0.025, 6, 48), M.alu, 0, 0, 0, lid).rotation.x = Math.PI / 2;
  lid.children[lid.children.length - 1].scale.set(0.8, 1.05, 1);
  // Hinge arms.
  for (const sx of [-0.35, 0.35]) k.box(0.05, 0.05, 0.25, M.alu, sx, 0, 0.1, hinge);

  // ---- Front: laser retroreflector (French), two TV cameras, stereo photo-cameras, low-gain cones.
  const refl = k.group(0, 0.38, 1.0);
  refl.rotation.x = -0.35;
  k.box(0.44, 0.2, 0.04, M.alu, 0, 0, 0, refl);
  const cube = new THREE.CircleGeometry(0.03, 6);
  const cubes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 14; i++) {
    const g = cube.clone();
    g.translate(-0.18 + (i % 7) * 0.06, i < 7 ? 0.045 : -0.045, 0.021);
    cubes.push(g);
  }
  k.add(mergeGeometries(cubes)!, M.mirror, 0, 0, 0, refl);
  for (const sx of [0.18, -0.18]) {
    const cam = k.add(new THREE.CylinderGeometry(0.05, 0.05, 0.2, 14), M.white, sx, 0.15, 0.98);
    cam.rotation.x = Math.PI / 2;
    k.add(new THREE.CircleGeometry(0.035, 14), M.lens, sx, 0.15, 1.081);
  }
  // Low-gain cone antenna (front left) and whip antennas.
  k.tube(V(0.55, 0.5, 0.8), V(0.62, 1.05, 0.85), 0.012, M.alu);
  const cone = k.add(new THREE.ConeGeometry(0.09, 0.28, 16, 1, true), M.alu, 0.62, 1.2, 0.85);
  cone.rotation.x = Math.PI;
  (cone.material as THREE.Material).side = THREE.DoubleSide;
  k.tube(V(-0.6, 0.55, 0.6), V(-0.75, 1.5, 0.55), 0.006, M.alu);
  k.tube(V(0.6, 0.55, -0.6), V(0.72, 1.4, -0.65), 0.006, M.alu);

  // ---- Narrow-beam helical antenna on a two-axis mount (aimed at Earth).
  const antBase = k.group(-0.55, 0.72, 0.55);
  k.add(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 12), M.anod, 0, 0.06, 0, antBase);
  const antYaw = k.group(0, 0.14, 0, antBase);
  const antTilt = k.group(0, 0, 0, antYaw);
  const helixPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * Math.PI * 2 * 9;
    helixPts.push(V(Math.cos(a) * 0.045, 0.06 + (i / 120) * 0.62, Math.sin(a) * 0.045));
  }
  k.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helixPts), 360, 0.006, 4), M.copper, 0, 0, 0, antTilt);
  k.add(new THREE.CylinderGeometry(0.012, 0.012, 0.75, 6), M.white, 0, 0.38, 0, antTilt);
  k.add(new THREE.CylinderGeometry(0.11, 0.11, 0.015, 20), M.alu, 0, 0.05, 0, antTilt);

  // ---- Rear: radioisotope heater unit and the ninth (odometer) wheel.
  const heater = k.add(new THREE.CylinderGeometry(0.12, 0.12, 0.42, 16), M.darkAnod, 0, 0.32, -1.0);
  heater.rotation.x = Math.PI / 2;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.box(0.006, 0.08, 0.4, M.alu, Math.cos(a) * 0.15, 0.32 + Math.sin(a) * 0.15, -1.0).rotation.z = a;
  }
  const ninthArm = k.group(0, -0.1, -1.2);
  k.tube(V(0, 0, 0), V(0, -0.27, -0.42), 0.015, M.alu, ninthArm);
  const ninth = k.group(0, -0.27, -0.42, ninthArm);
  const nw = new THREE.CylinderGeometry(0.11, 0.11, 0.05, 20);
  nw.rotateZ(Math.PI / 2);
  k.add(nw, M.alu, 0, 0, 0, ninth);
  for (let i = 0; i < 6; i++) k.box(0.01, 0.2, 0.012, M.black, 0, 0, 0, ninth).rotation.x = (i / 6) * Math.PI;

  // ---- Wheels: wire-mesh rims with titanium grousers, three rings, spokes, hub motor.
  const meshTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, 64, 64);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    for (let i = -8; i < 16; i++) {
      g.beginPath();
      g.moveTo(i * 8, 0);
      g.lineTo(i * 8 + 64, 64);
      g.stroke();
      g.beginPath();
      g.moveTo(i * 8, 64);
      g.lineTo(i * 8 + 64, 0);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(22, 2);
    return t;
  })();
  const meshMat = new THREE.MeshStandardMaterial({ color: 0xa8a8a2, metalness: 0.85, roughness: 0.4, alphaMap: meshTex, alphaTest: 0.45, side: THREE.DoubleSide });
  const R = LUNOKHOD_R, W = 0.2;
  const wheels = LUNOKHOD_WHEELS.map(([x, z]) => {
    const wv = wheelSlot(root, x, LUNOKHOD_AXLE, z);
    const sp = wv.spin;
    const tyre = new THREE.CylinderGeometry(R - 0.012, R - 0.012, W, 40, 1, true);
    tyre.rotateZ(Math.PI / 2);
    k.add(tyre, meshMat, 0, 0, 0, sp);
    for (const ox of [-W / 2, 0, W / 2]) k.add(new THREE.TorusGeometry(R - 0.012, 0.009, 6, 40), M.alu, ox, 0, 0, sp).rotation.y = Math.PI / 2;
    const lugs: THREE.BufferGeometry[] = [];
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 20; i++) {
      const g = new THREE.BoxGeometry(W * 0.95, 0.024, 0.012);
      g.translate(0, R - 0.01, 0);
      lugs.push(g.applyMatrix4(m4.makeRotationX((i / 20) * Math.PI * 2)));
    }
    k.add(mergeGeometries(lugs)!, M.titanium, 0, 0, 0, sp);
    const s = Math.sign(x);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      k.tube(V(s * 0.05, Math.cos(a) * 0.05, Math.sin(a) * 0.05), V(s * 0.09, Math.cos(a) * (R - 0.02), Math.sin(a) * (R - 0.02)), 0.008, M.alu, sp);
    }
    const hub = new THREE.CylinderGeometry(0.07, 0.07, 0.16, 16);
    hub.rotateZ(Math.PI / 2);
    k.add(hub, M.cream, 0, 0, 0, sp);
    const cap = new THREE.ConeGeometry(0.055, 0.1, 16);
    cap.rotateZ(-s * Math.PI / 2);
    k.add(cap, M.cream, s * 0.12, 0, 0, sp);
    bakeByMaterial(sp, new Set());
    return wv;
  });

  const lights = addLights(k, root, M, [[0.4, 0.05, 1.08], [-0.4, 0.05, 1.08]], 110);

  bakeByMaterial(root, new Set<THREE.Object3D>([hinge, antBase, ninthArm, ...wheels.map((w) => w.steer)]));

  // Driver's view: the forward TV camera pair, 1.0 m above the ground.
  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0, 0.2, 1.12);
  root.add(cockpitAnchor);

  let lidA = 0;
  let roll = 0;
  return {
    root,
    wheels,
    cockpitAnchor,
    lights: lights.lights,
    setHeadlights: lights.set,
    setSteering() {},
    animate(st: RoverAnimState) {
      // Lid: closed for travel at speed, open (≈ 105°) to charge when stopped; always open in the preview.
      const open = st.preview ? (Math.sin(st.time * 0.35) > -0.6 ? 1 : 0) : Math.abs(st.speed) < 0.4 ? 1 : 0.55;
      lidA = approach(lidA, open * 1.85, 0.9, st.dt);
      hinge.rotation.x = -lidA;
      // Antenna tracks Earth: slow corrections relative to the body.
      antYaw.rotation.y = approach(antYaw.rotation.y, 0.6 + Math.sin(st.time * 0.08) * 0.3, 0.5, st.dt);
      antTilt.rotation.x = approach(antTilt.rotation.x, -0.25 + Math.sin(st.time * 0.11) * 0.1, 0.5, st.dt);
      // Ninth wheel rolls on the ground behind the rover.
      roll += (st.speed / 0.11) * st.dt;
      ninth.rotation.x = roll;
    },
  };
}
