/**
 * VR menusu: model ayarlari, model listesi, araclar ve el takibi ayarlari.
 *
 * Sol bilekteki dugmeyle (kumandada Y) acilir, sag elin yaninda belirip
 * orada sabit kalir. Panel bir canvas'a cizilip duzleme doku olarak
 * giydirilir. Etkilesim: el takibinde isaret parmagiyla dokunma (poke),
 * kumandada isin + tetik. Menu kendi durumunu tutmaz; her cizimde degerleri
 * app.js'in verdigi api'den okur.
 */
import * as THREE from "three";

const PX_W = 600;
const PX_H = 720;
export const MENU_WIDTH = 0.24;                   // metre
const MENU_HEIGHT = MENU_WIDTH * PX_H / PX_W;     // 0.288 m

// Parmak ucu panel yuzeyine bu kadar yaklasinca basilmis sayilir; geri
// cekilince tekrar basilabilir. Aradaki fark titremeyle cift tiklamayi onler.
const PRESS_DEPTH = 0.006;
const RELEASE_DEPTH = 0.016;
const HOVER_DEPTH = 0.06;
const PAGE_SIZE = 6;

const C = {
  bg: "rgba(13, 17, 27, 0.94)",
  surface: "#1c2436",
  surfaceHover: "#27324a",
  line: "#34425f",
  text: "#e8ecf4",
  muted: "#9aa6bd",
  accent: "#6ea8fe",
  accentSoft: "rgba(110, 168, 254, 0.24)",
  ok: "#3ddc97",
  err: "#f4696b",
};

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export class WristMenu {
  /**
   * api: {
   *   model(): { name, realistic, opacity, scale, physics } | null
   *   catalog(): [{ name, url, ... }], currentUrl(): string
   *   settings(): { throw, push, handStyle, pinch, shadow, dims, ruler, depth, listMode }
   *   tools(): { exploded, section, sectionT, anchorSaved, modelCount, anim, measures }
   *   actions: { toggleView, opacity(d), scale(f), realSize, fit, physics,
   *              bringFront, exit, load(entry), refresh, setSetting(k, v),
   *              clearMeasures, explode, removeModel, cycleSection, sectionStep(d),
   *              saveAnchor, forgetAnchor, animToggle, animRestart }
   * }
   */
  constructor(api) {
    this.api = api;
    this.canvas = document.createElement("canvas");
    this.canvas.width = PX_W;
    this.canvas.height = PX_H;
    this.ctx = this.canvas.getContext("2d");

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;

    // Derinlik testi acik: el golgesi (HandOccluder) menunun onune gecen
    // gercek eli menunun ustunde birakir. En son cizilir.
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(MENU_WIDTH, MENU_HEIGHT),
      new THREE.MeshBasicMaterial({
        map: this.texture, transparent: true, depthWrite: false,
      }),
    );
    this.mesh.renderOrder = 10;

    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.visible = false;

    this.tab = "model";
    this.page = 0;
    this.items = [];
    this.hoverId = null;
    this.flashId = null;
    this.status = "";
    this.dirty = true;
    this.pokers = new Map(); // parmak anahtari -> { armed }

    this._local = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
  }

  get visible() { return this.group.visible; }

  setVisible(v) {
    if (this.group.visible === v) return;
    this.group.visible = v;
    if (v) this.dirty = true;
    else { this.hoverId = null; this.pokers.clear(); }
  }

  setStatus(text) {
    this.status = text;
    this.dirty = true;
  }

  invalidate() { this.dirty = true; }

  /** Her karede cagrilir; sadece degisiklik varsa yeniden cizer. */
  update() {
    if (!this.group.visible || !this.dirty) return;
    this.dirty = false;
    this.layout();
    this.draw();
    this.texture.needsUpdate = true;
  }

  // --- etkilesim -------------------------------------------------------------

  /** Dunya noktasini panel pikseline cevirir; z = panele uzaklik (metre). */
  toPanel(world) {
    const p = this.mesh.worldToLocal(this._local.copy(world));
    return {
      x: (p.x / MENU_WIDTH + 0.5) * PX_W,
      y: (0.5 - p.y / MENU_HEIGHT) * PX_H,
      depth: p.z,
      inside: Math.abs(p.x) <= MENU_WIDTH / 2 && Math.abs(p.y) <= MENU_HEIGHT / 2,
    };
  }

  itemAt(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.onPress && x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
    }
    return null;
  }

  /**
   * Parmak ucuyla dokunma. Parmak panele yakinsa true doner; app.js bunu
   * "menu kullaniliyor" diye yorumlayip menuyu kapatmaz ve cimdigi yok sayar.
   */
  poke(key, tipWorld) {
    if (!this.group.visible) return false;
    const p = this.toPanel(tipWorld);
    const state = this.pokers.get(key) || { armed: false };
    this.pokers.set(key, state);

    const near = p.inside && p.depth > -0.03 && p.depth < HOVER_DEPTH;
    if (!near) {
      state.armed = p.depth > RELEASE_DEPTH || !p.inside;
      return false;
    }
    const item = this.itemAt(p.x, p.y);
    this.setHover(item ? item.id : null);

    if (p.depth > RELEASE_DEPTH) state.armed = true;
    if (state.armed && p.depth < PRESS_DEPTH) {
      state.armed = false;
      if (item) this.press(item);
    }
    return true;
  }

  /** Kumanda isini panelle kesistirir; isabet varsa panel pikselini doner. */
  rayHit(origin, direction) {
    if (!this.group.visible) return null;
    this._raycaster.set(origin, direction);
    const hit = this._raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || !hit.uv) return null;
    return { x: hit.uv.x * PX_W, y: (1 - hit.uv.y) * PX_H, distance: hit.distance };
  }

  hoverAt(hit) {
    const item = hit ? this.itemAt(hit.x, hit.y) : null;
    this.setHover(item ? item.id : null);
  }

  clickAt(hit) {
    const item = this.itemAt(hit.x, hit.y);
    if (item) this.press(item);
  }

  setHover(id) {
    if (this.hoverId === id) return;
    this.hoverId = id;
    this.dirty = true;
  }

  press(item) {
    this.flashId = item.id;
    this.dirty = true;
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { this.flashId = null; this.dirty = true; }, 160);
    item.onPress();
    this.dirty = true;
  }

  // --- yerlesim --------------------------------------------------------------

  layout() {
    const items = [];
    const add = (it) => { items.push(it); return it; };
    const a = this.api.actions;

    // Sekmeler
    const tabs = [["model", "Model"], ["list", "Liste"], ["tools", "Arac"], ["hands", "El"]];
    const tw = (PX_W - 48 - 24) / 4;
    tabs.forEach(([id, label], i) => add({
      id: "tab-" + id, kind: "tab", label, active: this.tab === id,
      x: 24 + i * (tw + 8), y: 22, w: tw, h: 64,
      onPress: () => { this.tab = id; this.page = 0; },
    }));

    const top = 112;
    if (this.tab === "model") this.layoutModel(add, a, top);
    else if (this.tab === "list") this.layoutList(add, a, top);
    else if (this.tab === "tools") this.layoutTools(add, a, top);
    else this.layoutHands(add, a, top);

    this.items = items;
  }

  layoutModel(add, a, top) {
    const m = this.api.model();
    if (!m) {
      add({ id: "none", kind: "text", label: "Model yok. Liste sekmesinden sec.",
        x: 24, y: top + 20, w: PX_W - 48, h: 40 });
      return;
    }
    add({ id: "name", kind: "title", label: m.name, x: 24, y: top, w: PX_W - 48, h: 44 });

    let y = top + 58;
    const row = 72;
    const L = 24, R = PX_W - 24;

    add({ id: "l-view", kind: "label", label: "Gorunum", x: L, y, w: 200, h: 60 });
    add({ id: "view", kind: "toggle", label: m.realistic ? "Gercek" : "Hayalet",
      active: m.realistic, x: 250, y, w: R - 250, h: 60, onPress: a.toggleView });

    y += row;
    add({ id: "l-op", kind: "label", label: "Seffaflik", x: L, y, w: 200, h: 60 });
    this.stepper(add, "op", `%${Math.round((1 - m.opacity) * 100)}`, y,
      () => a.opacity(+0.1), () => a.opacity(-0.1));

    y += row;
    add({ id: "l-sc", kind: "label", label: "Boyut", x: L, y, w: 200, h: 60 });
    this.stepper(add, "sc", `%${formatPct(m.scale * 100)}`, y,
      () => a.scale(1 / 1.25), () => a.scale(1.25));

    y += row;
    const half = (R - L - 12) / 2;
    add({ id: "real", kind: "button", label: "1:1 Gercek boyut", active: Math.abs(m.scale - 1) < 0.005,
      x: L, y, w: half, h: 60, onPress: a.realSize });
    add({ id: "fit", kind: "button", label: "Sigdir (35 cm)",
      x: L + half + 12, y, w: half, h: 60, onPress: a.fit });

    y += row;
    add({ id: "l-ph", kind: "label", label: "Fizik", x: L, y, w: 200, h: 60 });
    add({ id: "phys", kind: "toggle", label: m.physics ? "Acik" : "Kapali",
      active: m.physics, x: 250, y, w: R - 250, h: 60, onPress: a.physics });

    y += row;
    add({ id: "front", kind: "button", label: "Onume getir",
      x: L, y, w: half, h: 60, onPress: a.bringFront });
    add({ id: "exit", kind: "button", label: "Cikis", danger: true,
      x: L + half + 12, y, w: half, h: 60, onPress: a.exit });
  }

  stepper(add, id, value, y, minus, plus) {
    const R = PX_W - 24;
    add({ id: id + "-", kind: "button", label: "−", x: 250, y, w: 70, h: 60, onPress: minus });
    add({ id: id + "-v", kind: "value", label: value, x: 328, y, w: R - 328 - 78, h: 60 });
    add({ id: id + "+", kind: "button", label: "+", x: R - 70, y, w: 70, h: 60, onPress: plus });
  }

  layoutList(add, a, top) {
    const list = this.api.catalog();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const current = this.api.currentUrl();

    const addMode = this.api.settings().listMode === "add";
    add({ id: "l-list", kind: "label", label: `${list.length} model`, x: 24, y: top, w: 150, h: 56 });
    add({ id: "mode", kind: "toggle", label: addMode ? "Sahneye ekle" : "Degistir", active: addMode,
      x: 180, y: top, w: 230, h: 56,
      onPress: () => a.setSetting("listMode", addMode ? "replace" : "add") });
    add({ id: "refresh", kind: "button", label: "Yenile", x: PX_W - 24 - 150, y: top, w: 150, h: 56,
      onPress: a.refresh });

    const start = this.page * PAGE_SIZE;
    let y = top + 70;
    if (!list.length) {
      add({ id: "empty", kind: "text", label: "Katalog bos.", x: 24, y: y + 10, w: PX_W - 48, h: 40 });
    }
    list.slice(start, start + PAGE_SIZE).forEach((entry, i) => {
      add({
        id: "m-" + (start + i), kind: "item", label: entry.name,
        meta: entry.format === "3mf" ? "3MF" : entry.cloud ? "GLB" : "",
        active: entry.url === current,
        x: 24, y, w: PX_W - 48, h: 60,
        onPress: () => a.load(entry),
      });
      y += 66;
    });

    if (pages > 1) {
      const py = top + 70 + PAGE_SIZE * 66 + 6;
      add({ id: "prev", kind: "button", label: "◀", x: 24, y: py, w: 110, h: 56,
        onPress: () => { this.page = (this.page + pages - 1) % pages; } });
      add({ id: "pg", kind: "value", label: `${this.page + 1} / ${pages}`, x: 144, y: py, w: PX_W - 288, h: 56 });
      add({ id: "next", kind: "button", label: "▶", x: PX_W - 134, y: py, w: 110, h: 56,
        onPress: () => { this.page = (this.page + 1) % pages; } });
    }
  }

  layoutTools(add, a, top) {
    const s = this.api.settings();
    const t = this.api.tools();
    const L = 24, R = PX_W - 24, row = 70, h = 60;
    const half = (R - L - 12) / 2;
    let y = top;

    const pair = (left, right) => {
      add({ ...left, x: L, y, w: half, h });
      add({ ...right, x: L + half + 12, y, w: half, h });
      y += row;
    };

    pair(
      { id: "shadow", kind: "toggle", label: "Golge", active: s.shadow,
        onPress: () => a.setSetting("shadow", !s.shadow) },
      { id: "dims", kind: "toggle", label: "Olculer", active: s.dims,
        onPress: () => a.setSetting("dims", !s.dims) },
    );
    pair(
      { id: "ruler", kind: "toggle", label: s.ruler ? "Cetvel acik" : "Cetvel", active: s.ruler,
        onPress: () => a.setSetting("ruler", !s.ruler) },
      { id: "tech", kind: "toggle", label: s.tech ? "Teknik detay acik" : "Teknik detay", active: s.tech,
        onPress: () => a.setSetting("tech", !s.tech) },
    );
    // Uclu satir: ayir / olcumleri sil / modeli kaldir.
    const third = (R - L - 24) / 3;
    add({ id: "explode", kind: "toggle", label: t.exploded ? "Topla" : "Ayir", active: t.exploded,
      x: L, y, w: third, h, onPress: a.explode });
    add({ id: "measure-clear", kind: "button", label: `Olcum sil${t.measures ? ` (${t.measures})` : ""}`,
      x: L + third + 12, y, w: third, h, onPress: a.clearMeasures });
    add({ id: "remove", kind: "button", label: "Kaldir", danger: t.modelCount > 1,
      x: L + (third + 12) * 2, y, w: third, h, onPress: a.removeModel });
    y += row;

    if (t.anim) {
      pair(
        { id: "anim", kind: "toggle", label: t.anim.playing ? "Animasyon ⏸" : "Animasyon ▶",
          active: t.anim.playing, onPress: a.animToggle },
        { id: "anim-restart", kind: "button", label: `Basa sar (%${Math.round(t.anim.progress * 100)})`,
          onPress: a.animRestart },
      );
    }

    const sectionNames = { off: "Kapali", y: "Yatay", x: "Dikey (X)", z: "Dikey (Z)" };
    add({ id: "l-sec", kind: "label", label: "Kesit", x: L, y, w: 200, h });
    add({ id: "section", kind: "toggle", label: sectionNames[t.section], active: t.section !== "off",
      x: 250, y, w: R - 250, h, onPress: a.cycleSection });
    y += row;
    if (t.section !== "off") {
      add({ id: "l-sect", kind: "label", label: "Kesit yeri", x: L, y, w: 200, h });
      this.stepper(add, "sect", `%${Math.round(t.sectionT * 100)}`, y,
        () => a.sectionStep(-0.05), () => a.sectionStep(0.05));
      y += row;
    }

    pair(
      { id: "anchor", kind: "toggle", label: t.anchorSaved ? "Konum kayitli" : "Konumu kaydet",
        active: t.anchorSaved, onPress: a.saveAnchor },
      { id: "anchor-forget", kind: "button", label: "Konumu unut", onPress: a.forgetAnchor },
    );

    add({ id: "l-depth", kind: "label", label: "Gercek nesne ortme", x: L, y, w: 260, h });
    // Ortme oturum baslarken istenir; degisiklik sonraki giriste gecerli.
    add({ id: "depth", kind: "toggle", label: s.depth ? "Acik (sonraki giris)" : "Kapali", active: s.depth,
      x: 300, y, w: R - 300, h, onPress: () => a.setSetting("depth", !s.depth) });
  }

  layoutHands(add, a, top) {
    const s = this.api.settings();
    const L = 24, R = PX_W - 24, row = 72;
    let y = top;

    const toggle = (id, label, on, key) => {
      add({ id: "l-" + id, kind: "label", label, x: L, y, w: 250, h: 60 });
      add({ id, kind: "toggle", label: on ? "Acik" : "Kapali", active: on,
        x: 300, y, w: R - 300, h: 60, onPress: () => a.setSetting(key, !on) });
      y += row;
    };
    const cycle = (id, label, options, value, key) => {
      const idx = Math.max(0, options.findIndex(([v]) => v === value));
      add({ id: "l-" + id, kind: "label", label, x: L, y, w: 250, h: 60 });
      add({ id, kind: "button", label: options[idx][1], x: 300, y, w: R - 300, h: 60,
        onPress: () => a.setSetting(key, options[(idx + 1) % options.length][0]) });
      y += row;
    };

    toggle("pinchPlace", "Cimdikle yerlestir", s.pinchPlace, "pinchPlace");
    toggle("farGrab", "Uzaktan tutma", s.farGrab, "farGrab");
    toggle("throw", "Firlatma", s.throw, "throw");
    toggle("push", "Parmakla itme", s.push, "push");
    cycle("style", "El gorunumu",
      [["tips", "Parmak uclari"], ["mesh", "El modeli"], ["none", "Gizli"]], s.handStyle, "handStyle");
    cycle("pinch", "Cimdik", [["low", "Az hassas"], ["normal", "Normal"], ["high", "Cok hassas"]],
      s.pinch, "pinch");

    const help = [
      "Isin modeldeyken cimdik: uzaktan tut",
      "Iki elle cimdik: boyut + dondur",
    ];
    y += 6;
    for (const [i, line] of help.entries()) {
      add({ id: "h" + i, kind: "text", label: line, x: L, y: y + i * 34, w: R - L, h: 30 });
    }
  }

  // --- cizim -----------------------------------------------------------------

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, PX_W, PX_H);
    roundRect(ctx, 0, 0, PX_W, PX_H, 28);
    ctx.fillStyle = C.bg;
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    ctx.stroke();

    for (const it of this.items) this.drawItem(it);

    if (this.status) {
      ctx.fillStyle = C.muted;
      ctx.font = `500 22px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ellipsis(ctx, this.status, PX_W - 48), PX_W / 2, PX_H - 26);
    }
  }

  drawItem(it) {
    const ctx = this.ctx;
    const hover = this.hoverId === it.id;
    const flash = this.flashId === it.id;
    ctx.textBaseline = "middle";

    if (it.kind === "label" || it.kind === "text" || it.kind === "title") {
      ctx.fillStyle = it.kind === "text" ? C.muted : C.text;
      ctx.font = it.kind === "title" ? `700 30px ${FONT}`
        : it.kind === "text" ? `400 22px ${FONT}` : `600 26px ${FONT}`;
      ctx.textAlign = "left";
      ctx.fillText(ellipsis(ctx, it.label, it.w), it.x, it.y + it.h / 2);
      return;
    }

    if (it.kind === "value") {
      ctx.fillStyle = C.text;
      ctx.font = `600 28px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(it.label, it.x + it.w / 2, it.y + it.h / 2);
      return;
    }

    // Tiklanabilir kutular
    roundRect(ctx, it.x, it.y, it.w, it.h, 14);
    let fill = C.surface;
    if (it.active) fill = C.accentSoft;
    if (hover) fill = it.active ? "rgba(110, 168, 254, 0.34)" : C.surfaceHover;
    if (flash) fill = C.accent;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = it.active ? C.accent : hover ? C.line : "transparent";
    ctx.lineWidth = 2;
    if (it.active || hover) ctx.stroke();

    let color = it.active ? C.accent : C.text;
    if (it.danger) color = C.err;
    if (flash) color = "#0b1020";
    ctx.fillStyle = color;

    if (it.kind === "item") {
      ctx.textAlign = "left";
      ctx.font = `600 25px ${FONT}`;
      const metaW = it.meta ? 70 : 0;
      ctx.fillText(ellipsis(ctx, it.label, it.w - 40 - metaW), it.x + 20, it.y + it.h / 2);
      if (it.meta) {
        ctx.textAlign = "right";
        ctx.font = `600 18px ${FONT}`;
        ctx.fillStyle = flash ? "#0b1020" : C.muted;
        ctx.fillText(it.meta, it.x + it.w - 20, it.y + it.h / 2);
      }
      return;
    }

    ctx.textAlign = "center";
    ctx.font = it.kind === "tab" ? `700 26px ${FONT}` : `600 25px ${FONT}`;
    ctx.fillText(ellipsis(ctx, it.label, it.w - 16), it.x + it.w / 2, it.y + it.h / 2);
  }
}

function formatPct(v) {
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ellipsis(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}
