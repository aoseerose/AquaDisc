/* AquaDisc — utilitaires partagés */
(function () {
  'use strict';
  const AD = (window.AD = window.AD || {});

  AD.$ = (s, r = document) => r.querySelector(s);
  AD.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  AD.h = function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  };

  AD.icon = (name, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    if (cls) s.setAttribute('class', cls);
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#i-' + name);
    s.appendChild(u);
    return s;
  };

  AD.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  AD.lerp = (a, b, t) => a + (b - a) * t;
  AD.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  AD.ease = {
    linear: (t) => t,
    inQuad: (t) => t * t,
    inCubic: (t) => t * t * t,
    outCubic: (t) => 1 - Math.pow(1 - t, 3),
    outQuart: (t) => 1 - Math.pow(1 - t, 4),
    inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    outBack: (t) => { const c1 = 2.2, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  };

  AD.fmt = function (sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  };
  AD.fmtLong = function (sec) {
    sec = Math.round(sec || 0);
    const hh = Math.floor(sec / 3600), mm = Math.round((sec % 3600) / 60);
    if (hh) return `${hh} h ${String(mm).padStart(2, '0')}`;
    return `${Math.max(mm, sec > 0 ? 1 : 0)} min`;
  };
  AD.plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  AD.hash = function (s) {
    let x = 2166136261;
    s = String(s);
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  };
  AD.uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  AD.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  AD.collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

  /* ---------- tweens (moteur d'animation maison) ---------- */
  const tweens = (AD._tweens = new Set());
  AD.killTweens = function (obj, keys) {
    for (const t of tweens) {
      if (t.obj !== obj) continue;
      if (!keys) { tweens.delete(t); t.resolve(false); continue; }
      for (const k of keys) delete t.to[k];
      if (!Object.keys(t.to).length) { tweens.delete(t); t.resolve(false); }
    }
  };
  AD.tween = function (obj, to, dur, easing, delay) {
    AD.killTweens(obj, Object.keys(to));
    return new Promise((resolve) => {
      tweens.add({ obj, to: Object.assign({}, to), from: null, dur: Math.max(0, dur || 0), ease: easing || AD.ease.inOutCubic, start: performance.now() + (delay || 0), resolve });
    });
  };
  /* attente synchronisée sur les images (et non sur les minuteries) */
  AD.wait = (ms) => AD.tween({ v: 0 }, { v: 1 }, ms, AD.ease.linear);
  function stepTweens(now) {
    for (const t of tweens) {
      if (now < t.start) continue;
      if (!t.from) { t.from = {}; for (const k in t.to) t.from[k] = t.obj[k]; }
      const p = t.dur ? AD.clamp((now - t.start) / t.dur, 0, 1) : 1;
      const e = t.ease(p);
      for (const k in t.to) t.obj[k] = t.from[k] + (t.to[k] - t.from[k]) * e;
      if (p >= 1) { tweens.delete(t); t.resolve(true); }
    }
  }

  /* ---------- boucle d'images ---------- */
  const frameFns = new Set();
  AD.onFrame = (fn) => { frameFns.add(fn); return () => frameFns.delete(fn); };
  let last = performance.now();
  function runFrame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    try { stepTweens(now); } catch (e) { console.error(e); }
    for (const fn of frameFns) {
      try { fn(now, dt); } catch (e) { console.error(e); }
    }
  }
  function loop() {
    runFrame(performance.now());
    requestAnimationFrame(loop);
  }
  AD._frame = () => runFrame(performance.now()); // débogage
  requestAnimationFrame(loop);

  /* ---------- couleurs ---------- */
  AD.parseColor = function (c) {
    if (!c) return null;
    let m = String(c).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    m = String(c).match(/^#?([0-9a-f]{6})$/i);
    if (m) { const n = parseInt(m[1], 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 }; }
    return null;
  };
  function rgbToHsl({ r, g, b }) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    let hh = 0, s = 0; const l = (mx + mn) / 2;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      hh /= 6;
    }
    return { h: hh * 360, s, l };
  }
  AD.hsl = function (hh, s, l) {
    const k = (n) => (n + hh / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const hex = (x) => Math.round(AD.clamp(x, 0, 1) * 255).toString(16).padStart(2, '0');
    return '#' + hex(f(0)) + hex(f(8)) + hex(f(4));
  };
  /* rend une couleur « jolie » (ni grise, ni trop sombre) */
  AD.niceAccent = function (c) {
    const rgb = typeof c === 'string' ? AD.parseColor(c) : c;
    if (!rgb) return null;
    const x = rgbToHsl(rgb);
    const s = x.s < 0.12 ? 0.35 : AD.clamp(x.s * 1.15, 0.45, 0.9);
    const l = AD.clamp(x.l, 0.46, 0.62);
    return AD.hsl(x.h, s, l);
  };
  AD.accentFrom = async function (src) {
    try {
      let img;
      if (src instanceof Blob) {
        img = await createImageBitmap(src);
      } else {
        img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = src;
        await img.decode();
      }
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, 32, 32);
      const d = x.getImageData(0, 0, 32, 32).data;
      let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        const sat = mx ? (mx - mn) / mx : 0;
        const wt = 0.03 + sat * sat * (mx / 255);
        r += R * wt; g += G * wt; b += B * wt; w += wt;
      }
      if (img.close) img.close();
      return AD.niceAccent({ r: r / w, g: g / w, b: b / w });
    } catch (e) {
      return null;
    }
  };

  /* ---------- toasts ---------- */
  AD.toast = function (msg, type, ms) {
    const box = AD.$('#toasts');
    if (!box) return;
    const t = AD.h('div', { class: 'toast ' + (type || 'info') }, AD.h('i'), AD.h('span', { text: msg }));
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('in'));
    setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 400); }, ms || 3600);
  };

  /* ---------- petit émetteur d'évènements ---------- */
  AD.Emitter = class {
    constructor() { this._h = {}; }
    on(n, fn) { (this._h[n] = this._h[n] || []).push(fn); return this; }
    emit(n, ...a) { (this._h[n] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); }
  };
})();
