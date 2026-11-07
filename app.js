/* AquaDisc — application : lecture, disques, import, interface */
(function () {
  'use strict';
  const AD = window.AD;
  const { $, $$, h, fmt, fmtLong, clamp, toast, plural, sleep } = AD;

  /* =========================================================
     Réglages (mémorisés dans le navigateur)
     ========================================================= */
  const LS = 'aquadisc.v1';
  function readLS() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
  const settings = Object.assign({
    volume: 0.8, muted: false, repeat: 'all', shuffle: false, sfx: true, crt: true,
    timeMode: 'elapsed', lastDisc: null,
  }, readLS());
  // source de lecture des disques Spotify : auto (Premium ou YouTube) | embed | preview
  if (!['auto', 'embed', 'preview'].includes(settings.spSource)) settings.spSource = settings.spotifyMode === 'preview' ? 'preview' : 'auto';
  delete settings.spotifyMode;
  if (!(settings.volume >= 0 && settings.volume <= 1)) settings.volume = 0.8;
  function save() { try { localStorage.setItem(LS, JSON.stringify(settings)); } catch (e) { /* navigation privée */ } }

  const app = $('#app');
  const state = {
    discs: [], cur: -1, track: -1, order: [], pos: -1,
    playing: false, switching: false, autoAfterSwitch: false,
    engine: null, errors: 0, server: null, loadToken: 0,
    booted: false, modal: null, previewWarned: false, empty: false,
  };
  const covers = new Map();
  let trackUrl = null;
  let scene = null;

  const disc = () => state.discs[state.cur] || null;
  const pad = (n) => String(n).padStart(2, '0');
  const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

  /* =========================================================
     Pochettes
     ========================================================= */
  async function coverOf(d) {
    if (!d || !d.coverKey) return null;
    if (covers.has(d.id)) return covers.get(d.id);
    try {
      const b = await AD.db.getBlob(d.coverKey);
      if (!b) return null;
      const u = URL.createObjectURL(b);
      covers.set(d.id, u);
      return u;
    } catch (e) { return null; }
  }
  function dropCover(id) {
    const u = covers.get(id);
    if (u) { URL.revokeObjectURL(u); covers.delete(id); }
  }
  function setAccent(d) {
    const c = (d && d.accent) || '#3fa8ff';
    document.documentElement.style.setProperty('--tint', c);
    scene.setAccent(c);
  }

  /* =========================================================
     Lecture
     ========================================================= */
  /* quel lecteur pour ce disque :
     fichiers → audio
     Spotify (auto) → compte Premium si connecté, sinon morceau complet via YouTube (gratuit),
                      sinon lecteur Spotify intégré, sinon extraits 30 s */
  function engineFor(d) {
    if (!d || d.kind !== 'spotify') return AD.audio;
    const src = settings.spSource;
    if (src === 'preview') return AD.audio;
    if (src === 'embed') return AD.spotify.available !== false ? AD.spotify : AD.audio;
    if (AD.sdk.usable()) return AD.sdk;
    if (state.server !== false && AD.yt.available !== false) return AD.yt;
    if (AD.spotify.available !== false) return AD.spotify;
    return AD.audio;
  }
  /* courbe « naturelle » : l'oreille entend le volume de façon logarithmique */
  function effectiveVolume() { return settings.muted ? 0 : Math.pow(settings.volume, 2); }

  function buildOrder(first) {
    const d = disc();
    const n = d ? d.tracks.length : 0;
    const arr = Array.from({ length: n }, (_, i) => i);
    if (settings.shuffle) {
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      if (first >= 0) { const k = arr.indexOf(first); if (k > 0) { arr.splice(k, 1); arr.unshift(first); } }
    }
    state.order = arr;
    state.pos = first >= 0 ? arr.indexOf(first) : -1;
  }

  function setPlaying(on) {
    state.playing = !!on;
    app.classList.toggle('is-playing', state.playing);
    app.classList.toggle('is-paused', !state.playing && state.track >= 0);
    scene.setPlaying(state.playing);
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = state.track < 0 ? 'none' : (state.playing ? 'playing' : 'paused'); } catch (e) { /* ignore */ }
    }
  }

  async function playTrack(i, autoplay, opt) {
    const d = disc();
    if (!d || !d.tracks[i]) return;
    const token = ++state.loadToken;
    const t = d.tracks[i];
    // titre introuvable en entier : extrait 30 s pour ce titre seulement
    const eng = opt && opt.preview ? AD.audio : engineFor(d);
    state.previewTrack = eng === AD.audio && d.kind === 'spotify';
    if (eng === AD.sdk) AD.sdk.activate();
    if (state.engine && state.engine !== eng) state.engine.unload();
    state.engine = eng;
    state.track = i;
    if (state.order.length !== d.tracks.length) buildOrder(i);
    state.pos = state.order.indexOf(i);
    if (state.pos < 0) buildOrder(i);
    app.classList.toggle('is-paused', !state.playing);
    renderHUD(); renderLCD(); markCurrent(); mediaMeta(); renderBadges();
    if (d.kind === 'spotify') renderSpBox(d);
    applyVolume();
    if (d.kind === 'spotify' && t.playable === false && eng !== AD.yt) { onTrackError('Titre indisponible sur Spotify'); return; }
    try {
      if (eng === AD.audio) {
        let url;
        if (d.kind === 'spotify') {
          url = t.preview;
          if (!url) throw new Error('nopreview');
        } else {
          const blob = await AD.db.getBlob(t.fileKey);
          if (token !== state.loadToken) return;
          if (!blob) throw new Error('missing');
          url = URL.createObjectURL(blob);
          if (trackUrl) URL.revokeObjectURL(trackUrl);
          trackUrl = url;
        }
        eng.load(url);
        if (autoplay) await eng.play();
      } else {
        const p = eng.load(t, autoplay);
        if (eng === AD.yt) renderLCD(); // affiche « RECHERCHE… » pendant la recherche
        await p;
        if (eng === AD.yt && token === state.loadToken) renderLCD();
      }
    } catch (e) {
      if (token !== state.loadToken) return;
      if (eng === AD.sdk && AD.sdk.disabled) {
        // compte non Premium / navigateur incompatible : on bascule sur le lecteur intégré
        renderPanel(); renderSettings();
        return playTrack(i, autoplay);
      }
      if (eng === AD.spotify && AD.spotify.available === false) {
        toast('Lecteur Spotify indisponible : lecture des extraits à la place', 'err', 5000);
        renderPanel();
        return playTrack(i, autoplay);
      }
      if (eng === AD.yt && AD.yt.available === false) {
        toast('YouTube indisponible ici : passage au lecteur Spotify', 'err', 5000);
        renderPanel(); renderBadges();
        return playTrack(i, autoplay);
      }
      if (eng === AD.sdk) { onTrackError(e && e.message ? 'Spotify : ' + e.message : null); return; }
      if (eng === AD.yt) {
        if (t.preview) {
          toast(`« ${t.title} » introuvable en entier : extrait de 30 s`, 'info', 4000);
          return playTrack(i, autoplay, { preview: true });
        }
        onTrackError(e && e.message ? e.message : 'Introuvable sur YouTube');
        return;
      }
      onTrackError(e && e.message === 'nopreview' ? 'Pas d’extrait disponible pour ce titre' : null);
    }
  }

  function onTrackError(msg) {
    const d = disc();
    if (!d) return;
    const t = d.tracks[state.track];
    state.errors++;
    if (state.errors >= Math.min(d.tracks.length, 8)) {
      state.errors = 0;
      stop();
      toast('Aucun titre lisible sur ce disque', 'err');
      return;
    }
    toast(msg ? `${msg} — titre suivant` : `Lecture impossible : ${t ? t.title : 'titre'} — suivant`, 'err');
    const tok = state.loadToken;
    setTimeout(() => { if (tok === state.loadToken) next(true, true); }, 800);
  }

  function next(auto, skipErr) {
    const d = disc();
    if (!d || !d.tracks.length || state.switching) return;
    if (auto && !skipErr && settings.repeat === 'one' && state.track >= 0) return playTrack(state.track, true);
    if (state.order.length !== d.tracks.length) buildOrder(state.track);
    let p = state.pos + 1;
    if (p >= state.order.length) {
      if (settings.repeat === 'off' && auto) { stop(); return; }
      if (settings.shuffle) buildOrder(-1);
      p = 0;
    }
    state.pos = p;
    playTrack(state.order[p], true);
  }

  function prev() {
    const d = disc();
    if (!d || !d.tracks.length || state.switching) return;
    if (state.track >= 0 && state.engine && state.engine.time > 3) { state.engine.seek(0); return; }
    if (state.order.length !== d.tracks.length) buildOrder(state.track);
    let p = state.pos - 1;
    if (p < 0) p = settings.repeat === 'all' || state.track < 0 ? state.order.length - 1 : 0;
    state.pos = p;
    playTrack(state.order[p], true);
  }

  function togglePlay() {
    AD.audio.unlock();
    const d = disc();
    if (!d) { openImport(); return; }
    if (state.switching) {
      state.autoAfterSwitch = !state.autoAfterSwitch;
      if (!state.autoAfterSwitch) state.pendingTrack = null;
      toast(state.autoAfterSwitch ? 'Lecture dès que le disque est posé' : 'Lecture annulée', 'info', 1800);
      return;
    }
    if (!d.tracks.length) { toast('Ce disque est vide', 'info'); return; }
    if (engineFor(d) === AD.sdk) AD.sdk.activate();
    if (state.track < 0 || !state.engine) {
      buildOrder(-1);
      state.pos = 0;
      playTrack(state.order[0], true);
      return;
    }
    if (state.playing) state.engine.pause();
    else state.engine.play();
  }

  function stop() {
    state.loadToken++;
    if (state.engine) state.engine.stop();
    state.track = -1;
    state.pos = -1;
    setPlaying(false);
    app.classList.remove('is-paused');
    renderHUD(); renderLCD(); markCurrent(); mediaMeta(); renderBadges();
  }

  function playFromList(i) {
    const d = disc();
    if (!d) return;
    AD.audio.unlock();
    if (state.switching) {
      state.pendingTrack = i;
      state.autoAfterSwitch = true;
      toast('Lecture dès que le disque est posé', 'info', 1600);
      return;
    }
    if (i === state.track && state.engine) {
      if (!state.playing) state.engine.play();
      return;
    }
    if (settings.shuffle) buildOrder(i); else if (state.order.length !== d.tracks.length) buildOrder(i);
    playTrack(i, true);
  }

  /* évènements des moteurs */
  for (const eng of [AD.audio, AD.spotify, AD.sdk, AD.yt]) {
    eng.on('state', (on) => {
      if (eng !== state.engine) return;
      if (on) state.errors = 0;
      setPlaying(on);
      if (on && eng === AD.yt) { prefetchNext(); renderLCD(); }
    });
    eng.on('ended', () => { if (eng === state.engine) next(true); });
    eng.on('error', (m) => {
      if (eng !== state.engine || state.track < 0) return;
      const d = disc();
      const t = d && d.tracks[state.track];
      if (eng === AD.yt && t && t.preview) {
        // aucune vidéo lisible pour ce titre : extrait de 30 s à la place
        toast(`« ${t.title} » introuvable en entier : extrait de 30 s`, 'info', 4000);
        playTrack(state.track, true, { preview: true });
        return;
      }
      const msg = typeof m === 'string' ? (eng === AD.sdk ? 'Spotify : ' + m : eng === AD.yt ? 'YouTube : ' + m : null) : null;
      onTrackError(msg);
    });
  }
  /* YouTube : on garde la vidéo trouvée avec le disque (plus besoin de la rechercher) */
  let ytSaveT = null;
  AD.yt.on('resolved', (track) => {
    const d = state.discs.find((x) => x.tracks && x.tracks.includes(track));
    if (!d) return;
    clearTimeout(ytSaveT);
    ytSaveT = setTimeout(() => saveDisc(d), 1500);
  });
  AD.yt.on('linked', () => renderPanel());
  function prefetchNext() {
    const d = disc();
    if (!d || state.pos < 0) return;
    const n = state.order[state.pos + 1];
    if (n != null && d.tracks[n] && !d.tracks[n].yt) AD.yt.resolve(d.tracks[n]).catch(() => {});
  }
  AD.audio.on('blocked', () => toast('Appuie sur ▶ pour lancer la lecture', 'info'));
  AD.sdk.on('blocked', () => toast('Appuie sur ▶ pour lancer la lecture', 'info'));
  AD.sdk.on('linked', () => { renderPanel(); });
  AD.sdk.on('fatal', (msg) => {
    toast(msg + ' Passage au lecteur Spotify intégré.', 'err', 8000);
    renderPanel(); renderSettings(); renderBadges();
    const d = disc();
    if (state.engine === AD.sdk && d && d.kind === 'spotify' && state.track >= 0) {
      const i = state.track;
      state.engine = null;
      playTrack(i, true);
    }
  });
  AD.spAuthEvents.on('expired', () => {
    toast('Connexion Spotify expirée : reconnecte ton compte dans Réglages', 'err', 7000);
    renderPanel(); renderSettings();
  });
  AD.spotify.on('preview', () => {
    if (state.engine !== AD.spotify) return;
    renderBadges();
    renderPanel();
    if (!state.previewWarned) {
      state.previewWarned = true;
      toast('Extraits de 30 s : choisis « Complet » dans Réglages pour écouter les titres en entier', 'info', 8000);
    }
  });
  AD.spotify.on('linked', () => $('#spLed').classList.add('on'));
  AD.spotify.on('stuck', () => {
    if (state.engine !== AD.spotify) return;
    toast('Spotify attend un clic : appuie sur ▶ dans le lecteur Spotify', 'err', 6500);
    openPanel();
  });

  /* =========================================================
     Disques
     ========================================================= */
  function sortDiscs() { state.discs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); }

  async function switchDisc(idx, dir, opt) {
    opt = opt || {};
    if (!state.discs.length) return showEmpty();
    idx = ((idx % state.discs.length) + state.discs.length) % state.discs.length;
    if (idx === state.cur && !opt.force) return;
    const wasPlaying = state.playing || (state.switching && state.autoAfterSwitch);
    state.loadToken++;
    if (state.engine) state.engine.stop();
    state.track = -1;
    state.pos = -1;
    setPlaying(false);
    app.classList.remove('is-paused', 'is-empty');
    state.empty = false;
    state.cur = idx;
    const d = state.discs[idx];
    settings.lastDisc = d.id;
    save();
    buildOrder(-1);
    state.switching = true;
    state.pendingTrack = null;
    state.autoAfterSwitch = opt.autoplay != null ? !!opt.autoplay : wasPlaying;
    updateNav();
    renderPanel(); renderRack(); renderBadges(); mediaMeta();
    setMarquee('◌  CHANGEMENT DE DISQUE…');
    const cover = await coverOf(d);
    if (disc() !== d) return;
    setAccent(d);
    if (engineFor(d) === AD.spotify && d.tracks[0]) AD.spotify.ensure(d.tracks[0].uri).catch(() => {});
    if (engineFor(d) === AD.sdk) AD.sdk.ensure().catch(() => {});
    if (engineFor(d) === AD.yt && d.tracks.length) {
      // on prépare le lecteur YouTube et le 1er titre pendant que le disque se pose
      AD.yt.ensure().catch(() => {});
      const first = d.tracks[state.order[0]];
      if (first && !first.yt) AD.yt.resolve(first).catch(() => {});
    }
    const ok = await scene.swap(d, cover, dir || 1, { onAppear: () => { if (disc() === d) { renderHUD(); renderLCD(); } } });
    if (!ok || disc() !== d) return;
    state.switching = false;
    const pending = state.pendingTrack;
    state.pendingTrack = null;
    if (state.autoAfterSwitch && d.tracks.length) {
      state.autoAfterSwitch = false;
      if (pending != null && d.tracks[pending]) { buildOrder(pending); playTrack(pending, true); return; }
      buildOrder(-1);
      state.pos = 0;
      playTrack(state.order[0], true);
    }
  }

  function stepDisc(delta) {
    if (state.discs.length < 2) return;
    switchDisc(state.cur + delta, delta > 0 ? 1 : -1);
  }

  function showEmpty() {
    state.loadToken++;
    if (state.engine) state.engine.unload();
    state.engine = null;
    state.cur = -1; state.track = -1; state.pos = -1;
    state.switching = false;
    state.empty = true;
    setPlaying(false);
    app.classList.remove('is-paused');
    app.classList.add('is-empty');
    setAccent(null);
    updateNav(); renderPanel(); renderRack(); renderHUD(); renderLCD(); renderBadges(); mediaMeta();
    scene.swap(AD.emptyDisc, null, 1, { empty: true, fromAbove: true });
  }

  function blobKeysOf(d) {
    const keys = new Set();
    if (d.coverKey) keys.add(d.coverKey);
    for (const t of d.tracks) if (t.fileKey) keys.add(t.fileKey);
    return [...keys];
  }

  async function saveDisc(d) {
    try { await AD.db.putDisc(d); return true; } catch (e) {
      console.error(e);
      toast('Impossible d’enregistrer le disque', 'err');
      return false;
    }
  }

  async function deleteDisc(d) {
    const ok = await ask({
      title: 'SUPPRIMER',
      text: `Supprimer « ${d.name} » de ta discothèque ?` + (d.kind === 'local' ? ' Les copies gardées dans le navigateur seront effacées (tes fichiers sur le PC ne bougent pas).' : ''),
      yes: 'Supprimer', danger: true,
    });
    if (!ok) return;
    const idx = state.discs.indexOf(d);
    if (idx < 0) return;
    const wasCur = idx === state.cur;
    if (wasCur) {
      state.loadToken++;
      if (state.engine) state.engine.unload();
      state.track = -1;
      setPlaying(false);
    }
    state.discs.splice(idx, 1);
    try {
      await AD.db.deleteDisc(d.id);
      await AD.db.deleteBlobs(blobKeysOf(d));
    } catch (e) { console.error(e); }
    dropCover(d.id);
    if (!state.discs.length) showEmpty();
    else if (wasCur) { state.cur = -1; switchDisc(Math.min(idx, state.discs.length - 1), 1, { autoplay: false }); }
    else if (idx < state.cur) state.cur--;
    renderRack(); updateNav();
    toast('Disque supprimé', 'ok');
  }

  async function renameDisc(d) {
    const name = await ask({ title: 'RENOMMER', text: 'Nouveau nom du disque :', input: true, value: d.name, yes: 'Renommer' });
    if (name == null) return;
    const v = name.trim().slice(0, 60);
    if (!v || v === d.name) return;
    d.name = v;
    if (!(await saveDisc(d))) return;
    scene.refresh(d, covers.get(d.id) || null);
    renderRack(); renderPanel(); renderLCD();
  }

  async function setCover(d, blob) {
    if (!blob || !/^image\//.test(blob.type)) { toast('Choisis une image (JPG, PNG…)', 'err'); return; }
    const key = 'c:' + d.id;
    try { await AD.db.putBlob(key, blob); } catch (e) { toast('Impossible d’enregistrer l’image', 'err'); return; }
    d.coverKey = key;
    d.accent = (await AD.accentFrom(blob)) || d.accent;
    if (!(await saveDisc(d))) return;
    dropCover(d.id);
    const url = await coverOf(d);
    scene.refresh(d, url);
    if (d === disc()) setAccent(d);
    renderRack(); renderPanel(); mediaMeta();
    toast('Pochette mise à jour', 'ok');
  }

  async function removeCover(d) {
    if (!d.coverKey) return;
    const key = d.coverKey;
    d.coverKey = null;
    d.accent = null;
    if (!(await saveDisc(d))) return;
    AD.db.deleteBlobs([key]).catch(() => {});
    dropCover(d.id);
    scene.refresh(d, null);
    if (d === disc()) setAccent(d);
    renderRack(); renderPanel(); mediaMeta();
  }

  async function deleteTrack(d, i) {
    const t = d.tracks[i];
    if (!t) return;
    const isCur = d === disc() && i === state.track;
    d.tracks.splice(i, 1);
    if (!(await saveDisc(d))) return;
    if (t.fileKey) AD.db.deleteBlobs([t.fileKey]).catch(() => {});
    if (d === disc()) {
      if (isCur) {
        const was = state.playing;
        stop();
        buildOrder(-1);
        if (was && d.tracks.length) { const j = Math.min(i, d.tracks.length - 1); buildOrder(j); playTrack(j, true); }
      } else {
        if (state.track > i) state.track--;
        buildOrder(state.track);
        renderHUD();
      }
    }
    scene.refresh(d, covers.get(d.id) || null);
    renderPanel(); renderRack();
  }

  async function syncSpotify(d) {
    if (!d.source) return;
    if (!(await checkServer())) { toast('Lance AquaDisc avec LANCER.bat pour synchroniser', 'err'); return; }
    toast('Synchronisation…', 'info', 1500);
    try {
      const info = await fetchSpotifyInfo(d.source.url || d.source.uri);
      d.name = info.name || d.name;
      d.subtitle = info.subtitle;
      d.truncated = info.truncated;
      d.tracks = info.tracks.map((t) => ({ id: AD.uid(), ...t, duration: (t.duration || 0) / 1000 }));
      if (!(await saveDisc(d))) return;
      if (d === disc()) { stop(); buildOrder(-1); }
      scene.refresh(d, covers.get(d.id) || null);
      renderPanel(); renderRack(); renderHUD(); renderLCD();
      toast(`À jour : ${plural(d.tracks.length, 'titre', 'titres')}`, 'ok');
    } catch (e) {
      toast(e.message || 'Synchronisation impossible', 'err');
    }
  }

  /* =========================================================
     Rendu : HUD, LCD
     ========================================================= */
  const hudTrack = $('#hudTrack'), hudTime = $('#hudTime');
  function setDigits(el, str) {
    if (el._v === str) return;
    el._v = str;
    el.innerHTML = [...str].map((ch) => (ch === ':' ? '<span class="c">:</span>' : ch === '-' ? '<span class="m">-</span>' : `<span class="d">${ch}</span>`)).join('');
  }
  function renderHUD() {
    const d = disc();
    if (!d) { setDigits(hudTrack, '--'); setDigits(hudTime, '--:--'); return; }
    if (state.track < 0) {
      setDigits(hudTrack, pad(d.tracks.length));
      setDigits(hudTime, fmt(AD.discTotal(d)));
      return;
    }
    setDigits(hudTrack, pad(state.track + 1));
  }

  const mq = { text: null };
  function setMarquee(text, force) {
    if (!force && mq.text === text) return;
    mq.text = text;
    const track = $('#lcdTrack');
    const box = $('#lcdMarquee');
    track.classList.remove('scroll');
    track.textContent = '';
    const s1 = h('span', { text });
    track.append(s1);
    requestAnimationFrame(() => {
      if (mq.text !== text) return;
      const W = box.clientWidth;
      const w = s1.offsetWidth;
      if (w > W - 16) {
        track.classList.add('scroll');
        track.append(h('span', { text, 'aria-hidden': 'true' }));
        const full = s1.offsetWidth;
        track.style.setProperty('--mq-w', full + 'px');
        track.style.setProperty('--mq-dur', Math.max(6, full / 42).toFixed(1) + 's');
      }
    });
  }
  function renderLCD() {
    const d = disc();
    if (!d) { setMarquee('✦ INSÈRE UN DISQUE ✦ AQUADISC ✦'); return; }
    if (state.track < 0) {
      const n = d.tracks.length;
      setMarquee(`${d.name} ✦ ${plural(n, 'TITRE', 'TITRES')} ✦ ${fmtLong(AD.discTotal(d)).toUpperCase()}`);
      return;
    }
    const t = d.tracks[state.track];
    if (state.engine === AD.yt && AD.yt.pending) {
      setMarquee(`${pad(state.track + 1)} ▸ ◌ RECHERCHE DU TITRE COMPLET…`);
      return;
    }
    setMarquee(`${pad(state.track + 1)} ▸ ${t.title}${t.artist ? '  —  ' + t.artist : ''}`);
  }
  function renderBadges() {
    const d = disc();
    const box = $('#lcdBadges');
    const b = [];
    if (d) b.push(`<span class="badge">${d.kind === 'spotify' ? 'SPOTIFY' : 'LOCAL'}</span>`);
    b.push(`<span class="badge ${settings.repeat === 'off' ? 'dim' : ''}">${settings.repeat === 'one' ? 'RPT 1' : 'RPT'}</span>`);
    b.push(`<span class="badge ${settings.shuffle ? '' : 'dim'}">RND</span>`);
    const preview = d && d.kind === 'spotify' && (engineFor(d) === AD.audio || (state.previewTrack && state.track >= 0) || (state.engine === AD.spotify && AD.spotify.preview));
    if (preview) b.push('<span class="badge hot">30 S</span>');
    else if (d && d.kind === 'spotify' && (engineFor(d) === AD.sdk || engineFor(d) === AD.yt)) b.push('<span class="badge">FULL</span>');
    box.innerHTML = b.join('');
    $('#btnRepeat').classList.toggle('on', settings.repeat !== 'off');
    $('#btnRepeat').classList.toggle('one', settings.repeat === 'one');
    $('#btnRepeat').title = settings.repeat === 'one' ? 'Répéter : ce titre' : settings.repeat === 'all' ? 'Répéter : tout le disque' : 'Répéter : non';
    $('#btnShuffle').classList.toggle('on', settings.shuffle);
  }

  /* ----- barre de progression + spectre (chaque image) ----- */
  const bar = $('#lcdBar'), barOn = $('#lcdBarOn');
  const lcdEl = $('#lcdElapsed'), lcdTot = $('#lcdTotal');
  const spec = { cv: $('#lcdSpec'), vals: new Float32Array(12), peaks: new Float32Array(12) };
  spec.cx = spec.cv.getContext('2d');
  let barW = 0, lastLit = -1, lastEl = '', lastTot = '';
  let dragging = false;
  function measureBar() { barW = bar.clientWidth; lastLit = -1; }

  function tick(now, dt) {
    const d = disc();
    const eng = state.engine;
    let t = 0, dur = 0;
    if (d && state.track >= 0 && eng) {
      const tr = d.tracks[state.track];
      t = eng.time;
      dur = eng.duration || (tr && tr.duration) || 0;
      if (!dragging) {
        const show = settings.timeMode === 'remain' && dur ? '-' + fmt(Math.max(0, dur - t)) : fmt(t);
        setDigits(hudTime, show);
      }
    } else if (d) {
      dur = AD.discTotal(d);
    }
    const el = fmt(t), tot = fmt(dur);
    if (el !== lastEl) { lastEl = el; lcdEl.textContent = el; }
    if (tot !== lastTot) { lastTot = tot; lcdTot.textContent = tot; }
    if (!dragging) {
      const p = d && state.track >= 0 && dur ? clamp(t / dur, 0, 1) : 0;
      setBar(p);
    }

    // spectre + niveau des basses
    const lv = eng && eng.hasLevels ? eng.levels() : null;
    let bass = 0;
    const playing = state.playing;
    for (let i = 0; i < 12; i++) {
      let v = 0;
      if (lv) {
        const a = Math.floor(Math.pow(i / 12, 1.8) * 110) + 1;
        const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / 12, 1.8) * 110) + 1);
        let s = 0;
        for (let k = a; k < b; k++) s += lv[k];
        v = Math.pow(s / ((b - a) * 255), 1.25) * 1.2;
      } else if (playing) {
        v = 0.42 + 0.3 * Math.sin(now / 170 + i * 1.3) * Math.sin(now / 610 + i * 0.7) + 0.16 * Math.sin(now / 93 + i * 2.1);
        v *= 1 - i * 0.03;
      }
      v = clamp(v, 0, 1);
      spec.vals[i] = v > spec.vals[i] ? v : Math.max(0, spec.vals[i] - dt * 1.7);
      spec.peaks[i] = Math.max(spec.peaks[i] - dt * 0.45, spec.vals[i]);
    }
    if (lv) { let s = 0; for (let k = 1; k < 7; k++) s += lv[k]; bass = s / (6 * 255); bass = Math.pow(bass, 2.2); }
    else if (playing) { bass = 0.12 + 0.3 * Math.pow(Math.max(0, Math.sin(now / 1000 * Math.PI * 2 * 0.95)), 14); }
    scene.setLevel(bass);
    drawSpec();
  }
  function setBar(p) {
    if (!barW) measureBar();
    const segs = Math.max(1, Math.floor((barW + 3) / 9));
    const lit = Math.round(p * segs);
    if (lit === lastLit) return;
    lastLit = lit;
    barOn.style.width = Math.min(barW, lit * 9) + 'px';
    bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  }
  function drawSpec() {
    const c = spec.cx, W = 72, H = 30;
    c.clearRect(0, 0, W, H);
    const rows = 10;
    for (let i = 0; i < 12; i++) {
      const x = i * 6;
      const n = Math.round(spec.vals[i] * rows);
      for (let r = 0; r < rows; r++) {
        const y = H - (r + 1) * 3;
        c.fillStyle = r < n ? (r >= rows - 2 ? '#ffffff' : '#bdf3ff') : 'rgba(120,200,255,.12)';
        c.fillRect(x, y + 1, 5, 2);
      }
      const pk = Math.round(spec.peaks[i] * rows);
      if (pk > 0 && pk > n) { c.fillStyle = '#ffe9a8'; c.fillRect(x, H - pk * 3 + 1, 5, 2); }
    }
  }

  /* déplacement dans le titre */
  function seekFromEvent(e) {
    const r = bar.getBoundingClientRect();
    const p = clamp((e.clientX - r.left) / r.width, 0, 1);
    return p;
  }
  bar.addEventListener('pointerdown', (e) => {
    if (state.track < 0 || !state.engine) return;
    dragging = true;
    bar.classList.add('drag');
    bar.setPointerCapture(e.pointerId);
    const p = seekFromEvent(e);
    setBar(p);
    bar._p = p;
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = seekFromEvent(e);
    bar._p = p;
    setBar(p);
    const dur = state.engine ? state.engine.duration : 0;
    if (dur) setDigits(hudTime, fmt(p * dur));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('drag');
    const eng = state.engine;
    if (eng && eng.duration) eng.seek(bar._p * eng.duration);
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', () => { dragging = false; bar.classList.remove('drag'); });
  bar.addEventListener('keydown', (e) => {
    const eng = state.engine;
    if (!eng || state.track < 0) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); eng.seek(eng.time + 5); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); eng.seek(eng.time - 5); }
  });

  /* =========================================================
     Rendu : liste des titres
     ========================================================= */
  const panel = $('#panel');
  function kindLabel(d) {
    if (d.kind !== 'spotify') return 'DISQUE LOCAL';
    const t = d.source && d.source.type;
    return 'SPOTIFY · ' + (t === 'album' ? 'ALBUM' : t === 'track' ? 'TITRE' : 'PLAYLIST');
  }
  function renderSpBox(d) {
    const eng = d && d.kind === 'spotify' ? engineFor(d) : null;
    panel.classList.toggle('is-spotify', eng === AD.spotify);
    panel.classList.toggle('is-sdk', eng === AD.sdk);
    panel.classList.toggle('is-yt', eng === AD.yt);
    const acts = $('#spActs');
    acts.textContent = '';
    const hint = $('#spHint');
    if (eng === AD.yt) {
      $('#spTitle').textContent = 'TITRES COMPLETS · YOUTUBE';
      $('#spLed').classList.toggle('on', !!AD.yt.ready);
      hint.textContent = state.previewTrack && state.track >= 0
        ? 'Ce titre n’existe pas en entier sur YouTube (bloqué par la maison de disques) : extrait de 30 s.'
        : 'Chaque titre est retrouvé en entier sur YouTube (gratuit, sans compte). Pas la bonne version ? Clique « Autre version ».';
      acts.append(
        h('button', { class: 'chip', type: 'button', title: 'Essayer une autre vidéo pour ce titre', onclick: () => {
          if (state.engine !== AD.yt || state.track < 0) { toast('Lance d’abord un titre', 'info', 1800); return; }
          if (!AD.yt.nextVersion()) toast('Pas d’autre version trouvée pour ce titre', 'info', 2200);
          else toast('Autre version…', 'info', 1400);
        } }, AD.icon('sync'), 'Autre version'),
        h('button', { class: 'chip chip-sp', type: 'button', onclick: () => openPremium() }, AD.icon('wave'), 'J’ai Premium'));
    } else if (eng === AD.sdk) {
      $('#spTitle').textContent = 'SPOTIFY PREMIUM';
      $('#spLed').classList.toggle('on', !!AD.sdk.deviceId);
      hint.textContent = `Titres complets et volume réglable${AD.spAuth.name ? ' · compte ' + AD.spAuth.name : ''}.`;
    } else if (eng === AD.spotify) {
      $('#spTitle').textContent = 'LIAISON SPOTIFY';
      hint.textContent = AD.spotify.preview
        ? 'Ce petit lecteur ne joue que des extraits de 30 s. Pour les titres complets (gratuit) et le volume : passe en mode « Complet ».'
        : 'Ce petit lecteur ne règle pas le volume. Mode « Complet » : titres entiers + volume, gratuit.';
      acts.append(
        h('button', { class: 'chip chip-sp', type: 'button', onclick: () => { $('#setSpMode [data-v="auto"]').click(); } }, AD.icon('check'), 'Passer en « Complet »'),
        h('button', { class: 'chip', type: 'button', title: 'Recharge le lecteur après t’être connecté sur open.spotify.com', onclick: () => reloadEmbed() }, AD.icon('sync'), 'Recharger'));
    }
  }
  function reloadEmbed() {
    const d = disc();
    const i = state.track, was = state.playing;
    AD.spotify.reset();
    $('#spLed').classList.remove('on');
    if (d && engineFor(d) === AD.spotify && d.tracks.length) {
      if (i >= 0) { state.engine = null; playTrack(i, was); }
      else AD.spotify.ensure(d.tracks[0].uri).catch(() => {});
    }
    renderPanel(); renderBadges();
  }

  function renderPanel() {
    const d = disc();
    renderSpBox(d);
    const art = $('#phArt');
    art.textContent = '';
    art.style.backgroundImage = '';
    const tools = $('#panelTools');
    tools.textContent = '';
    const list = $('#trackList');
    list.textContent = '';
    if (!d) {
      $('#phKind').textContent = 'AQUADISC';
      $('#phKind').className = 'ph-kind';
      $('#phName').textContent = 'Aucun disque';
      $('#phMeta').textContent = 'Ajoute une playlist pour commencer';
      list.append(h('li', { class: 'tracks-empty' }, 'Ta discothèque est vide.'));
      return;
    }
    const cover = covers.get(d.id);
    if (cover) art.style.backgroundImage = `url("${cover}")`; else art.append(AD.paperCover(d));
    $('#phKind').textContent = kindLabel(d);
    $('#phKind').className = 'ph-kind' + (d.kind === 'spotify' ? ' sp' : '');
    $('#phName').textContent = d.name;
    const meta = [plural(d.tracks.length, 'titre', 'titres'), fmtLong(AD.discTotal(d))];
    if (d.subtitle) meta.unshift(d.subtitle);
    if (d.truncated) meta.push('100 premiers titres');
    $('#phMeta').textContent = meta.join(' · ');

    if (d.kind === 'local') {
      tools.append(
        h('button', { class: 'chip', type: 'button', onclick: () => pickAddTracks(d) }, AD.icon('plus'), 'Ajouter des titres'),
        h('button', { class: 'chip', type: 'button', onclick: () => pickCover(d) }, AD.icon('image'), 'Pochette'),
        h('button', { class: 'chip', type: 'button', onclick: () => renameDisc(d) }, AD.icon('edit'), 'Renommer'),
      );
    } else {
      tools.append(
        h('button', { class: 'chip', type: 'button', onclick: () => syncSpotify(d) }, AD.icon('sync'), 'Synchroniser'),
        d.source && d.source.url ? h('a', { class: 'chip chip-sp', href: d.source.url, target: '_blank', rel: 'noopener' }, AD.icon('wave'), 'Ouvrir dans Spotify') : null,
        h('button', { class: 'chip', type: 'button', onclick: () => renameDisc(d) }, AD.icon('edit'), 'Renommer'),
      );
    }

    if (!d.tracks.length) {
      list.append(h('li', { class: 'tracks-empty' }, d.kind === 'local' ? 'Disque vide — ajoute des titres.' : 'Aucun titre.'));
      return;
    }
    const frag = document.createDocumentFragment();
    const previewMode = d.kind === 'spotify' && engineFor(d) === AD.audio;
    const viaYt = d.kind === 'spotify' && engineFor(d) === AD.yt;
    d.tracks.forEach((t, i) => {
      const off = (d.kind === 'spotify' && t.playable === false && !viaYt) || (previewMode && !t.preview);
      const li = h('li', { class: off ? 'off' : '', dataset: { i: String(i) } },
        h('span', { class: 'tr-num' }, h('span', { class: 'tr-n', text: pad(i + 1) }), h('span', { class: 'eq' }, h('i'), h('i'), h('i'))),
        h('div', { class: 'tr-txt' },
          h('div', { class: 'tr-title' }, t.title, t.explicit ? h('span', { class: 'tr-explicit', text: 'E' }) : null),
          h('div', { class: 'tr-artist', text: t.artist || (d.kind === 'local' ? t.album || '—' : '—') })),
        h('span', { class: 'tr-dur', text: t.duration ? fmt(t.duration) : '--:--' }),
        h('button', { class: 'tr-del', type: 'button', title: 'Retirer du disque', 'aria-label': 'Retirer ' + t.title, dataset: { del: String(i) } }, AD.icon('close')));
      frag.append(li);
    });
    list.append(frag);
    markCurrent();
  }
  $('#trackList').addEventListener('click', (e) => {
    const d = disc();
    if (!d) return;
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteTrack(d, Number(del.dataset.del)); return; }
    const li = e.target.closest('li[data-i]');
    if (li) playFromList(Number(li.dataset.i));
  });
  function markCurrent() {
    const list = $('#trackList');
    const old = list.querySelector('li.cur');
    if (old) old.classList.remove('cur');
    if (state.track < 0) return;
    const li = list.querySelector(`li[data-i="${state.track}"]`);
    if (li) {
      li.classList.add('cur');
      if (panel.classList.contains('open')) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  /* =========================================================
     Rendu : discothèque
     ========================================================= */
  const rack = $('#rack');
  function eqIcon() { return h('span', { class: 'eq', style: { display: 'flex' } }, h('i'), h('i'), h('i')); }
  function renderRack() {
    const list = $('#rackList');
    list.textContent = '';
    state.discs.forEach((d, i) => {
      const cover = covers.get(d.id) || null;
      const art = h('div', { class: 'case-art' });
      art.append(AD.miniDisc(d, cover, 'case-disc'));
      const front = h('div', { class: 'case-front' });
      if (cover) front.style.backgroundImage = `url("${cover}")`; else front.append(AD.paperCover(d));
      if (i === state.cur) front.append(h('span', { class: 'now-tag' }, 'EN COURS'));
      art.append(front);
      const more = h('button', { class: 'case-more', type: 'button', title: 'Options', 'aria-label': 'Options de ' + d.name }, AD.icon('more'));
      const item = h('div', { class: 'case' + (i === state.cur ? ' cur' : ''), role: 'button', tabindex: '0', 'aria-label': d.name },
        art,
        h('div', { class: 'case-info' },
          h('div', { class: 'case-name', text: d.name, title: d.name }),
          h('div', { class: 'case-meta' }, h('span', { class: 'kind-tag' + (d.kind === 'spotify' ? ' sp' : ''), text: d.kind === 'spotify' ? 'SPOTIFY' : 'LOCAL' }), plural(d.tracks.length, 'titre', 'titres'))),
        more);
      item.addEventListener('click', (e) => { if (e.target.closest('.case-more')) return; pickDisc(i); });
      item.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === item) { e.preventDefault(); pickDisc(i); } });
      more.addEventListener('click', (e) => { e.stopPropagation(); discMenu(d, more, item); });
      list.append(item);
    });
    list.append(
      h('button', { class: 'case-add', type: 'button', onclick: () => openImport('local') }, AD.icon('folder'), 'Disque local'),
      h('button', { class: 'case-add sp', type: 'button', onclick: () => openImport('spotify') }, AD.icon('wave'), 'Depuis Spotify'));
    $('#rackCount').textContent = plural(state.discs.length, 'disque', 'disques');
    AD.db.estimate().then((est) => {
      if (!est || !est.usage) { $('#rackFoot').textContent = ''; return; }
      const mo = est.usage / (1024 * 1024);
      $('#rackFoot').textContent = `Stockage navigateur : ${mo < 1 ? '< 1' : mo < 1024 ? Math.round(mo) : (mo / 1024).toFixed(1).replace('.', ',')} ${mo < 1024 ? 'Mo' : 'Go'} utilisés`;
    });
  }
  function pickDisc(i) {
    closeRack();
    if (i === state.cur) { if (!state.playing && !state.switching) togglePlay(); return; }
    switchDisc(i, i > state.cur ? 1 : -1, { autoplay: true });
  }
  function updateNav() {
    app.classList.toggle('few-discs', state.discs.length < 2);
  }

  /* =========================================================
     Panneaux, menus, fenêtres
     ========================================================= */
  function openRack() { closePanel(); closeMenu(); renderRack(); rack.classList.add('open'); rack.setAttribute('aria-hidden', 'false'); $('#btnDiscs').classList.add('on'); }
  function closeRack() { rack.classList.remove('open'); rack.setAttribute('aria-hidden', 'true'); $('#btnDiscs').classList.remove('on'); closeMenu(); }
  function toggleRack() { rack.classList.contains('open') ? closeRack() : openRack(); }
  function openPanel() { closeRack(); panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); $('#btnList').classList.add('on'); const li = $('#trackList li.cur'); if (li) li.scrollIntoView({ block: 'center' }); }
  function closePanel() { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); $('#btnList').classList.remove('on'); }
  function togglePanel() { panel.classList.contains('open') ? closePanel() : openPanel(); }

  const menu = $('#menu');
  let menuOwner = null;
  function showMenu(anchor, items, owner) {
    closeMenu();
    menu.textContent = '';
    for (const it of items) {
      if (!it) continue;
      menu.append(h('button', { type: 'button', class: it.danger ? 'danger' : '', onclick: () => { closeMenu(); it.fn(); } }, AD.icon(it.icon), it.label));
    }
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = r.right - mw, y = r.bottom + 6;
    if (y + mh > innerHeight - 8) y = r.top - mh - 6;
    menu.style.left = clamp(x, 8, innerWidth - mw - 8) + 'px';
    menu.style.top = clamp(y, 8, innerHeight - mh - 8) + 'px';
    menuOwner = owner || null;
    if (menuOwner) menuOwner.classList.add('menu-open');
    const b = menu.querySelector('button');
    if (b) b.focus({ preventScroll: true });
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    if (menuOwner) menuOwner.classList.remove('menu-open');
    menuOwner = null;
  }
  function discMenu(d, anchor, owner) {
    showMenu(anchor, [
      { icon: 'edit', label: 'Renommer', fn: () => renameDisc(d) },
      { icon: 'image', label: d.coverKey ? 'Changer la pochette' : 'Ajouter une pochette', fn: () => pickCover(d) },
      d.coverKey ? { icon: 'close', label: 'Retirer la pochette', fn: () => removeCover(d) } : null,
      d.kind === 'local' ? { icon: 'plus', label: 'Ajouter des titres', fn: () => pickAddTracks(d) } : null,
      d.kind === 'spotify' ? { icon: 'sync', label: 'Synchroniser avec Spotify', fn: () => syncSpotify(d) } : null,
      { icon: 'trash', label: 'Supprimer le disque', danger: true, fn: () => deleteDisc(d) },
    ], owner);
  }

  const layer = $('#modalLayer');
  let askResolve = null;
  function openModal(id) {
    closeMenu();
    layer.classList.add('open');
    layer.setAttribute('aria-hidden', 'false');
    $$('.win', layer).forEach((w) => w.classList.toggle('active', w.id === id));
    state.modal = id;
  }
  function closeModal() {
    if (!state.modal) return;
    if (state.modal === 'winImport' && imp.busy) return;
    if (state.modal === 'winAsk' && askResolve) { const r = askResolve; askResolve = null; r(null); }
    layer.classList.remove('open');
    layer.setAttribute('aria-hidden', 'true');
    $$('.win', layer).forEach((w) => w.classList.remove('active'));
    state.modal = null;
  }
  layer.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

  function ask(o) {
    if (askResolve) { const r = askResolve; askResolve = null; r(null); }
    const win = $('#winAsk');
    win.classList.toggle('danger', !!o.danger);
    $('#askTitle').textContent = o.title || 'AQUADISC';
    $('#askText').textContent = o.text || '';
    const inp = $('#askInput');
    inp.hidden = !o.input;
    inp.value = o.value || '';
    $('#askYes').firstElementChild.textContent = (o.yes || 'OK').toUpperCase();
    openModal('winAsk');
    setTimeout(() => (o.input ? (inp.focus(), inp.select()) : $('#askYes').focus()), 60);
    return new Promise((resolve) => { askResolve = (v) => resolve(v); });
  }
  function answer(ok) {
    if (!askResolve) return;
    const r = askResolve;
    askResolve = null;
    const inp = $('#askInput');
    const v = ok ? (inp.hidden ? true : inp.value) : (inp.hidden ? false : null);
    layer.classList.remove('open');
    layer.setAttribute('aria-hidden', 'true');
    $('#winAsk').classList.remove('active');
    state.modal = null;
    r(v);
  }
  $('#askYes').addEventListener('click', () => answer(true));
  $('#askNo').addEventListener('click', () => answer(false));
  $('#askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); answer(true); } });

  /* =========================================================
     Import : fichiers locaux
     ========================================================= */
  const imp = { files: [], cover: null, busy: false, found: null, tab: 'local', fetching: false, folderArt: new Map() };
  const folderOf = (f) => {
    const p = f._path || f.webkitRelativePath || '';
    const i = p.lastIndexOf('/');
    return i > 0 ? p.slice(0, i) : '';
  };
  const baseName = (p) => (p ? p.split('/').filter(Boolean).pop() : '');

  function openImport(tab, opt) {
    opt = opt || {};
    closeRack();
    setTab(tab || imp.tab || 'local');
    openModal('winImport');
    if (opt.url) { $('#spUrl').value = opt.url; spFetch(); }
    else if ((tab || imp.tab) === 'spotify') setTimeout(() => $('#spUrl').focus(), 80);
  }
  function setTab(tab) {
    imp.tab = tab;
    $$('#winImport .tab').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    $$('#winImport .win-body').forEach((p) => p.classList.toggle('is-on', p.dataset.pane === tab));
    if (tab === 'spotify') refreshServerNotice();
  }
  $$('#winImport .tab').forEach((b) => b.addEventListener('click', () => { if (!imp.busy) setTab(b.dataset.tab); }));

  const ART_RE = /^(cover|folder|front|album|artwork|pochette)[^/]*\.(jpe?g|png|webp)$/i;
  function stageFiles(files) {
    const audio = files.filter(AD.isAudioFile);
    const arts = files.filter((f) => ART_RE.test(f.name));
    for (const f of arts) if (!imp.folderArt.has(folderOf(f))) imp.folderArt.set(folderOf(f), f);
    const ignored = files.length - audio.length - arts.length;
    const key = (f) => (f._path || f.webkitRelativePath || f.name) + ':' + f.size;
    const have = new Set(imp.files.map(key));
    for (const f of audio) if (!have.has(key(f))) imp.files.push(f);
    if (!audio.length && files.length) toast('Aucun fichier audio dans la sélection', 'err');
    else if (ignored > 0) toast(`${plural(ignored, 'fichier ignoré', 'fichiers ignorés')} (pas de l’audio)`, 'info');
    renderStaged();
  }
  function renderStaged() {
    const n = imp.files.length;
    $('#staged').hidden = !n;
    $('#burnLocal').disabled = !n || imp.busy;
    const folders = new Set(imp.files.map(folderOf).filter(Boolean));
    const size = imp.files.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
    $('#stagedSum').textContent = n ? `${plural(n, 'fichier audio', 'fichiers audio')}${folders.size > 1 ? ' · ' + folders.size + ' dossiers' : ''} · ${size < 1 ? '< 1' : Math.round(size)} Mo` : '';
    $('#splitRow').hidden = folders.size < 2;
    if (folders.size >= 2 && !imp.splitTouched) $('#splitFolders').checked = true;
    const nameInp = $('#localName');
    if (!nameInp.dataset.touched) {
      const common = folders.size === 1 ? baseName([...folders][0]) : '';
      nameInp.value = common || (n ? 'Ma compil' : '');
    }
    nameInp.disabled = !$('#splitRow').hidden && $('#splitFolders').checked;
  }
  $('#localName').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('#splitFolders').addEventListener('change', () => { imp.splitTouched = true; renderStaged(); });
  $('#stagedClear').addEventListener('click', () => { imp.files = []; imp.folderArt.clear(); renderStaged(); });
  $('#pickFiles').addEventListener('click', () => $('#fileInput').click());
  $('#pickFolder').addEventListener('click', () => $('#folderInput').click());
  $('#fileInput').addEventListener('change', (e) => { stageFiles([...e.target.files]); e.target.value = ''; });
  $('#folderInput').addEventListener('change', (e) => { stageFiles([...e.target.files]); e.target.value = ''; });
  $('#coverPick').addEventListener('click', () => { coverTarget = null; $('#coverInput').click(); });

  let coverTarget = null;
  function pickCover(d) { coverTarget = d; $('#coverInput').click(); }
  $('#coverInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (coverTarget) { const d = coverTarget; coverTarget = null; setCover(d, f); return; }
    if (!/^image\//.test(f.type)) { toast('Choisis une image', 'err'); return; }
    imp.cover = f;
    const prevEl = $('#coverPrev');
    if (prevEl._u) URL.revokeObjectURL(prevEl._u);
    prevEl._u = URL.createObjectURL(f);
    prevEl.style.backgroundImage = `url("${prevEl._u}")`;
  });

  let addTarget = null;
  function pickAddTracks(d) { addTarget = d; $('#addInput').click(); }
  $('#addInput').addEventListener('change', async (e) => {
    const files = [...e.target.files].filter(AD.isAudioFile);
    e.target.value = '';
    const d = addTarget;
    addTarget = null;
    if (!d || !files.length) return;
    toast(`Ajout de ${plural(files.length, 'titre', 'titres')}…`, 'info', 2000);
    try {
      const res = await readTracks(files, () => {});
      if (!res.tracks.length) { toast('Aucun titre lisible', 'err'); return; }
      d.tracks.push(...res.tracks);
      if (!(await saveDisc(d))) return;
      if (!d.coverKey && res.picture) await setCover(d, res.picture);
      if (d === disc()) buildOrder(state.track);
      scene.refresh(d, covers.get(d.id) || null);
      renderPanel(); renderRack(); renderHUD(); renderLCD();
      toast(`${plural(res.tracks.length, 'titre ajouté', 'titres ajoutés')}`, 'ok');
    } catch (err) { importError(err); }
  });

  function setBurn(sel, p, txt) {
    const b = $(sel);
    b.hidden = p == null;
    if (p == null) return;
    b.querySelector('i').style.width = Math.round(clamp(p, 0, 1) * 100) + '%';
    b.querySelector('.burn-txt').textContent = txt || '';
  }

  /* lit tags + durée, copie les fichiers dans le navigateur */
  async function readTracks(files, onStep) {
    const tracks = [];
    let picture = null, skipped = 0;
    const written = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        onStep(i, f);
        const m = await AD.meta.read(f);
        if (!m.ok) { skipped++; continue; }
        const fileKey = 'f:' + AD.uid();
        await AD.db.putBlob(fileKey, f);
        written.push(fileKey);
        tracks.push({ id: AD.uid(), title: m.title, artist: m.artist, album: m.album, duration: m.duration, fileKey, _n: m.track, _d: m.disc, _f: f._path || f.webkitRelativePath || f.name });
        if (!picture && m.picture) picture = m.picture;
      }
    } catch (e) {
      AD.db.deleteBlobs(written).catch(() => {});
      throw e;
    }
    const allNumbered = tracks.length > 1 && tracks.every((t) => t._n > 0);
    tracks.sort((a, b) => {
      if (allNumbered) {
        const al = AD.collator.compare(a.album || '', b.album || '');
        if (al) return al;
        if ((a._d || 0) !== (b._d || 0)) return (a._d || 0) - (b._d || 0);
        if (a._n !== b._n) return a._n - b._n;
      }
      return AD.collator.compare(a._f, b._f);
    });
    for (const t of tracks) { delete t._n; delete t._d; delete t._f; }
    return { tracks, picture, skipped };
  }

  function importError(err) {
    console.error(err);
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
    toast(quota ? 'Plus assez de place dans le navigateur pour ces fichiers' : 'Erreur pendant l’import : ' + (err && err.message ? err.message : 'inconnue'), 'err', 6000);
  }

  $('#burnLocal').addEventListener('click', async () => {
    if (imp.busy || !imp.files.length) return;
    const files = imp.files.slice();
    const split = !$('#splitRow').hidden && $('#splitFolders').checked;
    let groups;
    if (split) {
      const map = new Map();
      for (const f of files) {
        const k = folderOf(f) || '';
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(f);
      }
      groups = [...map.entries()].map(([k, fs]) => ({ name: baseName(k) || 'Ma compil', files: fs, art: imp.folderArt.get(k) || null }));
    } else {
      groups = [{ name: ($('#localName').value || '').trim().slice(0, 60) || 'Ma compil', files, art: imp.folderArt.values().next().value || null }];
    }
    imp.busy = true;
    renderStaged();
    $('#winImport').classList.add('busy');
    const total = files.length;
    let done = 0, skipped = 0;
    const created = [];
    AD.db.persist();
    try {
      for (const g of groups) {
        const id = AD.uid();
        const res = await readTracks(g.files, (i, f) => setBurn('#localBurn', (done + i) / total, `GRAVURE ${done + i + 1}/${total}`));
        done += g.files.length;
        skipped += res.skipped;
        if (!res.tracks.length) continue;
        const coverBlob = (!split && imp.cover) || g.art || res.picture;
        let coverKey = null, accent = null;
        if (coverBlob) {
          coverKey = 'c:' + id;
          await AD.db.putBlob(coverKey, coverBlob);
          accent = await AD.accentFrom(coverBlob);
        }
        const d = { id, kind: 'local', name: g.name, createdAt: Date.now() + created.length, coverKey, accent, look: AD.makeLook(id), tracks: res.tracks };
        await AD.db.putDisc(d);
        created.push(d);
      }
      setBurn('#localBurn', 1, 'TERMINÉ');
    } catch (err) {
      importError(err);
    }
    imp.busy = false;
    $('#winImport').classList.remove('busy');
    setBurn('#localBurn', null);
    if (!created.length) {
      renderStaged();
      if (skipped) toast('Aucun fichier lisible par le navigateur', 'err');
      return;
    }
    for (const d of created) { state.discs.push(d); await coverOf(d); }
    sortDiscs();
    imp.files = [];
    imp.folderArt.clear();
    imp.cover = null;
    $('#coverPrev').style.backgroundImage = '';
    $('#localName').value = '';
    delete $('#localName').dataset.touched;
    imp.splitTouched = false;
    renderStaged();
    closeModal();
    renderRack();
    updateNav();
    toast(created.length > 1 ? `${created.length} disques gravés !` : `Disque gravé : ${created[0].name}`, 'ok');
    if (skipped) setTimeout(() => toast(`${plural(skipped, 'fichier illisible ignoré', 'fichiers illisibles ignorés')}`, 'info'), 900);
    switchDisc(state.discs.indexOf(created[0]), 1, { autoplay: true, force: true });
  });

  /* =========================================================
     Import : Spotify
     ========================================================= */
  async function checkServer() {
    if (state.server != null) return state.server;
    if (location.protocol === 'file:') { state.server = false; return false; }
    try {
      const r = await fetch('/api/ping', { signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined, cache: 'no-store' });
      const j = await r.json();
      state.server = !!(j && j.ok);
      state.serverV = (j && j.v) || 1;
      if (state.server && state.serverV < 2) {
        // ancien serveur encore ouvert : la recherche des titres complets n'existe pas dedans
        AD.yt.available = false;
        setTimeout(() => toast('AquaDisc a été mis à jour : ferme la fenêtre noire puis relance LANCER.bat pour avoir les titres complets', 'err', 12000), 1500);
      }
    } catch (e) { state.server = false; }
    return state.server;
  }
  async function refreshServerNotice() {
    const ok = await checkServer();
    if (!ok) {
      const online = !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) && location.protocol !== 'file:';
      spMsg(online
        ? 'Sur la version en ligne, l’import Spotify n’est pas disponible (il faut le petit serveur). Télécharge AquaDisc et lance LANCER.bat sur ton PC pour l’avoir. Les disques locaux marchent ici.'
        : 'Pour importer depuis Spotify, ouvre AquaDisc avec LANCER.bat (petit serveur local). Les disques locaux marchent sans.', 'warn');
    }
    $('#spUrl').disabled = !ok;
    $('#spFetch').disabled = !ok;
    $('#spImportHint').textContent = AD.spAuth.connected
      ? 'Tes playlists (même privées) sont gravées en entier. Les autres playlists publiques : 100 premiers titres (limite de Spotify).'
      : 'Playlists publiques, albums ou titres. Sans compte connecté, Spotify ne donne que les 100 premiers titres d’une playlist.';
    renderMyPlaylists();
  }

  /* « Mes playlists » quand le compte Spotify est connecté */
  let myPlCache = null;
  async function renderMyPlaylists(force) {
    const box = $('#myPl');
    if (!AD.spAuth.connected) { box.hidden = true; return; }
    box.hidden = false;
    const list = $('#myPlList');
    if (myPlCache && !force) return drawMyPl(myPlCache);
    list.innerHTML = '<div class="my-pl-empty">Chargement de tes playlists…</div>';
    try {
      myPlCache = await AD.spAuth.myPlaylists();
      drawMyPl(myPlCache);
    } catch (e) {
      list.innerHTML = '';
      list.append(h('div', { class: 'my-pl-empty', text: 'Impossible de lire tes playlists (' + (e.message || 'erreur') + ').' }));
    }
  }
  function drawMyPl(items) {
    const list = $('#myPlList');
    list.textContent = '';
    if (!items.length) { list.append(h('div', { class: 'my-pl-empty', text: 'Aucune playlist sur ce compte.' })); return; }
    for (const p of items) {
      const thumb = h('span', { class: 'mp-art' });
      if (p.image) thumb.style.backgroundImage = `url("${p.image}")`;
      list.append(h('button', { class: 'mp-item', type: 'button', title: p.name, onclick: () => { $('#spUrl').value = p.url; spFetch(); } },
        thumb,
        h('span', { class: 'mp-txt' }, h('b', { text: p.name }), h('small', { text: [p.owner, p.total != null ? plural(p.total, 'titre', 'titres') : ''].filter(Boolean).join(' · ') }))));
    }
  }
  $('#myPlRefresh').addEventListener('click', () => renderMyPlaylists(true));
  function spMsg(text, type) {
    const m = $('#spMsg');
    m.hidden = !text;
    m.textContent = text || '';
    m.className = 'sp-msg' + (type ? ' ' + type : '');
  }
  async function fetchSpotifyInfo(url) {
    // compte connecté + playlist à soi : liste complète (au-delà de 100 titres, même privée)
    const m = String(url).match(/playlist[/:]([A-Za-z0-9]{10,40})/);
    if (m && AD.spAuth.connected) {
      try {
        const full = await AD.spAuth.fullPlaylist(m[1]);
        if (full) return full;
      } catch (e) { console.warn('Lecture via le compte impossible, on passe par le lien public', e); }
    }
    const r = await fetch('/api/spotify?url=' + encodeURIComponent(url), { cache: 'no-store' });
    let j = null;
    try { j = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) throw new Error((j && j.error) || `Erreur ${r.status}`);
    return j;
  }
  async function spFetch() {
    const url = $('#spUrl').value.trim();
    imp.found = null;
    $('#spFound').hidden = true;
    $('#burnSpotify').disabled = true;
    if (!url) { spMsg('Colle d’abord un lien Spotify.', 'err'); return; }
    if (!/spotify/i.test(url)) { spMsg('Ce n’est pas un lien Spotify.', 'err'); return; }
    if (!(await checkServer())) { refreshServerNotice(); return; }
    if (imp.fetching) return;
    imp.fetching = true;
    spMsg('Lecture de la playlist…');
    $('#spFetch').disabled = true;
    try {
      const info = await fetchSpotifyInfo(url);
      if ($('#spUrl').value.trim() !== url) return;
      imp.found = info;
      spMsg('');
      const total = info.tracks.reduce((s, t) => s + (t.duration || 0), 0) / 1000;
      $('#spfArt').style.backgroundImage = info.cover ? `url("${info.cover}")` : '';
      $('#spfKind').textContent = info.type === 'album' ? 'ALBUM' : info.type === 'track' ? 'TITRE' : 'PLAYLIST';
      $('#spfName').textContent = info.name;
      $('#spfMeta').textContent = [info.subtitle, plural(info.tracks.length, 'titre', 'titres'), fmtLong(total)].filter(Boolean).join(' · ');
      $('#spFound').hidden = false;
      $('#burnSpotify').disabled = false;
      const dup = state.discs.find((d) => d.source && d.source.uri === info.uri);
      if (dup) spMsg('Ce disque est déjà dans ta discothèque — le graver en crée une copie.', 'warn');
      else if (info.truncated) spMsg('Spotify ne donne que les 100 premiers titres de cette playlist.', 'warn');
    } catch (e) {
      spMsg(e.message || 'Impossible de lire ce lien.', 'err');
    } finally {
      imp.fetching = false;
      $('#spFetch').disabled = false;
    }
  }
  $('#spFetch').addEventListener('click', spFetch);
  $('#spUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); spFetch(); } });
  $('#spUrl').addEventListener('paste', () => setTimeout(spFetch, 30));
  $('#spUrl').addEventListener('input', () => { if (imp.found) { imp.found = null; $('#spFound').hidden = true; $('#burnSpotify').disabled = true; spMsg(''); } });

  $('#burnSpotify').addEventListener('click', async () => {
    const info = imp.found;
    if (!info || imp.busy) return;
    imp.busy = true;
    $('#burnSpotify').disabled = true;
    setBurn('#spBurn', 0.15, 'GRAVURE…');
    try {
      const id = AD.uid();
      let coverKey = null;
      let accent = AD.niceAccent(info.color);
      if (info.cover) {
        try {
          const r = await fetch(info.cover);
          if (r.ok) {
            const b = await r.blob();
            setBurn('#spBurn', 0.6, 'POCHETTE…');
            coverKey = 'c:' + id;
            await AD.db.putBlob(coverKey, b);
            accent = (await AD.accentFrom(b)) || accent;
          }
        } catch (e) { coverKey = null; }
      }
      const d = {
        id, kind: 'spotify', name: info.name, subtitle: info.subtitle || '', createdAt: Date.now(),
        coverKey, accent, look: AD.makeLook(id), truncated: !!info.truncated,
        source: { type: info.type, id: info.id, uri: info.uri, url: info.url },
        tracks: info.tracks.map((t) => ({ id: AD.uid(), ...t, duration: (t.duration || 0) / 1000 })),
      };
      await AD.db.putDisc(d);
      setBurn('#spBurn', 1, 'TERMINÉ');
      state.discs.push(d);
      sortDiscs();
      await coverOf(d);
      imp.busy = false;
      imp.found = null;
      $('#spUrl').value = '';
      $('#spFound').hidden = true;
      spMsg('');
      setBurn('#spBurn', null);
      closeModal();
      renderRack();
      updateNav();
      toast(`Disque gravé : ${d.name}`, 'ok');
      switchDisc(state.discs.indexOf(d), 1, { autoplay: true, force: true });
    } catch (e) {
      imp.busy = false;
      setBurn('#spBurn', null);
      $('#burnSpotify').disabled = false;
      importError(e);
    }
  });

  /* =========================================================
     Glisser-déposer & coller
     ========================================================= */
  async function filesFromDrop(dt) {
    const items = dt.items ? [...dt.items] : [];
    const entries = items.map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return [...(dt.files || [])];
    const out = [];
    async function walk(entry, path) {
      if (entry.isFile) {
        const f = await new Promise((res) => entry.file(res, () => res(null)));
        if (f) { try { f._path = path + f.name; } catch (e) { /* ignore */ } out.push(f); }
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const e of batch) await walk(e, path + entry.name + '/');
        } while (batch.length);
      }
    }
    for (const e of entries) await walk(e, '');
    return out;
  }
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  let dragDepth = 0;
  const dropOverlay = $('#dropOverlay');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || imp.busy) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.add('on');
  });
  window.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = imp.busy ? 'none' : 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.classList.remove('on');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.remove('on');
    if (!e.dataTransfer || imp.busy) return;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    if (hasFiles(e)) {
      const files = await filesFromDrop(e.dataTransfer);
      stageFiles(files);
      if (imp.files.length) openImport('local');
    } else if (/spotify/i.test(text)) {
      openImport('spotify', { url: text.split(/\s+/)[0] });
    }
  });
  document.addEventListener('paste', (e) => {
    if (isTyping(e.target) || state.modal) return;
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (/open\.spotify\.com\/|^spotify:|spotify\.link|spoti\.fi/i.test(t.trim())) openImport('spotify', { url: t.trim() });
  });

  /* =========================================================
     Commandes
     ========================================================= */
  const click = (sel, fn) => $(sel).addEventListener('click', (e) => { AD.Sfx.click(); fn(e); });
  click('#btnPlay', togglePlay);
  click('#btnStop', () => { if (state.track >= 0) stop(); });
  click('#btnNext', () => next(false));
  click('#btnPrev', () => prev());
  click('#btnRepeat', () => {
    settings.repeat = settings.repeat === 'all' ? 'one' : settings.repeat === 'one' ? 'off' : 'all';
    save(); renderBadges();
    toast(settings.repeat === 'all' ? 'Répéter : tout le disque' : settings.repeat === 'one' ? 'Répéter : ce titre' : 'Répétition désactivée', 'info', 1600);
  });
  click('#btnShuffle', () => {
    settings.shuffle = !settings.shuffle;
    save();
    buildOrder(state.track);
    renderBadges();
    toast(settings.shuffle ? 'Lecture aléatoire' : 'Lecture dans l’ordre', 'info', 1600);
  });
  click('#btnDiscs', toggleRack);
  click('#btnList', togglePanel);
  $('#rackClose').addEventListener('click', closeRack);
  $('#panelClose').addEventListener('click', closePanel);
  $('#rackAddLocal').addEventListener('click', () => openImport('local'));
  $('#rackAddSpotify').addEventListener('click', () => openImport('spotify'));
  $('#rackSettings').addEventListener('click', () => { renderSettings(); openModal('winSettings'); });
  $('#btnEmptyAdd').addEventListener('click', () => openImport('local'));
  $('#discPrev').addEventListener('click', () => { AD.Sfx.click(); stepDisc(-1); });
  $('#discNext').addEventListener('click', () => { AD.Sfx.click(); stepDisc(1); });
  $('#hudTime').addEventListener('click', () => {
    settings.timeMode = settings.timeMode === 'remain' ? 'elapsed' : 'remain';
    save();
    if (state.track < 0) toast(settings.timeMode === 'remain' ? 'Affichage : temps restant' : 'Affichage : temps écoulé', 'info', 1500);
  });

  /* clic / balayage sur le disque */
  const hit = $('#discHit');
  let sw = null;
  function onDiscClick() {
    if (state.empty || !disc()) { openImport('local'); return; }
    AD.Sfx.click();
    togglePlay();
  }
  hit.addEventListener('pointerdown', (e) => { sw = { x: e.clientX, y: e.clientY }; });
  hit.addEventListener('pointerup', (e) => {
    if (!sw) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    sw = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) stepDisc(dx < 0 ? 1 : -1);
    else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) onDiscClick();
  });
  hit.addEventListener('pointercancel', () => { sw = null; });
  hit.addEventListener('click', (e) => { if (e.detail === 0) onDiscClick(); });

  /* volume */
  const volRange = $('#volRange');
  function applyVolume() {
    const ev = effectiveVolume();
    AD.audio.volume = ev;
    AD.sdk.volume = ev;
    AD.yt.volume = ev;
    const v = Math.round(settings.volume * 100);
    if (Number(volRange.value) !== v) volRange.value = v;
    const shown = settings.muted ? 0 : v;
    volRange.style.setProperty('--v', shown + '%');
    $('#volNum').textContent = settings.muted ? 'OFF' : String(v);
    volRange.setAttribute('aria-valuetext', settings.muted ? 'muet' : v + ' %');
    $('#vol').classList.toggle('muted', settings.muted || settings.volume === 0);
    const locked = state.engine === AD.spotify;
    $('#vol').classList.toggle('locked', locked);
    $('#vol').title = locked ? 'Le petit lecteur Spotify ne se règle pas d’ici : choisis « Complet » dans Réglages' : 'Volume ' + v + ' % (molette pour régler)';
  }
  let volWarned = 0;
  function onVolumeChange() {
    if (state.engine === AD.spotify && Date.now() - volWarned > 15000) {
      volWarned = Date.now();
      toast('Le petit lecteur Spotify ne se règle pas d’ici : choisis « Complet » dans Réglages (ou utilise le volume du PC)', 'info', 7000);
    }
  }
  volRange.addEventListener('input', () => {
    settings.volume = Number(volRange.value) / 100;
    settings.muted = false;
    applyVolume();
    onVolumeChange();
    save();
  });
  /* molette de la souris sur le volume */
  $('#vol').addEventListener('wheel', (e) => {
    e.preventDefault();
    settings.volume = clamp(Math.round((settings.volume + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100, 0, 1);
    settings.muted = false;
    applyVolume();
    onVolumeChange();
    save();
  }, { passive: false });
  function toggleMute() { settings.muted = !settings.muted; applyVolume(); onVolumeChange(); save(); }
  $('#btnMute').addEventListener('click', toggleMute);

  /* ----- connexion Spotify Premium ----- */
  function openPremium() {
    $('#premRedirect').textContent = AD.spAuth.redirectUri();
    $('#premClient').value = AD.spAuth.clientId;
    premMsg('');
    if (!AD.spAuth.canLogin()) premMsg('Ouvre AquaDisc avec LANCER.bat (adresse http://127.0.0.1:5177) pour pouvoir te connecter.', 'warn');
    openModal('winPremium');
    setTimeout(() => $('#premClient').focus(), 80);
  }
  function premMsg(text, type) {
    const m = $('#premMsg');
    m.hidden = !text;
    m.textContent = text || '';
    m.className = 'sp-msg' + (type ? ' ' + type : '');
  }
  async function premGo() {
    try {
      premMsg('Redirection vers Spotify…');
      await AD.spAuth.login($('#premClient').value);
    } catch (e) {
      premMsg(e.message || 'Connexion impossible', 'err');
    }
  }
  $('#premGo').addEventListener('click', premGo);
  $('#premClient').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); premGo(); } });
  $('#premCopy').addEventListener('click', async () => {
    const t = $('#premRedirect').textContent;
    try { await navigator.clipboard.writeText(t); toast('Adresse copiée', 'ok', 1500); } catch (e) {
      const r = document.createRange(); r.selectNodeContents($('#premRedirect'));
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      toast('Sélectionnée : fais Ctrl+C', 'info', 2000);
    }
  });
  $('#setPremBtn').addEventListener('click', () => {
    if (AD.spAuth.connected) {
      const d = disc();
      const was = state.playing, i = state.track;
      if (state.engine === AD.sdk) stop();
      AD.sdk.disconnect();
      AD.spAuth.logout();
      myPlCache = null;
      renderSettings(); renderPanel(); renderBadges();
      toast('Compte Spotify déconnecté', 'ok');
      if (d && d.kind === 'spotify' && was && i >= 0) playTrack(i, true);
    } else {
      openPremium();
    }
  });

  /* réglages */
  function renderSettings() {
    const btn = $('#setPremBtn');
    if (AD.spAuth.connected) {
      btn.textContent = 'Déconnecter';
      $('#setPremTxt').textContent = AD.sdk.disabled
        ? 'Connecté, mais Spotify refuse la lecture complète (compte non Premium ou navigateur incompatible).'
        : `Connecté${AD.spAuth.name ? ' : ' + AD.spAuth.name : ''}. Titres complets et volume réglable.`;
    } else {
      btn.textContent = 'Connecter';
      $('#setPremTxt').textContent = 'Titres complets et volume réglable pour tes disques Spotify (compte Premium).';
    }
    $$('#setSpMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.spSource));
    $('#setSfx').classList.toggle('on', settings.sfx);
    $('#setSfx').setAttribute('aria-checked', String(settings.sfx));
    $('#setCrt').classList.toggle('on', settings.crt);
    $('#setCrt').setAttribute('aria-checked', String(settings.crt));
  }
  $$('#setSpMode button').forEach((b) => b.addEventListener('click', () => {
    if (settings.spSource === b.dataset.v) return;
    settings.spSource = b.dataset.v;
    if (b.dataset.v === 'embed' && AD.spotify.available === false) AD.spotify.available = null;
    if (b.dataset.v === 'auto' && AD.yt.available === false) AD.yt.available = null;
    save();
    renderSettings();
    const d = disc();
    if (d && d.kind === 'spotify') {
      const was = state.playing, i = state.track;
      stop();
      if (state.engine) state.engine.unload();
      state.engine = null;
      renderPanel();
      if (was && i >= 0) playTrack(i, true);
    }
    renderBadges();
    applyVolume();
  }));
  $('#setSfx').addEventListener('click', () => { settings.sfx = !settings.sfx; AD.Sfx.enabled = settings.sfx; save(); renderSettings(); });
  $('#setCrt').addEventListener('click', () => { settings.crt = !settings.crt; app.classList.toggle('no-crt', !settings.crt); save(); renderSettings(); });

  /* clavier */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!menu.hidden) closeMenu();
      else if (state.modal) { if (state.modal === 'winAsk') answer(false); else closeModal(); }
      else if (rack.classList.contains('open')) closeRack();
      else if (panel.classList.contains('open')) closePanel();
      return;
    }
    if (!state.booted) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(); }
      return;
    }
    if (state.modal || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const onButton = e.target && e.target.closest && e.target.closest('button, a, [role="button"]');
    if (onButton && (e.key === ' ' || e.key === 'Enter')) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': e.preventDefault(); next(false); break;
      case 'ArrowLeft': e.preventDefault(); prev(); break;
      case 'ArrowUp': e.preventDefault(); stepDisc(-1); break;
      case 'ArrowDown': e.preventDefault(); stepDisc(1); break;
      case 'd': case 'D': toggleRack(); break;
      case 'l': case 'L': togglePanel(); break;
      case 'm': case 'M': toggleMute(); break;
      default: break;
    }
  });

  /* fermer en cliquant ailleurs */
  document.addEventListener('pointerdown', (e) => {
    const t = e.target;
    if (!menu.hidden && !menu.contains(t) && !t.closest('.case-more')) closeMenu();
    if (state.modal) return;
    if (rack.classList.contains('open') && !rack.contains(t) && !t.closest('#btnDiscs') && !t.closest('.menu')) closeRack();
    if (panel.classList.contains('open') && !panel.contains(t) && !t.closest('#btnList') && !t.closest('.deck') && !t.closest('.menu') && !t.closest('.disc-hit')) closePanel();
  });
  window.addEventListener('resize', () => { closeMenu(); measureBar(); setMarquee(mq.text || '', true); });
  $('#rackList').addEventListener('scroll', closeMenu, { passive: true });

  /* barre multimédia du système */
  function mediaMeta() {
    if (!('mediaSession' in navigator)) return;
    const d = disc();
    const t = d && d.tracks[state.track];
    try {
      if (!t) { navigator.mediaSession.metadata = null; return; }
      const art = covers.get(d.id);
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist || '', album: d.name, artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
    } catch (e) { /* ignore */ }
  }
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch (e) { /* non supporté */ } };
    set('play', () => { if (!state.playing) togglePlay(); });
    set('pause', () => { if (state.playing) togglePlay(); });
    set('previoustrack', () => prev());
    set('nexttrack', () => next(false));
    set('stop', () => stop());
    set('seekto', (d) => { if (state.engine && d && typeof d.seekTime === 'number') state.engine.seek(d.seekTime); });
  }

  /* hauteur de la console (pour placer les notifications) */
  const deck = $('#deck');
  if ('ResizeObserver' in window) new ResizeObserver(() => document.documentElement.style.setProperty('--deck-h', deck.offsetHeight + 'px')).observe(deck);

  /* =========================================================
     Démarrage
     ========================================================= */
  let readyP = null;
  async function init() {
    scene = AD.scene = new AD.Scene();
    app.classList.toggle('no-crt', !settings.crt);
    AD.Sfx.enabled = settings.sfx;
    applyVolume();
    renderBadges();
    renderHUD();
    setMarquee('✦ AQUADISC ✦');
    const note = $('#splashNote');
    try {
      const all = await AD.db.allDiscs();
      state.discs = (all || []).filter((d) => d && d.id && Array.isArray(d.tracks));
      sortDiscs();
      await Promise.all(state.discs.map(coverOf));
      note.textContent = state.discs.length ? `${plural(state.discs.length, 'disque', 'disques')} dans ta discothèque` : '';
    } catch (e) {
      console.error(e);
      note.textContent = 'Stockage indisponible (navigation privée ?) : les disques ne seront pas gardés.';
    }
    // retour de la page de connexion Spotify
    try {
      const res = await AD.spAuth.handleRedirect();
      if (res && res.ok) {
        note.textContent = `Spotify Premium connecté${AD.spAuth.name ? ' : ' + AD.spAuth.name : ''} ✓`;
        state.authNote = { msg: 'Spotify connecté : titres complets et volume réglable ✓', type: 'ok' };
      } else if (res && res.error) {
        note.textContent = res.error;
        state.authNote = { msg: res.error, type: 'err' };
      }
    } catch (e) { console.error(e); }
    renderRack();
    renderPanel();
    renderSettings();
    updateNav();
    checkServer();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measureBar(); setMarquee(mq.text || '', true); });
  }
  async function start() {
    if (state.booted) return;
    state.booted = true;
    AD.audio.unlock();
    await readyP;
    AD.Sfx.chime();
    $('#splash').classList.add('out');
    app.classList.remove('booting');
    setTimeout(() => { const s = $('#splash'); if (s) s.remove(); }, 1200);
    await AD.wait(380);
    if (state.authNote) { toast(state.authNote.msg, state.authNote.type, 6000); state.authNote = null; }
    if (state.discs.length) {
      const idx = Math.max(0, state.discs.findIndex((d) => d.id === settings.lastDisc));
      switchDisc(idx, 1, { autoplay: false, force: true });
    } else {
      showEmpty();
    }
  }
  $('#splashStart').addEventListener('click', start);
  $('#splash').addEventListener('click', (e) => { if (e.target.id === 'splash' || e.target.closest('.splash-inner')) start(); });

  AD.onFrame(tick);
  readyP = init();

  // accès pour le débogage dans la console
  AD.app = { state, settings, switchDisc, playTrack, stageFiles, openImport, readTracks };
})();
