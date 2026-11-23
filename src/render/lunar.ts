import * as THREE from 'three';

/**
 * Lunar regolith photometry for Lambert-based materials.
 *
 * Replaces Lambert's direct term with McEwen's lunar-Lambert model (blend of
 * Lommel-Seeliger and Lambert, weight L(g) from the phase angle g) multiplied by
 * the Hapke opposition surge B(g) = 1 + B0 / (1 + tan(g/2) / h): the bright halo
 * around the antisolar point (around the rover's own shadow, and around the
 * headlight beam seen from the cab).
 */
export const LUNAR_BRDF_GLSL = /* glsl */ `
varying vec3 vViewPosition;
uniform float uOppB0;
uniform float uOppH;
uniform float uLambertW;

struct LambertMaterial {
	vec3 diffuseColor;
	float specularStrength;
};

float lunarReflectance( vec3 N, vec3 L, vec3 V ) {
	float mu0 = dot( N, L );
	if ( mu0 <= 0.0 ) return 0.0;
	float mu = max( dot( N, V ), 0.0 );
	float g = acos( clamp( dot( L, V ), -1.0, 1.0 ) );
	float gd = degrees( g );
	float Lw = clamp( 1.0 - 0.019 * gd + 2.42e-4 * gd * gd - 1.46e-6 * gd * gd * gd, 0.0, 1.0 );
	float f = ( 1.0 - Lw ) * mu0 + Lw * 2.0 * mu0 / ( mu0 + mu + 1e-3 );
	// Mars soils are close to Lambertian (dusty, multiple scattering).
	f = mix( f, mu0, uLambertW );
	float B = 1.0 + uOppB0 / ( 1.0 + tan( min( g, 3.0 ) * 0.5 ) / uOppH );
	return min( f, 2.0 ) * B;
}

void RE_Direct_Lunar( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	float r = lunarReflectance( geometryNormal, directLight.direction, geometryViewDir );
	reflectedLight.directDiffuse += directLight.color * r * BRDF_Lambert( material.diffuseColor );
}

void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
	reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}

#define RE_Direct				RE_Direct_Lunar
#define RE_IndirectDiffuse		RE_IndirectDiffuse_Lambert
`;

export const NOISE_GLSL = /* glsl */ `
float lhash12( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
// Value noise with analytic derivatives: (value, d/dx, d/dy).
vec3 lnoised( vec2 x ) {
	x = mod( x, 4096.0 );
	vec2 i = floor( x );
	vec2 f = fract( x );
	vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
	vec2 du = 30.0 * f * f * ( f * ( f - 2.0 ) + 1.0 );
	float a = lhash12( i );
	float b = lhash12( i + vec2( 1.0, 0.0 ) );
	float c = lhash12( i + vec2( 0.0, 1.0 ) );
	float d = lhash12( i + vec2( 1.0, 1.0 ) );
	float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
	return vec3( a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2( k1 + k4 * u.y, k2 + k4 * u.x ) );
}
`;

/**
 * Lunar curvature: the surface drops by d²/2R below the camera's tangent plane
 * (4.6 m at 4 km, 115 m at 20 km), which sets the close lunar horizon and sinks
 * distant massifs realistically. Physics works in the local flat frame.
 */
export const CURVATURE_PROJECT_VERTEX = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
vec4 wpCurv = modelMatrix * mvPosition;
vec2 dCurv = wpCurv.xz - cameraPosition.xz;
wpCurv.y -= dot( dCurv, dCurv ) * uCurvK;
mvPosition = viewMatrix * wpCurv;
gl_Position = projectionMatrix * mvPosition;
`;

export const oppositionUniforms = {
  uOppB0: { value: 0.9 },
  uOppH: { value: 0.06 },
  /** 0 = lunar-Lambert (McEwen), 1 = Lambert. */
  uLambertW: { value: 0 },
  /** Curvature drop factor 1 / 2R. */
  uCurvK: { value: 0.5 / 1737400 },
};

/** Configure photometry and curvature for the current body. */
export function setSurfacePhotometry(body: 'moon' | 'mars', radius: number): void {
  const u = oppositionUniforms;
  u.uCurvK.value = 0.5 / radius;
  if (body === 'mars') {
    u.uOppB0.value = 0.35;
    u.uOppH.value = 0.08;
    u.uLambertW.value = 0.75;
  } else {
    u.uOppB0.value = 0.9;
    u.uOppH.value = 0.06;
    u.uLambertW.value = 0;
  }
}

/** Patch a MeshLambertMaterial to use lunar photometry. */
export function makeLunar(
  mat: THREE.MeshLambertMaterial,
  key: string,
  extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void,
): THREE.MeshLambertMaterial {
  mat.customProgramCacheKey = () => `lunar-${key}`;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOppB0 = oppositionUniforms.uOppB0;
    shader.uniforms.uOppH = oppositionUniforms.uOppH;
    shader.uniforms.uLambertW = oppositionUniforms.uLambertW;
    shader.uniforms.uCurvK = oppositionUniforms.uCurvK;
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_lambert_pars_fragment>', LUNAR_BRDF_GLSL);
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uCurvK;\nvoid main() {')
      .replace('#include <project_vertex>', CURVATURE_PROJECT_VERTEX);
    extra?.(shader);
  };
  return mat;
}
