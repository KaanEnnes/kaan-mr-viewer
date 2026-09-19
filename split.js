/**
 * Tek mesh'e birlestirilmis modelleri parcalarina ayirir.
 *
 * Bircok dilimleyici / donusturucu (or. Creality) tum parcalari tek bir
 * geometriye yazar. Print-in-place tasarimlarda parcalar arasinda baski
 * boslugu oldugu icin her hareketli parca birbirine degmeyen ayri bir
 * "kabuk"tur; ayni noktayi paylasan ucgenler birlestirilerek (union-find)
 * bu kabuklar bulunur. PC pipeline'indaki bolme adiminin tarayici karsiligi.
 */
import * as THREE from "three";

// Bundan fazla kabuk cikarsa model parcali degil, gurultulu (kopuk ucgenler)
// sayilir ve bolunmez: yuzlerce fizik govdesi gozlugu yorar.
const MAX_PARTS = 200;

/** root altindaki her tek parcali mesh'i kabuklarina boler; bolunen mesh sayisini dondurur. */
export function splitDisconnected(root) {
  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && !o.isSkinnedMesh && !o.name.startsWith("PART_") && !o.name.startsWith("COL_")) meshes.push(o);
  });
  let count = 0;
  for (const mesh of meshes) {
    const pieces = splitGeometry(mesh.geometry);
    if (!pieces) continue;
    const parent = mesh.parent;
    pieces.forEach((geo, i) => {
      const part = new THREE.Mesh(geo, mesh.material);
      part.name = `${mesh.name || "parca"}_${i}`;
      part.position.copy(mesh.position);
      part.quaternion.copy(mesh.quaternion);
      part.scale.copy(mesh.scale);
      parent.add(part);
    });
    parent.remove(mesh);
    mesh.geometry.dispose();
    count++;
  }
  return count;
}

/** Geometriyi kabuklarina ayirir; tek kabuksa ya da ayrilamiyorsa null. */
export function splitGeometry(geometry) {
  const pos = geometry.attributes.position;
  if (!pos || geometry.groups.length > 1 || geometry.morphAttributes.position) return null;
  const index = geometry.index;
  const triCount = (index ? index.count : pos.count) / 3;
  if (triCount < 2) return null;

  // Ayni konumdaki kopyalari (normal/uv farkli dikisler) tek noktaya indir.
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const eps = size * 1e-6;
  const weld = new Int32Array(pos.count);
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) / eps)},${Math.round(pos.getY(i) / eps)},${Math.round(pos.getZ(i) / eps)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = seen.size;
      seen.set(key, id);
    }
    weld[i] = id;
  }

  const parent = new Int32Array(seen.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const vertexOf = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);

  for (let t = 0; t < triCount; t++) {
    const a = weld[vertexOf(t, 0)];
    union(a, weld[vertexOf(t, 1)]);
    union(a, weld[vertexOf(t, 2)]);
  }

  const groups = new Map();
  for (let t = 0; t < triCount; t++) {
    const r = find(weld[vertexOf(t, 0)]);
    let list = groups.get(r);
    if (!list) groups.set(r, (list = []));
    list.push(t);
  }
  if (groups.size < 2 || groups.size > MAX_PARTS) return null;

  // Her kabuk icin kullandigi koseleri ve tum oznitelikleri (normal, uv, renk) kopyala.
  const names = Object.keys(geometry.attributes);
  const pieces = [];
  for (const tris of groups.values()) {
    const remap = new Map();
    const newIndex = new Uint32Array(tris.length * 3);
    tris.forEach((t, j) => {
      for (let k = 0; k < 3; k++) {
        const v = vertexOf(t, k);
        let n = remap.get(v);
        if (n === undefined) {
          n = remap.size;
          remap.set(v, n);
        }
        newIndex[j * 3 + k] = n;
      }
    });
    const geo = new THREE.BufferGeometry();
    for (const name of names) {
      const src = geometry.attributes[name];
      const itemSize = src.itemSize;
      // getComponent normalize edilmis degeri (0-1) dondurur; tamsayi diziye
      // geri yazilirsa bozulur. Kopya her zaman Float32.
      const arr = new Float32Array(remap.size * itemSize);
      for (const [oldV, newV] of remap) {
        for (let c = 0; c < itemSize; c++) arr[newV * itemSize + c] = src.getComponent(oldV, c);
      }
      geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
    }
    geo.setIndex(new THREE.BufferAttribute(newIndex, 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    pieces.push(geo);
  }
  // En buyuk parca once: govde genelde ilk sirada olsun.
  pieces.sort((a, b) => b.index.count - a.index.count);
  return pieces;
}
