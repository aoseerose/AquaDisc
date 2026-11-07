/* AquaDisc — fabrication des disques (étiquette imprimée ou CD-R écrit au marqueur) */
(function () {
  'use strict';
  const AD = window.AD;
  const { h, esc } = AD;

  const STYLES = ['silver', 'gold', 'white', 'black', 'blue', 'pink', 'silver', 'white'];
  const INKS = {
    silver: ['#16206e', '#111318', '#b0122f'],
    gold: ['#14110c', '#3b0f0f'],
    white: ['#111318', '#c4122f', '#1440a8'],
    black: ['#f4f4f4', '#e9d27a'],
    blue: ['#ffffff', '#ffe970'],
    pink: ['#1d1452', '#111318'],
  };

  /* donne à chaque disque un « look » stable (choisi une fois pour toutes) */
  AD.makeLook = function (seed) {
    const x = AD.hash(seed);
    const style = STYLES[x % STYLES.length];
    const inks = INKS[style];
    return { style, ink: inks[(x >>> 4) % inks.length], rot: ((x >>> 8) % 11) - 7 };
  };

  AD.discTotal = (disc) => (disc && disc.tracks ? disc.tracks.reduce((s, t) => s + (t.duration || 0), 0) : 0);

  function splitName(name) {
    const s = String(name || '').trim() || 'Sans titre';
    if (s.length <= 13) return [s];
    const words = s.split(/\s+/);
    if (words.length === 1) return [s.length > 22 ? s.slice(0, 21) + '…' : s];
    let best = [s], bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      const diff = Math.abs(a.length - b.length);
      if (diff < bestDiff) { bestDiff = diff; best = [a, b]; }
    }
    return best.map((l) => (l.length > 22 ? l.slice(0, 21) + '…' : l));
  }

  function microText(base, n) {
    let s = '';
    while (s.length < n) s += base;
    return s.slice(0, n);
  }

  function printSVG(disc, look, pressed, id, empty) {
    const n = disc.tracks ? disc.tracks.length : 0;
    const total = AD.fmt(AD.discTotal(disc));
    let s = `<svg class="f-print" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>` +
      `<path id="${id}o" d="M100,100 m-87,0 a87,87 0 1,1 174,0 a87,87 0 1,1 -174,0"/>` +
      `<path id="${id}i" d="M100,100 m-31.6,0 a31.6,31.6 0 1,1 63.2,0 a31.6,31.6 0 1,1 -63.2,0"/></defs>`;
    const tag = pressed ? (disc.kind === 'spotify' ? 'SPOTIFY STREAM' : 'DIGITAL AUDIO') : 'CD-R 80 MIN 700 MB';
    const micro = microText(`${tag} ✦ ${n} ${n > 1 ? 'TRACKS' : 'TRACK'} ✦ ${total} ✦ AQUADISC ✦ `, 46);
    s += `<text class="micro" font-size="3.3" letter-spacing=".45"><textPath href="#${id}i">${esc(micro)}</textPath></text>`;
    if (!pressed) {
      const lines = empty ? ['INSÈRE', 'UN DISQUE'] : splitName(disc.name);
      const longest = Math.max(...lines.map((l) => l.length));
      const fs = Math.max(11, Math.min(lines.length > 1 ? 21 : 27, 158 / (longest * 0.58)));
      const ys = lines.length > 1 ? [44, 44 + fs * 0.98] : [60];
      s += `<g class="marker" fill="${look.ink}" transform="rotate(${look.rot} 100 100)">`;
      lines.forEach((ln, i) => { s += `<text x="100" y="${ys[i].toFixed(1)}" text-anchor="middle" font-size="${fs.toFixed(1)}">${esc(ln)}</text>`; });
      if (empty) {
        s += `<text x="100" y="152" text-anchor="middle" font-size="10.5">glisse tes sons ici ✦</text>`;
      } else {
        const d = new Date(disc.createdAt || Date.now());
        const date = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
        s += `<text x="100" y="149" text-anchor="middle" font-size="10.5">${n} ${n > 1 ? 'titres' : 'titre'} · ${total}</text>`;
        s += `<text x="100" y="165" text-anchor="middle" font-size="8">${date}</text>`;
      }
      s += `</g>`;
      s += `<text class="brand" font-size="5.6" letter-spacing="1.1"><textPath href="#${id}o">${esc(microText('AQUA·R ✦ RECORDABLE ✦ 80 MIN / 700 MB ✦ 1× – 52× ✦ ', 64))}</textPath></text>`;
    }
    return s + '</svg>';
  }

  function front(disc, coverUrl, id, empty) {
    const look = disc.look || AD.makeLook(disc.id || 'x');
    const pressed = !!coverUrl;
    const f = h('div', { class: `face front ${pressed ? 'pressed' : 'cdr'} st-${look.style}` });
    f.append(h('div', { class: 'f-mirror' }));
    const label = h('div', { class: 'f-label' });
    if (pressed) label.style.backgroundImage = `url("${coverUrl}")`;
    f.append(label);
    f.insertAdjacentHTML('beforeend', printSVG(disc, look, pressed, id, empty));
    f.append(h('div', { class: 'f-hub' }));
    return f;
  }

  function back(disc, coverUrl) {
    const look = disc.look || AD.makeLook(disc.id || 'x');
    const f = h('div', { class: `face back ${coverUrl ? 'pressed' : 'cdr'} st-${look.style}` });
    f.append(h('div', { class: 'b-data' }), h('div', { class: 'f-hub' }));
    return f;
  }

  let n = 0;
  AD.DiscView = class DiscView {
    constructor(parent) {
      this.id = 'dv' + (++n);
      this.root = h('div', { class: 'disc-root' });
      this.spinner = h('div', { class: 'spinner' });
      this.root.append(this.spinner, h('div', { class: 'sheen sheen-front' }), h('div', { class: 'sheen sheen-back' }));
      this.root.style.visibility = 'hidden';
      parent.appendChild(this.root);
    }
    set(disc, coverUrl, empty) {
      this.spinner.textContent = '';
      if (!disc) return;
      this.root.classList.toggle('is-pressed', !!coverUrl);
      this.spinner.append(front(disc, coverUrl, this.id + 'p' + (++n), empty), back(disc, coverUrl));
    }
  };

  /* petit disque 2D (miniatures) */
  AD.miniDisc = function (disc, coverUrl, cls) {
    const look = disc.look || AD.makeLook(disc.id || 'x');
    const el = h('div', { class: 'mini-disc ' + (cls || '') });
    el.append(front(disc, coverUrl, 'md' + (++n), false));
    el.firstChild.classList.add('flat');
    el.dataset.style = look.style;
    return el;
  };

  /* fausse pochette pour les disques sans image (papier + marqueur) */
  AD.paperCover = function (disc) {
    const look = disc.look || AD.makeLook(disc.id || 'x');
    const lines = splitName(disc.name);
    const paper = h('div', { class: 'paper' });
    const hue = AD.hash(disc.id) % 360;
    paper.style.setProperty('--paper-h', hue);
    const ink = look.style === 'black' || look.style === 'blue' ? '#111318' : look.ink;
    paper.innerHTML = `<span class="p-lines" style="color:${ink};transform:rotate(${look.rot * 0.6}deg)">${lines.map(esc).join('<br>')}</span>`;
    return paper;
  };

  AD.emptyDisc = { id: 'empty-disc', name: 'INSÈRE UN DISQUE', tracks: [], kind: 'empty', look: { style: 'silver', ink: '#16206e', rot: -6 } };
})();
