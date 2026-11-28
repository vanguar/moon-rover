import * as THREE from 'three';

/**
 * The void under a skylight (Pavonis Mons): what is measured and what is reconstructed.
 *
 * Measured (HiRISE DTM, terrain.json "cave"): the opening - its rim height and its
 * outline at 72 bearings - and the top of the debris pile seen through it (28 m below
 * the rim). From the funnel's volume the HiRISE team estimated a cavity at least ~90 m
 * deep and a pile at least ~62 m tall.
 *
 * Reconstructed (nobody has seen inside): a lava tube along the volcano's downslope
 * direction, ~70 m wide and ~80 m tall with a flat floor (lava solidified in the tube),
 * meandering, with lumpy walls (no two cross-sections alike), its roof ~10 m thick at
 * the opening; the pile a cone at the angle of repose (33°) under the opening, spread
 * along the tube between its walls. Both ends choke with rubble a few hundred metres off.
 *
 * Light, physically: sunlight enters only through the opening - the lit patch is the
 * opening projected along the Sun's rays onto whatever lies below; sky light enters
 * through the same opening (its solid angle as seen from each point); the sunlit
 * patch of the pile lights the rest by bounce, falling off with distance. Beyond that,
 * darkness. Rendered with its own shader (the scene's sun would light it through the
 * roof).
 */
export interface CaveMeta {
  x: number;
  z: number;
  rimY: number;
  pileTopY: number;
  ceilY: number;
  floorY: number;
  holeR: number[];
  axis: [number, number];
  width: number;
  length: number;
  slope: number;
}

const REPOSE = Math.tan(THREE.MathUtils.degToRad(33));

// Exact integer hash value noise (no float-hash stripes), 3D, for the wall relief.
function h3(x: number, y: number, z: number): number {
  let a = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1)) >>> 0;
  a = Math.imul(a ^ (a >>> 15), 0x85ebca6b) >>> 0;
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35) >>> 0;
  return ((a ^ (a >>> 16)) >>> 0) / 4294967295;
}
function vn3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => h3(ix + dx, iy + dy, iz + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), fx), l(c(0, 1, 0), c(1, 1, 0), fx), fy), l(l(c(0, 0, 1), c(1, 0, 1), fx), l(c(0, 1, 1), c(1, 1, 1), fx), fy), fz);
}
function fbm(x: number, y: number, z: number): number {
  return vn3(x, y, z) * 0.55 + vn3(x * 2.13 + 7.1, y * 2.13, z * 2.13) * 0.3 + vn3(x * 4.7, y * 4.7 + 3.3, z * 4.7) * 0.15;
}

export class Cave {
  readonly group = new THREE.Group();
  readonly uniforms: Record<string, THREE.IUniform>;
  private ax: number;
  private az: number;
  private meanR: number;

  constructor(private c: CaveMeta) {
    this.ax = c.axis[0];
    this.az = c.axis[1];
    this.meanR = c.holeR.reduce((a, b) => a + b, 0) / c.holeR.length;
    this.uniforms = {
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uSunE: { value: new THREE.Color(1, 1, 1) },
      uSky: { value: new THREE.Color(0.3, 0.2, 0.12) },
      uHole: { value: new THREE.Vector4(c.x, c.z, c.rimY, c.ceilY) },
      uHoleR: { value: c.holeR },
      uMeanR: { value: this.meanR },
      uPileTop: { value: c.pileTopY },
    };
    this.group.add(this.mesh(this.tubeGeometry(), 0.085, true));
    this.group.add(this.mesh(this.shaftGeometry(), 0.09, false));
    this.group.add(this.mesh(this.pileGeometry(), 0.2, false));
  }

  /** Lateral meander of the tube's centre line at distance u along it (0 under the opening). */
  private lat(u: number): number {
    const f = (t: number) => 12 * Math.sin(t / 85 + 1.1) + 5 * Math.sin(t / 31 + 0.4);
    return f(u) - f(0);
  }
  private floorAt0(u: number): number {
    return this.c.floorY - this.c.slope * u;
  }
  private ceilAt0(u: number): number {
    return this.c.ceilY - this.c.slope * u;
  }
  /** Tube-local coordinates (u along, v across) of a world point. */
  private uv(x: number, z: number): [number, number] {
    const dx = x - this.c.x, dz = z - this.c.z;
    const u = dx * this.ax + dz * this.az;
    const v = dx * -this.az + dz * this.ax - this.lat(u);
    return [u, v];
  }
  private world(u: number, v: number): [number, number] {
    const l = this.lat(u) + v;
    return [this.c.x + this.ax * u - this.az * l, this.c.z + this.az * u + this.ax * l];
  }
  /** Height of the debris pile (or the floor) at tube-local (u, v). */
  private pileAt(u: number, v: number): number {
    const d = Math.hypot(u, v);
    const lump = (fbm(u / 6, v / 6, 3.7) - 0.5) * 1.6 + (fbm(u / 1.8, v / 1.8, 9.1) - 0.5) * 0.5;
    return Math.max(this.floorAt0(u) + 0.3, this.c.pileTopY - REPOSE * d + lump * Math.min(1, d / 8));
  }

  /** Inside the tube or the shaft (below the rim of the opening)? */
  contains(p: THREE.Vector3): boolean {
    const [u, v] = this.uv(p.x, p.z);
    if (p.y > this.c.rimY + 0.5) return false;
    if (Math.abs(u) < this.c.length / 2 - 40 && Math.abs(v) < this.c.width * 0.48 && p.y < this.ceilAt0(u) + 1) return true;
    return Math.hypot(p.x - this.c.x, p.z - this.c.z) < this.meanR && p.y < this.c.rimY;
  }
  /** Ground under a point inside the cave (pile or floor), or null if not in it. */
  groundAt(x: number, z: number, y: number): number | null {
    const p = new THREE.Vector3(x, y, z);
    if (!this.contains(p)) return null;
    const [u, v] = this.uv(x, z);
    return this.pileAt(u, v);
  }
  /** Ceiling over a point in the tube (Infinity under the opening). */
  ceilingAt(x: number, z: number): number {
    if (Math.hypot(x - this.c.x, z - this.c.z) < this.meanR - 1) return Infinity;
    const [u] = this.uv(x, z);
    return this.ceilAt0(u);
  }
  /** How far below the rim of the opening a point is (m, 0 above it). */
  depth(p: THREE.Vector3): number {
    return this.contains(p) ? Math.max(0, this.c.rimY - p.y) : 0;
  }

  /** Radius of the opening's outline toward a bearing from its centre. */
  private outlineR(dx: number, dz: number): number {
    let a = Math.atan2(dz, dx);
    if (a < 0) a += Math.PI * 2;
    const f = (a / (Math.PI * 2)) * 72, i0 = Math.floor(f) % 72, i1 = (i0 + 1) % 72;
    return this.c.holeR[i0] + (this.c.holeR[i1] - this.c.holeR[i0]) * (f - Math.floor(f));
  }

  /**
   * Light reaching a point in the cave, relative to the open surface: the Sun (1 if its
   * ray passes through the opening, else 0) and the sky (the opening's solid angle /
   * π, plus a little bounce off the sunlit pile). Outside the cave: 1, 1.
   */
  lightAt(p: THREE.Vector3, sun: THREE.Vector3): { sun: number; sky: number } {
    if (!this.contains(p) || p.y > this.c.rimY) return { sun: 1, sky: 1 };
    let s = 0;
    if (sun.y > 0.03) {
      const t = (this.c.rimY - p.y) / sun.y;
      const qx = p.x + sun.x * t - this.c.x, qz = p.z + sun.z * t - this.c.z;
      s = Math.hypot(qx, qz) < this.outlineR(qx, qz) ? 1 : 0;
    }
    const dx = this.c.x - p.x, dy = this.c.rimY - p.y, dz = this.c.z - p.z;
    const D2 = dx * dx + dy * dy + dz * dz, A = Math.PI * this.meanR * this.meanR;
    const omega = (A * Math.max(dy, 0)) / Math.sqrt(D2) / (D2 + A);
    return { sun: s, sky: Math.min(1, omega / Math.PI + 0.02 * Math.max(sun.y, 0)) };
  }

  setLight(sun: THREE.Vector3, sunE: THREE.Color, sky: THREE.Color): void {
    (this.uniforms.uSun.value as THREE.Vector3).copy(sun);
    (this.uniforms.uSunE.value as THREE.Color).copy(sunE);
    (this.uniforms.uSky.value as THREE.Color).copy(sky);
  }

  private tubeGeometry(): THREE.BufferGeometry {
    const U = 240, T = 72, L = this.c.length, a0 = this.c.width / 2;
    const pos: number[] = [];
    for (let i = 0; i <= U; i++) {
      const u = -L / 2 + (L * i) / U;
      // Rubble chokes at both ends: the tube narrows to a close.
      const s = THREE.MathUtils.smoothstep(L / 2 - Math.abs(u), 0, 70);
      const fl = this.floorAt0(u), ce = this.ceilAt0(u);
      const yc = (fl + ce) / 2, b0 = (ce - fl) / 2;
      for (let k = 0; k < T; k++) {
        const th = (2 * Math.PI * k) / T;
        const cs = Math.cos(th), sn = Math.sin(th);
        const n = 1 + 0.16 * (fbm(cs * 1.4 + 11, sn * 1.4, u / 26) - 0.5) * 2 + 0.06 * (fbm(cs * 4, sn * 4 + 5, u / 7) - 0.5) * 2;
        const k2 = n * (0.2 + 0.8 * s);
        const v = a0 * cs * k2;
        // Flat floor: the lower part of the section is the solidified lava surface.
        let y = yc + b0 * sn * k2;
        const floorY = fl + 0.6 * (fbm(u / 9, v / 9, 1.3) - 0.5) + (1 - s) * b0 * 0.6;
        if (y < floorY) y = floorY;
        const [x, z] = this.world(u, v);
        pos.push(x, y, z);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < U; i++) {
      for (let k = 0; k < T; k++) {
        const a = i * T + k, b = i * T + ((k + 1) % T), c = (i + 1) * T + k, d = (i + 1) * T + ((k + 1) % T);
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** The opening's throat through the roof, from just below the ceiling to the rim. */
  private shaftGeometry(): THREE.BufferGeometry {
    const K = this.c.holeR.length, V = 10;
    // Down to below the cut in the tube's ceiling (overlapping it): no gap to see the sky through.
    const y0 = this.c.ceilY - 9, y1 = this.c.rimY + 0.3;
    const pos: number[] = [];
    for (let j = 0; j <= V; j++) {
      const y = y0 + ((y1 - y0) * j) / V;
      for (let k = 0; k < K; k++) {
        const a = (2 * Math.PI * k) / K;
        // Rough rock: the throat widens a little downward (the roof broke back).
        const r = this.c.holeR[k] * (1 + 0.08 * (1 - j / V)) + (fbm(Math.cos(a) * 3, Math.sin(a) * 3, y / 3) - 0.5) * 1.6;
        pos.push(this.c.x + Math.cos(a) * r, y, this.c.z + Math.sin(a) * r);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < V; j++) {
      for (let k = 0; k < K; k++) {
        const a = j * K + k, b = j * K + ((k + 1) % K), c = (j + 1) * K + k, d = (j + 1) * K + ((k + 1) % K);
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private pileGeometry(): THREE.BufferGeometry {
    const Nu = 180, Nv = 48, U = 120, Vh = this.c.width * 0.47;
    const pos: number[] = [];
    for (let i = 0; i <= Nu; i++) {
      const u = -U + (2 * U * i) / Nu;
      for (let j = 0; j <= Nv; j++) {
        const v = -Vh + (2 * Vh * j) / Nv;
        const [x, z] = this.world(u, v);
        pos.push(x, this.pileAt(u, v), z);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < Nu; i++) {
      for (let j = 0; j < Nv; j++) {
        const a = i * (Nv + 1) + j, b = a + 1, c = a + Nv + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private mesh(g: THREE.BufferGeometry, albedo: number, tube: boolean): THREE.Mesh {
    const m = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uAlbedo: { value: albedo }, uTube: { value: tube ? 1 : 0 } },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec3 vW; varying vec3 vN;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vW; varying vec3 vN;
        uniform vec3 uSun; uniform vec3 uSunE; uniform vec3 uSky; uniform vec4 uHole;
        uniform float uHoleR[72]; uniform float uMeanR; uniform float uPileTop; uniform float uAlbedo; uniform float uTube;
        float holeRadius(vec2 q) {
          float a = atan(q.y, q.x); if (a < 0.0) a += 6.2831853;
          float f = a / 6.2831853 * 72.0; int i0 = int(floor(f)); int i1 = i0 + 1; if (i1 >= 72) i1 = 0; if (i0 >= 72) i0 = 0;
          return mix(uHoleR[i0], uHoleR[i1], fract(f));
        }
        uint hu(uvec3 v) { v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; return v.x + v.y * v.z; }
        float hn(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          #define H(o) (float(hu(uvec3(ivec3(i + o) + 1048576))) * (1.0 / 4294967295.0))
          return mix(mix(mix(H(vec3(0,0,0)), H(vec3(1,0,0)), f.x), mix(H(vec3(0,1,0)), H(vec3(1,1,0)), f.x), f.y),
                     mix(mix(H(vec3(0,0,1)), H(vec3(1,0,1)), f.x), mix(H(vec3(0,1,1)), H(vec3(1,1,1)), f.x), f.y), f.z); }
        void main() {
          vec2 hc = uHole.xy; float rim = uHole.z, ceil = uHole.w;
          // The tube's ceiling is open where the throat comes through.
          // (cut slightly inside the throat, which reaches below it: they overlap).
          if (uTube > 0.5 && vW.y > ceil - 6.0 && length(vW.xz - hc) < holeRadius(vW.xz - hc) * 0.92) discard;
          vec3 n = normalize(vN);
          if (!gl_FrontFacing) n = -n;
          vec3 E = vec3(0.0);
          // Sunlight through the opening: is the point's ray to the Sun inside its outline?
          if (uSun.y > 0.03 && vW.y < rim) {
            float t = (rim - vW.y) / uSun.y;
            vec2 q = vW.xz + uSun.xz * t - hc;
            float lit = 1.0 - smoothstep(-0.6, 0.6, length(q) - holeRadius(q));
            E += uSunE * lit * max(dot(n, uSun), 0.0);
          }
          // Sky light through the opening (its solid angle, cosine-weighted).
          vec3 toH = vec3(hc.x, rim, hc.y) - vW;
          float D2 = dot(toH, toH);
          vec3 dH = toH * inversesqrt(D2);
          float A = 3.14159 * uMeanR * uMeanR;
          float omega = A * max(dH.y, 0.0) / (D2 + A);
          E += uSky * omega * max(dot(n, dH), 0.0) * 3.14159;
          // Bounce from the sunlit patch of the pile (its flux over the distance squared).
          vec3 spot = vec3(hc.x - uSun.x / max(uSun.y, 0.05) * (rim - uPileTop), uPileTop, hc.y - uSun.z / max(uSun.y, 0.05) * (rim - uPileTop));
          vec3 toS = spot - vW;
          float S2 = dot(toS, toS) + 40.0;
          float flux = A * max(uSun.y, 0.0) * 0.2 / 3.14159;
          E += uSunE * flux * max(dot(n, toS * inversesqrt(S2)), 0.0) / S2 * 1.5;
          // Basalt walls; dust and fine debris on the upward faces and the pile.
          float up = smoothstep(0.35, 0.85, n.y);
          float var = hn(vW * 0.35) * 0.6 + hn(vW * 1.7 + 3.1) * 0.4;
          float alb = mix(uAlbedo, 0.2, up * 0.6) * (0.75 + 0.5 * var);
          vec3 col = vec3(alb) * vec3(1.0, 0.82, 0.68) / 3.14159 * E;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    return mesh;
  }
}
