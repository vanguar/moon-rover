import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { makeLunar, NOISE_GLSL } from '../render/lunar';
import { mulberry32 } from '../terrain/TerrainData';

/** Unit vector for azimuth (deg, from north, clockwise) and elevation (deg). North = -z, east = +x. */
export function azElToDir(azDeg: number, elDeg: number): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

function radialTexture(stops: [number, string][], size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function earthTexture(): THREE.CanvasTexture {
  // Procedural Earth: oceans, continents from value noise, cloud bands, polar ice.
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const rnd = mulberry32(3);
  const grid = Array.from({ length: 33 * 17 }, () => rnd());
  const vn = (x: number, y: number, f: number) => {
    const gx = (x * f) % 32, gy = Math.min(y * f, 15.999);
    const ix = Math.floor(gx), iy = Math.floor(gy), tx = gx - ix, ty = gy - iy;
    const s = (t: number) => t * t * (3 - 2 * t);
    const a = grid[iy * 33 + ix], b = grid[iy * 33 + ((ix + 1) % 32)];
    const cc = grid[(iy + 1) * 33 + ix], d = grid[(iy + 1) * 33 + ((ix + 1) % 32)];
    return a + (b - a) * s(tx) + (cc - a) * s(ty) + (a - b - cc + d) * s(tx) * s(ty);
  };
  for (let y = 0; y < H; y++) {
    const lat = (y / H - 0.5) * Math.PI;
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H;
      const land = vn(u, v, 4) * 0.6 + vn(u * 2, v * 2, 4) * 0.3 + vn(u * 4, v * 4, 4) * 0.1;
      const cloud = vn(u * 3 + 0.3, v * 3, 4) * 0.6 + vn(u * 8, v * 8, 4) * 0.4;
      let r = 18, gg = 48, b = 120;
      if (land > 0.55) {
        const dry = Math.abs(Math.sin(lat)) < 0.45 ? vn(u * 6, v * 6, 4) : 0;
        r = 70 + dry * 90; gg = 95 + dry * 40; b = 50 + dry * 20;
      }
      const ice = Math.abs(lat) > 1.2 ? 1 : 0;
      const band = 0.5 + 0.5 * Math.sin(lat * 6);
      const cl = Math.min(1, Math.max(0, (cloud - 0.45) * 2.2) * (0.6 + 0.4 * band) + ice);
      const i = (y * W + x) * 4;
      img.data[i] = r + (250 - r) * cl;
      img.data[i + 1] = gg + (250 - gg) * cl;
      img.data[i + 2] = b + (255 - b) * cl;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Sky {
  readonly group = new THREE.Group();
  readonly sunDir: THREE.Vector3;
  readonly earthDir: THREE.Vector3;
  private stars: THREE.Points;
  private mountains: THREE.Mesh;
  private flare: Lensflare;

  private milkyWay: THREE.Mesh | null = null;
  private constLines: THREE.LineSegments | null = null;
  private flashes: { sprite: THREE.Sprite; t: number; peak: number }[] = [];
  private flashTex: THREE.Texture;

  constructor(
    sunAz: number,
    sunEl: number,
    starCount: number,
    earthPos?: { azimuth: number; elevation: number },
    stars?: Float32Array,
    extras: { constellations?: Float32Array; galaxy?: { pole: number[]; center: number[] } } = {},
  ) {
    this.sunDir = azElToDir(sunAz, sunEl);
    // Earth from Hadley Rille (26.1 N, 3.6 E): az ≈ 188°, el ≈ 64° (librations ignored).
    this.earthDir = earthPos ? azElToDir(earthPos.azimuth, earthPos.elevation) : azElToDir(188, 63.8);

    this.stars = buildStars(stars, starCount);
    this.stars.renderOrder = -10;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    // Sun: 0.53° disc, far brighter than anything else; no atmospheric halo.
    const sunDist = 9500;
    const sunR = sunDist * Math.tan(THREE.MathUtils.degToRad(0.265));
    const sunDisc = new THREE.Mesh(
      new THREE.CircleGeometry(sunR, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.98, 0.95).multiplyScalar(40), depthWrite: false, fog: false, toneMapped: true }),
    );
    sunDisc.position.copy(this.sunDir).multiplyScalar(sunDist);
    sunDisc.lookAt(0, 0, 0);
    sunDisc.renderOrder = -9;
    this.group.add(sunDisc);

    // Camera-lens glare: starburst + ghosts along the sun-centre axis; hidden when the sun is occluded.
    const glow = radialTexture([[0, 'rgba(255,255,255,1)'], [0.08, 'rgba(255,250,240,0.9)'], [0.25, 'rgba(255,240,220,0.25)'], [1, 'rgba(0,0,0,0)']], 256);
    const ring = radialTexture([[0, 'rgba(0,0,0,0)'], [0.75, 'rgba(0,0,0,0)'], [0.88, 'rgba(120,160,255,0.35)'], [0.95, 'rgba(255,200,120,0.2)'], [1, 'rgba(0,0,0,0)']]);
    const ghost = radialTexture([[0, 'rgba(160,200,255,0.35)'], [0.7, 'rgba(120,170,255,0.15)'], [1, 'rgba(0,0,0,0)']]);
    const flare = new Lensflare();
    flare.addElement(new LensflareElement(glow, 420, 0, new THREE.Color(1, 0.97, 0.9)));
    flare.addElement(new LensflareElement(ring, 260, 0, new THREE.Color(1, 1, 1)));
    flare.addElement(new LensflareElement(ghost, 60, 0.4));
    flare.addElement(new LensflareElement(ghost, 110, 0.65));
    flare.addElement(new LensflareElement(ring, 160, 0.9));
    flare.addElement(new LensflareElement(ghost, 40, 1.15));
    flare.position.copy(this.sunDir).multiplyScalar(sunDist * 0.98);
    this.group.add(flare);
    this.flare = flare;

    // Earth: 1.9° disc, phase from the true sun direction, thin atmosphere rim.
    const earthDist = 8000;
    const earthR = earthDist * Math.tan(THREE.MathUtils.degToRad(0.95));
    const earthMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: earthTexture() }, uSun: { value: this.sunDir } },
      vertexShader: `varying vec3 vN; varying vec2 vUv; varying vec3 vV;
        void main(){ vUv=uv; vN=normalize(mat3(modelMatrix)*normal);
        vec4 wp=modelMatrix*vec4(position,1.0); vV=normalize(cameraPosition-wp.xyz);
        gl_Position=projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `uniform sampler2D uMap; uniform vec3 uSun; varying vec3 vN; varying vec2 vUv; varying vec3 vV;
        void main(){ vec3 c=texture2D(uMap,vUv).rgb; float d=dot(normalize(vN),uSun);
        float lit=smoothstep(-0.03,0.08,d)*(0.25+0.75*max(d,0.0));
        float rim=pow(1.0-max(dot(normalize(vN),vV),0.0),3.0)*smoothstep(-0.1,0.3,d);
        vec3 col=c*lit*2.2+vec3(0.3,0.5,1.0)*rim*1.2;
        gl_FragColor=vec4(col,1.0);
        #include <colorspace_fragment>
        }`,
      depthWrite: false,
    });
    const earth = new THREE.Mesh(new THREE.SphereGeometry(earthR, 48, 24), earthMat);
    earth.position.copy(this.earthDir).multiplyScalar(earthDist);
    earth.rotation.set(0.4, 2.2, 0.1);
    earth.renderOrder = -9;
    this.group.add(earth);

    if (extras.galaxy) {
      this.milkyWay = buildMilkyWay(new THREE.Vector3(...extras.galaxy.pole), new THREE.Vector3(...extras.galaxy.center));
      this.group.add(this.milkyWay);
    }
    if (extras.constellations && extras.constellations.length >= 6) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(extras.constellations.map((v) => v * 8900), 3));
      this.constLines = new THREE.LineSegments(
        g,
        new THREE.LineBasicMaterial({ color: 0x5f8fd6, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      this.constLines.visible = false;
      this.constLines.frustumCulled = false;
      this.constLines.renderOrder = -10;
      this.group.add(this.constLines);
    }
    this.flashTex = radialTexture([[0, 'rgba(255,255,255,1)'], [0.15, 'rgba(255,240,210,0.8)'], [0.4, 'rgba(255,200,150,0.15)'], [1, 'rgba(0,0,0,0)']], 64);

    this.mountains = this.buildMountains();
    this.group.add(this.mountains);
  }

  /** Far skyline: Mons Hadley (NE), Hadley Delta (S), Apennine front, as angular elevation profiles. */
  private buildMountains(): THREE.Mesh {
    const R = 15000, seg = 720, rows = 16;
    const peaks: [number, number, number][] = [
      [40, 28, 6.5], // Mons Hadley
      [75, 18, 3.5],
      [185, 32, 8.5], // Hadley Delta
      [150, 22, 4.0],
      [230, 25, 3.0],
      [300, 40, 1.6], // Swann range / mare rim
    ];
    const rnd = mulberry32(9);
    const ripple = Array.from({ length: 24 }, () => [rnd() * 6.28, rnd()]);
    const elevAt = (az: number) => {
      let e = 0.5;
      for (const [pa, w, h] of peaks) {
        let d = Math.abs(az - pa);
        if (d > 180) d = 360 - d;
        e += h * Math.exp(-(d * d) / (2 * (w * 0.5) ** 2));
      }
      for (let k = 0; k < ripple.length; k++) e += Math.sin(THREE.MathUtils.degToRad(az) * (k + 2) + ripple[k][0]) * ripple[k][1] * 0.35 / (1 + k * 0.3);
      return Math.max(0.2, e);
    };
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= seg; i++) {
      const az = (i / seg) * 360;
      const top = elevAt(az);
      const d = azElToDir(az, 0);
      for (let j = 0; j <= rows; j++) {
        const t = j / rows; // 0 = base, 1 = crest
        const a = THREE.MathUtils.degToRad(az);
        const bump = j > 0 && j < rows ? (Math.sin(a * 37 + j * 1.7) * 0.5 + Math.sin(a * 91 + j * 2.9) * 0.3) * 0.12 * top * t * (1 - t) : 0;
        const el = THREE.MathUtils.lerp(-6, top, Math.pow(t, 0.7)) + bump;
        const r = R * (1 - 0.25 * t); // crest slightly closer -> lit slopes
        pos.push(d.x * r, Math.tan(THREE.MathUtils.degToRad(el)) * R, d.z * r);
      }
    }
    for (let i = 0; i < seg; i++)
      for (let j = 0; j < rows; j++) {
        const a = i * (rows + 1) + j, b = a + rows + 1;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = makeLunar(new THREE.MeshLambertMaterial({ color: 0x55524d, side: THREE.DoubleSide }), 'mountain', (shader) => {
      // Distant massifs: ridges and crater pocks as normal perturbation + albedo mottling.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vLocal;\n${NOISE_GLSL}`)
        .replace('#include <map_fragment>', `vec2 mp = vec2(atan(vLocal.z, vLocal.x) * 2400.0, vLocal.y);
vec3 n1 = lnoised(mp * 0.004), n2 = lnoised(mp * 0.017 + 7.0), n3 = lnoised(mp * 0.06 + 3.0);
vec2 mg = n1.yz * 1.2 + n2.yz * 0.6 + n3.yz * 0.3;
diffuseColor.rgb *= 0.8 + 0.35 * n2.x + 0.15 * n3.x;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
normal = normalize(normal + vec3(mg.x, mg.y, 0.0) * 0.5);`);
    });
    const m = new THREE.Mesh(g, mat);
    m.renderOrder = -8;
    m.frustumCulled = false;
    return m;
  }

  /** 1 = dark-adapted eye (all catalogue stars), lower = only the brightest remain. */
  setAdaptation(a: number): void {
    const u = (this.stars.material as THREE.ShaderMaterial).uniforms.uAdapt;
    u.value += (a - u.value) * 0.08;
    if (this.milkyWay) (this.milkyWay.material as THREE.ShaderMaterial).uniforms.uAdapt.value = u.value;
    if (this.constLines) (this.constLines.material as THREE.LineBasicMaterial).opacity = 0.12 + 0.3 * u.value;
  }

  toggleConstellations(): boolean {
    if (!this.constLines) return false;
    this.constLines.visible = !this.constLines.visible;
    return this.constLines.visible;
  }

  /**
   * Meteoroid impact flash. With no atmosphere there are no shooting stars on the
   * Moon: meteoroids arrive unseen at 20–70 km/s and flash briefly on impact —
   * visible only where the ground is dark (in shadow).
   */
  impactFlash(scene: THREE.Scene, pos: THREE.Vector3, dist: number): void {
    const mat = new THREE.SpriteMaterial({ map: this.flashTex, color: 0xfff1dc, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.position.copy(pos);
    sprite.scale.setScalar(Math.max(0.6, dist * 0.004));
    scene.add(sprite);
    this.flashes.push({ sprite, t: 0, peak: 1.5 + Math.random() * 3 });
  }

  updateFlashes(dt: number, scene: THREE.Scene): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      // ~20 ms rise, ~150 ms thermal glow decay.
      const k = f.t < 0.02 ? f.t / 0.02 : Math.exp(-(f.t - 0.02) / 0.08);
      (f.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, k);
      (f.sprite.material as THREE.SpriteMaterial).color.setScalar(f.peak * k);
      if (f.t > 0.6) {
        scene.remove(f.sprite);
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
      }
    }
  }

  update(camera: THREE.Camera, groundY: number): void {
    this.group.position.copy(camera.position);
    // Lensflare projects points behind the camera to the front; hide it then.
    const dir = camera.getWorldDirection(new THREE.Vector3());
    this.flare.visible = dir.dot(this.sunDir) > 0.05;
    this.mountains.position.y = groundY - camera.position.y;
  }
}

/** Approximate sRGB colour of a black body (Tanner Helland fit). */
function blackbody(T: number): [number, number, number] {
  const t = T / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
    b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
    b = 255;
  }
  const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
  return [c(r), c(g), c(b)];
}

/**
 * Real star field: Yale Bright Star Catalogue (V <= 6.5) placed for the Apollo 15
 * site and epoch. Point sources with flux 10^(-0.4 V), colour from temperature;
 * no twinkling (no atmosphere). Falls back to a random field if data is missing.
 */
function buildStars(data: Float32Array | undefined, fallbackCount: number): THREE.Points {
  let n: number;
  const pos: number[] = [], col: number[] = [], flux: number[] = [];
  if (data && data.length >= 5) {
    n = data.length / 5;
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      pos.push(data[o] * 9000, data[o + 1] * 9000, data[o + 2] * 9000);
      const [r, g, b] = blackbody(data[o + 4] || 5800);
      col.push(r, g, b);
      flux.push(Math.pow(10, -0.4 * data[o + 3]));
    }
  } else {
    const rnd = mulberry32(42);
    n = fallbackCount;
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.push(Math.cos(a) * s * 9000, u * 9000, Math.sin(a) * s * 9000);
      col.push(1, 1, 1);
      flux.push(Math.pow(10, -0.4 * (6.5 - 7 * Math.pow(rnd(), 0.3))));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('flux', new THREE.Float32BufferAttribute(flux, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uAdapt: { value: 1 }, uScale: { value: Math.min(2, window.devicePixelRatio || 1) } },
    vertexShader: /* glsl */ `
      attribute float flux;
      uniform float uAdapt;
      uniform float uScale;
      varying vec3 vCol;
      void main() {
        // Perceived brightness ~ flux^0.5 (eye/camera response); the threshold
        // rises when the eye is light-adapted to the sunlit ground.
        float b = sqrt(flux) * 3.2;
        float vis = max(b - (1.0 - uAdapt) * 1.6, 0.0) * mix(0.35, 1.0, uAdapt);
        vCol = color * min(vis, 2.5);
        gl_PointSize = (2.2 + 2.6 * clamp(b - 1.0, 0.0, 1.8)) * uScale * step(0.01, vis);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float a = exp(-dot(c, c) * 9.0);
        gl_FragColor = vec4(vCol * a, 1.0);
      }`,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const p = new THREE.Points(g, mat);
  p.frustumCulled = false;
  return p;
}

/**
 * Milky Way: a band along the real galactic plane (pole/centre given in the
 * local sky frame), wider and brighter toward the galactic centre, mottled, with
 * the Great Rift dust lane. Only visible to a dark-adapted eye.
 */
function buildMilkyWay(pole: THREE.Vector3, center: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPole: { value: pole.normalize() }, uCenter: { value: center.normalize() }, uAdapt: { value: 1 } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      varying vec3 vD;
      uniform vec3 uPole, uCenter;
      uniform float uAdapt;
      float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n3(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * n3(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vD);
        float b = asin(clamp(dot(d, uPole), -1.0, 1.0));
        vec3 e2 = normalize(cross(uPole, uCenter));
        float l = atan(dot(d, e2), dot(d, uCenter));
        float bulge = exp(-l * l / 0.35);
        float width = 0.10 + 0.12 * bulge;
        float band = exp(-b * b / (width * width)) * (0.35 + 0.65 * exp(-l * l / 2.5));
        float mott = fbm(d * 9.0) * 0.8 + fbm(d * 30.0) * 0.4;
        float rift = 1.0 - 0.75 * exp(-pow((b - 0.02 * sin(l * 3.0)) / 0.025, 2.0)) * smoothstep(1.6, 0.2, abs(l));
        float I = band * mott * rift * 0.22 * uAdapt * uAdapt;
        gl_FragColor = vec4(vec3(1.0, 0.95, 0.88) * I, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    transparent: true,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(9200, 64, 32), mat);
  m.renderOrder = -11;
  m.frustumCulled = false;
  return m;
}
