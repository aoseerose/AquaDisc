'use strict';
/*
 *  AquaDisc — petit serveur local (Node 18+, aucune dépendance)
 *  ------------------------------------------------------------
 *  Lance-le avec :  node server.js      (ou double-clique LANCER.bat)
 *  Puis ouvre      :  http://127.0.0.1:5177
 *
 *  Il sert le site (dossier /site) et lit les playlists Spotify publiques
 *  (le navigateur ne peut pas le faire seul à cause des règles CORS).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 5177;
const HOST = '127.0.0.1';
// le site est soit dans /site, soit directement à côté de server.js (version GitHub)
const ROOT = fs.existsSync(path.join(__dirname, 'site', 'index.html')) ? path.join(__dirname, 'site') : __dirname;
const NO_OPEN = process.argv.includes('--no-open');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/* ---------- Spotify ---------- */

function parseRef(input) {
  const s = String(input || '').trim();
  let m = s.match(/^spotify:(playlist|album|track):([A-Za-z0-9]{10,40})$/i);
  if (!m) {
    m = s.match(/open\.spotify\.com\/(?:intl-[a-z]{2,3}(?:-[a-z]{2,4})?\/)?(?:embed\/)?(?:user\/[^/]+\/)?(playlist|album|track)\/([A-Za-z0-9]{10,40})/i);
  }
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

async function resolveShortLink(url) {
  // liens courts spotify.link / spoti.fi → on suit les redirections
  const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(10000) });
  const direct = parseRef(r.url);
  if (direct) return direct;
  const html = await r.text();
  const m = html.match(/https?:\/\/open\.spotify\.com\/[^"'\s<>]+/);
  return m ? parseRef(m[0]) : null;
}

function pickImage(e) {
  const list = [];
  if (e.visualIdentity && Array.isArray(e.visualIdentity.image)) {
    for (const i of e.visualIdentity.image) if (i && i.url) list.push({ url: i.url, w: i.maxWidth || 0 });
  }
  if (e.coverArt && Array.isArray(e.coverArt.sources)) {
    for (const i of e.coverArt.sources) if (i && i.url) list.push({ url: i.url, w: i.width || 1 });
  }
  list.sort((a, b) => b.w - a.w);
  return list.length ? list[0].url : null;
}

function rgb(c) {
  return c && typeof c.red === 'number' ? `rgb(${c.red},${c.green},${c.blue})` : null;
}

function httpError(message, code) {
  const e = new Error(message);
  e.status = code;
  return e;
}

async function fetchSpotify(ref) {
  const url = `https://open.spotify.com/embed/${ref.type}/${ref.id}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(15000),
  });
  if (r.status === 404) throw httpError('Introuvable : vérifie que la playlist est publique.', 404);
  if (!r.ok) throw httpError(`Spotify a répondu ${r.status}. Réessaie dans un instant.`, 502);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw httpError('Réponse Spotify inattendue (le format a peut-être changé).', 502);
  let data;
  try { data = JSON.parse(m[1]); } catch { throw httpError('Réponse Spotify illisible.', 502); }
  const st = data && data.props && data.props.pageProps && data.props.pageProps.state;
  const e = st && st.data && st.data.entity;
  if (!e) throw httpError('Introuvable : la playlist est peut-être privée ou supprimée.', 404);

  const artistsOf = (x) => (Array.isArray(x.artists) ? x.artists.map((a) => a && a.name).filter(Boolean).join(', ') : '');
  let tracks;
  if (ref.type === 'track') {
    tracks = [{
      uri: e.uri,
      title: e.title || e.name || 'Sans titre',
      artist: artistsOf(e),
      duration: e.duration || 0,
      preview: (e.audioPreview && e.audioPreview.url) || null,
      explicit: !!e.isExplicit,
      playable: e.isPlayable !== false,
    }];
  } else {
    tracks = (e.trackList || [])
      .filter((t) => t && t.uri && /^spotify:(track|episode):/.test(t.uri))
      .map((t) => ({
        uri: t.uri,
        title: (t.title || 'Sans titre').trim(),
        artist: (t.subtitle || '').trim(),
        duration: t.duration || 0,
        preview: (t.audioPreview && t.audioPreview.url) || null,
        explicit: !!t.isExplicit,
        playable: t.isPlayable !== false,
      }));
  }
  if (!tracks.length) throw httpError('Cette playlist est vide (ou indisponible dans ton pays).', 404);

  return {
    type: ref.type,
    id: ref.id,
    uri: `spotify:${ref.type}:${ref.id}`,
    url: `https://open.spotify.com/${ref.type}/${ref.id}`,
    name: (e.name || e.title || 'Sans titre').trim(),
    subtitle: ref.type === 'track' ? artistsOf(e) : (e.subtitle || '').trim(),
    cover: pickImage(e),
    color: rgb(e.visualIdentity && e.visualIdentity.backgroundBase),
    tracks,
    truncated: ref.type === 'playlist' && tracks.length >= 100,
  };
}

async function handleSpotify(u, res) {
  try {
    const input = (u.searchParams.get('url') || '').trim();
    let ref = parseRef(input);
    if (!ref && /^https?:\/\/(spotify\.link|spoti\.fi)\//i.test(input)) ref = await resolveShortLink(input);
    if (!ref) return sendJSON(res, 400, { error: 'Lien non reconnu. Colle un lien de playlist, d’album ou de titre Spotify.' });
    const data = await fetchSpotify(ref);
    return sendJSON(res, 200, data);
  } catch (err) {
    let msg = err && err.message ? err.message : 'Erreur inconnue';
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) msg = 'Spotify ne répond pas (délai dépassé). Réessaie.';
    else if (err instanceof TypeError) msg = 'Impossible de joindre Spotify. Vérifie ta connexion internet.';
    const code = err && err.status ? err.status : 502;
    return sendJSON(res, code, { error: msg });
  }
}

/* ---------- YouTube : retrouver le morceau complet ---------- */

const ytCache = new Map();
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const BAD = ['live', 'cover', 'karaoke', 'instrumental', 'remix', 'sped up', 'speed up', 'slowed', 'nightcore', '8d', 'reverb', '1 hour', 'hour', 'loop', 'reaction', 'tutorial', 'piano', 'acoustic', 'mashup', 'bass boosted', 'extended', 'concert', 'session', 'teaser', 'trailer', 'en direct',
  'show', 'tonight show', 'late show', 'performance', 'performs', 'interview', 'parodie', 'parody', 'dance', 'choreography', 'choregraphie', 'tiktok', 'strictly', 'olympics', 'jo', 'emission', 'reportage', 'making of', 'behind the scenes', 'fan made', 'amv', 'guitar', 'drum', 'lesson', 'tuto', 'version francaise', 'traduction',
  'later', 'jools holland', 'colbert', 'fallon', 'kimmel', 'taratata', 'tiny desk', 'npr', 'kexp', 'bbc', 'radio 1', 'live lounge', 'lift', 'sessions', 'unplugged', 'mtv', 'tv', 'snl', 'saturday night', 'grammys', 'awards', 'festival', 'coachella', 'glastonbury', 'tour'];

function parseLen(s) {
  if (!s) return 0;
  return String(s).split(':').reduce((a, x) => a * 60 + (parseInt(x, 10) || 0), 0);
}
function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[([](feat|ft|with)\.?[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mono|stereo|live|mix).*$/i, '')
    .trim();
}

function scoreVideo(v, i, artist, title, dur) {
  const vt = norm(v.title);
  const ch = norm(v.channel);
  const ta = norm(title);
  const tc = norm(cleanTitle(title));
  const fa = norm(String(artist || '').split(',')[0]);
  const topic = / topic$/.test(ch);
  // le titre du morceau doit figurer dans la vidéo (sinon ce n'est pas le bon morceau)
  if (tc && !vt.includes(tc)) return -999;
  // durée trop différente : version raccourcie, extrait, version TV, compilation…
  if (dur > 0 && v.len > 0) {
    if (v.len < dur - Math.max(12, dur * 0.08)) return -999;
    if (v.len > dur + Math.max(30, dur * 0.3)) return -999;
  }
  let s = (10 - i) * 0.6;
  if (dur > 0 && v.len > 0) {
    const d = Math.abs(v.len - dur);
    s -= d * 0.9;
    if (d <= 4) s += 30; else if (d <= 10) s += 12;
  }
  const chanArtist = fa && (ch.includes(fa) || (ch && fa.includes(ch.replace(/ topic$/, '').replace(/vevo$/, '').trim())));
  if (topic) s += 22;
  if (chanArtist) s += 15;
  if (tc) s += 14;
  if (fa && vt.includes(fa)) s += 6;
  if (fa && !vt.includes(fa) && !chanArtist) s -= 60; // l'artiste n'apparaît nulle part
  if (/official audio|audio officiel|\baudio\b/.test(vt)) s += 6;
  // versions live / TV / reprises : on les écarte (on cherche aussi dans le nom de la chaîne)
  const hay = vt + ' | ' + ch;
  for (const w of BAD) {
    if (new RegExp('\\b' + w + '\\b').test(hay) && !ta.includes(w) && !norm(artist).includes(w)) s -= 100;
  }
  return s;
}

/* beaucoup de vidéos musicales sont bloquées hors de YouTube par les maisons de disques
   (erreur 150 dans le lecteur) : on vérifie chaque candidate sur sa page « embed » */
const embedCache = new Map();
async function embeddable(id) {
  if (embedCache.has(id)) return embedCache.get(id);
  try {
    const r = await fetch(`https://www.youtube.com/embed/${id}`, {
      headers: { 'User-Agent': UA, Referer: `http://${HOST}:${PORT}/`, 'Accept-Language': 'fr-FR,fr;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+cb' },
      signal: AbortSignal.timeout(9000),
    });
    const t = await r.text();
    const ok = r.ok && !/UNPLAYABLE|errorScreen/.test(t) && /playableInEmbed/.test(t);
    embedCache.set(id, ok);
    if (embedCache.size > 5000) embedCache.delete(embedCache.keys().next().value);
    return ok;
  } catch {
    return null; // inconnu (réseau) : on la garde en dernier recours
  }
}

async function searchYouTube(artist, title, dur) {
  const key = norm(artist) + '|' + norm(title) + '|' + Math.round(dur / 5);
  if (ytCache.has(key)) return ytCache.get(key);
  const base = `${String(artist || '').split(',')[0]} ${cleanTitle(title)}`.trim();
  const good = [], unknown = [], seen = new Set();
  for (const q of [base, base + ' lyrics', base + ' official audio', base + ' paroles', base + ' audio']) {
    let list;
    try { list = await searchOnce(q, artist, title, dur); } catch (e) { if (q === base) throw e; continue; }
    const fresh = list.filter((v) => !seen.has(v.id));
    fresh.forEach((v) => seen.add(v.id));
    for (let i = 0; i < fresh.length && good.length < 4; i += 6) {
      const batch = fresh.slice(i, i + 6);
      const ok = await Promise.all(batch.map((v) => embeddable(v.id)));
      batch.forEach((v, k) => { if (ok[k] === true) good.push(v); else if (ok[k] === null) unknown.push(v); });
    }
    if (good.length >= 2) break;
  }
  const results = good.sort((a, b) => b.score - a.score).concat(unknown).slice(0, 6)
    .map(({ id, title: t, channel, len }) => ({ id, title: t, channel, len }));
  if (results.length) {
    ytCache.set(key, results);
    if (ytCache.size > 2000) ytCache.delete(ytCache.keys().next().value);
  }
  return results;
}

async function searchOnce(q, artist, title, dur) {
  const get = () => fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&hl=fr&gl=FR', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8', Cookie: 'SOCS=CAI; CONSENT=YES+cb' },
    signal: AbortSignal.timeout(12000),
  });
  const extract = (html) => {
    const m = html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/) || html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});\s*(?:window|<\/script>)/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  let data = null;
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    if (attempt) await new Promise((ok) => setTimeout(ok, 500 * attempt));
    let r;
    try { r = await get(); } catch (e) { if (attempt === 2) throw e; continue; }
    if (!r.ok) { if (attempt === 2) throw httpError(`YouTube a répondu ${r.status}.`, 502); continue; }
    data = extract(await r.text());
  }
  if (!data) throw httpError('Réponse YouTube inattendue.', 502);
  const vids = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 40 || vids.length >= 20) return;
    if (o.videoRenderer && o.videoRenderer.videoId) {
      const v = o.videoRenderer;
      const runs = (x) => (x && x.runs && x.runs[0] && x.runs[0].text) || (x && x.simpleText) || '';
      if (!v.badges || !JSON.stringify(v.badges).includes('LIVE')) {
        vids.push({ id: v.videoId, title: runs(v.title), channel: runs(v.ownerText) || runs(v.longBylineText), len: parseLen(v.lengthText && v.lengthText.simpleText) });
      }
      return;
    }
    for (const k in o) walk(o[k], depth + 1);
  })(data, 0);
  return vids
    .filter((v) => v.len > 0)
    .map((v, i) => ({ ...v, score: scoreVideo(v, i, artist, title, dur) }))
    .filter((v) => v.score > -30)
    .sort((a, b) => b.score - a.score)
    .slice(0, 18);
}

async function handleYouTube(u, res) {
  try {
    const artist = (u.searchParams.get('artist') || '').slice(0, 200);
    const title = (u.searchParams.get('title') || '').slice(0, 200);
    const dur = Number(u.searchParams.get('dur')) || 0;
    if (!title) return sendJSON(res, 400, { error: 'Titre manquant.' });
    const results = await searchYouTube(artist, title, dur);
    if (!results.length) return sendJSON(res, 404, { error: 'Introuvable sur YouTube.' });
    return sendJSON(res, 200, { results });
  } catch (err) {
    let msg = err && err.message ? err.message : 'Erreur inconnue';
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) msg = 'YouTube ne répond pas (délai dépassé).';
    else if (err instanceof TypeError) msg = 'Impossible de joindre YouTube. Vérifie ta connexion internet.';
    return sendJSON(res, err && err.status ? err.status : 502, { error: msg });
  }
}

/* ---------- fichiers statiques ---------- */

function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — introuvable');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- serveur ---------- */

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, `http://${HOST}:${PORT}`); } catch { res.writeHead(400); return res.end(); }
  if (u.pathname === '/api/ping') return sendJSON(res, 200, { ok: true, app: 'aquadisc', v: 2 });
  if (u.pathname === '/api/spotify') return void handleSpotify(u, res);
  if (u.pathname === '/api/yt') return void handleYouTube(u, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, u.pathname);
});

function openBrowser() {
  if (NO_OPEN) return;
  const url = `http://${HOST}:${PORT}/`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  AquaDisc tourne déjà → http://${HOST}:${PORT}\n`);
    openBrowser();
    setTimeout(() => process.exit(0), 800);
  } else {
    console.error(err);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('   ╭──────────────────────────────────────────╮');
  console.log('   │   A Q U A D I S C   ·   lecteur de CD     │');
  console.log('   ╰──────────────────────────────────────────╯');
  console.log(`   → ouvert sur  http://${HOST}:${PORT}`);
  console.log('   (laisse cette fenêtre ouverte, ferme-la pour arrêter)');
  console.log('');
  openBrowser();
});
