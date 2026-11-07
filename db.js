/* AquaDisc — stockage (IndexedDB) : les disques et les fichiers audio restent dans le navigateur */
(function () {
  'use strict';
  const AD = window.AD;
  const NAME = 'aquadisc';
  const VERSION = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('Ce navigateur ne permet pas de stocker des disques.'));
      let r;
      try { r = indexedDB.open(NAME, VERSION); } catch (e) { return reject(e); }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('discs')) db.createObjectStore('discs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      r.onerror = () => reject(r.error || new Error('Impossible d’ouvrir le stockage.'));
      r.onblocked = () => reject(new Error('Stockage bloqué : ferme les autres onglets AquaDisc.'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }

  async function run(store, mode, op) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(store, mode); } catch (e) { return reject(e); }
      let req;
      try { req = op(t.objectStore(store)); } catch (e) { return reject(e); }
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      t.onerror = () => reject(t.error || (req && req.error));
      t.onabort = () => reject(t.error || new Error('Opération annulée'));
    });
  }

  AD.db = {
    open,
    allDiscs: () => run('discs', 'readonly', (s) => s.getAll()),
    putDisc: (d) => run('discs', 'readwrite', (s) => s.put(d)),
    deleteDisc: (id) => run('discs', 'readwrite', (s) => s.delete(id)),
    putBlob: (key, blob) => run('blobs', 'readwrite', (s) => s.put(blob, key)),
    getBlob: (key) => run('blobs', 'readonly', (s) => s.get(key)),
    deleteBlobs: (keys) => run('blobs', 'readwrite', (s) => { keys.filter(Boolean).forEach((k) => s.delete(k)); return null; }),
    async estimate() {
      try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; }
    },
    async persist() {
      try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* rien */ }
      return false;
    },
  };
})();
