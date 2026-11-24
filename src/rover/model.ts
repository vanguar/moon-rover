import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { InstrumentPanel } from './InstrumentPanel';
import { approach, bakeByMaterial, canvasTex, type RoverAnimState, type RoverModel, type WheelVisual } from './models/kit';

export const WHEEL_VIS_R = 0.409;

/** Box with rounded edges (real panels and boxes have bent edges and radii, not knife edges). */
function rbox(w: number, h: number, d: number): THREE.BufferGeometry {
  const r = Math.min(0.025, Math.min(w, h, d) * 0.3);
  return r < 0.002 ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, 3, r);
}
/** LRV: four wheels, wheelbase 2.29 m, track 1.83 m. */
export const LRV_WHEELS: [number, number][] = [[0.915, 1.145], [-0.915, 1.145], [0.915, -1.145], [-0.915, -1.145]];

/** Woven piano-wire mesh (LRV tyre, HGA reflector). alphaMap reads the green channel. */
function weaveTexture(cells: number): THREE.CanvasTexture {
  const t = canvasTex(128, 128, (g) => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    const s = 128 / cells;
    for (let i = -cells; i <= cells * 2; i++) {
      g.beginPath();
      g.moveTo(i * s, 0);
      g.lineTo(i * s + 128, 128);
      g.stroke();
      g.beginPath();
      g.moveTo(i * s, 128);
      g.lineTo(i * s + 128, 0);
      g.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Deforming wheel material: the wire-mesh tyre flattens against the ground
 * under load (vertices past the contact plane are projected onto it).
 */
function deformable<T extends THREE.Material>(mat: T, u: NonNullable<WheelVisual['uniforms']>): T {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uCenter;\nuniform vec3 uDown;\nuniform float uDefl;')
      .replace(
        '#include <project_vertex>',
        `vec4 wpF = modelMatrix * vec4( transformed, 1.0 );
float dd = dot( wpF.xyz - uCenter, uDown );
float lim = ${WHEEL_VIS_R.toFixed(3)} - uDefl;
if ( dd > lim ) wpF.xyz -= uDown * ( dd - lim );
vec4 mvPosition = viewMatrix * wpF;
gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  mat.customProgramCacheKey = () => 'wheel-deform';
  return mat;
}

/** Lunar Roving Vehicle-style rover. Local frame: +z forward, +x left, +y up. */
export function buildLrvModel(): RoverModel {
  const root = new THREE.Group();

  // PBR metals; they reflect the sunlit regolith via the scene environment map.
  const alu = new THREE.MeshStandardMaterial({ color: 0xb9bdc1, metalness: 0.9, roughness: 0.35 });
  const anod = new THREE.MeshStandardMaterial({ color: 0x6e7378, metalness: 0.7, roughness: 0.45 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xe0a94a, metalness: 1, roughness: 0.18 });
  const mylar = new THREE.MeshStandardMaterial({ color: 0xf2f2f4, metalness: 1, roughness: 0.08 });
  const whitePaint = new THREE.MeshStandardMaterial({ color: 0xe9e7e2, metalness: 0, roughness: 0.55 });
  const mirror = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.02 });
  const fenderMat = new THREE.MeshStandardMaterial({ color: 0x9ea6ae, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
  const webbing = new THREE.MeshStandardMaterial({ color: 0x6f7c88, metalness: 0, roughness: 0.95, side: THREE.DoubleSide });
  const black = new THREE.MeshStandardMaterial({ color: 0x141516, metalness: 0.2, roughness: 0.7 });
  const lens = new THREE.MeshStandardMaterial({ color: 0x101820, metalness: 0.3, roughness: 0.05 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xfff2d8, emissiveIntensity: 0 });
  const hgaWeave = weaveTexture(10);
  hgaWeave.repeat.set(6, 3);
  const hgaMesh = new THREE.MeshStandardMaterial({
    color: 0xe3b25c, metalness: 1, roughness: 0.3, alphaMap: hgaWeave, alphaTest: 0.5, side: THREE.DoubleSide,
  });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, parent: THREE.Object3D = root) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const m = add(new THREE.CylinderGeometry(r, r, d.length(), 16), mat, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, parent);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // ---- Chassis: aluminium tube frame in three sections, floor panels.
  for (const sx of [-0.62, 0.62]) tube(V(sx, -0.08, -1.55), V(sx, -0.08, 1.55), 0.025, alu);
  for (const z of [-1.55, -0.75, 0, 0.75, 1.55]) tube(V(-0.66, -0.08, z), V(0.66, -0.08, z), 0.02, alu);
  add(rbox(1.2, 0.012, 1.4), anod, 0, -0.1, -0.05);
  // Suspension wishbones and dampers to each wheel.
  for (const [x, z] of LRV_WHEELS) {
    const sx = Math.sign(x);
    tube(V(sx * 0.62, -0.06, z + 0.18), V(sx * 0.78, -0.2, z), 0.018, alu);
    tube(V(sx * 0.62, -0.06, z - 0.18), V(sx * 0.78, -0.2, z), 0.018, alu);
    tube(V(sx * 0.62, 0.06, z), V(sx * 0.76, -0.12, z), 0.014, anod);
  }

  // ---- Forward chassis: batteries & signal processor in MLI, LCRU on the front.
  add(rbox(1.1, 0.26, 0.55), gold, 0, 0.06, 1.2);
  add(rbox(0.45, 0.2, 0.42), mylar, 0.3, 0.29, 1.18);
  add(rbox(0.45, 0.2, 0.42), mylar, -0.3, 0.29, 1.18);
  // Battery radiator mirrors (second-surface mirrors -> strong sun glints).
  add(rbox(0.4, 0.01, 0.37), mirror, 0.3, 0.395, 1.18);
  add(rbox(0.4, 0.01, 0.37), mirror, -0.3, 0.395, 1.18);
  // LCRU communications relay.
  add(rbox(0.55, 0.32, 0.24), whitePaint, 0, 0.36, 1.5);
  add(rbox(0.5, 0.012, 0.2), mirror, 0, 0.525, 1.5);
  // Low-gain helical antenna (front right, outboard).
  tube(V(-0.68, 0.3, 1.35), V(-0.7, 1.0, 1.36), 0.012, alu);
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 10), mylar, -0.7, 1.25, 1.36);
  // High-gain umbrella antenna (front left): gold-plated wire-mesh reflector on ribs.
  tube(V(-0.5, 0.52, 1.5), V(-0.52, 2.05, 1.5), 0.016, alu);
  const hga = new THREE.Group();
  hga.position.set(-0.52, 2.08, 1.52);
  hga.rotation.set(-1.15, -0.6, 0);
  root.add(hga);
  add(new THREE.SphereGeometry(0.62, 24, 6, 0, Math.PI * 2, 0, 0.82), hgaMesh, 0, -0.5, 0, hga);
  hga.scale.setScalar(0.455 / (0.62 * Math.sin(0.82)));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const p = V(Math.sin(0.82) * 0.62 * Math.cos(a), Math.cos(0.82) * 0.62 - 0.5, Math.sin(0.82) * 0.62 * Math.sin(a));
    tube(V(0, 0.12, 0), p, 0.006, alu, hga);
  }
  tube(V(0, 0.12, 0), V(0, 0.32, 0), 0.01, alu, hga);
  // TV camera (GCTA) on its mast: pan/tilt head, white body with mirror radiator, lens and sunshade.
  tube(V(-0.12, 0.52, 1.58), V(-0.12, 1.12, 1.6), 0.022, alu);
  const tvHead = new THREE.Group();
  tvHead.position.set(-0.12, 1.15, 1.6);
  root.add(tvHead);
  add(new THREE.CylinderGeometry(0.045, 0.05, 0.07, 14), anod, 0, 0, 0, tvHead);
  const tvBody = new THREE.Group();
  tvBody.position.set(0, 0.1, 0);
  tvBody.rotation.x = 0.1;
  tvHead.add(tvBody);
  add(rbox(0.13, 0.12, 0.3), whitePaint, 0, 0, 0, tvBody);
  add(rbox(0.135, 0.004, 0.25), mirror, 0, 0.062, -0.01, tvBody);
  const barrel = add(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 16), black, 0, 0, 0.2, tvBody);
  barrel.rotation.x = Math.PI / 2;
  const hood = add(new THREE.CylinderGeometry(0.055, 0.04, 0.08, 16, 1, true), black, 0, 0, 0.29, tvBody);
  hood.rotation.x = Math.PI / 2;
  const glass = add(new THREE.CircleGeometry(0.03, 16), lens, 0, 0, 0.262, tvBody);
  glass.castShadow = false;

  // ---- Centre chassis: two seats (tubular frames + nylon webbing), footrests.
  for (const sx of [0.4, -0.4]) {
    add(rbox(0.48, 0.012, 0.46), webbing, sx, 0.2, -0.32);
    const back = add(rbox(0.48, 0.5, 0.012), webbing, sx, 0.47, -0.6);
    back.rotation.x = 0.22;
    tube(V(sx - 0.25, 0.2, -0.1), V(sx - 0.25, 0.2, -0.56), 0.014, alu);
    tube(V(sx + 0.25, 0.2, -0.1), V(sx + 0.25, 0.2, -0.56), 0.014, alu);
    tube(V(sx - 0.25, 0.2, -0.56), V(sx - 0.25, 0.72, -0.66), 0.014, alu);
    tube(V(sx + 0.25, 0.2, -0.56), V(sx + 0.25, 0.72, -0.66), 0.014, alu);
    tube(V(sx - 0.25, 0.72, -0.66), V(sx + 0.25, 0.72, -0.66), 0.014, alu);
    for (const leg of [-0.22, 0.22]) tube(V(sx + leg, -0.08, -0.12), V(sx + leg, 0.2, -0.12), 0.014, alu);
    add(rbox(0.36, 0.02, 0.18), anod, sx, -0.02, 0.38).rotation.x = -0.5;
    tube(V(sx - 0.22, 0.25, -0.45), V(sx + 0.2, 0.3, -0.2), 0.012, webbing);
  }
  // Armrest between the seats, carrying the hand controller.
  tube(V(0, 0.2, -0.55), V(0, 0.36, 0.0), 0.02, alu);
  const stick = new THREE.Group();
  stick.position.set(0.12, 0.38, 0.0);
  root.add(stick);
  add(rbox(0.08, 0.05, 0.1), anod, 0, -0.03, 0, stick);
  add(new THREE.CylinderGeometry(0.014, 0.014, 0.2), black, 0, 0.1, 0, stick);
  const tbar = add(new THREE.CylinderGeometry(0.016, 0.016, 0.14), black, 0, 0.2, 0, stick);
  tbar.rotation.z = Math.PI / 2;

  // ---- Control & Display Console on its post, angled toward the crew.
  tube(V(0, -0.08, 0.6), V(0, 0.72, 0.52), 0.025, alu);
  const panel = new InstrumentPanel();
  panel.group.position.set(0.06, 0.9, 0.5);
  // Face toward the crew (the panel's front is its +z).
  panel.group.rotation.set(-0.4, Math.PI - 0.35, 0, 'YXZ');
  root.add(panel.group);

  // ---- Aft chassis: tool & sample pallet, sample bags, gnomon and tongs.
  add(rbox(1.3, 0.3, 0.55), gold, 0, 0.08, -1.3);
  add(rbox(1.25, 0.04, 0.5), alu, 0, 0.25, -1.3);
  for (const [x, z] of [[-0.35, -1.25], [0.0, -1.35], [0.35, -1.25]] as const) add(rbox(0.28, 0.3, 0.2), webbing, x, 0.42, z);
  tube(V(0.55, 0.25, -1.5), V(0.62, 1.2, -1.6), 0.01, alu);
  tube(V(-0.5, 0.25, -1.55), V(-0.55, 0.95, -1.6), 0.008, alu);

  // (The second seat stays empty: a stand-in figure looked worse than none.)

  // ---- Wheels: woven wire-mesh tyre, titanium chevrons, inner bump-stop frame,
  // spun-aluminium hub disc, traction drive; a fender above each.
  const wheelPos = LRV_WHEELS;
  const weave = weaveTexture(8);
  weave.repeat.set(40, 3); // 0.83 mm zinc-coated piano wire, woven in a fine diamond pattern
  const tireGeo = new THREE.CylinderGeometry(WHEEL_VIS_R, WHEEL_VIS_R, 0.23, 72, 3, true);
  tireGeo.rotateZ(Math.PI / 2);
  const bumpGeo = new THREE.CylinderGeometry(0.31, 0.31, 0.18, 64, 1, true);
  bumpGeo.rotateZ(Math.PI / 2);
  const flangeGeo = new THREE.TorusGeometry(WHEEL_VIS_R - 0.004, 0.01, 8, 96);
  flangeGeo.rotateY(Math.PI / 2);
  const hubDisc = new THREE.LatheGeometry(
    [new THREE.Vector2(0.001, 0.06), new THREE.Vector2(0.1, 0.055), new THREE.Vector2(0.2, 0.03), new THREE.Vector2(0.3, 0.0), new THREE.Vector2(0.39, -0.02)],
    64,
  );
  hubDisc.rotateZ(-Math.PI / 2);
  const driveGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.16, 40);
  driveGeo.rotateZ(Math.PI / 2);
  // V-shaped chevron: two titanium strips across the tread.
  const chevGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      // Titanium chevrons cover ~50 % of the tread (LRV Operations Handbook): wide strips.
      const b = new THREE.BoxGeometry(0.125, 0.008, 0.055, 4, 1, 2);
      b.rotateY(s * 0.5);
      b.translate(s * 0.052, WHEEL_VIS_R + 0.004, s * -0.018);
      parts.push(b);
    }
    return mergeGeometries(parts)!;
  })();
  const blurGeo = new THREE.CylinderGeometry(WHEEL_VIS_R + 0.012, WHEEL_VIS_R + 0.012, 0.235, 48, 1, true);
  blurGeo.rotateZ(Math.PI / 2);
  const blurTex = canvasTex(16, 64, (g) => {
    // Motion-smeared tread: chevrons averaged into soft bands across the width.
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0, 'rgba(150,150,150,0.0)');
    grd.addColorStop(0.15, 'rgba(165,165,165,0.9)');
    grd.addColorStop(0.5, 'rgba(120,120,125,0.75)');
    grd.addColorStop(0.85, 'rgba(165,165,165,0.9)');
    grd.addColorStop(1, 'rgba(150,150,150,0.0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 16, 64);
  });

  const wheels: WheelVisual[] = wheelPos.map(([x, z]) => {
    const steer = new THREE.Group();
    steer.position.set(x, -0.35, z);
    root.add(steer);
    const spin = new THREE.Group();
    steer.add(spin);
    const uniforms = { uCenter: { value: new THREE.Vector3() }, uDown: { value: new THREE.Vector3(0, -1, 0) }, uDefl: { value: 0.02 } };
    const tireMat = deformable(
      new THREE.MeshStandardMaterial({ color: 0xb3b0a8, metalness: 0.8, roughness: 0.5, alphaMap: weave, alphaTest: 0.45, alphaToCoverage: true, side: THREE.DoubleSide }),
      uniforms,
    );
    // Opaque: transparent chevrons over the alpha-tested wire mesh flickered (sorting).
    const chevronMat = deformable(new THREE.MeshStandardMaterial({ color: 0x9c9da1, metalness: 0.8, roughness: 0.35 }), uniforms);
    const flangeMat = deformable(new THREE.MeshStandardMaterial({ color: 0xb8b9bc, metalness: 0.85, roughness: 0.3 }), uniforms);
    add(tireGeo, tireMat, 0, 0, 0, spin);
    add(bumpGeo, anod, 0, 0, 0, spin);
    add(flangeGeo, flangeMat, 0.115, 0, 0, spin);
    add(flangeGeo, flangeMat, -0.115, 0, 0, spin);
    const outward = Math.sign(x);
    const disc = add(hubDisc, alu, outward * 0.02, 0, 0, spin);
    if (outward < 0) disc.rotation.y = Math.PI;
    add(driveGeo, anod, -outward * 0.06, 0, 0, spin);
    const chevs: THREE.BufferGeometry[] = [];
    const m4 = new THREE.Matrix4();
    for (let k = 0; k < 18; k++) chevs.push(chevGeo.clone().applyMatrix4(m4.makeRotationX((k / 18) * Math.PI * 2)));
    add(mergeGeometries(chevs)!, chevronMat, 0, 0, 0, spin);
    const blurMat = new THREE.MeshBasicMaterial({ map: blurTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
    const blur = add(blurGeo, blurMat, 0, 0, 0, steer);
    blur.castShadow = false;
    // Fender covering the top 150° of the wheel.
    const f = add(new THREE.CylinderGeometry(0.47, 0.47, 0.32, 48, 1, true, Math.PI * 0.08, Math.PI * 0.84), fenderMat, x, -0.33, z);
    f.rotation.set(0, 0, Math.PI / 2);
    return { steer, spin, uniforms, blurMat, chevronMat };
  });

  // ---- Headlights (not on the real LRV; a game concession) at the front corners.
  const lights: THREE.SpotLight[] = [];
  for (const sx of [0.5, -0.5]) {
    add(rbox(0.14, 0.09, 0.07), black, sx, 0.2, 1.5);
    const l = add(new THREE.CircleGeometry(0.04, 16), lampMat, sx, 0.2, 1.536);
    l.castShadow = false;
    const s = new THREE.SpotLight(0xfff2d8, 0, 120, 0.5, 0.55, 2);
    s.position.set(sx, 0.2, 1.56);
    s.target.position.set(sx * 1.6, -1.0, 22);
    s.castShadow = false;
    root.add(s, s.target);
    lights.push(s);
  }

  // Merge static parts per material (hundreds of meshes -> a handful of draw calls).
  bakeByMaterial(root, new Set<THREE.Object3D>([stick, panel.group, tvHead, ...wheels.map((w) => w.steer)]));
  for (const w of wheels) bakeByMaterial(w.spin, new Set());

  const cockpitAnchor = new THREE.Object3D();
  cockpitAnchor.position.set(0.4, 1.22, -0.34);
  root.add(cockpitAnchor);

  return {
    root,
    wheels,
    cockpitAnchor,
    lights,
    panel,
    setHeadlights(on: boolean) {
      for (const l of lights) l.intensity = on ? 140 : 0;
      lampMat.emissiveIntensity = on ? 6 : 0;
    },
    setSteering(a: number) {
      stick.rotation.z = -a * 0.6;
    },
    animate(st: RoverAnimState) {
      // GCTA TV camera: slow survey pan when parked (it was driven from Houston), forward while driving.
      const pan = st.parked || st.preview ? Math.sin(st.time * 0.25) * 1.1 : 0;
      tvHead.rotation.y = approach(tvHead.rotation.y, pan, 1.5, st.dt);
      tvBody.rotation.x = approach(tvBody.rotation.x, st.parked || st.preview ? 0.1 + Math.sin(st.time * 0.17) * 0.15 : 0.1, 1.5, st.dt);
    },
  };
}
