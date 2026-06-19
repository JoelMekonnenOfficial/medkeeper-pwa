/* MedKeeper IndexedDB Promise wrapper.
 * Three object stores:
 *   - medications: { id, name, dose, unit, color, shape, prescriber,
 *                    startDate, endDate, supply, perDose, notes,
 *                    schedule: { type, ... }, missed: { rule, asapHours },
 *                    createdAt, updatedAt }
 *   - logs:        { id, medId, scheduledAt, takenAt, status, note }
 *   - settings:    { key, value }
 */
(function () {
  'use strict';

  const DB_NAME = 'medkeeper';
  const DB_VERSION = 1;
  const STORE_MEDS = 'medications';
  const STORE_LOGS = 'logs';
  const STORE_SETT = 'settings';

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MEDS)) {
          const s = db.createObjectStore(STORE_MEDS, { keyPath: 'id' });
          s.createIndex('byName', 'name', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_LOGS)) {
          const s = db.createObjectStore(STORE_LOGS, { keyPath: 'id' });
          s.createIndex('byMed', 'medId', { unique: false });
          s.createIndex('byScheduled', 'scheduledAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SETT)) {
          db.createObjectStore(STORE_SETT, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('Database is blocked by another tab'));
    });
    return dbPromise;
  }

  function tx(storeNames, mode) {
    return open().then((db) => db.transaction(storeNames, mode));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IDB request failed'));
    });
  }

  function uid() {
    if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Medications
  async function putMed(m) {
    if (!m.id) m.id = uid();
    m.updatedAt = Date.now();
    if (!m.createdAt) m.createdAt = m.updatedAt;
    const t = await tx(STORE_MEDS, 'readwrite');
    await reqToPromise(t.objectStore(STORE_MEDS).put(m));
    return m;
  }
  async function getMed(id) {
    const t = await tx(STORE_MEDS, 'readonly');
    return reqToPromise(t.objectStore(STORE_MEDS).get(id));
  }
  async function allMeds() {
    const t = await tx(STORE_MEDS, 'readonly');
    return reqToPromise(t.objectStore(STORE_MEDS).getAll());
  }
  async function deleteMed(id) {
    const t = await tx([STORE_MEDS, STORE_LOGS], 'readwrite');
    await reqToPromise(t.objectStore(STORE_MEDS).delete(id));
    // Also delete logs for this med
    const idx = t.objectStore(STORE_LOGS).index('byMed');
    await new Promise((resolve, reject) => {
      const c = idx.openCursor(IDBKeyRange.only(id));
      c.onsuccess = () => {
        const cur = c.result;
        if (cur) { cur.delete(); cur.continue(); } else resolve();
      };
      c.onerror = () => reject(c.error);
    });
    return true;
  }

  // Logs
  async function putLog(l) {
    if (!l.id) l.id = uid();
    const t = await tx(STORE_LOGS, 'readwrite');
    await reqToPromise(t.objectStore(STORE_LOGS).put(l));
    return l;
  }
  async function getLog(id) {
    const t = await tx(STORE_LOGS, 'readonly');
    return reqToPromise(t.objectStore(STORE_LOGS).get(id));
  }
  async function allLogs() {
    const t = await tx(STORE_LOGS, 'readonly');
    return reqToPromise(t.objectStore(STORE_LOGS).getAll());
  }
  async function logsForMed(medId) {
    const t = await tx(STORE_LOGS, 'readonly');
    const idx = t.objectStore(STORE_LOGS).index('byMed');
    return reqToPromise(idx.getAll(IDBKeyRange.only(medId)));
  }
  async function logsBetween(fromTs, toTs) {
    const t = await tx(STORE_LOGS, 'readonly');
    const idx = t.objectStore(STORE_LOGS).index('byScheduled');
    return reqToPromise(idx.getAll(IDBKeyRange.bound(fromTs, toTs)));
  }
  async function deleteLog(id) {
    const t = await tx(STORE_LOGS, 'readwrite');
    await reqToPromise(t.objectStore(STORE_LOGS).delete(id));
    return true;
  }

  // Settings
  const DEFAULTS = {
    meals: { breakfast: '08:00', lunch: '12:30', dinner: '18:30' },
    notifications: false,
    leadMinutes: 0,
    theme: 'auto',
    largeText: false,
    pinHash: null,
    pinSalt: null,
    onboarded: false,
    lastReminderScheduleAt: 0,
  };

  async function getSetting(key) {
    const t = await tx(STORE_SETT, 'readonly');
    const row = await reqToPromise(t.objectStore(STORE_SETT).get(key));
    if (row && 'value' in row) return row.value;
    return key in DEFAULTS ? DEFAULTS[key] : undefined;
  }
  async function setSetting(key, value) {
    const t = await tx(STORE_SETT, 'readwrite');
    await reqToPromise(t.objectStore(STORE_SETT).put({ key, value }));
    return value;
  }
  async function allSettings() {
    const t = await tx(STORE_SETT, 'readonly');
    const rows = await reqToPromise(t.objectStore(STORE_SETT).getAll());
    const out = Object.assign({}, DEFAULTS);
    rows.forEach((r) => { out[r.key] = r.value; });
    return out;
  }

  // Backup
  async function exportAll() {
    const [meds, logs, settings] = await Promise.all([allMeds(), allLogs(), allSettings()]);
    return {
      app: 'MedKeeper',
      version: 1,
      exportedAt: new Date().toISOString(),
      medications: meds,
      logs,
      settings,
    };
  }

  async function importAll(payload, mode) {
    // mode: 'merge' | 'replace'
    if (!payload || typeof payload !== 'object') throw new Error('Invalid backup file');
    if (!Array.isArray(payload.medications) || !Array.isArray(payload.logs)) {
      throw new Error('Backup is missing medications or logs');
    }
    const t = await tx([STORE_MEDS, STORE_LOGS, STORE_SETT], 'readwrite');
    if (mode === 'replace') {
      await reqToPromise(t.objectStore(STORE_MEDS).clear());
      await reqToPromise(t.objectStore(STORE_LOGS).clear());
      await reqToPromise(t.objectStore(STORE_SETT).clear());
    }
    for (const m of payload.medications) {
      if (!m || !m.id) continue;
      await reqToPromise(t.objectStore(STORE_MEDS).put(m));
    }
    for (const l of payload.logs) {
      if (!l || !l.id) continue;
      await reqToPromise(t.objectStore(STORE_LOGS).put(l));
    }
    if (payload.settings && typeof payload.settings === 'object') {
      for (const [k, v] of Object.entries(payload.settings)) {
        await reqToPromise(t.objectStore(STORE_SETT).put({ key: k, value: v }));
      }
    }
    return true;
  }

  async function clearAll() {
    const t = await tx([STORE_MEDS, STORE_LOGS, STORE_SETT], 'readwrite');
    await reqToPromise(t.objectStore(STORE_MEDS).clear());
    await reqToPromise(t.objectStore(STORE_LOGS).clear());
    await reqToPromise(t.objectStore(STORE_SETT).clear());
    return true;
  }

  window.MK_DB = {
    open,
    uid,
    putMed, getMed, allMeds, deleteMed,
    putLog, getLog, allLogs, logsForMed, logsBetween, deleteLog,
    getSetting, setSetting, allSettings,
    exportAll, importAll, clearAll,
    DEFAULTS,
  };
})();
