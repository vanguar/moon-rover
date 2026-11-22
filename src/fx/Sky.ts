import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { makeLunar } from '../render/lunar';
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

  constructor(sunAz: number, sunEl: number, starCount: number, earthPos?: { azimuth: number; elevation: number }) {
    this.sunDir = azElToDir(sunAz, sunEl);
    // Earth from Hadley Rille (26.1 N, 3.6 E): az ≈ 188°, el ≈ 64° (librations ignored).
    this.earthDir = earthPos ? azElToDir(earthPos.azimuth, earthPos.elevation) : azElToDir(188, 63.8);

    // Stars: magnitude-distributed points, fixed screen size.
    const rnd = mulberry32(42);
    const pos = new Float32Array(starCount * 3);
    const col = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pos.set([Math.cos(a) * s * 9000, u * 9000, Math.sin(a) * s * 9000], i * 3);
      const mag = Math.pow(rnd(), 6); // most stars faint
      const tint = rnd();
      const k = 0.25 + mag * 1.6;
      col.set([k * (tint > 0.8 ? 1 : 0.85 + tint * 0.15), k * 0.95, k * (tint < 0.2 ? 1 : 0.85 + (1 - tint) * 0.2)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, fog: false }),
    );
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
    const m = new THREE.Mesh(g, makeLunar(new THREE.MeshLambertMaterial({ color: 0x3c3a37, side: THREE.DoubleSide }), 'mountain'));
    m.renderOrder = -8;
    m.frustumCulled = false;
    return m;
  }

  update(camera: THREE.Camera, groundY: number): void {
    this.group.position.copy(camera.position);
    this.mountains.position.y = groundY - camera.position.y;
  }
}
