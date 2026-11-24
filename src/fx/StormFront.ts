import * as THREE from 'three';

/**
 * The leading edge of a regional dust storm, seen from the ground as it comes in.
 *
 * Orbiters (MGS MOC, MRO MARCI) show Martian storm fronts as sharp-edged walls of
 * dust with convective billows on top, lofting dust kilometres high and moving at
 * 10–30 m/s. Drawn here as a curved wall around the camera at the front's distance:
 * cauliflower lobes from 3-D noise, churning and rolling, lit like a cloud (sunlit
 * tops, dark undersides), fading into the haze with distance.
 *
 * Lightning: discharges inside the cloud and now and then to the ground. Triboelectric
 * charging of dust is real and discharges have been proposed for Martian storms, but
 * none has been observed - a game liberty, noted in docs/REALISM.md.
 */
const ARC = THREE.MathUtils.degToRad(220);
/** Wall height, m (billow tops vary around it). */
const HEIGHT = 2200;
const BOLT_SEGS = 160;

interface Flash {
  t: number;
  pulses: number[];
  /** World angle from the camera and height of the discharge in the cloud. */
  ang: number;
  h: number;
  ground: boolean;
  /** Strike point on the ground (strikes inside the front zone), with its ground height. */
  at?: { x: number; z: number; gy: number };
}

export class StormFront {
  readonly group = new THREE.Group();
  private wall: THREE.Mesh;
  /** Lightning channel: one camera-facing quad per segment (a 1-px line is lost in the haze). */
  private bolt: THREE.Mesh;
  private boltPos = new Float32Array(BOLT_SEGS * 4 * 3);
  private boltOther = new Float32Array(BOLT_SEGS * 4 * 3);
  private boltB = new Float32Array(BOLT_SEGS * 4);
  readonly uniforms: Record<string, THREE.IUniform>;
  /** Lightning light on the scene right now, 0..1 (for a brief flash of the landscape). */
  flash = 0;
  private flashes: Flash[] = [];
  private nextFlash = 4;
  private time = 0;

  constructor(shared: { uLight: THREE.IUniform; uAmb: THREE.IUniform; uSun: THREE.IUniform; uFogColor: THREE.IUniform; uFogDensity: THREE.IUniform }) {
    this.uniforms = {
      ...shared,
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uDist: { value: 4000 },
      /** Direction the front comes from (world angle of its centre, rad). */
      uCenter: { value: 0 },
      /** Lightning inside the cloud: angle (rad, world), height (m), intensity. */
      uFlash: { value: new THREE.Vector3(0, 1000, 0) },
    };
    const geo = new THREE.CylinderGeometry(1, 1, 1, 96, 1, true, 0, ARC);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform float uDist;
        varying vec2 vUv;
        varying vec3 vW;
        void main() {
          vUv = uv;
          // The head of a gravity current leans forward: the top stands ~8 % nearer.
          vec3 pos = position;
          pos.xz *= 1.0 - 0.08 * pos.y;
          vec4 w = modelMatrix * vec4(pos, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uAmount, uDist, uCenter, uFogDensity;
        uniform vec3 uLight, uAmb, uSun, uFogColor, uFlash;
        varying vec2 vUv;
        varying vec3 vW;
        // Integer hash (PCG3D): exact at any coordinate - the float sin/fract hashes
        // lose precision at kilometre coordinates and break into square blocks.
        uvec3 pcg3d(uvec3 v) {
          v = v * 1664525u + 1013904223u;
          v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
          v ^= v >> 16u;
          v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
          return v;
        }
        float hh(ivec3 i) { return float(pcg3d(uvec3(i + 65536)).x) * (1.0 / 4294967295.0); }
        float n3(vec3 x) {
          vec3 fl = floor(x), f = x - fl;
          ivec3 i = ivec3(fl);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(hh(i), hh(i + ivec3(1,0,0)), f.x), mix(hh(i + ivec3(0,1,0)), hh(i + ivec3(1,1,0)), f.x), f.y),
                     mix(mix(hh(i + ivec3(0,0,1)), hh(i + ivec3(1,0,1)), f.x), mix(hh(i + ivec3(0,1,1)), hh(i + ivec3(1,1,1)), f.x), f.y), f.z);
        }
        // Turbulent dust masses: smooth billows, domain-warped (the warp evolves too).
        float billow(vec3 p, int oct) {
          vec3 q = p + vec3(n3(p * 0.5 + vec3(3.0, 0.0, 0.0)), n3(p * 0.5 + vec3(11.0, 0.0, 0.0)), 0.0) * 1.3;
          float s = 0.0, a = 0.5, norm = 0.0;
          for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * n3(q); norm += a; q = q * 2.03 + 5.1; a *= 0.5; }
          return s / norm;
        }
        void main() {
          float ang = ${(-ARC / 2).toFixed(4)} + vUv.x * ${ARC.toFixed(4)};
          // Metres along the front at its real distance, metres above the ground.
          float s = ang * uDist;
          float y = vUv.y * ${HEIGHT.toFixed(1)};
          float t = uTime;
          // Motion in metres per second, as in a real gust front: the dust boils up at
          // ~8 m/s, lobes slide along the front, ~400 m eddies renew in ~50 s. Seen from
          // closer the same motion sweeps more of the view - it looks faster (parallax).
          vec3 p = vec3((s + t * 3.0) / 420.0, (y - t * 8.0) / 420.0, t * 0.02);
          float b = billow(p, 5);
          // Lobes and clefts of the leading edge (gravity-current structure): kilometre-
          // scale bulges and narrow re-entrant clefts, slowly changing.
          float lobe = n3(vec3(s / 1400.0, 0.0, t * 0.006));
          float cleft = smoothstep(0.62, 0.9, n3(vec3(s / 700.0 + 40.0, 0.0, t * 0.01)));
          float top = 0.42 + 0.42 * lobe - 0.22 * cleft + 0.3 * (b - 0.5);
          float yn = vUv.y;
          // Dense and opaque low down; a soft, boiling, partly translucent top.
          float edgeIn = smoothstep(top, top - 0.09, yn);
          float dens = edgeIn * (0.8 + 0.7 * b) * mix(1.0, 0.75, smoothstep(top - 0.25, top, yn));
          // Ragged arc ends: the front frays out into the haze.
          dens *= smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          float a = clamp(dens, 0.0, 1.0) * uAmount;
          if (a < 0.004) discard;
          // Lighting from the billow shape (cheap low-octave gradient): sunlit tops,
          // shaded undersides and clefts.
          float e = 0.07;
          float b2 = billow(p, 2);
          float gx = billow(p + vec3(e, 0.0, 0.0), 2) - b2, gy = billow(p + vec3(0.0, e, 0.0), 2) - b2;
          vec3 inward = normalize(vec3(cameraPosition.x - vW.x, 0.0, cameraPosition.z - vW.z));
          vec3 tang = vec3(-inward.z, 0.0, inward.x);
          vec3 nrm = normalize(inward * 0.6 - tang * gx * 7.0 + vec3(0.0, 1.0, 0.0) * (0.3 - gy * 7.0));
          float lit = max(dot(nrm, uSun), 0.0);
          // Self-shadowing: optically thick dust is dark inside and low down; folds darker.
          float depthDark = mix(0.32, 1.0, smoothstep(top - 0.5, top - 0.02, yn)) * (0.35 + 0.75 * smoothstep(0.2, 0.8, b));
          // Rolls and plumes inside the wall stay readable up close (turbulent masses).
          depthDark *= 0.8 + 0.4 * smoothstep(0.3, 0.7, billow(p * 2.7 + vec3(7.0, 0.0, 0.0), 3));
          vec3 dust = vec3(0.8, 0.43, 0.22);
          vec3 col = dust * (uLight * lit * 1.7 + uAmb * 1.35) * depthDark;
          // The dark, sharp base of the wall where it scours the ground.
          col *= mix(0.55, 1.0, smoothstep(0.0, 0.12, yn));
          // Lightning lighting the cloud from inside.
          float da = uCenter - ang - uFlash.x;
          da = mod(da + 3.14159265, 6.2831853) - 3.14159265;
          vec2 fd = vec2(da * uDist / 320.0, (y - uFlash.y) / 260.0);
          // Scattered by the dust inside, so it lights up billows, not a white disc.
          float glow = uFlash.z * exp(-dot(fd, fd)) * smoothstep(0.35, 0.8, b) * edgeIn;
          col += vec3(1.0, 0.82, 0.72) * glow * 1.3;
          // Against the Sun the thin, frayed top edge glows (forward scattering by dust).
          vec3 vd = normalize(vW - cameraPosition);
          float fwdS = pow(max(dot(vd, uSun), 0.0), 6.0);
          col += uLight * vec3(1.0, 0.75, 0.45) * fwdS * (1.0 - edgeIn * 0.85) * 3.0;
          // Aerial perspective: far away the wall sinks into the dusty air.
          float fogK = 1.0 - exp(-pow(uFogDensity * uDist, 2.0)); // as the scene's FogExp2
          col = mix(col, uFogColor, fogK * (1.0 - glow * 0.5));
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
    });
    this.wall = new THREE.Mesh(geo, mat);
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 2;
    this.group.add(this.wall);

    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(this.boltPos, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aOther', new THREE.BufferAttribute(this.boltOther, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('aB', new THREE.BufferAttribute(this.boltB, 1).setUsage(THREE.DynamicDrawUsage));
    const side = new Float32Array(BOLT_SEGS * 4), idx = new Uint16Array(BOLT_SEGS * 6);
    for (let i = 0; i < BOLT_SEGS; i++) {
      side.set([-1, 1, -1, 1], i * 4);
      const v = i * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], i * 6);
    }
    bg.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    bg.setIndex(new THREE.BufferAttribute(idx, 1));
    bg.setDrawRange(0, 0);
    this.bolt = new THREE.Mesh(
      bg,
      new THREE.ShaderMaterial({
        vertexShader: /* glsl */ `
          attribute vec3 aOther; attribute float aSide; attribute float aB;
          varying float vS; varying float vB;
          void main() {
            vec3 dir = normalize(aOther - position + 1e-5);
            vec3 toCam = cameraPosition - position;
            vec3 side = normalize(cross(dir, toCam) + 1e-5);
            // At least ~2.5 px wide at any distance; the core is a few dm across up close.
            float w = max(0.35, length(toCam) * 0.0022);
            vS = aSide; vB = aB;
            gl_Position = projectionMatrix * viewMatrix * vec4(position + side * aSide * w, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          varying float vS; varying float vB;
          void main() {
            float core = exp(-vS * vS * 6.0);
            gl_FragColor = vec4(vec3(0.85, 0.8, 1.0) * vB * (0.6 + 2.4 * core), 1.0);
          }`,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // The quad's winding depends on which way "side" points: draw both faces.
        side: THREE.DoubleSide,
      }),
    );
    this.bolt.frustumCulled = false;
    this.bolt.renderOrder = 3;
    this.group.add(this.bolt);
  }

  /** A cloud-to-ground discharge at (x, z) with ground height gy - inside the front zone. */
  strike(x: number, z: number, gy: number, cam: THREE.Vector3, rnd: () => number): void {
    const pulses = [0, ...Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => 0.05 + rnd() * 0.25)];
    this.flashes.push({ t: 0, pulses, ang: Math.atan2(z - cam.z, x - cam.x), h: 350 + rnd() * 450, ground: true, at: { x, z, gy } });
  }

  /**
   * dist: front distance from the camera, m; center: world angle the front comes from;
   * amount: wall opacity 0..1; groundY: ground height below the camera.
   */
  update(dt: number, cam: THREE.Vector3, groundY: number, dist: number, center: number, amount: number, rnd: () => number): void {
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uAmount.value = amount;
    u.uDist.value = dist;
    u.uCenter.value = center;
    this.group.visible = amount > 0.002 || this.flashes.some((f) => f.at);
    if (!this.group.visible) {
      this.flash = 0;
      this.flashes.length = 0;
      this.bolt.geometry.setDrawRange(0, 0);
      return;
    }
    // The wall is centred on the camera; its middle faces the incoming storm.
    this.wall.position.set(cam.x, groundY - 60, cam.z);
    this.wall.scale.set(Math.max(dist, 60), HEIGHT, Math.max(dist, 60));
    // A CylinderGeometry vertex at θ lies at world angle atan2(z, x) = π/2 − θ − rotation.y:
    // put the middle of the arc (θ = ARC/2) on `center`. Then angle = center − ang (shader).
    this.wall.rotation.y = Math.PI / 2 - ARC / 2 - center;

    // Lightning: more often as the front comes closer.
    this.nextFlash -= dt;
    if (this.nextFlash <= 0 && amount > 0.3) {
      const near = THREE.MathUtils.clamp(1 - dist / 4500, 0, 1);
      this.nextFlash = (1.2 + rnd() * 5) * (1.6 - near);
      const pulses = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => rnd() * 0.25);
      this.flashes.push({ t: 0, pulses, ang: center + (rnd() - 0.5) * 1.6, h: 500 + rnd() * 1100, ground: rnd() < 0.35 });
    }
    let fl = 0, best: Flash | null = null;
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      // Each discharge: a few return strokes, ~60 ms each, decaying.
      let k = 0;
      for (const p0 of f.pulses) {
        const tt = f.t - p0;
        if (tt > 0) k = Math.max(k, Math.exp(-tt / 0.06) * (tt < 0.012 ? tt / 0.012 : 1));
      }
      if (f.t > 0.6) {
        this.flashes.splice(i, 1);
        continue;
      }
      if (k > fl) {
        fl = k;
        best = f;
      }
    }
    // A strike in the front zone lights everything at full strength (the rover is inside it).
    const lvl = best?.at ? fl : fl * amount;
    this.flash = lvl;
    if (best) (u.uFlash.value as THREE.Vector3).set(best.ang, best.h, lvl);
    else (u.uFlash.value as THREE.Vector3).z = 0;
    if (best?.ground && fl > 0.05) this.drawBolt(best, cam, groundY, dist, lvl);
    else this.bolt.geometry.setDrawRange(0, 0);
  }

  /** A jagged channel from the cloud to the ground with a few branches (seeded per flash). */
  private drawBolt(f: Flash, cam: THREE.Vector3, groundY: number, dist: number, k: number): void {
    let seed = Math.floor((f.ang * 1000 + f.h) * 7919) >>> 0;
    const r = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const d = Math.max(dist - 150, 100);
    const ox = f.at ? f.at.x : cam.x + Math.cos(f.ang) * d, oz = f.at ? f.at.z : cam.z + Math.sin(f.ang) * d;
    if (f.at) groundY = f.at.gy;
    const tx = -Math.sin(f.ang), tz = Math.cos(f.ang);
    let n = 0;
    const P = this.boltPos, O = this.boltOther, B = this.boltB;
    const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, b: number) => {
      if (n >= BOLT_SEGS) return;
      // Quad corners: start ±side, end ±side; each knows the other end for its direction.
      P.set([x0, y0, z0, x0, y0, z0, x1, y1, z1, x1, y1, z1], n * 12);
      O.set([x1, y1, z1, x1, y1, z1, x1 * 2 - x0, y1 * 2 - y0, z1 * 2 - z0, x1 * 2 - x0, y1 * 2 - y0, z1 * 2 - z0], n * 12);
      B.fill(b, n * 4, n * 4 + 4);
      n++;
    };
    const channel = (x: number, y: number, z: number, bottom: number, bright: number, depth: number) => {
      const steps = depth === 0 ? 40 : 12;
      const dy = (y - bottom) / steps;
      for (let i = 0; i < steps; i++) {
        const lat = (r() - 0.5) * dy * 1.4;
        const nx = x + tx * lat + (r() - 0.5) * dy * 0.4, nz = z + tz * lat + (r() - 0.5) * dy * 0.4, ny = y - dy * (0.6 + 0.8 * r());
        seg(x, y, z, nx, Math.max(ny, bottom), nz, bright);
        if (depth < 1 && r() < 0.12) channel(nx, ny, nz, ny - dy * (4 + r() * 6), bright * 0.45, depth + 1);
        x = nx; y = Math.max(ny, bottom); z = nz;
        if (y <= bottom) break;
      }
    };
    channel(ox, groundY + f.h, oz, groundY - 20, k, 0);
    const g = this.bolt.geometry;
    g.setDrawRange(0, n * 6);
    for (const a of ['position', 'aOther', 'aB']) (g.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
  }
}
