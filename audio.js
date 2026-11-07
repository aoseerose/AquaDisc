/* AquaDisc — moteurs de lecture : fichiers audio (Web Audio) + lecteur Spotify (iFrame API) + bruitages */
(function () {
  'use strict';
  const AD = window.AD;

  /* ============ Fichiers audio / extraits ============ */
  class AudioEngine extends AD.Emitter {
    constructor() {
      super();
      this.kind = 'audio';
      const a = (this.el = new Audio());
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      a.addEventListener('ended', () => this.emit('ended'));
      a.addEventListener('playing', () => this.emit('state', true));
      a.addEventListener('pause', () => this.emit('state', false));
      a.addEventListener('error', () => {
        if (!a.getAttribute('src')) return;
        this.emit('error', a.error);
      });
      this.ctx = null;
      this.analyser = null;
      this.gain = null;
      this.freq = null;
      this.graph = false;
      this._vol = 1;
    }
    context() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
      return this.ctx;
    }
    unlock() {
      const c = this.context();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    }
    graphUp() {
      if (this.graph || !this.context()) return;
      this.graph = true;
      try {
        const src = this.ctx.createMediaElementSource(this.el);
        const an = this.ctx.createAnalyser();
        an.fftSize = 512;
        an.smoothingTimeConstant = 0.78;
        // le volume passe par un nœud de gain : fiable sur tous les navigateurs,
        // et le visualiseur reste vivant même avec le son bas
        const g = this.ctx.createGain();
        g.gain.value = this._vol;
        src.connect(an);
        an.connect(g);
        g.connect(this.ctx.destination);
        this.analyser = an;
        this.gain = g;
        this.el.volume = 1;
        this.freq = new Uint8Array(an.frequencyBinCount);
      } catch (e) {
        console.warn('Analyseur indisponible', e);
        this.el.volume = this._vol;
      }
    }
    load(url) {
      this.el.src = url;
      try { this.el.currentTime = 0; } catch (e) { /* ignore */ }
    }
    async play() {
      this.graphUp();
      if (this.ctx && this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) { /* ignore */ } }
      try {
        await this.el.play();
      } catch (e) {
        if (e && e.name === 'NotAllowedError') this.emit('blocked');
        // les autres erreurs (format illisible…) arrivent par l'évènement « error »
      }
    }
    pause() { this.el.pause(); }
    stop() { this.el.pause(); try { this.el.currentTime = 0; } catch (e) { /* ignore */ } }
    unload() {
      this.el.pause();
      if (this.el.getAttribute('src')) { this.el.removeAttribute('src'); try { this.el.load(); } catch (e) { /* ignore */ } }
    }
    seek(t) {
      const d = this.duration;
      if (d > 0) this.el.currentTime = AD.clamp(t, 0, Math.max(0, d - 0.25));
    }
    get time() { return this.el.currentTime || 0; }
    get duration() { const d = this.el.duration; return isFinite(d) && d > 0 ? d : 0; }
    get paused() { return this.el.paused; }
    get hasLevels() { return !!this.analyser; }
    /* v de 0 à 1 (déjà « courbé » par l'appli) */
    set volume(v) {
      v = AD.clamp(Number(v) || 0, 0, 1);
      this._vol = v;
      if (this.gain) {
        this.el.volume = 1;
        try { this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015); } catch (e) { this.gain.gain.value = v; }
      } else {
        this.el.volume = v;
      }
    }
    get volume() { return this._vol; }
    levels() {
      if (!this.analyser || this.el.paused) return null;
      this.analyser.getByteFrequencyData(this.freq);
      return this.freq;
    }
  }

  /* ============ Spotify (lecteur officiel intégré) ============ */
  class SpotifyEngine extends AD.Emitter {
    constructor() {
      super();
      this.kind = 'spotify';
      this.controller = null;
      this.available = null;
      this.track = null;
      this.isPaused = true;
      this.pos = 0;
      this.dur = 0;
      this.maxPos = 0;
      this.lastUpd = 0;
      this.wantPlay = false;
      this.userPaused = true;
      this.endedFired = false;
      this.preview = false;
      this.loadedUri = null;
    }
    loadApi() {
      if (this._apiP) return this._apiP;
      this._apiP = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Le lecteur Spotify ne répond pas.')), 15000);
        window.onSpotifyIframeApiReady = (api) => { clearTimeout(timer); resolve(api); };
        const s = document.createElement('script');
        s.src = 'https://open.spotify.com/embed/iframe-api/v1';
        s.async = true;
        s.onerror = () => { clearTimeout(timer); reject(new Error('Impossible de charger le lecteur Spotify.')); };
        document.head.appendChild(s);
      }).then(
        (api) => { this.available = true; return api; },
        (err) => { this.available = false; this._apiP = null; throw err; }
      );
      return this._apiP;
    }
    async ensure(uri) {
      if (this.controller) return this.controller;
      if (!this._ctrlP) {
        this._ctrlP = this.loadApi().then((api) => new Promise((resolve, reject) => {
          const host = document.getElementById('spotifyHost');
          host.innerHTML = '';
          const el = document.createElement('div');
          host.appendChild(el);
          // le lecteur Spotify crée son iframe en « loading=lazy » : on force le chargement immédiat,
          // sinon il ne se charge pas tant que le panneau LISTE est fermé
          const eager = (f) => { if (f && f.tagName === 'IFRAME' && f.getAttribute('loading') !== 'eager') f.setAttribute('loading', 'eager'); };
          const mo = new MutationObserver(() => host.querySelectorAll('iframe').forEach(eager));
          mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['loading'] });
          const timer = setTimeout(() => reject(new Error('Le lecteur Spotify ne démarre pas.')), 15000);
          try {
            api.createController(el, { uri, width: '100%', height: 80 }, (c) => {
              clearTimeout(timer);
              this.controller = c;
              this.loadedUri = uri;
              c.addListener('ready', () => this._ready());
              c.addListener('playback_update', (e) => this._update(e && e.data));
              this.emit('linked');
              resolve(c);
            });
          } catch (e) { clearTimeout(timer); reject(e); }
        }));
        this._ctrlP.catch(() => { this._ctrlP = null; this.available = false; });
      }
      return this._ctrlP;
    }
    async load(track, autoplay) {
      this.track = track;
      this.pos = 0;
      this.maxPos = 0;
      this.dur = track.duration || 0; // en secondes
      this.wantPlay = !!autoplay;
      this.userPaused = !autoplay;
      this.endedFired = false;
      this.preview = false;
      this.sawStart = false;
      this.isPaused = true;
      this.lastUpd = performance.now();
      this._watch();
      const fresh = !this.controller;
      const c = await this.ensure(track.uri);
      if (this.track !== track) return;
      if (!fresh && this.loadedUri !== track.uri) {
        this.loadedUri = track.uri;
        c.loadUri(track.uri);
      }
      if (autoplay) this._kick(fresh ? 900 : 500);
    }
    _ready() { if (this.wantPlay && this.isPaused) this._kick(150); }
    _kick(delay) {
      clearTimeout(this._kickT);
      let tries = 0;
      const attempt = () => {
        if (!this.wantPlay || !this.controller || !this.isPaused) return;
        tries++;
        try { this.controller.play(); } catch (e) { /* ignore */ }
        if (tries < 4) this._kickT = setTimeout(attempt, 1500);
        else if (this.isPaused) this.emit('stuck');
      };
      this._kickT = setTimeout(attempt, delay || 300);
    }
    _update(d) {
      if (!d) return;
      if (d.playingURI && this.track && d.playingURI !== this.track.uri) return;
      // ignore les derniers messages du titre précédent (position en fin de morceau)
      if (!this.sawStart) {
        if (typeof d.position === 'number' && d.position < 3000) this.sawStart = true;
        else return;
      }
      const was = this.isPaused;
      this.isPaused = !!d.isPaused;
      if (typeof d.position === 'number') this.pos = d.position / 1000;
      if (d.duration) this.dur = d.duration / 1000;
      this.lastUpd = performance.now();
      if (!this.isPaused) {
        this.maxPos = Math.max(this.maxPos, this.pos);
        if (!d.isBuffering) { this.wantPlay = false; clearTimeout(this._kickT); this.userPaused = false; }
      }
      if (this.track && d.duration && this.track.duration && d.duration <= 31000 && this.track.duration * 1000 - d.duration > 4000 && !this.preview) {
        this.preview = true;
        this.emit('preview');
      }
      if (was !== this.isPaused) this.emit('state', !this.isPaused);
      this._checkEnd();
    }
    /* fin de titre : le lecteur Spotify reste parfois « en lecture » bloqué sur la dernière seconde,
       ou se remet à 0 en pause — on gère les deux cas */
    _checkEnd() {
      if (this.endedFired || this.userPaused || this.wantPlay || !this.track || this.dur <= 1) return;
      const nearMax = this.maxPos >= this.dur - 1.6;
      const atEnd = this.pos >= this.dur - 0.35;
      const stalled = !this.isPaused && this.maxPos >= this.dur - 1.6 && performance.now() - this.lastUpd > 2500;
      if (atEnd || stalled || (this.isPaused && nearMax && this.pos < 0.5)) {
        this.endedFired = true;
        this.emit('ended');
      }
    }
    _watch() {
      clearInterval(this._watchT);
      this._watchT = setInterval(() => {
        if (!this.track) { clearInterval(this._watchT); return; }
        this._checkEnd();
      }, 1000);
    }
    async play() {
      this.userPaused = false;
      if (!this.controller) return;
      if (this.maxPos > 0.3) { try { this.controller.resume(); } catch (e) { /* ignore */ } }
      else { this.wantPlay = true; this._kick(50); }
    }
    pause() {
      this.userPaused = true;
      this.wantPlay = false;
      clearTimeout(this._kickT);
      if (this.controller && !this.isPaused) { try { this.controller.pause(); } catch (e) { /* ignore */ } }
    }
    stop() {
      this.pause();
      if (this.controller) { try { this.controller.seek(0); } catch (e) { /* ignore */ } }
      this.pos = 0;
      this.maxPos = 0;
    }
    unload() { this.stop(); this.track = null; clearInterval(this._watchT); }
    /* recrée le lecteur (après une connexion à Spotify dans un autre onglet) */
    reset() {
      this.unload();
      try { if (this.controller && this.controller.destroy) this.controller.destroy(); } catch (e) { /* ignore */ }
      this.controller = null;
      this._ctrlP = null;
      this.loadedUri = null;
      this.isPaused = true;
      this.preview = false;
      if (this.available === false) this.available = null;
      const host = document.getElementById('spotifyHost');
      if (host) host.innerHTML = '';
    }
    seek(t) {
      if (!this.controller) return;
      t = AD.clamp(t, 0, Math.max(0, this.dur - 0.5));
      try { this.controller.seek(t); } catch (e) { /* ignore */ }
      this.pos = t;
      this.lastUpd = performance.now();
    }
    get time() {
      if (this.isPaused) return this.pos;
      return Math.min(this.dur || Infinity, this.pos + (performance.now() - this.lastUpd) / 1000);
    }
    get duration() { return this.dur; }
    get paused() { return this.isPaused; }
    get hasLevels() { return false; }
    set volume(v) { /* le lecteur Spotify intégré ne permet pas de régler le volume */ }
    levels() { return null; }
  }

  /* ============ Bruitages (synthétisés) ============ */
  const Sfx = {
    enabled: true,
    _noise: null,
    ctx() { return AD.audio.context(); },
    out(vol) {
      const c = this.ctx();
      if (!c || !this.enabled) return null;
      if (c.state === 'suspended') c.resume().catch(() => {});
      const g = c.createGain();
      g.gain.value = vol;
      g.connect(c.destination);
      return g;
    },
    noise() {
      const c = this.ctx();
      if (!this._noise) {
        const b = c.createBuffer(1, c.sampleRate * 1.2, c.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        this._noise = b;
      }
      return this._noise;
    },
    click() {
      const o = this.out(0.05); if (!o) return;
      const c = this.ctx(), t = c.currentTime;
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1500, t);
      osc.frequency.exponentialRampToValueAtTime(760, t + 0.05);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      osc.connect(g).connect(o);
      osc.start(t); osc.stop(t + 0.08);
    },
    whoosh() {
      const o = this.out(0.07); if (!o) return;
      const c = this.ctx(), t = c.currentTime;
      const src = c.createBufferSource(); src.buffer = this.noise();
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.3;
      bp.frequency.setValueAtTime(320, t);
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.38);
      bp.frequency.exponentialRampToValueAtTime(520, t + 0.9);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
      src.connect(bp).connect(g).connect(o);
      src.start(t); src.stop(t + 1);
    },
    land() {
      const o = this.out(0.16); if (!o) return;
      const c = this.ctx(), t = c.currentTime;
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(170, t);
      osc.frequency.exponentialRampToValueAtTime(52, t + 0.2);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.26);
      osc.connect(g).connect(o);
      osc.start(t); osc.stop(t + 0.3);
      const n = c.createBufferSource(); n.buffer = this.noise();
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2600;
      const g2 = c.createGain();
      g2.gain.setValueAtTime(0.5, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      n.connect(hp).connect(g2).connect(o);
      n.start(t); n.stop(t + 0.06);
    },
    chime() {
      const o = this.out(0.11); if (!o) return;
      const c = this.ctx(), t0 = c.currentTime + 0.02;
      const delay = c.createDelay(1); delay.delayTime.value = 0.24;
      const fb = c.createGain(); fb.gain.value = 0.32;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3400;
      delay.connect(lp).connect(fb).connect(delay);
      const wet = c.createGain(); wet.gain.value = 0.45;
      lp.connect(wet).connect(o);
      const notes = [659.25, 987.77, 1318.51, 1479.98, 1661.22];
      notes.forEach((f, i) => {
        const t = t0 + i * 0.085;
        [['sine', 1, 0], ['triangle', 0.5, 0.5]].forEach(([type, amp, oct]) => {
          const osc = c.createOscillator(), g = c.createGain();
          osc.type = type;
          osc.frequency.value = f * (oct ? 0.5 : 1);
          osc.detune.value = (i % 2 ? 4 : -4);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.5 * amp, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 1.9 - i * 0.1);
          osc.connect(g);
          g.connect(o);
          g.connect(delay);
          osc.start(t); osc.stop(t + 2);
        });
      });
    },
  };

  AD.audio = new AudioEngine();
  AD.spotify = new SpotifyEngine();
  AD.Sfx = Sfx;
})();
