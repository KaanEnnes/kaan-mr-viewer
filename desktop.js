/**
 * PC'de 3B onizleme: sayfadaki goruntuleyici, fareyle dondurme/yakinlastirma
 * ve VR'daki araclarin bir kismi (gorunum, seffaflik, boyut, olculer, golge,
 * parca ayirma, kesit, animasyon, fizik, fareyle cetvel).
 *
 * VR ile ayni sahneyi ve model fonksiyonlarini kullanir (api, app.js'ten);
 * VR'a girilince askiya alinir, cikilinca model ortaya geri konur.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const BACKGROUND = 0x11141b;

export function initDesktop(api) {
  const { state, settings } = api;
  const $ = (id) => document.getElementById(id);
  const el = {
    viewer: $("viewer"),
    empty: $("viewer-empty"),
    tools: $("viewer-tools"),
    info: $("viewer-info"),
    view: $("t-view"),
    opacity: $("t-opacity"),
    explode: $("t-explode"),
    physics: $("t-physics"),
    section: $("t-section"),
    sectionPos: $("t-section-pos"),
    animRow: $("t-anim-row"),
    anim: $("t-anim"),
    animPos: $("t-anim-pos"),
    animTime: $("t-anim-time"),
    rulerOut: $("t-ruler-out"),
  };

  const renderer = state.renderer;
  const camera = state.camera;
  const canvas = renderer.domElement;
  canvas.classList.add("viewer-canvas");
  el.viewer.appendChild(canvas);
  renderer.setClearColor(BACKGROUND, 1);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  // Zemin izgarasi yalnizca PC'de; VR'da gercek zemin var.
  const helpers = new THREE.Group();
  const grid = new THREE.GridHelper(4, 40, 0x3a4458, 0x232937);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  helpers.add(grid);
  state.scene.add(helpers);

  let active = true;
  let lastTime = 0;

  // --- boyut ----------------------------------------------------------------

  function resize() {
    if (state.session) return; // VR'da boyut gozlugun
    const w = Math.max(el.viewer.clientWidth, 200);
    const h = Math.round(Math.min(w * 0.62, 560));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", resize);
  new ResizeObserver(resize).observe(el.viewer);

  // --- model yerlestirme ve kamera ----------------------------------------------

  /** Modeli izgaranin ortasina, dik ve toplanmis koyar. */
  function place(m) {
    api.removeBodies(m);
    m.physics = false;
    m.explode = m.explodeTarget = 0;
    api.restoreHome(m.root);
    api.applyExplode(m);
    m.holder.position.set(0, 0, 0);
    m.holder.rotation.set(0, 0, 0);
    m.holder.updateMatrixWorld(true);
  }

  function frameCamera() {
    const m = state.model;
    camera.fov = 45;
    if (!m) {
      camera.position.set(0.6, 0.5, 0.8);
      controls.target.set(0, 0.1, 0);
    } else {
      const box = new THREE.Box3().setFromObject(m.holder);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const r = Math.max(sphere.radius, 0.01);
      const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * 1.15;
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).add(new THREE.Vector3(0.75, 0.55, 1).normalize().multiplyScalar(dist));
      camera.near = Math.max(r / 200, 0.001);
      camera.far = dist * 30;
      grid.scale.setScalar(Math.max(r * 2, 0.25));
    }
    camera.updateProjectionMatrix();
    controls.update();
  }

  // --- durum -> arayuz -----------------------------------------------------------

  function setPressed(button, on) {
    button.setAttribute("aria-pressed", String(Boolean(on)));
  }

  function info() {
    const m = state.model;
    if (!m) return "";
    const size = m.localBox.getSize(new THREE.Vector3())
      .multiplyScalar(m.root.scale.x * m.holder.scale.x * 100);
    const f = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
    const scale = Math.round(m.holder.scale.x * 100);
    return `${m.parts.length} parca · ${f(size.x)} × ${f(size.z)} × ${f(size.y)} cm`
      + (scale === 100 ? " · gercek boyut" : ` · %${scale} boyut`);
  }

  function refresh() {
    const m = state.model;
    if (!m) return;
    el.info.textContent = info();
    el.view.textContent = m.realistic ? "Gercek" : "Hayalet";
    setPressed(el.view, m.realistic);
    el.opacity.value = String(Math.round((1 - m.opacity) * 100));
    for (const b of el.tools.querySelectorAll("[data-toggle]")) setPressed(b, settings[b.dataset.toggle]);
    el.explode.textContent = m.explodeTarget > 0 ? "Parcalari topla" : "Parcalari ayir";
    setPressed(el.explode, m.explodeTarget > 0);
    setPressed(el.physics, m.physics);
    el.section.value = state.sectionMode;
    el.sectionPos.disabled = state.sectionMode === "off";
    el.sectionPos.value = String(Math.round(state.sectionT * 100));
    el.animRow.hidden = !m.anim;
    refreshAnimation();
  }

  function refreshAnimation() {
    const a = state.model && state.model.anim;
    if (!a) return;
    el.anim.textContent = a.playing ? "⏸ Duraklat" : "▶ Animasyon";
    setPressed(el.anim, a.playing);
    el.animPos.value = String(Math.round((a.action.time / (a.duration || 1)) * 1000));
    el.animTime.textContent = `${a.action.time.toFixed(1)} / ${a.duration.toFixed(1)} sn`;
  }

  // --- arayuz olaylari -------------------------------------------------------------

  const actions = {
    view: () => api.toggleView(),
    fit: () => {
      const m = state.model;
      if (!m) return;
      api.setScale(api.fitScaleOf(m));
      frameCamera();
    },
    real: () => {
      api.setScale(1);
      frameCamera();
    },
    camera: frameCamera,
    reset: () => {
      if (!state.model) return;
      place(state.model);
      frameCamera();
    },
    explode: () => api.toggleExplode(),
    physics: () => {
      const m = state.model;
      if (!m) return;
      // PC'de fizigin bir etkisi gorunsun: model biraz yukaridan, egik duser.
      if (!m.physics) {
        place(m);
        m.holder.position.y = 0.15 * Math.max(m.holder.scale.x, 0.3);
        m.holder.rotation.set(0.25, 0.3, 0.15);
      }
      api.togglePhysics();
    },
    anim: () => api.toggleAnimation(),
    "ruler-clear": () => {
      state.ruler.clear();
      el.rulerOut.textContent = "";
    },
  };

  el.tools.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.toggle) {
      const key = b.dataset.toggle;
      api.setSetting(key, !settings[key]);
      if (key === "ruler") el.rulerOut.textContent = settings.ruler ? "Modelin uzerinde iki noktaya tikla" : "";
    } else if (actions[b.dataset.act]) {
      actions[b.dataset.act]();
    }
    refresh();
  });

  el.opacity.addEventListener("input", () => {
    const m = state.model;
    if (!m) return;
    m.realistic = false;
    api.setOpacity(1 - Number(el.opacity.value) / 100);
    el.view.textContent = "Hayalet";
    setPressed(el.view, false);
  });

  el.section.addEventListener("change", () => {
    state.sectionMode = el.section.value;
    api.applySection();
    refresh();
  });
  el.sectionPos.addEventListener("input", () => {
    state.sectionT = Number(el.sectionPos.value) / 100;
    api.applySection();
  });

  el.animPos.addEventListener("input", () => {
    const a = state.model && state.model.anim;
    if (!a) return;
    api.seekAnimation((Number(el.animPos.value) / 1000) * a.duration);
    refreshAnimation();
  });

  // --- fareyle cetvel ------------------------------------------------------------

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let hover = null;
  let down = null;

  function pick(e) {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(state.models.map((m) => m.holder), true)
      .filter((h) => h.object.isMesh && h.object.visible);
    if (hits.length) return hits[0].point.clone();
    return raycaster.ray.intersectPlane(ground, new THREE.Vector3());
  }

  canvas.addEventListener("pointermove", (e) => {
    hover = settings.ruler ? pick(e) : null;
  });
  canvas.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!settings.ruler || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5) return; // surukleme = kamerayi dondurme
    const p = pick(e);
    if (!p) return;
    state.ruler.addPoint(p);
    const pts = state.ruler.points;
    el.rulerOut.textContent = pts.length === 2
      ? `Mesafe: ${(pts[0].distanceTo(pts[1]) * 100).toFixed(1)} cm (gercek olcekte ${(pts[0].distanceTo(pts[1]) * 100 / (state.model?.holder.scale.x || 1)).toFixed(1)} cm)`
      : "Ikinci noktaya tikla";
  });

  // --- kare dongusu ---------------------------------------------------------------

  function frame(time) {
    if (!active) return;
    const dt = lastTime ? Math.min((time - lastTime) / 1000, 0.05) : 0;
    lastTime = time;
    controls.update();

    const m = state.model;
    if (m && m.physics && dt > 0) {
      if (!m.bodies.length) {
        api.liftAboveFloor();
        api.buildBodies();
      }
      state.world.step(1 / 60, dt, 3);
      api.syncPartsFromBodies();
    }
    api.updateExplode(dt);
    api.updateAnimations(dt, time);

    for (const x of state.models) x.holder.updateMatrixWorld(true);
    state.section.update();
    api.setHead(camera.position);
    api.updateShadowAndDims();
    state.ruler.update(settings.ruler, hover, camera.position);
    renderer.render(state.scene, camera);
  }

  // --- disari acilanlar -------------------------------------------------------------

  return {
    frame,
    refresh,
    refreshAnimation,
    loading(entry) {
      el.empty.hidden = false;
      el.empty.textContent = `Yukleniyor: ${entry.name}…`;
    },
    failed(err) {
      el.empty.hidden = false;
      el.empty.textContent = "Model yuklenemedi: " + err.message;
    },
    onModel(m) {
      el.empty.hidden = true;
      el.tools.hidden = false;
      if (!state.session) {
        place(m);
        frameCamera();
      }
      refresh();
    },
    suspend() {
      active = false;
      controls.enabled = false;
      helpers.visible = false;
    },
    resume() {
      active = true;
      lastTime = 0;
      controls.enabled = true;
      helpers.visible = true;
      renderer.setClearColor(BACKGROUND, 1);
      for (const m of state.models) place(m);
      resize();
      frameCamera();
      refresh();
    },
  };
}
