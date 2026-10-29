/* PaceCoach – Formatierung + Plan-Manager */
(function (global) {
  'use strict';

  /* ---------- Formatierungs-Helfer ---------- */
  const Fmt = {
    /** Sekunden/km → "M:SS" (immer MM:SS-Stil, z.B. "5:08") */
    pace(sec) {
      if (!isFinite(sec) || sec <= 0) return '--:--';
      const t = Math.round(sec);
      const m = Math.floor(t / 60);
      const s = t % 60;
      return m + ':' + String(s).padStart(2, '0');
    },
    /** Sekunden → "MM:SS" bzw. "H:MM:SS" ab 1 Stunde */
    time(sec) {
      if (!isFinite(sec) || sec < 0) sec = 0;
      const t = Math.round(sec);
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = t % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
    },
    /** Kilometer mit deutschem Dezimalkomma */
    km(k, digits) {
      const d = digits === undefined ? 2 : digits;
      return (Number(k) || 0).toFixed(d).replace('.', ',');
    },
    /** "5:30" → 330 ; liefert null bei ungültiger Eingabe */
    parsePace(str) {
      if (typeof str !== 'string') return null;
      const m = str.trim().match(/^(\d{1,2})(?:[:.](\d{1,2}))?$/);
      if (!m) return null;
      const min = parseInt(m[1], 10);
      const sec = m[2] === undefined ? 0 : parseInt(m[2], 10);
      if (sec > 59) return null;
      const total = min * 60 + sec;
      return total > 0 ? total : null;
    },
    parseKm(str) {
      if (typeof str === 'number') return str;
      const v = parseFloat(String(str).trim().replace(',', '.'));
      return isFinite(v) ? v : null;
    },
    segPaceSec(seg) {
      return (Number(seg.targetPaceMin) || 0) * 60 + (Number(seg.targetPaceSec) || 0);
    },
    esc(str) {
      return String(str === undefined || str === null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    todayISO() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    dateDE(iso) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
      return m ? m[3] + '.' + m[2] + '.' + m[1] : (iso || '');
    }
  };

  /* ---------- UUID ---------- */
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      try { return global.crypto.randomUUID(); } catch (e) { /* fallthrough */ }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ---------- Plan-Validierung ---------- */
  function normalizePlan(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Kein gültiger Plan (Objekt erwartet).');
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) throw new Error('Plan hat keinen Namen.');
    if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
      throw new Error('Plan "' + name + '" enthält keine Segmente.');
    }
    const segments = raw.segments.map(function (s, i) {
      const label = 'Segment ' + (i + 1) + ' in "' + name + '"';
      if (!s || typeof s !== 'object') throw new Error(label + ' ist ungültig.');
      const segName = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : 'Segment ' + (i + 1);
      const distance = Fmt.parseKm(s.distance);
      if (distance === null || distance <= 0) throw new Error(label + ': Distanz muss größer als 0 sein.');
      const min = Number(s.targetPaceMin);
      const sec = Number(s.targetPaceSec === undefined ? 0 : s.targetPaceSec);
      if (!isFinite(min) || !isFinite(sec) || min < 0 || sec < 0 || sec > 59 || min * 60 + sec <= 0) {
        throw new Error(label + ': Pace ist ungültig.');
      }
      return {
        id: typeof s.id === 'string' && s.id ? s.id : 'seg-' + (i + 1),
        name: segName,
        distance: distance,
        targetPaceMin: Math.floor(min),
        targetPaceSec: Math.floor(sec)
      };
    });
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uuid(),
      name: name,
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : Fmt.todayISO(),
      segments: segments
    };
  }

  function totalDistance(plan) {
    return plan.segments.reduce(function (a, s) { return a + (Number(s.distance) || 0); }, 0);
  }
  function estimatedSeconds(plan) {
    return plan.segments.reduce(function (a, s) { return a + (Number(s.distance) || 0) * Fmt.segPaceSec(s); }, 0);
  }

  /* ---------- Plan-Manager ---------- */
  const PlanManager = {
    uuid: uuid,
    normalize: normalizePlan,
    totalDistance: totalDistance,
    estimatedSeconds: estimatedSeconds,

    getAll() { return StorageManager.getPlans(); },
    get(id) { return this.getAll().find(function (p) { return p.id === id; }) || null; },

    save(plan) {
      const plans = this.getAll();
      const idx = plans.findIndex(function (p) { return p.id === plan.id; });
      if (idx >= 0) plans[idx] = plan; else plans.push(plan);
      StorageManager.savePlans(plans);
      return plan;
    },

    delete(id) {
      const plans = this.getAll().filter(function (p) { return p.id !== id; });
      StorageManager.savePlans(plans);
    },

    /** Liest eine JSON-Datei (File-API), validiert und speichert. Resolved mit Array der importierten Pläne. */
    importFromJSON(file) {
      const self = this;
      return new Promise(function (resolve, reject) {
        if (!file) { reject(new Error('Keine Datei ausgewählt.')); return; }
        const reader = new FileReader();
        reader.onerror = function () { reject(new Error('Datei konnte nicht gelesen werden.')); };
        reader.onload = function () {
          let data;
          try { data = JSON.parse(reader.result); } catch (e) { reject(new Error('Datei enthält kein gültiges JSON.')); return; }
          try {
            const list = Array.isArray(data) ? data : [data];
            if (list.length === 0) throw new Error('Datei enthält keine Pläne.');
            const imported = list.map(function (raw) {
              const plan = normalizePlan(raw);
              // neue IDs, damit bestehende Pläne nicht überschrieben werden
              plan.id = uuid();
              plan.segments.forEach(function (s, i) { s.id = 'seg-' + (i + 1); });
              return plan;
            });
            imported.forEach(function (p) { self.save(p); });
            resolve(imported);
          } catch (e) {
            reject(e);
          }
        };
        reader.readAsText(file);
      });
    },

    /** Download als <planname>.json */
    exportToJSON(plan) {
      const clean = {
        id: plan.id,
        name: plan.name,
        createdAt: plan.createdAt,
        segments: plan.segments.map(function (s) {
          return { id: s.id, name: s.name, distance: s.distance, targetPaceMin: s.targetPaceMin, targetPaceSec: s.targetPaceSec };
        })
      };
      const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const fname = (plan.name || 'plan').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'plan';
      a.href = url;
      a.download = fname + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
    }
  };

  global.Fmt = Fmt;
  global.PlanManager = PlanManager;
})(window);
