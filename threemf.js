/**
 * 3MF okuyucu (cekirdek + Production eklentisi).
 *
 * three.js'in 3MFLoader'i Bambu Studio / Creality Print / PrusaSlicer'in
 * kullandigi "Production" eklentisini desteklemiyor: bu dosyalarda geometri
 * ana 3dmodel.model'de degil, 3D/Objects/*.model gibi ayri dosyalardadir ve
 * ana dosya ona <component p:path="..."> ile basvurur. three'un okuyucusu
 * bu durumda cokuyordu. Bu okuyucu paketteki tum .model dosyalarini okuyup
 * bilesenleri donusumleriyle birlikte cozer.
 *
 * Donen grup 3MF ekseninde (Z yukari) ve dosyanin biriminde; birim ve eksen
 * donusumunu app.js yapar.
 */
import * as THREE from "three";
import { unzipSync, strFromU8 } from "three/addons/libs/fflate.module.js";

export const MF_UNITS = {
  micron: 1e-6, millimeter: 1e-3, centimeter: 1e-2,
  inch: 0.0254, foot: 0.3048, meter: 1,
};

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
};

/**
 * 3MF'in 4x3 satir-oncelikli donusumu ("m00 m01 m02 m10 ... m32"):
 * nokta satir vektoru olarak carpilir (x' = x*m00 + y*m10 + z*m20 + m30).
 */
function parseTransform(text) {
  const m4 = new THREE.Matrix4();
  if (!text) return m4;
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some(Number.isNaN)) return m4;
  return m4.set(
    v[0], v[3], v[6], v[9],
    v[1], v[4], v[7], v[10],
    v[2], v[5], v[8], v[11],
    0, 0, 0, 1);
}

function normalisePath(p, fallback) {
  if (!p) return fallback;
  return p.replace(/^\//, "");
}

/** Bir .model dosyasindaki nesneleri (mesh ya da bilesen listesi) okur. */
function parseModelFile(xml) {
  const objects = new Map();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let om;
  while ((om = objRe.exec(xml))) {
    const id = attr(om[1], "id");
    const body = om[2];
    const obj = { mesh: null, components: [] };

    const meshStart = body.indexOf("<mesh");
    if (meshStart !== -1) {
      const positions = [];
      const vRe = /<vertex\b([^>]*)\/?>/g;
      let vm;
      while ((vm = vRe.exec(body))) {
        positions.push(Number(attr(vm[1], "x")), Number(attr(vm[1], "y")), Number(attr(vm[1], "z")));
      }
      const indices = [];
      const tRe = /<triangle\b([^>]*)\/?>/g;
      let tm;
      while ((tm = tRe.exec(body))) {
        indices.push(Number(attr(tm[1], "v1")), Number(attr(tm[1], "v2")), Number(attr(tm[1], "v3")));
      }
      if (positions.length && indices.length) obj.mesh = { positions, indices };
    }

    const cRe = /<component\b([^>]*)\/?>/g;
    let cm;
    while ((cm = cRe.exec(body))) {
      obj.components.push({
        objectid: attr(cm[1], "objectid"),
        path: attr(cm[1], "p:path"),
        transform: parseTransform(attr(cm[1], "transform")),
      });
    }
    objects.set(id, obj);
  }

  const items = [];
  const build = xml.match(/<build\b[^>]*>([\s\S]*?)<\/build>/);
  if (build) {
    const iRe = /<item\b([^>]*)\/?>/g;
    let im;
    while ((im = iRe.exec(build[1]))) {
      items.push({
        objectid: attr(im[1], "objectid"),
        path: attr(im[1], "p:path"),
        transform: parseTransform(attr(im[1], "transform")),
      });
    }
  }
  const unitMatch = xml.match(/<model\b[^>]*\sunit\s*=\s*"([a-z]+)"/i);
  return { objects, items, unit: unitMatch ? unitMatch[1].toLowerCase() : "millimeter" };
}

/** ArrayBuffer -> { group, unitScale } ; hic mesh bulunamazsa null. */
export function parse3mf(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const models = new Map();
  for (const name of Object.keys(files)) {
    if (/\.model$/i.test(name)) models.set(name, parseModelFile(strFromU8(files[name])));
  }

  // Kok model: _rels/.rels'in gosterdigi, yoksa 3D/3dmodel.model
  let rootPath = "3D/3dmodel.model";
  const rels = files["_rels/.rels"] && strFromU8(files["_rels/.rels"]);
  const target = rels && rels.match(/Target\s*=\s*"([^"]+\.model)"/i);
  if (target) rootPath = normalisePath(target[1]);
  const root = models.get(rootPath) || [...models.values()][0];
  if (!root) return null;

  const material = new THREE.MeshStandardMaterial({ color: 0xb4bcc8, roughness: 0.6, metalness: 0 });
  const geometryCache = new Map();
  const group = new THREE.Group();
  let meshCount = 0;

  const geometryFor = (path, id, mesh) => {
    const key = `${path}#${id}`;
    let geo = geometryCache.get(key);
    if (!geo) {
      geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
      geo.setIndex(mesh.indices);
      geo.computeVertexNormals();
      geometryCache.set(key, geo);
    }
    return geo;
  };

  // Bilesenleri donusumleri carpilarak cozer; dongu korumasi derinlikle.
  const place = (path, id, matrix, depth) => {
    if (depth > 16) return;
    const file = models.get(path);
    const obj = file && file.objects.get(id);
    if (!obj) return;
    if (obj.mesh) {
      const mesh = new THREE.Mesh(geometryFor(path, id, obj.mesh), material);
      mesh.name = `nesne_${id}`;
      mesh.matrixAutoUpdate = true;
      matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      group.add(mesh);
      meshCount++;
    }
    for (const c of obj.components) {
      const childPath = normalisePath(c.path, path);
      place(childPath, c.objectid, matrix.clone().multiply(c.transform), depth + 1);
    }
  };

  for (const item of root.items) {
    place(normalisePath(item.path, rootPath), item.objectid, item.transform.clone(), 0);
  }
  if (!meshCount) return null;
  return { group, unitScale: MF_UNITS[root.unit] || MF_UNITS.millimeter };
}
