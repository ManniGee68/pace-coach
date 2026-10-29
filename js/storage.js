/* PaceCoach – Storage (localStorage Wrapper) */
(function (global) {
  'use strict';

  const KEY_PLANS = 'pacecoach_plans';
  const KEY_LOGS = 'pacecoach_logs';

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
    saveLogs(arr) { return write(KEY_LOGS, arr); }
  };

  global.StorageManager = StorageManager;
})(window);
