/* AquaDisc — lecture des tags audio (ID3v2, FLAC, MP4/M4A, Ogg) sans librairie */
(function () {
  'use strict';
  const AD = window.AD;

  const AUDIO_EXT = /\.(mp3|m4a|mp4|aac|flac|wav|wave|ogg|oga|opus|webm|weba|aif|aiff)$/i;
  AD.isAudioFile = (f) => !!f && (AUDIO_EXT.test(f.name || '') || /^audio\//.test(f.type || ''));

  async function bytes(file, start, len) {
    if (start >= file.size) return new Uint8Array(0);
    return new Uint8Array(await file.slice(start, Math.min(file.size, start + len)).arrayBuffer());
  }
  const latin = (b, s, e) => { let o = ''; for (let i = s; i < e && i < b.length; i++) o += String.fromCharCode(b[i]); return o; };
  const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const u32le = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  const syncsafe = (b, p) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

  const decoders = {};
  function dec(label, buf) {
    try {
      if (!decoders[label]) decoders[label] = new TextDecoder(label);
      return decoders[label].decode(buf);
    } catch (e) { return ''; }
  }
  const clean = (s) => String(s || '').replace(/\u0000+$/g, '').split('\u0000').filter(Boolean).join(', ').trim();

  function sniffImage(d) {
    if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
    if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
    if (d[0] === 0x47 && d[1] === 0x49) return 'image/gif';
    if (d[0] === 0x52 && d[1] === 0x49 && d[8] === 0x57) return 'image/webp';
    return null;
  }
  function pictureBlob(data, mime) {
    if (!data || data.length < 64) return null;
    const type = sniffImage(data) || (mime && /^image\//.test(mime) ? mime.replace('image/jpg', 'image/jpeg') : null);
    if (!type) return null;
    return new Blob([data.slice()], { type });
  }

  /* ---------- ID3v2 ---------- */
  function unsync(b) {
    const out = new Uint8Array(b.length);
    let j = 0;
    for (let i = 0; i < b.length; i++) {
      out[j++] = b[i];
      if (b[i] === 0xff && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
  }
  function id3Text(d) {
    if (!d.length) return '';
    const enc = d[0];
    const body = d.subarray(1);
    if (enc === 0) return clean(dec('iso-8859-1', body));
    if (enc === 3) return clean(dec('utf-8', body));
    if (enc === 1) {
      if (body[0] === 0xfe && body[1] === 0xff) return clean(dec('utf-16be', body.subarray(2)));
      if (body[0] === 0xff && body[1] === 0xfe) return clean(dec('utf-16le', body.subarray(2)));
      return clean(dec('utf-16le', body));
    }
    if (enc === 2) return clean(dec('utf-16be', body));
    return clean(dec('iso-8859-1', body));
  }
  function skipTerm(d, p, enc) {
    if (enc === 1 || enc === 2) {
      while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2;
      return p + 2;
    }
    while (p < d.length && d[p] !== 0) p++;
    return p + 1;
  }
  function id3Picture(d, v2) {
    const enc = d[0];
    let p = 1, mime = '';
    if (v2) { mime = 'image/' + latin(d, 1, 4).toLowerCase(); p = 4; } else {
      const s = p; while (p < d.length && d[p] !== 0) p++;
      mime = latin(d, s, p).toLowerCase(); p++;
    }
    const picType = d[p]; p++;
    p = skipTerm(d, p, enc);
    return { type: picType, blob: pictureBlob(d.subarray(p), mime) };
  }

  async function parseID3(file, head, out) {
    const ver = head[3];
    const flags = head[5];
    const size = syncsafe(head, 6);
    if (ver < 2 || ver > 4 || !size) return;
    let buf = await bytes(file, 10, Math.min(size, 40 * 1024 * 1024));
    if ((flags & 0x80) && ver < 4) buf = unsync(buf);
    let p = 0;
    if (flags & 0x40) p = ver === 3 ? 4 + u32(buf, 0) : syncsafe(buf, 0);
    const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
    let pic = null;
    while (p + hdr <= buf.length) {
      const id = latin(buf, p, p + idLen);
      if (!/^[A-Z0-9]+$/.test(id)) break;
      const fsize = ver === 2 ? ((buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5]) : ver === 4 ? syncsafe(buf, p + 4) : u32(buf, p + 4);
      const ff = ver >= 3 ? ((buf[p + 8] << 8) | buf[p + 9]) : 0;
      const start = p + hdr, end = start + fsize;
      if (fsize <= 0 || end > buf.length) break;
      p = end;
      let d = buf.subarray(start, end);
      if (ver === 3) {
        if (ff & 0x00c0) continue; // compressé / chiffré
        if (ff & 0x0020) d = d.subarray(1);
      } else if (ver === 4) {
        if (ff & 0x000c) continue;
        if (ff & 0x0040) d = d.subarray(1);
        if (ff & 0x0001) d = d.subarray(4);
        if (ff & 0x0002) d = unsync(d);
      }
      switch (id) {
        case 'TIT2': case 'TT2': out.title = out.title || id3Text(d); break;
        case 'TPE1': case 'TP1': out.artist = out.artist || id3Text(d); break;
        case 'TPE2': case 'TP2': out.albumArtist = out.albumArtist || id3Text(d); break;
        case 'TALB': case 'TAL': out.album = out.album || id3Text(d); break;
        case 'TRCK': case 'TRK': out.track = parseInt(id3Text(d), 10) || out.track; break;
        case 'TPOS': case 'TPA': out.disc = parseInt(id3Text(d), 10) || out.disc; break;
        case 'APIC': case 'PIC': {
          try {
            const r = id3Picture(d, id === 'PIC');
            if (r.blob && (!pic || (r.type === 3 && pic.type !== 3))) pic = r;
          } catch (e) { /* image illisible */ }
          break;
        }
        default: break;
      }
    }
    if (pic) out.picture = pic.blob;
  }

  /* ---------- Vorbis comments (FLAC / Ogg) ---------- */
  function b64bytes(s) {
    const bin = atob(s.replace(/\s+/g, ''));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function flacPicture(d) {
    let p = 0;
    const type = u32(d, p); p += 4;
    const ml = u32(d, p); p += 4;
    const mime = latin(d, p, p + ml); p += ml;
    const dl = u32(d, p); p += 4 + dl;
    p += 16;
    const len = u32(d, p); p += 4;
    return { type, blob: pictureBlob(d.subarray(p, p + len), mime) };
  }
  function vorbis(d, p, out) {
    const vlen = u32le(d, p); p += 4 + vlen;
    if (p + 4 > d.length) return;
    const n = u32le(d, p); p += 4;
    for (let i = 0; i < n && i < 500 && p + 4 <= d.length; i++) {
      const len = u32le(d, p); p += 4;
      if (len > d.length - p) break;
      const kv = dec('utf-8', d.subarray(p, p + len)); p += len;
      const eq = kv.indexOf('=');
      if (eq < 1) continue;
      const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1).trim();
      if (k === 'TITLE') out.title = out.title || v;
      else if (k === 'ARTIST') out.artist = out.artist ? out.artist : v;
      else if (k === 'ALBUMARTIST' || k === 'ALBUM ARTIST') out.albumArtist = out.albumArtist || v;
      else if (k === 'ALBUM') out.album = out.album || v;
      else if (k === 'TRACKNUMBER') out.track = parseInt(v, 10) || out.track;
      else if (k === 'DISCNUMBER') out.disc = parseInt(v, 10) || out.disc;
      else if (k === 'METADATA_BLOCK_PICTURE' && !out.picture) {
        try { out.picture = flacPicture(b64bytes(v)).blob; } catch (e) { /* ignore */ }
      }
    }
  }

  async function parseFLAC(file, out) {
    let pos = 4;
    let pic = null;
    for (let i = 0; i < 64; i++) {
      const h = await bytes(file, pos, 4);
      if (h.length < 4) break;
      const last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
      const s = pos + 4;
      if (type === 4) vorbis(await bytes(file, s, len), 0, out);
      else if (type === 6 && (!pic || pic.type !== 3) && len < 30 * 1024 * 1024) {
        try { const r = flacPicture(await bytes(file, s, len)); if (r.blob && (!pic || r.type === 3)) pic = r; } catch (e) { /* ignore */ }
      }
      pos = s + len;
      if (last) break;
    }
    if (pic && !out.picture) out.picture = pic.blob;
  }

  async function parseOGG(file, out) {
    const d = await bytes(file, 0, 512 * 1024);
    const find = (sig) => {
      outer: for (let i = 0; i < d.length - sig.length; i++) {
        for (let j = 0; j < sig.length; j++) if (d[i + j] !== sig.charCodeAt(j)) continue outer;
        return i;
      }
      return -1;
    };
    let i = find('\u0003vorbis');
    if (i >= 0) return vorbis(d, i + 7, out);
    i = find('OpusTags');
    if (i >= 0) return vorbis(d, i + 8, out);
  }

  /* ---------- MP4 / M4A ---------- */
  function atoms(b, start, end, cb) {
    let p = start;
    while (p + 8 <= end) {
      let len = u32(b, p);
      const type = latin(b, p + 4, p + 8);
      let hdr = 8;
      if (len === 1) { len = u32(b, p + 12); hdr = 16; } else if (len === 0) len = end - p;
      if (len < 8 || p + len > end) break;
      if (cb(type, p + hdr, p + len) === false) break;
      p += len;
    }
  }
  function ilst(b, s, e, out) {
    atoms(b, s, e, (type, is, ie) => {
      atoms(b, is, ie, (dt, ds, de) => {
        if (dt !== 'data') return;
        const payload = b.subarray(ds + 8, de);
        const txt = () => dec('utf-8', payload).trim();
        if (type === '©nam') out.title = out.title || txt();
        else if (type === '©ART') out.artist = out.artist || txt();
        else if (type === 'aART') out.albumArtist = out.albumArtist || txt();
        else if (type === '©alb') out.album = out.album || txt();
        else if (type === 'trkn' && payload.length >= 4) out.track = ((payload[2] << 8) | payload[3]) || out.track;
        else if (type === 'disk' && payload.length >= 4) out.disc = ((payload[2] << 8) | payload[3]) || out.disc;
        else if (type === 'covr' && !out.picture) out.picture = pictureBlob(payload, null);
        return false;
      });
    });
  }
  function meta(b, s, e, out) {
    // « meta » est une full box : 4 octets version/flags (parfois absents)
    const off = latin(b, s + 4, s + 8) === 'hdlr' ? 0 : 4;
    atoms(b, s + off, e, (t, cs, ce) => { if (t === 'ilst') ilst(b, cs, ce, out); });
  }
  async function parseMP4(file, out) {
    let pos = 0;
    for (let guard = 0; guard < 200 && pos + 8 <= file.size; guard++) {
      const h = await bytes(file, pos, 16);
      let len = u32(h, 0);
      const type = latin(h, 4, 8);
      let hdr = 8;
      if (len === 1) { len = u32(h, 8) * 4294967296 + u32(h, 12); hdr = 16; } else if (len === 0) len = file.size - pos;
      if (len < 8) break;
      if (type === 'moov') {
        const b = await bytes(file, pos + hdr, Math.min(len - hdr, 60 * 1024 * 1024));
        atoms(b, 0, b.length, (t, s, e) => {
          if (t === 'udta') atoms(b, s, e, (t2, s2, e2) => { if (t2 === 'meta') meta(b, s2, e2, out); });
          else if (t === 'meta') meta(b, s, e, out);
        });
        return;
      }
      pos += len;
    }
  }

  /* ---------- nom de fichier ---------- */
  function fromName(name) {
    let base = String(name || '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    let track;
    const tm = base.match(/^\s*(\d{1,3})\s*[-–._)\]]?\s+(.*)$/);
    if (tm && tm[2]) { track = parseInt(tm[1], 10); base = tm[2]; }
    let artist = '', title = base;
    const parts = base.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) { artist = parts[0].trim(); title = parts.slice(1).join(' - ').trim(); }
    return { title: title || name, artist, track };
  }

  /* ---------- durée ---------- */
  function probe(file) {
    return new Promise((resolve) => {
      const a = new Audio();
      const url = URL.createObjectURL(file);
      let done = false;
      const fin = (ok, d) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.onloadedmetadata = a.onerror = a.ondurationchange = null;
        a.removeAttribute('src');
        try { a.load(); } catch (e) { /* ignore */ }
        URL.revokeObjectURL(url);
        resolve({ ok, duration: isFinite(d) && d > 0 ? d : 0 });
      };
      const timer = setTimeout(() => fin(true, a.duration), 9000);
      a.preload = 'metadata';
      a.onloadedmetadata = () => {
        if (a.duration === Infinity) {
          a.ondurationchange = () => { if (isFinite(a.duration)) fin(true, a.duration); };
          try { a.currentTime = 1e7; } catch (e) { fin(true, 0); }
        } else fin(true, a.duration);
      };
      a.onerror = () => fin(false, 0);
      a.src = url;
    });
  }

  AD.meta = {
    async read(file) {
      const out = {};
      try {
        const head = await bytes(file, 0, 16);
        if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) await parseID3(file, head, out);
        else if (latin(head, 0, 4) === 'fLaC') await parseFLAC(file, out);
        else if (latin(head, 4, 8) === 'ftyp') await parseMP4(file, out);
        else if (latin(head, 0, 4) === 'OggS') await parseOGG(file, out);
      } catch (e) {
        console.warn('Tags illisibles :', file.name, e);
      }
      const fb = fromName(file.name);
      const p = await probe(file);
      return {
        ok: p.ok,
        duration: p.duration,
        title: (out.title || fb.title || file.name).slice(0, 200),
        artist: (out.artist || out.albumArtist || fb.artist || '').slice(0, 200),
        album: (out.album || '').slice(0, 200),
        track: out.track || fb.track || 0,
        disc: out.disc || 0,
        picture: out.picture || null,
      };
    },
  };
})();
