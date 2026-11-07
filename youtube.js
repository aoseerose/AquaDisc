/* AquaDisc — lecture complète gratuite : chaque titre Spotify est retrouvé sur YouTube
   (même artiste, même titre, durée la plus proche) et joué avec le lecteur officiel YouTube. */
(function () {
  'use strict';
  const AD = window.AD;

  class YouTubeEngine extends AD.Emitter {
    constructor() {
      super();
      this.kind = 'yt';
      this.player = null;
      this.ready = false;
      this.available = null;
      this.track = null;
      this.cands = [];
      this.ci = 0;
      this.isPaused = true;
      this.userPaused = true;
      this.endedFired = false;
      this.dur = 0;
      this.vol = 0.64;
      this.lookups = new Map();
    }

    loadApi() {
      if (window.YT && window.YT.Player) return Promise.resolve();
      if (this._apiP) return this._apiP;
      this._apiP = new Promise((resolve, reject) => {
        const prev = window.onYouTubeIframeAPIReady;
        const t = setTimeout(() => reject(new Error('YouTube ne répond pas.')), 15000);
        window.onYouTubeIframeAPIReady = () => {
          clearTimeout(t);
          if (typeof prev === 'function') { try { prev(); } catch (e) { /* ignore */ } }
          resolve();
        };
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.async = true;
        s.onerror = () => { clearTimeout(t); reject(new Error('Impossible de charger YouTube (bloqueur de pubs ?).')); };
        document.head.appendChild(s);
      });
      this._apiP.catch(() => { this._apiP = null; });
      return this._apiP;
    }

    ensure() {
      if (this.player && this.ready) return Promise.resolve();
      if (this._pp) return this._pp;
      this._pp = this.loadApi().then(() => new Promise((resolve, reject) => {
        const host = document.getElementById('ytHost');
        host.innerHTML = '';
        const el = document.createElement('div');
        host.appendChild(el);
        const t = setTimeout(() => reject(new Error('Le lecteur YouTube ne démarre pas.')), 15000);
        this.ready = false;
        this.player = new window.YT.Player(el, {
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, fs: 0, iv_load_policy: 3, origin: location.origin },
          events: {
            onReady: () => {
              clearTimeout(t);
              this.ready = true;
              this.available = true;
              const f = host.querySelector('iframe');
              if (f) f.setAttribute('loading', 'eager');
              this._applyVol();
              this.emit('linked');
              resolve();
            },
            onStateChange: (e) => this._st(e.data),
            onError: (e) => this._err(e.data),
          },
        });
      }));
      this._pp.catch(() => { this.available = false; }).finally(() => { this._pp = null; });
      return this._pp;
    }

    /* cherche les vidéos (une seule fois par titre : le résultat est gardé avec le disque) */
    async resolve(track) {
      if (track.yt && track.yt.length) return track.yt;
      // déjà cherché récemment sans succès : inutile de recommencer à chaque fois
      if (track.ytNone && Date.now() - track.ytNone < 3 * 86400e3) throw new Error('Introuvable sur YouTube');
      const key = track.uri || track.id;
      if (this.lookups.has(key)) return this.lookups.get(key);
      const p = (async () => {
        const q = new URLSearchParams({ artist: track.artist || '', title: track.title || '', dur: String(Math.round(track.duration || 0)) });
        const ask = () => fetch('/api/yt?' + q.toString(), { cache: 'no-store' });
        let r;
        try { r = await ask(); } catch (e) { r = null; }
        if (!r || r.status >= 500) { await new Promise((ok) => setTimeout(ok, 1200)); r = await ask(); } // petit raté de YouTube : on réessaie
        const j = await r.json().catch(() => ({}));
        if (r.status === 404 && j.error) { track.ytNone = Date.now(); this.emit('resolved', track); }
        if (!r.ok) throw new Error(j.error || 'Serveur pas à jour : ferme et relance LANCER.bat');
        delete track.ytNone;
        track.yt = (j.results || []).map((x) => x.id);
        track.ytPick = 0;
        this.emit('resolved', track);
        return track.yt;
      })();
      this.lookups.set(key, p);
      p.catch(() => {}).finally(() => this.lookups.delete(key));
      return p;
    }

    async load(track, autoplay) {
      // on coupe tout de suite la vidéo précédente (la recherche du titre peut prendre quelques secondes)
      if (this.player && this.ready) { try { this.player.stopVideo(); } catch (e) { /* ignore */ } }
      this.track = track;
      this.isPaused = true;
      this.pending = true;
      this.userPaused = !autoplay;
      this.endedFired = false;
      this.dur = track.duration || 0;
      this.autoplay = !!autoplay;
      const mine = track;
      let ids;
      try {
        [ids] = await Promise.all([this.resolve(track), this.ensure()]);
      } finally {
        if (this.track === mine) this.pending = false;
      }
      if (this.track !== mine) return;
      if (!ids || !ids.length) throw new Error('Introuvable sur YouTube');
      this.cands = ids;
      this.ci = Math.min(Math.max(0, track.ytPick || 0), ids.length - 1);
      this._cue();
    }

    _cue() {
      const id = this.cands[this.ci];
      this.endedFired = false;
      try {
        if (this.autoplay) this.player.loadVideoById({ videoId: id, startSeconds: 0 });
        else this.player.cueVideoById({ videoId: id, startSeconds: 0 });
      } catch (e) { this.emit('error', 'Lecteur YouTube indisponible'); }
    }

    /* vidéo bloquée (pas intégrable, supprimée…) : on essaie la version suivante */
    _err(code) {
      if (!this.track) return;
      console.warn('YouTube erreur', code, this.cands[this.ci]);
      if (this.ci < this.cands.length - 1) {
        this.ci++;
        this.track.ytPick = this.ci;
        this.emit('resolved', this.track);
        this._cue();
        return;
      }
      this.emit('error', 'aucune version lisible sur YouTube');
    }

    _st(s) {
      const P = window.YT.PlayerState;
      if (s === P.PLAYING) {
        this.userPaused = false;
        const d = this.player.getDuration();
        if (d) this.dur = d;
        if (this.isPaused) { this.isPaused = false; this.emit('state', true); }
      } else if (s === P.PAUSED) {
        if (!this.isPaused) { this.isPaused = true; this.emit('state', false); }
      } else if (s === P.ENDED) {
        if (!this.isPaused) { this.isPaused = true; this.emit('state', false); }
        if (!this.endedFired && this.track) { this.endedFired = true; this.emit('ended'); }
      }
    }

    /* « autre version » : passe à la vidéo suivante pour ce titre */
    nextVersion() {
      if (!this.track || this.cands.length < 2) return false;
      this.ci = (this.ci + 1) % this.cands.length;
      this.track.ytPick = this.ci;
      this.emit('resolved', this.track);
      this.autoplay = true;
      this._cue();
      return true;
    }

    play() {
      this.userPaused = false;
      this.autoplay = true;
      if (this.pending) return; // la vidéo démarrera dès qu'elle sera trouvée
      if (this.player && this.ready && this.track) { try { this.player.playVideo(); } catch (e) { /* ignore */ } }
    }
    pause() {
      this.userPaused = true;
      if (this.pending) { this.autoplay = false; return; }
      if (this.player && this.ready) { try { this.player.pauseVideo(); } catch (e) { /* ignore */ } }
    }
    stop() {
      this.userPaused = true;
      this.autoplay = false;
      if (this.pending) { this.track = null; this.pending = false; } // annule la recherche en cours
      if (this.player && this.ready) { try { this.player.pauseVideo(); this.player.seekTo(0, true); } catch (e) { /* ignore */ } }
    }
    unload() {
      this.track = null;
      this.pending = false;
      this.userPaused = true;
      if (this.player && this.ready) { try { this.player.stopVideo(); } catch (e) { /* ignore */ } }
      this.isPaused = true;
    }
    seek(t) {
      if (!this.player || !this.ready) return;
      try { this.player.seekTo(AD.clamp(t, 0, Math.max(0, this.dur - 0.5)), true); } catch (e) { /* ignore */ }
    }
    get time() {
      if (!this.player || !this.ready || !this.track || this.pending) return 0;
      try { return this.player.getCurrentTime() || 0; } catch (e) { return 0; }
    }
    get duration() { return this.dur; }
    get paused() { return this.isPaused; }
    get hasLevels() { return false; }
    _applyVol() {
      if (!this.player || !this.ready) return;
      try {
        this.player.setVolume(Math.round(this.vol * 100));
        if (this.vol > 0 && this.player.isMuted()) this.player.unMute();
      } catch (e) { /* ignore */ }
    }
    set volume(v) { this.vol = AD.clamp(Number(v) || 0, 0, 1); this._applyVol(); }
    levels() { return null; }
  }

  AD.yt = new YouTubeEngine();
})();
