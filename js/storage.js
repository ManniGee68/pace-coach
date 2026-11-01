/* PaceCoach – Storage (localStorage Wrapper) */
(function (global) {
  'use strict';

  const KEY_PLANS = 'pacecoach_plans';
  const KEY_LOGS = 'pacecoach_logs';
  const KEY_PENDING_LOG = 'pacecoach_pending_log';

  function read(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return null;
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch (e) {
      console.warn('Storage read error', key, e);
      return [];
    }
  }

  function write(key, arr) {
    try {
      localStorage.setItem(key, JSON.stringify(arr));
      return true;
    } catch (e) {
      console.error('Storage write error', key, e);
      return false;
    }
  }

  const StorageManager = {
    KEY_PLANS,
    KEY_LOGS,
    /** true, wenn noch nie Pläne gespeichert wurden (für Demo-Daten) */
    isFirstStart() {
      try { return localStorage.getItem(KEY_PLANS) === null; } catch (e) { return false; }
    },
    getPlans() { return read(KEY_PLANS) || []; },
    savePlans(arr) { return write(KEY_PLANS, arr); },
    getLogs() { return read(KEY_LOGS) || []; },
    saveLogs(arr) { return write(KEY_LOGS, arr); },
    getPendingLog() {
      try {
        const raw = localStorage.getItem(KEY_PENDING_LOG);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    savePendingLog(log) {
      try { localStorage.setItem(KEY_PENDING_LOG, JSON.stringify(log)); } catch (e) {}
    },
    clearPendingLog() {
      try { localStorage.removeItem(KEY_PENDING_LOG); } catch (e) {}
    }
  };

  global.StorageManager = StorageManager;
})(window);
