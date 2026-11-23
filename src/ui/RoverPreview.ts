import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { RoverModel } from '../rover/models/kit';
import type { RoverSpec } from '../rover/specs';

/**
 * Turntable view of the selected rover in the menu: the procedural model with
 * all its moving parts running (wheels, mast, arm, lid, wings), and animated
 * contour lines — the model's feature edges glow as a scan band sweeps up and a
 * pulse travels along them.
 */
export class RoverPreview {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1.6, 0.01, 100);
  private model: RoverModel | null = null;
  private holder = new THREE.Group();
  private edgeMat: THREE.ShaderMaterial;
  private ground: THREE.Mesh;
  private spec: RoverSpec | null = null;
  private time = 0;
  private last = performance.now();
  private yaw = 0.6;
  private drag: { id: number; x: number } | null = null;
  private size = 1;
  private centerY = 0.5;
  private wheelLocal: THREE.Vector3[] = [];
  private key: THREE.DirectionalLight;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'preview3d';
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    } catch {
      this.renderer = null;
    }
    this.scene.environmentIntensity = 0.55;
    this.key = new THREE.DirectionalLight(0xffffff, 3.2);
    this.key.position.set(4, 6, 3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.radius = 4;
    this.scene.add(this.key, this.key.target);
    this.scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x302820, 0.6));
    const rim = new THREE.DirectionalLight(0x8fd8ff, 1.6);
    rim.position.set(-5, 3, -4);
    this.scene.add(rim);
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.ShadowMaterial({ opacity: 0.45 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.scene.add(this.holder);
    this.edgeMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uH: { value: 1 }, uColor: { value: new THREE.Color(0x7fdcff) } },
      vertexShader: /* glsl */ `
        varying float vY;
        varying float vS;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vY = w.y;
          vS = dot(w.xyz, vec3(3.1, 1.7, 2.3));
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        varying float vY;
        varying float vS;
        uniform float uTime;
        uniform float uH;
        uniform vec3 uColor;
        void main() {
          float scan = fract(uTime * 0.22) * uH * 1.5 - uH * 0.2;
          float band = exp(-pow((vY - scan) / (uH * 0.05), 2.0));
          float pulse = 0.5 + 0.5 * sin(vS * 6.0 - uTime * 5.0);
          float a = 0.16 + 0.22 * pulse + 0.9 * band;
          gl_FragColor = vec4(uColor * (0.7 + 1.6 * band), a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drag = { id: e.pointerId, x: e.clientX };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.yaw += (e.clientX - this.drag.x) * 0.01;
      this.drag.x = e.clientX;
    });
    const end = () => (this.drag = null);
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
  }

  get available(): boolean {
    return !!this.renderer;
  }

  setRover(spec: RoverSpec, theme: 'moon' | 'mars'): void {
    if (this.spec === spec) return;
    this.spec = spec;
    if (this.model) {
      this.holder.remove(this.model.root);
      this.model.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh || (o as THREE.LineSegments).isLineSegments) m.geometry.dispose();
      });
    }
    const model = spec.build();
    this.model = model;
    // Rest pose: wheels on the ground plane, model centred.
    this.wheelLocal = spec.wheels.map(([x, z]) => new THREE.Vector3(x, spec.axleY, z));
    model.root.position.y = -spec.axleY + spec.wheelRadius;
    for (const w of model.wheels) {
      if (w.uniforms) w.uniforms.uDefl.value = 0;
    }
    // Contour lines on every mesh, following its animation.
    const meshes: THREE.Mesh[] = [];
    model.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m.material as THREE.Material).transparent) meshes.push(m);
    });
    for (const m of meshes) {
      const geo = new THREE.EdgesGeometry(m.geometry, 32);
      const l = new THREE.LineSegments(geo, this.edgeMat);
      l.raycast = () => {};
      m.add(l);
    }
    this.holder.add(model.root);
    // Settle the moving parts (suspension links, lids) before measuring.
    model.animate({ dt: 0.016, time: 0, speed: 0, steer: 0, lookYaw: 0, lookPitch: 0, parked: true, wheelLocal: this.wheelLocal, preview: true });
    model.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.root);
    const size = box.getSize(new THREE.Vector3());
    this.size = Math.max(size.x, size.z, size.y * 1.15);
    this.centerY = (box.min.y + box.max.y) / 2;
    this.edgeMat.uniforms.uH.value = size.y + 0.1;
    (this.edgeMat.uniforms.uColor.value as THREE.Color).set(theme === 'mars' ? 0xffb070 : 0x7fdcff);
    this.ground.scale.setScalar(this.size * 0.9);
    const s = this.key.shadow.camera as THREE.OrthographicCamera;
    s.left = s.bottom = -this.size;
    s.right = s.top = this.size;
    s.near = 0.1;
    s.far = 40 * Math.max(1, this.size);
    s.updateProjectionMatrix();
    this.key.position.set(this.size * 2, this.size * 3, this.size * 1.5);
    this.time = 0;
  }

  render(now: number): void {
    const r = this.renderer;
    if (!r || !this.model || !this.spec) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * r.getPixelRatio()) || this.canvas.height !== Math.round(h * r.getPixelRatio())) {
      r.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    if (!this.drag) this.yaw += dt * 0.28;
    this.holder.rotation.y = this.yaw;
    // Wheels roll; everything else animates through the model's own preview cycle.
    const roll = Math.sin(this.time * 0.25) > -0.3 ? 1 : 0;
    for (const wv of this.model.wheels) wv.spin.rotation.x += dt * 1.6 * roll;
    this.model.animate({
      dt, time: this.time, speed: 0.6 * roll, steer: Math.sin(this.time * 0.5) * 0.3, lookYaw: 0, lookPitch: 0,
      parked: true, wheelLocal: this.wheelLocal, preview: true,
    });
    this.model.setSteering(Math.sin(this.time * 0.5) * 0.3);
    this.edgeMat.uniforms.uTime.value = this.time;
    const d = this.size * 1.9;
    this.camera.position.set(0, this.centerY + this.size * 0.3, d);
    this.camera.lookAt(0, this.centerY, 0);
    r.render(this.scene, this.camera);
  }
}
