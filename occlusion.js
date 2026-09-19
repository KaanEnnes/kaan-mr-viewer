/**
 * Yumusak derinlik ortmesi (gercek nesneler sanal modelin onune gecince).
 *
 * three.js depth-sensing acikken gozlugun derinlik dokusunu dogrudan derinlik
 * tamponuna yazar: ortme ya tam ya hic olur. Quest'in derinlik haritasi dusuk
 * cozunurluklu ve gurultulu oldugu icin kenarlar tirtikli ve titrek cikiyor.
 * Burada onun yerine model materyallerinde, gercek ve sanal derinlik farkina
 * gore kademeli saydamlik uygulanir ve 3x3 komsu ornegin ortalamasi alinir
 * (Meta'nin "soft occlusion" onerisi).
 */
import * as THREE from "three";

const CHUNK_DECL = /* glsl */ `
uniform sampler2DArray occDepth;
uniform vec2 occViewport;
uniform float occNear;
uniform float occFar;
uniform float occOn;

float occLinear(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * occNear * occFar) / (occFar + occNear - z * (occFar - occNear));
}
`;

// Gercek yuzey sanal noktanin 1.5 cm onundeyse tamamen ortulur, 3 cm
// arkasindaysa tamamen gorunur; arasi yumusak gecis.
const CHUNK_APPLY = /* glsl */ `
if (occOn > 0.5) {
  vec2 occUv = gl_FragCoord.xy / occViewport;
  float occLayer = 0.0;
  if (occUv.x >= 1.0) { occUv.x -= 1.0; occLayer = 1.0; }
  float occVirtual = occLinear(gl_FragCoord.z);
  vec2 occTexel = 2.0 / vec2(textureSize(occDepth, 0).xy);
  float occVisible = 0.0;
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      vec2 uv = clamp(occUv + vec2(float(dx), float(dy)) * occTexel, 0.0, 1.0);
      float real = occLinear(texture(occDepth, vec3(uv, occLayer)).r);
      occVisible += smoothstep(-0.015, 0.03, real - occVirtual);
    }
  }
  gl_FragColor.a *= occVisible / 9.0;
}
`;

export class SoftOcclusion {
  constructor(renderer) {
    this.renderer = renderer;
    this.uniforms = {
      occDepth: { value: null },
      occViewport: { value: new THREE.Vector2(1, 1) },
      occNear: { value: 0.1 },
      occFar: { value: 100 },
      occOn: { value: 0 },
    };
    // three.js'in sert ortmesini kapat; ortme artik materyallerde.
    renderer.xr.getDepthSensingMesh = () => null;
  }

  get active() { return this.uniforms.occOn.value > 0.5; }

  /** Materyale ortme kodunu ekler (ayni uniform nesneleri paylasilir). */
  patch(material) {
    if (material.userData.softOcclusion) return;
    material.userData.softOcclusion = true;
    const uniforms = this.uniforms;
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      previous?.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = CHUNK_DECL + shader.fragmentShader.replace(
        "#include <dithering_fragment>", CHUNK_APPLY + "\n#include <dithering_fragment>");
    };
    const key = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => (key ? key() : "") + "|soft-occlusion";
    material.needsUpdate = true;
  }

  /** Her karede: derinlik dokusu ve goz goruntu alani. */
  update() {
    const texture = this.renderer.xr.getDepthTexture?.();
    if (!texture) {
      this.uniforms.occOn.value = 0;
      return;
    }
    const cam = this.renderer.xr.getCamera();
    const vp = cam.cameras && cam.cameras[0] && cam.cameras[0].viewport;
    if (!vp || !vp.z || !vp.w) {
      this.uniforms.occOn.value = 0;
      return;
    }
    this.uniforms.occDepth.value = texture;
    this.uniforms.occViewport.value.set(vp.z, vp.w);
    this.uniforms.occNear.value = cam.near;
    this.uniforms.occFar.value = cam.far;
    this.uniforms.occOn.value = 1;
  }
}
