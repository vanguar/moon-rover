import * as THREE from 'three';

/**
 * Free the GPU resources of an object tree (geometries, materials, their textures).
 * Shared cached assets (NASA glTF) are simply re-uploaded if used again later.
 */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.geometry && !m.material) return;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      const u = (mat as THREE.ShaderMaterial).uniforms;
      if (u) for (const k of Object.keys(u)) if (u[k].value instanceof THREE.Texture) (u[k].value as THREE.Texture).dispose();
      mat.dispose();
    }
  });
}
