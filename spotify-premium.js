/* AquaDisc — Spotify Premium : connexion au compte (OAuth PKCE, sans mot de passe stocké)
   + lecteur officiel « Web Playback SDK » : titres complets et volume réglable. */
(function () {
  'use strict';
  const AD = window.AD;

  const LS = 'aquadisc.spotify.v1';
  const PKCE = 'aquadisc.spotify.pkce';
  const AUTH_URL = 'https://accounts.spotify.com/authorize';
  const TOKEN_URL = 'https://accounts.spotify.com/api/token';
  const API = 'https://api.spotify.com/v1';
  const SCOPES = [
    'streaming', 'user-read-email', 'user-read-private',
    'user-read-playback-state', 'user-modify-playback-state',
    'playlist-read-private', 'playlist-read-collaborative',
  ].join(' ');

  /* ---------------- compte ---------------- */
  function b64url(bytes) {
    let s = '';
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomString(n) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const v = crypto.getRandomValues(new Uint8Array(n));
    let s = '';
    for (const x of v) s += chars[x % chars.length];
    return s;
  }

  const auth = {
    data: (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } })(),
    save(patch) {
      Object.assign(this.data, patch);
      try { localStorage.setItem(LS, JSON.stringify(this.data)); } catch (e) { /* ignore */ }
    },
    // adresse de la page elle-même (marche aussi dans un sous-dossier, ex. pseudo.github.io/aquadisc/)
    redirectUri() { return location.origin + location.pathname.replace(/[^/]*$/, ''); },
    get clientId() { return this.data.clientId || ''; },
    get connected() { return !!this.data.refresh; },
    get name() { return this.data.name || ''; },
    canLogin() { return location.protocol === 'http:' || location.protocol === 'https:'; },

    async login(clientId) {
      clientId = String(clientId || '').trim();
      if (!/^[0-9a-f]{32}$/i.test(clientId)) throw new Error('Ce Client ID ne ressemble pas à celui de Spotify (32 caractères).');
      if (!window.crypto || !crypto.subtle) throw new Error('Ouvre AquaDisc via LANCER.bat (adresse http://127.0.0.1:5177).');
      this.save({ clientId });
      const verifier = randomString(64);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      const challenge = b64url(new Uint8Array(digest));
      const state = randomString(16);
      sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, clientId }));
      const q = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: this.redirectUri(),
        scope: SCOPES,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
        show_dialog: 'false',
      });
      location.href = AUTH_URL + '?' + q.toString();
    },

    /* retour de la page de connexion Spotify */
    async handleRedirect() {
      const p = new URLSearchParams(location.search);
      if (!p.has('code') && !p.has('error')) return null;
      history.replaceState(null, '', location.pathname);
      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(PKCE)); } catch (e) { /* ignore */ }
      sessionStorage.removeItem(PKCE);
      if (p.get('error')) return { error: p.get('error') === 'access_denied' ? 'Connexion Spotify annulée.' : 'Spotify a refusé la connexion (' + p.get('error') + ').' };
      if (!saved || saved.state !== p.get('state')) return { error: 'Réponse Spotify invalide : réessaie la connexion.' };
      try {
        const r = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: p.get('code'),
            redirect_uri: this.redirectUri(),
            client_id: saved.clientId,
            code_verifier: saved.verifier,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) return { error: 'Connexion impossible : ' + (j.error_description || j.error || r.status) };
        this.save({ clientId: saved.clientId, access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
        try {
          const me = await this.api('/me');
          if (me.ok) { const u = await me.json(); this.save({ name: u.display_name || u.id || '' }); }
        } catch (e) { /* ignore */ }
        return { ok: true };
      } catch (e) {
        return { error: 'Impossible de joindre Spotify. Vérifie ta connexion internet.' };
      }
    },

    async token(force) {
      if (!force && this.data.access && Date.now() < (this.data.exp || 0)) return this.data.access;
      if (!this.data.refresh) throw new Error('Spotify non connecté');
      if (!this._refreshing) {
        this._refreshing = (async () => {
          const r = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.data.refresh, client_id: this.data.clientId }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.access_token) {
            if (j.error === 'invalid_grant' || j.error === 'invalid_client') { this.logout(); AD.spAuthEvents.emit('expired'); }
            throw new Error('Session Spotify expirée');
          }
          this.save({ access: j.access_token, refresh: j.refresh_token || this.data.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 });
          return j.access_token;
        })();
        this._refreshing.finally(() => { this._refreshing = null; }).catch(() => {});
      }
      return this._refreshing;
    },

    async api(path, opt) {
      opt = opt || {};
      const go = async (tok) => fetch(path.startsWith('http') ? path : API + path, {
        method: opt.method || 'GET',
        headers: Object.assign({ Authorization: 'Bearer ' + tok }, opt.body ? { 'Content-Type': 'application/json' } : {}),
        body: opt.body ? JSON.stringify(opt.body) : undefined,
      });
      let r = await go(await this.token());
      if (r.status === 401) r = await go(await this.token(true));
      return r;
    },

    logout() {
      const clientId = this.data.clientId;
      this.data = {};
      this.save({ clientId });
    },
  };
  AD.spAuthEvents = new AD.Emitter();

  async function apiError(r) {
    let j = null;
    try { j = await r.json(); } catch (e) { /* ignore */ }
    const msg = j && j.error && (j.error.message || j.error);
    const reason = j && j.error && j.error.reason;
    const e = new Error(typeof msg === 'string' ? msg : 'Erreur Spotify ' + r.status);
    e.status = r.status;
    e.reason = reason;
    return e;
  }

  /* playlists du compte + lecture complète des playlists dont on est propriétaire */
  auth.myPlaylists = async function () {
    const out = [];
    let url = '/me/playlists?limit=50';
    for (let i = 0; i < 6 && url; i++) {
      const r = await auth.api(url);
      if (!r.ok) throw await apiError(r);
      const j = await r.json();
      for (const p of j.items || []) {
        if (!p || !p.id) continue;
        const total = (p.items && p.items.total) != null ? p.items.total : (p.tracks && p.tracks.total);
        out.push({ id: p.id, name: p.name || 'Sans titre', owner: p.owner && (p.owner.display_name || p.owner.id), total: total == null ? null : total, image: p.images && p.images.length ? p.images[p.images.length > 1 ? 1 : 0].url : null, url: (p.external_urls && p.external_urls.spotify) || `https://open.spotify.com/playlist/${p.id}` });
      }
      url = j.next || null;
    }
    return out;
  };
  auth.fullPlaylist = async function (id) {
    const r = await auth.api(`/playlists/${id}`);
    if (!r.ok) throw await apiError(r);
    const j = await r.json();
    const box = j.items || j.tracks;
    if (!box || !Array.isArray(box.items)) return null; // pas propriétaire : on passe par l'autre méthode
    const tracks = [];
    const take = (arr) => {
      for (const e of arr || []) {
        const t = e && (e.item || e.track);
        if (!t || t.is_local || !t.uri || !/^spotify:track:/.test(t.uri)) continue;
        tracks.push({
          uri: t.uri,
          title: t.name || 'Sans titre',
          artist: (t.artists || []).map((a) => a && a.name).filter(Boolean).join(', '),
          duration: t.duration_ms || 0,
          preview: t.preview_url || null,
          explicit: !!t.explicit,
          playable: t.is_playable !== false,
        });
      }
    };
    take(box.items);
    let next = box.next;
    for (let i = 0; i < 60 && next; i++) {
      const rr = await auth.api(next);
      if (!rr.ok) break;
      const jj = await rr.json();
      take(jj.items);
      next = jj.next;
    }
    if (!tracks.length) return null;
    return {
      type: 'playlist', id, uri: `spotify:playlist:${id}`, url: `https://open.spotify.com/playlist/${id}`,
      name: j.name || 'Sans titre', subtitle: (j.owner && (j.owner.display_name || j.owner.id)) || '',
      cover: j.images && j.images.length ? j.images[0].url : null, color: null, tracks, truncated: false,
    };
  };

  /* ---------------- lecteur Web Playback SDK ---------------- */
  class SdkEngine extends AD.Emitter {
    constructor() {
      super();
      this.kind = 'sdk';
      this.player = null;
      this.deviceId = null;
      this.disabled = false;     // vrai si le compte n'est pas Premium / navigateur incompatible
      this.track = null;
      this.isPaused = true;
      this.pos = 0;
      this.dur = 0;
      this.maxPos = 0;
      this.lastUpd = 0;
      this.started = false;
      this.userPaused = true;
      this.endedFired = false;
      this.vol = 0.8;
    }
    usable() { return auth.connected && !this.disabled && auth.canLogin(); }

    loadScript() {
      if (window.Spotify && window.Spotify.Player) return Promise.resolve();
      if (this._scriptP) return this._scriptP;
      this._scriptP = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Le lecteur Spotify ne se charge pas.')), 20000);
        window.onSpotifyWebPlaybackSDKReady = () => { clearTimeout(timer); resolve(); };
        const s = document.createElement('script');
        s.src = 'https://sdk.scdn.co/spotify-player.js';
        s.async = true;
        s.onerror = () => { clearTimeout(timer); reject(new Error('Impossible de charger le lecteur Spotify (bloqueur de pubs ?).')); };
        document.head.appendChild(s);
      });
      this._scriptP.catch(() => { this._scriptP = null; });
      return this._scriptP;
    }

    ensure() {
      if (this.player && this.deviceId) return Promise.resolve();
      if (this._readyP) return this._readyP;
      this._readyP = (async () => {
        await this.loadScript();
        if (!this.player) {
          const p = (this.player = new window.Spotify.Player({
            name: 'AquaDisc',
            volume: this.vol,
            getOAuthToken: (cb) => { auth.token().then(cb, () => cb('')); },
          }));
          p.addListener('ready', ({ device_id }) => { this.deviceId = device_id; this.emit('linked'); if (this._onReady) this._onReady(); });
          p.addListener('not_ready', () => { this.deviceId = null; });
          p.addListener('player_state_changed', (s) => this._state(s));
          p.addListener('autoplay_failed', () => this.emit('blocked'));
          p.addListener('initialization_error', ({ message }) => this._fatal('Ce navigateur ne peut pas lire Spotify ici (' + message + ').'));
          p.addListener('authentication_error', () => { auth.logout(); this._fatal('Session Spotify expirée : reconnecte ton compte dans Réglages.'); });
          p.addListener('account_error', () => this._fatal('Lecture complète réservée aux comptes Spotify Premium.'));
          p.addListener('playback_error', ({ message }) => { console.warn('Spotify', message); this.emit('error', message); });
        }
        const devP = new Promise((resolve, reject) => {
          if (this.deviceId) return resolve();
          const t = setTimeout(() => reject(new Error('Le lecteur Spotify ne répond pas.')), 15000);
          this._onReady = () => { clearTimeout(t); resolve(); };
          this._onFatal = (e) => { clearTimeout(t); reject(e); };
        });
        const ok = await this.player.connect();
        if (!ok) throw new Error('Connexion au lecteur Spotify impossible.');
        await devP;
      })();
      this._readyP.catch(() => {}).finally(() => { this._readyP = null; });
      return this._readyP;
    }

    _fatal(msg) {
      this.disabled = true;
      const e = new Error(msg);
      if (this._onFatal) this._onFatal(e);
      this.emit('fatal', msg);
    }

    /* à appeler dans un clic : débloque la lecture audio (Safari, mobiles) */
    activate() { try { if (this.player && this.player.activateElement) this.player.activateElement(); } catch (e) { /* ignore */ } }

    async _start(uri, ms) {
      await this.ensure();
      const body = { uris: [uri], position_ms: Math.max(0, Math.round(ms || 0)) };
      let r = await auth.api(`/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, { method: 'PUT', body });
      if (r.status === 404) {
        // appareil oublié par Spotify : on se reconnecte une fois
        this.deviceId = null;
        try { this.player.disconnect(); } catch (e) { /* ignore */ }
        await this.ensure();
        r = await auth.api(`/me/player/play?device_id=${encodeURIComponent(this.deviceId)}`, { method: 'PUT', body });
      }
      if (!r.ok) {
        const e = await apiError(r);
        if (e.status === 403 && /PREMIUM/i.test(String(e.reason || e.message))) this._fatal('Lecture complète réservée aux comptes Spotify Premium.');
        throw e;
      }
      this.started = true;
    }

    async load(track, autoplay) {
      this.track = track;
      this.pos = 0;
      this.maxPos = 0;
      this.dur = track.duration || 0;
      this.started = false;
      this.endedFired = false;
      this.userPaused = !autoplay;
      this.sawStart = false;
      this.lastUpd = performance.now();
      this._watch();
      if (autoplay) {
        await this._start(track.uri, 0);
      } else {
        await this.ensure();
      }
    }

    _same(cur) {
      if (!cur || !this.track) return false;
      const u = this.track.uri;
      return cur.uri === u || (cur.linked_from && cur.linked_from.uri === u) || ('spotify:track:' + cur.id) === u;
    }

    _state(s) {
      if (!s) { if (!this.isPaused) { this.isPaused = true; this.emit('state', false); } return; }
      const cur = s.track_window && s.track_window.current_track;
      if (!this._same(cur)) {
        // fin de notre titre (Spotify l'a rangé dans les précédents)
        const prev = s.track_window && s.track_window.previous_tracks;
        if (this.started && prev && prev.some((t) => this._same(t))) this._end();
        return;
      }
      if (!this.sawStart) {
        if (s.position < 4000) this.sawStart = true;
        else return;
      }
      const was = this.isPaused;
      this.isPaused = !!s.paused;
      this.pos = (s.position || 0) / 1000;
      if (s.duration) this.dur = s.duration / 1000;
      this.lastUpd = performance.now();
      if (!this.isPaused) { this.maxPos = Math.max(this.maxPos, this.pos); this.userPaused = false; }
      if (was !== this.isPaused) this.emit('state', !this.isPaused);
      this._check();
    }
    _check() {
      if (this.endedFired || this.userPaused || !this.started || this.dur <= 1) return;
      const near = this.maxPos >= this.dur - 2.5;
      if ((this.isPaused && near && (this.pos < 0.5 || this.pos >= this.dur - 1)) || this.pos >= this.dur - 0.3) this._end();
    }
    _end() {
      if (this.endedFired) return;
      this.endedFired = true;
      this.emit('ended');
    }
    _watch() {
      clearInterval(this._watchT);
      this._watchT = setInterval(async () => {
        if (!this.track || !this.player) { clearInterval(this._watchT); return; }
        if (this.isPaused) { this._check(); return; }
        try { const s = await this.player.getCurrentState(); if (s) this._state(s); } catch (e) { /* ignore */ }
        if (!this.isPaused && this.maxPos >= this.dur - 2.5 && performance.now() - this.lastUpd > 3000) this._end();
      }, 1000);
    }

    async play() {
      this.userPaused = false;
      if (!this.track) return;
      try {
        if (this.started) await this.player.resume();
        else await this._start(this.track.uri, 0);
      } catch (e) { this.emit('error', e.message); }
    }
    pause() {
      this.userPaused = true;
      if (this.player && this.started) this.player.pause().catch(() => {});
    }
    stop() {
      this.pause();
      if (this.player && this.started) this.player.seek(0).catch(() => {});
      this.pos = 0;
      this.maxPos = 0;
    }
    unload() { this.stop(); this.track = null; this.started = false; clearInterval(this._watchT); }
    seek(t) {
      if (!this.player || !this.started) return;
      t = AD.clamp(t, 0, Math.max(0, this.dur - 0.5));
      this.player.seek(Math.round(t * 1000)).catch(() => {});
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
    set volume(v) {
      this.vol = AD.clamp(Number(v) || 0, 0, 1);
      if (this.player) this.player.setVolume(Math.max(0.0001, this.vol)).catch(() => {});
    }
    levels() { return null; }
    disconnect() {
      this.unload();
      if (this.player) { try { this.player.disconnect(); } catch (e) { /* ignore */ } }
      this.player = null;
      this.deviceId = null;
    }
  }

  AD.spAuth = auth;
  AD.sdk = new SdkEngine();
})();
