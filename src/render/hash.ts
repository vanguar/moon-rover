/**
 * Integer hash (PCG2D, Jarzynski & Olano 2020) of a lattice point, in [0, 1]: exact at
 * any coordinate. The classic fract(sin(dot(p, k)) * 43758.5) loses precision once
 * p reaches thousands (metres along a track, a storm kilometres away), and on mobile
 * GPUs its noise then collapses into regular stripes and square blocks.
 */
export const HASH2I_GLSL = /* glsl */ `
float hash2i(vec2 p) {
  uvec2 v = uvec2(ivec2(floor(p)) + 1048576);
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return float(v.x) * (1.0 / 4294967295.0);
}
`;
