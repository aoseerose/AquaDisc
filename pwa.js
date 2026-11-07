/* AquaDisc — transforme le site en application installable (PC, Android, iPhone) */
(function () {
  'use strict';
  const head = document.head;
  const add = (tag, attrs) => {
    const el = document.createElement(tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    head.appendChild(el);
  };
  if (!document.querySelector('link[rel="manifest"]')) add('link', { rel: 'manifest', href: 'manifest.webmanifest' });
  if (!document.querySelector('link[rel="apple-touch-icon"]')) add('link', { rel: 'apple-touch-icon', href: 'apple-touch-icon.png' });
  if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
    add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
    add('meta', { name: 'apple-mobile-web-app-title', content: 'AquaDisc' });
    add('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' });
  }

  const secure = location.protocol === 'https:' || /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
  if ('serviceWorker' in navigator && secure) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Mode hors ligne indisponible', e));
    });
  }

  /* bouton « Installer l'app » dans les Réglages */
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let promptEvt = null;

  function row() {
    const body = document.querySelector('#winSettings .win-body');
    if (!body || standalone) return null;
    let r = document.getElementById('setInstall');
    if (!r) {
      r = document.createElement('div');
      r.className = 'set-row';
      r.id = 'setInstall';
      r.innerHTML = '<div><b>Application</b><small></small></div>';
      body.insertBefore(r, body.firstChild);
    }
    return r;
  }

  function showInstall() {
    const r = row();
    if (!r) return;
    r.querySelector('small').textContent = 'Installe AquaDisc comme une vraie app : icône sur ton bureau ou ton écran d’accueil, sa propre fenêtre.';
    if (!r.querySelector('button')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-sp';
      b.textContent = 'Installer';
      b.addEventListener('click', async () => {
        if (!promptEvt) return;
        promptEvt.prompt();
        try { await promptEvt.userChoice; } catch (e) { promptEvt = null; }
        promptEvt = null;
        r.remove();
      });
      r.appendChild(b);
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    promptEvt = e;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showInstall);
    else showInstall();
  });
  window.addEventListener('appinstalled', () => {
    const r = document.getElementById('setInstall');
    if (r) r.remove();
  });

  if (ios && !standalone) {
    document.addEventListener('DOMContentLoaded', () => {
      const r = row();
      if (r) r.querySelector('small').textContent = 'Sur iPhone : touche Partager puis « Sur l’écran d’accueil » pour installer AquaDisc.';
    });
  }
})();
