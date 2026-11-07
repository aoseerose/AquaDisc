/* AquaDisc — la scène : disque en 3D, reflet dans l'eau, vaguelettes, changement de disque */
(function () {
  'use strict';
  const AD = window.AD;
  const { ease, tween, killTweens, clamp } = AD;

  const FLAT = 66;          // inclinaison du disque posé « à plat »
  const FLOOR = 0.1;        // distance disque → surface de l'eau (en fraction de S)
  const SPIN_PLAY = 132;    // vitesse de rotation en lecture (°/s)

  class Scene {
    constructor() {
      this.stage = AD.$('#stage');
      this.mirror = AD.$('#mirror');
      this.slots = [0, 1].map(() => ({
        main: new AD.DiscView(this.stage),
        refl: new AD.DiscView(this.mirror),
        st: { x: 0, y: 0, z: 0, rx: FLAT, ry: 0, s: 1, o: 0 },
        spin: { a: Math.random() * 360, v: 0, target: 0 },
        wobble: 0, bob: 0, vis: false, disc: null,
      }));
      this.cur = null;
      this.token = 0;
      this.level = 0;
      this.levelPrev = 0;
      this.lastBeat = 0;
      this.ripples = [];
      this.accent = { r: 120, g: 200, b: 255 };
      this.playing = false;
      this.landed = false;
      this.canvas = AD.$('#waterfx');
      this.cx = this.canvas.getContext('2d');
      this.reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.layout();
      let rt;
      window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => this.layout(), 60); });
      AD.onFrame((now, dt) => this.frame(now, dt));
    }

    layout() {
      const w = window.innerWidth, hh = window.innerHeight;
      const portrait = hh > w * 1.05;
      let S = portrait ? Math.min(hh * 0.4, w * 0.8) : Math.min(hh * 0.5, w * 0.4);
      S = clamp(S, 160, 600);
      this.S = S;
      this.discY = portrait ? hh * 0.41 : hh * 0.43;
      this.horizon = this.discY + S * 0.06;
      const r = document.documentElement.style;
      r.setProperty('--S', S.toFixed(1) + 'px');
      r.setProperty('--persp', (S * 2.7).toFixed(1) + 'px');
      r.setProperty('--disc-y', this.discY.toFixed(1) + 'px');
      r.setProperty('--horizon', this.horizon.toFixed(1) + 'px');
      r.setProperty('--floor', (S * FLOOR).toFixed(2) + 'px');
      this.scale = Math.min(1, 1100 / Math.max(w, 1)) * 0.8;
      this.canvas.width = Math.max(1, Math.round(w * this.scale));
      this.canvas.height = Math.max(1, Math.round(hh * this.scale));
      const hit = AD.$('#discHit');
      if (hit) {
        hit.style.width = (S * 1.04) + 'px';
        hit.style.height = (S * 0.62) + 'px';
        hit.style.left = (w / 2 - S * 0.52) + 'px';
        hit.style.top = (this.discY - S * 0.34) + 'px';
      }
      this.emit && this.emit('layout');
    }

    setAccent(c) {
      const rgb = AD.parseColor(c);
      if (rgb) this.accent = rgb;
    }

    /* ---------- disques ---------- */
    other(sl) { return sl === this.slots[0] ? this.slots[1] : this.slots[0]; }

    refresh(disc, coverUrl) {
      for (const sl of this.slots) {
        if (sl.disc && disc && sl.disc.id === disc.id) {
          sl.main.set(disc, coverUrl);
          sl.refl.set(disc, coverUrl);
          sl.disc = disc;
        }
      }
    }

    /* insère un disque façon console : il arrive debout en tournoyant puis se couche sur l'eau */
    async swap(disc, coverUrl, dir, opt) {
      opt = opt || {};
      dir = dir || 1;
      const token = ++this.token;
      const out = this.cur && this.cur.vis ? this.cur : null;
      const inc = this.cur ? this.other(this.cur) : this.slots[0];
      killTweens(inc.st);
      inc.wobble = 0; inc.bob = 0;
      inc.main.set(disc, coverUrl, opt.empty);
      inc.refl.set(disc, coverUrl, opt.empty);
      inc.disc = disc;
      this.cur = inc;
      this.landed = false;

      if (out) this._eject(out, dir);

      const fromAbove = !out || opt.fromAbove;
      Object.assign(inc.st, fromAbove
        ? { x: 0, y: -1.2, z: 0.15, rx: -14, ry: 210 * dir, s: 0.86, o: 0 }
        : { x: 1.45 * dir, y: -0.22, z: 0.18, rx: 0, ry: 210 * dir, s: 0.86, o: 0 });
      inc.spin.a = opt.empty ? 0 : (Math.random() * 30 - 15);
      inc.spin.v = 0; inc.spin.target = 0;

      await AD.wait(out ? 280 : 40);
      if (token !== this.token) return false;
      if (opt.onAppear) opt.onAppear();
      AD.Sfx.whoosh();

      const fast = this.reduced ? 0.5 : 1;
      tween(inc.st, { o: 1 }, 300 * fast, ease.outCubic);
      tween(inc.st, { s: 1 }, 720 * fast, ease.outCubic);
      tween(inc.st, { x: 0, y: -0.14, z: 0.33, rx: 0 }, 820 * fast, ease.outCubic);
      await tween(inc.st, { ry: 0 }, 1050 * fast, ease.outQuart);
      if (token !== this.token) return false;

      if (opt.empty) {
        inc.wobble = 22; inc.bob = 0.6; inc.spin.target = 0;
        return true;
      }

      await AD.wait(160 * fast);
      if (token !== this.token) return false;

      // il se couche
      tween(inc.st, { y: 0, z: 0 }, 540 * fast, ease.inOutCubic);
      await tween(inc.st, { rx: FLAT + 6 }, 540 * fast, ease.inCubic);
      if (token !== this.token) return false;
      this.splash(1);
      AD.Sfx.land();
      this.landed = true;
      inc.spin.target = this.playing ? SPIN_PLAY : 0;
      tween(inc.st, { rx: FLAT }, 460 * fast, ease.outBack);
      return true;
    }

    /* l'ancien disque se redresse, recule et file sur le côté */
    _eject(sl, dir) {
      killTweens(sl.st);
      sl.wobble = 0; sl.bob = 0;
      sl.spin.target = Math.max(40, sl.spin.v);
      tween(sl.st, { rx: 0, y: -0.15 }, 340, ease.outCubic);
      tween(sl.st, { z: -0.28 }, 720, ease.inOutCubic);
      tween(sl.st, { x: -1.45 * dir, ry: -140 * dir }, 660, ease.inCubic, 110);
      tween(sl.st, { s: 0.82 }, 660, ease.inCubic, 110);
      tween(sl.st, { o: 0 }, 380, ease.inQuad, 400).then((done) => {
        if (done && sl !== this.cur) { sl.spin.v = 0; sl.spin.target = 0; }
      });
    }

    setPlaying(on) {
      this.playing = !!on;
      if (this.cur && this.landed) this.cur.spin.target = on ? SPIN_PLAY : 0;
    }

    splash(strength) {
      const now = performance.now();
      for (let i = 0; i < 3; i++) this.ripples.push({ t0: now + i * 210, amp: strength * (1 - i * 0.26), dur: 1700 + i * 200 });
    }

    setLevel(v) { this.level = v; }

    /* ---------- rendu ---------- */
    frame(now, dt) {
      const S = this.S;
      for (const sl of this.slots) {
        const k = 1 - Math.exp(-dt * 2.4);
        sl.spin.v += (sl.spin.target - sl.spin.v) * k;
        if (Math.abs(sl.spin.v) < 0.05 && sl.spin.target === 0) sl.spin.v = 0;
        sl.spin.a = (sl.spin.a + sl.spin.v * dt) % 360;
        const st = sl.st;
        const vis = st.o > 0.003;
        if (vis !== sl.vis) {
          sl.vis = vis;
          sl.main.root.style.visibility = sl.refl.root.style.visibility = vis ? 'visible' : 'hidden';
        }
        if (!vis) continue;
        const ry = st.ry + (sl.wobble ? Math.sin(now / 1400) * sl.wobble : 0);
        const y = st.y + (sl.bob ? Math.sin(now / 1000) * 0.03 * sl.bob : 0);
        const tf = `translate3d(${(st.x * S).toFixed(2)}px,${(y * S).toFixed(2)}px,${(st.z * S).toFixed(2)}px) rotateX(${st.rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg) scale(${st.s.toFixed(4)})`;
        const sp = `rotateZ(${sl.spin.a.toFixed(2)}deg)`;
        sl.main.root.style.transform = sl.refl.root.style.transform = tf;
        sl.main.spinner.style.transform = sl.refl.spinner.style.transform = sp;
        const o = st.o.toFixed(3);
        if (o !== sl._o) {
          sl._o = o;
          sl.main.root.style.setProperty('--o', o);
          sl.refl.root.style.setProperty('--o', o);
        }
        const ga = (ry * 0.55 + (st.rx - FLAT) * 0.9).toFixed(1);
        if (ga !== sl._ga) {
          sl._ga = ga;
          sl.main.root.style.setProperty('--ga', ga + 'deg');
          sl.refl.root.style.setProperty('--ga', ga + 'deg');
        }
      }
      this.drawWater(now);
    }

    drawWater(now) {
      const c = this.cx, W = this.canvas.width, H = this.canvas.height, sc = this.scale;
      c.clearRect(0, 0, W, H);
      const t = now / 1000;
      const hz = this.horizon * sc;
      const cxp = W / 2;
      const floorY = (this.discY + this.S * FLOOR * 0.95) * sc;
      const S = this.S * sc;
      const lv = this.level;
      const { r, g, b } = this.accent;

      // halo sous le disque
      if (this.cur && this.cur.vis) {
        const o = this.cur.st.o;
        const k = this.landed ? 1 : 0.55;
        c.save();
        c.translate(cxp, floorY);
        c.scale(1, 0.24);
        const rad = S * (0.78 + lv * 0.25);
        const gr = c.createRadialGradient(0, 0, 0, 0, 0, rad);
        gr.addColorStop(0, `rgba(255,255,255,${(0.34 + lv * 0.4) * o * k})`);
        gr.addColorStop(0.35, `rgba(${r},${g},${b},${(0.22 + lv * 0.35) * o * k})`);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = gr;
        c.beginPath(); c.arc(0, 0, rad, 0, Math.PI * 2); c.fill();
        c.restore();
      }

      // reflets scintillants
      if (!this.reduced) {
        c.fillStyle = '#ffffff';
        const rows = 48;
        for (let i = 0; i < rows; i++) {
          const k = i / (rows - 1);
          const y = hz + (H - hz) * Math.pow(k, 1.65);
          const step = (5 + 30 * k) * sc * 1.7;
          const th = Math.max(1, (0.6 + 2.6 * k) * sc * 1.5);
          const drift = t * (12 + 46 * k) * (i % 2 ? 1 : -0.7);
          const f1 = 0.05 / (0.3 + k), f2 = 0.12 / (0.3 + k);
          const base = 0.18 + 0.5 * (1 - k);
          for (let px = -step; px < W + step; px += step) {
            const wx = px - drift;
            const n = Math.sin(wx * f1 + i * 1.93 + t * 0.8) * 0.62 + Math.sin(wx * f2 - t * 1.6 + i * 0.61) * 0.38;
            if (n <= 0.5) continue;
            const dxn = (px - cxp) / W;
            const center = 0.35 + 0.65 * Math.exp(-(dxn * dxn) / 0.07);
            const a = (n - 0.5) * 2 * base * center * (0.75 + lv * 0.6);
            if (a < 0.02) continue;
            c.globalAlpha = Math.min(0.85, a);
            c.fillRect(px, y, step * (0.35 + (n - 0.5) * 1.7), th);
          }
        }
        c.globalAlpha = 1;
      }

      // ondes (atterrissage + basses)
      if (lv - this.levelPrev > 0.16 && now - this.lastBeat > 520 && this.landed && this.playing) {
        this.lastBeat = now;
        this.ripples.push({ t0: now, amp: 0.35 + lv * 0.3, dur: 1500 });
      }
      this.levelPrev = this.levelPrev * 0.85 + lv * 0.15;
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const rp = this.ripples[i];
        const p = (now - rp.t0) / rp.dur;
        if (p < 0) continue;
        if (p >= 1) { this.ripples.splice(i, 1); continue; }
        const rad = S * (0.48 + p * 1.05);
        c.strokeStyle = `rgba(255,255,255,${(Math.pow(1 - p, 1.6) * 0.6 * rp.amp).toFixed(3)})`;
        c.lineWidth = Math.max(0.8, (3 * (1 - p) + 0.6) * sc * 1.4);
        c.beginPath();
        c.ellipse(cxp, floorY, rad, rad * 0.24, 0, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }

  AD.Scene = Scene;
  AD.FLAT = FLAT;
})();
