/* PaceCoach – GPS-Tracker
 *
 * Arbeitet direkt auf dem `run`-Objekt (state.currentRun) und meldet Ereignisse über Callbacks:
 *   onPositionUpdate(distKm, currentPaceSec, elapsedMs)
 *   onKmReached(km, splitSec)
 *   onPaceAlert(deltaSec)          // > 0 = zu langsam, < 0 = zu schnell
 *   onSegmentChange(segmentIdx)
 * Zusätzlich (optional): onFirstFix(), onTick(elapsedMs), onError(message), onPlanComplete()
 *
 * Zeitbasis: Die Laufzeit startet beim ersten brauchbaren GPS-Fix (Pausen werden nicht mitgezählt).
 * Test-Modus: URL-Parameter ?sim=1[&speed=10][&pace=330] simuliert einen Lauf ohne GPS.
 */
(function (global) {
  'use strict';

  /* ---------- Konstanten ---------- */
  const EARTH_RADIUS_KM = 6371.0088;
  const PACE_WINDOW_KM = 0.5;          // gleitender Durchschnitt: letzte 500 m ...
  const PACE_WINDOW_MS = 30000;        // ... oder letzte 30 s (was mehr Punkte enthält)
  const MIN_WINDOW_KM = 0.02;          // Mindeststrecke für eine Pace-Berechnung
  const MIN_WINDOW_MS = 5000;
  const PACE_TOLERANCE_SEC = 10;       // ±10 s
  const WARN_COOLDOWN_MS = 60000;      // 60 s zwischen Warnungen
  const NO_WARN_FIRST_KM = 0.2;        // keine Warnung in den ersten 200 m eines Segments
  const MAX_ACCURACY_M = 40;           // schlechtere Fixes werden verworfen
  const MIN_STEP_KM = 0.003;           // Mini-Bewegungen (GPS-Rauschen) ignorieren
  const MAX_SPEED_MS = 12;             // > 43 km/h = Ausreißer
  const STALE_MS = 20000;              // ohne neue Punkte → Pace "--"

  /* ---------- Geometrie ---------- */
  function toRad(deg) { return deg * Math.PI / 180; }

  /** Haversine-Distanz in Kilometern */
  function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* ---------- Interner Zustand ---------- */
  let run = null;
  let plan = null;
  let cb = {};
  let watchId = null;
  let tickTimer = null;
  let simTimer = null;
  let sim = null;
  let simClock = 0;

  let hasFix = false;
  let paused = false;
  let startClock = 0;
  let pausedTotal = 0;
  let pausedAt = 0;
  let lastPoint = null;       // letzter akzeptierter Punkt {lat, lon, t, distKm}
  let lastAcceptedAt = 0;     // elapsed ms des letzten akzeptierten Punkts
  let segBounds = [];         // kumulative Segmentenden in km
  let segStats = [];          // [{startMs, startKm, endMs, endKm}]
  let lastKmMs = 0;
  let planCompleteFired = false;
  let lastError = null;

  function clock() { return sim ? simClock : Date.now(); }
  function elapsedNow() {
    if (!hasFix) return 0;
    const end = paused ? pausedAt : clock();
    return Math.max(0, end - startClock - pausedTotal);
  }

  function emit(name) {
    const fn = cb[name];
    if (typeof fn === 'function') {
      try { fn.apply(null, Array.prototype.slice.call(arguments, 1)); }
      catch (e) { console.error('Tracker callback ' + name, e); }
    }
  }

  /** Linear interpolierte Zeit (ms), zu der `targetKm` zwischen zwei Punkten überschritten wurde */
  function interpolateTime(p0, d1, t1, targetKm) {
    const span = d1 - p0.distKm;
    if (span <= 0) return t1;
    const f = Math.min(1, Math.max(0, (targetKm - p0.distKm) / span));
    return p0.t + f * (t1 - p0.t);
  }

  /** Pace (s/km) über gleitendes Fenster; minIdx begrenzt das Fenster nach unten (Segmentstart) */
  function computePace(minIdx) {
    const pts = run.positions;
    const n = pts.length;
    if (n < 2) return 0;
    const last = pts[n - 1];

    // Fenster 1: letzte 500 m
    let iDist = n - 1;
    while (iDist > 0 && last.distKm - pts[iDist - 1].distKm <= PACE_WINDOW_KM) iDist--;
    // Fenster 2: letzte 30 s
    let iTime = n - 1;
    while (iTime > 0 && last.t - pts[iTime - 1].t <= PACE_WINDOW_MS) iTime--;

    // Fenster mit mehr Punkten (= kleinerer Startindex)
    let start = Math.min(iDist, iTime);
    // Fenster 1 sollte mindestens 1 Punkt davor einschließen, damit die Strecke ≈ 500 m abdeckt
    if (start > 0 && start === iDist && last.distKm - pts[start].distKm < PACE_WINDOW_KM) start--;
    if (minIdx !== undefined && minIdx > start) start = Math.min(minIdx, n - 1);

    const first = pts[start];
    const dKm = last.distKm - first.distKm;
    const dMs = last.t - first.t;
    if (dKm < MIN_WINDOW_KM || dMs < MIN_WINDOW_MS) return 0;
    return (dMs / 1000) / dKm;
  }

  function segTarget(idx) {
    const s = plan.segments[idx];
    return s ? Fmt.segPaceSec(s) : 0;
  }

  /* ---------- Position verarbeiten ---------- */
  function handlePosition(pos) {
    if (!run || !run.active || paused) return;
    const c = pos && pos.coords;
    if (!c || !isFinite(c.latitude) || !isFinite(c.longitude)) return;
    if (typeof c.accuracy === 'number' && c.accuracy > MAX_ACCURACY_M) return;

    const now = clock();

    // Erster Fix: Laufzeit startet jetzt
    if (!hasFix) {
      hasFix = true;
      startClock = now;
      pausedTotal = 0;
      run.startTime = new Date().toISOString();
      lastPoint = { lat: c.latitude, lon: c.longitude, t: 0, distKm: 0 };
      run.positions.push(lastPoint);
      lastAcceptedAt = 0;
      lastKmMs = 0;
      run.segmentStartKm = 0;
      run.segmentDistanceAtStart = 0;
      run.segmentStartMs = 0;
      segStats = [{ startMs: 0, startKm: 0, endMs: null, endKm: null }];
      lastError = null;
      emit('onFirstFix');
      emit('onPositionUpdate', 0, 0, 0);
      return;
    }

    const t = elapsedNow();
    if (!lastPoint) {
      // Neustart nach Pause: Punkt ohne Distanzzuwachs
      lastPoint = { lat: c.latitude, lon: c.longitude, t: t, distKm: run.distanceKm };
      run.positions.push(lastPoint);
      lastAcceptedAt = t;
      return;
    }

    const step = haversineKm(lastPoint.lat, lastPoint.lon, c.latitude, c.longitude);
    if (step < MIN_STEP_KM) return;
    const dtSec = (t - lastPoint.t) / 1000;
    if (dtSec > 0 && (step * 1000) / dtSec > MAX_SPEED_MS) return;

    const prev = lastPoint;
    const newDist = prev.distKm + step;
    const point = { lat: c.latitude, lon: c.longitude, t: t, distKm: newDist };
    run.positions.push(point);
    lastPoint = point;
    lastAcceptedAt = t;
    run.distanceKm = newDist;
    run.elapsedMs = t;

    // --- Kilometer-Marken ---
    let nextKm = run.lastKmAnnounced + 1;
    while (newDist >= nextKm) {
      const crossMs = interpolateTime(prev, newDist, t, nextKm);
      const splitSec = Math.max(1, Math.round((crossMs - lastKmMs) / 1000));
      lastKmMs = crossMs;
      run.kmSplits.push({ km: nextKm, timeSeconds: splitSec });
      run.lastKmAnnounced = nextKm;
      emit('onKmReached', nextKm, splitSec);
      nextKm++;
    }

    // --- Segmentwechsel ---
    while (run.currentSegmentIdx < plan.segments.length - 1 &&
      newDist >= segBounds[run.currentSegmentIdx]) {
      const boundary = segBounds[run.currentSegmentIdx];
      const crossMs = interpolateTime(prev, newDist, t, boundary);
      const cur = segStats[run.currentSegmentIdx];
      cur.endMs = crossMs;
      cur.endKm = boundary;
      run.currentSegmentIdx++;
      segStats[run.currentSegmentIdx] = { startMs: crossMs, startKm: boundary, endMs: null, endKm: null };
      run.segmentStartKm = boundary;
      run.segmentDistanceAtStart = boundary;
      run.segmentStartMs = crossMs;
      emit('onSegmentChange', run.currentSegmentIdx);
    }

    // --- Pace ---
    run.currentPaceSec = computePace();
    emit('onPositionUpdate', newDist, run.currentPaceSec, t);

    // --- Plan komplett? ---
    if (!planCompleteFired && newDist >= segBounds[segBounds.length - 1]) {
      planCompleteFired = true;
      emit('onPlanComplete');
    }

    checkPaceAlert(t, newDist);
  }

  function checkPaceAlert(t, distKm) {
    if (planCompleteFired) return;

    // Pace dieses Kilometers: Zeit seit letzter km-Marke / Distanz seit letzter km-Marke
    // Resettet an jeder km-Marke → kein Drift über Zeit
    const distInKm = distKm - run.lastKmAnnounced;   // 0..1 km innerhalb dieses km
    if (distInKm < NO_WARN_FIRST_KM) return;           // erste 200 m: Einlaufzeit
    if (run.lastWarnMs && t - run.lastWarnMs < WARN_COOLDOWN_MS) return;

    const timeInKmMs = t - lastKmMs;
    if (distInKm < MIN_WINDOW_KM || timeInKmMs < MIN_WINDOW_MS) return;
    const pace = (timeInKmMs / 1000) / distInKm;       // s/km (Hochrechnung für diesen km)

    const target = segTarget(run.currentSegmentIdx);
    if (!target) return;
    const delta = Math.round(pace - target);
    if (Math.abs(delta) > PACE_TOLERANCE_SEC) {
      run.lastWarnMs = t;
      emit('onPaceAlert', delta);
    }
  }

  function handleError(err) {
    let msg;
    switch (err && err.code) {
      case 1: msg = 'GPS-Zugriff verweigert. Bitte Standortfreigabe in den Browser-Einstellungen erlauben.'; break;
      case 2: msg = 'GPS-Position nicht verfügbar. Bitte im Freien versuchen.'; break;
      case 3: msg = 'GPS-Signal wird gesucht … (Zeitüberschreitung)'; break;
      default: msg = 'GPS-Fehler: ' + ((err && err.message) || 'unbekannt');
    }
    lastError = msg;
    // Timeouts sind meist temporär, Zugriffsverweigerung nicht
    emit('onError', msg, err && err.code);
  }

  function tick() {
    if (!run || !run.active) return;
    const t = elapsedNow();
    if (hasFix && !paused) {
      run.elapsedMs = t;
      if (t - lastAcceptedAt > STALE_MS && run.currentPaceSec !== 0) {
        run.currentPaceSec = 0;
        emit('onPositionUpdate', run.distanceKm, 0, t);
      }
    }
    emit('onTick', t);
  }

  /* ---------- Simulation ---------- */
  function startSimulation() {
    const q = new URLSearchParams(global.location.search);
    const speed = Math.max(1, parseFloat(q.get('speed')) || 1);
    const basePace = Math.max(120, parseFloat(q.get('pace')) || 330); // s/km
    sim = { speed: speed, basePace: basePace, lat: 52.52, lon: 13.405, t: 0 };
    simClock = Date.now();
    const STEP_MS = 500;
    simTimer = setInterval(function () {
      if (paused) { simClock += STEP_MS * sim.speed; return; }
      simClock += STEP_MS * sim.speed;
      sim.t += STEP_MS * sim.speed / 1000;
      // Pace schwankt leicht, damit Warnungen auftreten können
      const pace = sim.basePace + 25 * Math.sin(sim.t / 90);
      const metres = (STEP_MS * sim.speed / 1000) / pace * 1000;
      sim.lat += metres / 111320;
      handlePosition({ coords: { latitude: sim.lat, longitude: sim.lon, accuracy: 5 } });
    }, STEP_MS);
  }

  /* ---------- Öffentliche API ---------- */
  const Tracker = {
    haversineKm: haversineKm,
    isSimulation() { return /[?&]sim=1/.test(global.location.search); },
    isSupported() { return this.isSimulation() || ('geolocation' in navigator); },
    getError() { return lastError; },
    hasFix() { return hasFix; },
    isPaused() { return paused; },
    getElapsedMs: elapsedNow,

    /** run = state.currentRun (wird direkt mutiert) */
    start(runState, planObj, callbacks) {
      this.stop(true);
      run = runState;
      plan = planObj;
      cb = callbacks || {};
      hasFix = false;
      paused = false;
      pausedTotal = 0;
      pausedAt = 0;
      lastPoint = null;
      lastAcceptedAt = 0;
      lastKmMs = 0;
      planCompleteFired = false;
      lastError = null;
      segStats = [];
      segBounds = [];
      let acc = 0;
      plan.segments.forEach(function (s) { acc += Number(s.distance) || 0; segBounds.push(acc); });

      if (this.isSimulation()) {
        startSimulation();
      } else {
        if (!('geolocation' in navigator)) {
          lastError = 'Dieses Gerät/Browser unterstützt keine GPS-Ortung.';
          emit('onError', lastError, 0);
          return false;
        }
        watchId = navigator.geolocation.watchPosition(handlePosition, handleError, {
          enableHighAccuracy: true,
          maximumAge: 0,
          timeout: 20000
        });
      }
      tickTimer = setInterval(tick, 1000);
      return true;
    },

    pause() {
      if (!run || paused) return;
      pausedAt = clock();
      paused = true;
      if (hasFix) run.elapsedMs = elapsedNow();
    },

    resume() {
      if (!run || !paused) return;
      pausedTotal += clock() - pausedAt;
      paused = false;
      lastPoint = null; // erster Punkt nach Pause zählt keine Strecke
    },

    /** Beendet das Tracking, schließt das laufende Segment ab. */
    stop(silent) {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      if (simTimer) { clearInterval(simTimer); simTimer = null; }
      if (run && hasFix && !silent) {
        run.elapsedMs = elapsedNow();
        const cur = segStats[run.currentSegmentIdx];
        if (cur && cur.endMs === null) {
          cur.endMs = run.elapsedMs;
          cur.endKm = run.distanceKm;
        }
      }
      sim = null;
    },

    /** Ergebnisse je (betretenem) Segment: Ist-Pace in s/km */
    getSegmentResults() {
      if (!plan) return [];
      const out = [];
      segStats.forEach(function (st, i) {
        if (!st) return;
        const seg = plan.segments[i];
        const endMs = st.endMs === null ? elapsedNow() : st.endMs;
        const endKm = st.endKm === null ? (run ? run.distanceKm : st.startKm) : st.endKm;
        const dKm = endKm - st.startKm;
        const dSec = (endMs - st.startMs) / 1000;
        if (dKm < 0.05) return; // zu kurz für eine sinnvolle Auswertung
        out.push({
          segmentId: seg.id,
          name: seg.name,
          targetPace: Fmt.pace(Fmt.segPaceSec(seg)),
          actualPaceSec: Math.round(dSec / dKm)
        });
      });
      return out;
    }
  };

  global.Tracker = Tracker;
})(window);
