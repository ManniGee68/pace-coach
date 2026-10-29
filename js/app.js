/* PaceCoach – App: State, Router, Screens */
(function () {
  'use strict';

  const APP_VERSION = 'v0.4.2';

  /* ================= State ================= */
  function freshRun() {
    return {
      active: false,
      plan: null,
      startTime: null,
      elapsedMs: 0,
      distanceKm: 0,
      currentSegmentIdx: 0,
      segmentStartKm: 0,
      kmSplits: [],
      positions: [],
      currentPaceSec: 0,
      lastKmAnnounced: 0,
      lastWarnMs: 0,
      segmentStartMs: 0,
      segmentDistanceAtStart: 0
    };
  }

  const state = {
    plans: [],
    logs: [],
    editingPlan: null,    // Plan im Editor
    selectedPlan: null,   // Plan für Pre-Run
    pendingLog: null,     // Ergebnis des letzten Laufs (Summary)
    pendingSaved: false,
    currentRun: freshRun()
  };

  const $ = function (id) { return document.getElementById(id); };
  const esc = Fmt.esc;

  /* ================= Router ================= */
  const SCREENS = ['plans', 'editor', 'prerun', 'run', 'summary', 'log'];
  let currentScreen = null;

  function show(name) {
    SCREENS.forEach(function (s) {
      $('screen-' + s).classList.toggle('active', s === name);
    });
    currentScreen = name;
    const navVisible = name === 'plans' || name === 'log';
    $('nav-tabs').classList.toggle('visible', navVisible);
    $('tab-plans').classList.toggle('active', name === 'plans');
    $('tab-log').classList.toggle('active', name === 'log');
    window.scrollTo(0, 0);
  }

  /* ================= Dialog / Toast ================= */
  let modalResolve = null;
  function confirmDialog(title, text, okLabel, cancelLabel) {
    return new Promise(function (resolve) {
      $('modal-title').textContent = title;
      $('modal-text').textContent = text;
      $('modal-ok').textContent = okLabel || 'OK';
      const cancel = $('modal-cancel');
      if (cancelLabel === null) cancel.classList.add('hidden');
      else { cancel.classList.remove('hidden'); cancel.textContent = cancelLabel || 'Abbrechen'; }
      $('modal').classList.remove('hidden');
      modalResolve = resolve;
    });
  }
  function closeModal(result) {
    $('modal').classList.add('hidden');
    const r = modalResolve;
    modalResolve = null;
    if (r) r(result);
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3200);
  }

  /* ================= Daten laden ================= */
  function loadData() {
    if (StorageManager.isFirstStart()) {
      const demo = {
        id: PlanManager.uuid(),
        name: '10km Sub-50',
        createdAt: Fmt.todayISO(),
        segments: [
          { id: 'seg-1', name: 'Warm-Up', distance: 2, targetPaceMin: 6, targetPaceSec: 30 },
          { id: 'seg-2', name: 'Main Run', distance: 6, targetPaceMin: 5, targetPaceSec: 0 },
          { id: 'seg-3', name: 'Cool-Down', distance: 2, targetPaceMin: 6, targetPaceSec: 30 }
        ]
      };
      StorageManager.savePlans([demo]);
    }
    state.plans = PlanManager.getAll();
    state.logs = StorageManager.getLogs();
  }

  /* ================= Screen 1: Pläne ================= */
  function renderPlans() {
    state.plans = PlanManager.getAll();
    const list = $('plans-list');
    if (state.plans.length === 0) {
      list.innerHTML = '<div class="empty-state"><span class="big">🏃</span>Noch keine Pläne.<br>Lege einen neuen Plan an oder importiere eine JSON-Datei.</div>';
      return;
    }
    list.innerHTML = state.plans.map(function (p) {
      const n = p.segments.length;
      return '<div class="card tappable" data-plan="' + esc(p.id) + '">' +
        '<div class="card-title">' + esc(p.name) + '</div>' +
        '<div class="card-meta">' + Fmt.km(PlanManager.totalDistance(p), 1) + ' km · ' + n + (n === 1 ? ' Segment' : ' Segmente') +
        ' · ca. ' + Fmt.time(PlanManager.estimatedSeconds(p)) + '</div>' +
        '<div class="card-actions">' +
        '<button type="button" class="btn btn-secondary btn-small" data-act="edit" data-plan="' + esc(p.id) + '">✏️ Bearbeiten</button>' +
        '<button type="button" class="btn btn-danger btn-small" data-act="delete" data-plan="' + esc(p.id) + '">🗑 Löschen</button>' +
        '</div></div>';
    }).join('');
  }

  function onPlansClick(e) {
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('[data-plan]');
    if (!card) return;
    const id = card.getAttribute('data-plan');
    if (btn) {
      e.stopPropagation();
      if (btn.getAttribute('data-act') === 'edit') openEditor(id);
      else if (btn.getAttribute('data-act') === 'delete') deletePlan(id);
      return;
    }
    openPrerun(id);
  }

  function deletePlan(id) {
    const plan = PlanManager.get(id);
    if (!plan) return;
    confirmDialog('Plan löschen?', '„' + plan.name + '“ wird unwiderruflich gelöscht.', 'Löschen').then(function (ok) {
      if (!ok) return;
      PlanManager.delete(id);
      renderPlans();
      toast('Plan gelöscht');
    });
  }

  function importPlans(file) {
    PlanManager.importFromJSON(file).then(function (imported) {
      renderPlans();
      toast(imported.length === 1 ? 'Plan „' + imported[0].name + '“ importiert' : imported.length + ' Pläne importiert', 'ok');
    }).catch(function (err) {
      toast('Import fehlgeschlagen: ' + err.message, 'error');
    });
  }

  /* ================= Screen 2: Editor ================= */
  function blankSegment() {
    return { id: 'seg-' + PlanManager.uuid().slice(0, 8), name: '', distance: '', targetPaceMin: 5, targetPaceSec: 30, _paceText: '5:30' };
  }

  function openEditor(id) {
    if (id) {
      const p = PlanManager.get(id);
      if (!p) return;
      state.editingPlan = JSON.parse(JSON.stringify(p));
      state.editingPlan.segments.forEach(function (s) {
        s._paceText = Fmt.pace(Fmt.segPaceSec(s));
      });
      $('editor-title').textContent = 'Plan bearbeiten';
    } else {
      state.editingPlan = {
        id: PlanManager.uuid(),
        name: '',
        createdAt: Fmt.todayISO(),
        segments: [Object.assign(blankSegment(), { name: 'Warm-Up' })]
      };
      $('editor-title').textContent = 'Neuer Plan';
    }
    $('editor-name').value = state.editingPlan.name;
    $('editor-error').textContent = '';
    renderEditorSegments();
    show('editor');
  }

  function renderEditorSegments() {
    const plan = state.editingPlan;
    $('editor-segments').innerHTML = plan.segments.map(function (s, i) {
      return '<div class="seg-card" data-idx="' + i + '">' +
        '<div class="seg-head"><span class="seg-index">' + (i + 1) + '</span>' +
        '<input type="text" class="seg-name" placeholder="Name (z. B. Warm-Up)" maxlength="40" value="' + esc(s.name) + '" aria-label="Segmentname"></div>' +
        '<div class="seg-row">' +
        '<label class="field"><span class="field-label">Distanz (km)</span>' +
        '<input type="text" inputmode="decimal" class="seg-dist" placeholder="2,5" value="' + esc(s.distance === '' ? '' : String(s.distance).replace('.', ',')) + '"></label>' +
        '<label class="field"><span class="field-label">Pace (MM:SS)</span>' +
        '<input type="text" inputmode="numeric" class="seg-pace" placeholder="5:30" maxlength="5" value="' + esc(s._paceText) + '"></label>' +
        '<button type="button" class="seg-del" data-del="' + i + '" aria-label="Segment löschen">🗑</button>' +
        '</div></div>';
    }).join('');
    updateEditorSummary();
  }

  /** DOM → editingPlan (ohne Validierung) */
  function collectEditor() {
    const plan = state.editingPlan;
    plan.name = $('editor-name').value;
    document.querySelectorAll('#editor-segments .seg-card').forEach(function (card) {
      const i = parseInt(card.getAttribute('data-idx'), 10);
      const s = plan.segments[i];
      if (!s) return;
      s.name = card.querySelector('.seg-name').value;
      s.distance = card.querySelector('.seg-dist').value;
      s._paceText = card.querySelector('.seg-pace').value;
    });
  }

  function updateEditorSummary() {
    if (!state.editingPlan) return;
    let dist = 0, sec = 0;
    document.querySelectorAll('#editor-segments .seg-card').forEach(function (card) {
      const d = Fmt.parseKm(card.querySelector('.seg-dist').value);
      const p = Fmt.parsePace(card.querySelector('.seg-pace').value);
      if (d > 0) { dist += d; if (p) sec += d * p; }
    });
    $('editor-summary').textContent = dist > 0
      ? 'Gesamt: ' + Fmt.km(dist, 2) + ' km · ca. ' + Fmt.time(sec)
      : '';
  }

  /** Validiert editingPlan; liefert fertigen Plan oder null (und markiert Fehler) */
  function validateEditor() {
    collectEditor();
    const plan = state.editingPlan;
    const err = $('editor-error');
    err.textContent = '';
    document.querySelectorAll('#screen-editor .invalid').forEach(function (el) { el.classList.remove('invalid'); });

    const nameEl = $('editor-name');
    if (!plan.name.trim()) {
      nameEl.classList.add('invalid'); nameEl.focus();
      err.textContent = 'Bitte einen Plan-Namen eingeben.';
      return null;
    }
    if (plan.segments.length === 0) {
      err.textContent = 'Mindestens ein Segment ist nötig.';
      return null;
    }
    const cards = document.querySelectorAll('#editor-segments .seg-card');
    const out = [];
    for (let i = 0; i < plan.segments.length; i++) {
      const s = plan.segments[i];
      const card = cards[i];
      const dist = Fmt.parseKm(s.distance);
      const pace = Fmt.parsePace(s._paceText);
      if (!dist || dist <= 0 || dist > 500) {
        card.querySelector('.seg-dist').classList.add('invalid');
        err.textContent = 'Segment ' + (i + 1) + ': Bitte eine gültige Distanz in km eingeben.';
        return null;
      }
      if (!pace) {
        card.querySelector('.seg-pace').classList.add('invalid');
        err.textContent = 'Segment ' + (i + 1) + ': Pace bitte als MM:SS eingeben (z. B. 5:30).';
        return null;
      }
      out.push({
        id: s.id || ('seg-' + (i + 1)),
        name: s.name.trim() || ('Segment ' + (i + 1)),
        distance: Math.round(dist * 1000) / 1000,
        targetPaceMin: Math.floor(pace / 60),
        targetPaceSec: pace % 60
      });
    }
    return { id: plan.id, name: plan.name.trim(), createdAt: plan.createdAt, segments: out };
  }

  function saveEditor() {
    const plan = validateEditor();
    if (!plan) return;
    PlanManager.save(plan);
    state.editingPlan = null;
    renderPlans();
    show('plans');
    toast('Plan gespeichert', 'ok');
  }

  function cancelEditor() {
    state.editingPlan = null;
    show('plans');
  }

  /* ================= Screen 3: Pre-Run ================= */
  function openPrerun(id) {
    const plan = PlanManager.get(id);
    if (!plan) return;
    state.selectedPlan = plan;
    $('prerun-name').textContent = plan.name;
    $('prerun-distance').textContent = Fmt.km(PlanManager.totalDistance(plan), 1) + ' km';
    $('prerun-time').textContent = Fmt.time(PlanManager.estimatedSeconds(plan));
    $('prerun-segments').innerHTML = plan.segments.map(function (s, i) {
      return '<div class="card"><div class="seg-line">' +
        '<div class="grow"><div class="name">' + (i + 1) + '. ' + esc(s.name) + '</div>' +
        '<div class="card-meta">' + Fmt.km(s.distance, 2) + ' km</div></div>' +
        '<div class="pace">' + Fmt.pace(Fmt.segPaceSec(s)) + '<small>min/km</small></div>' +
        '</div></div>';
    }).join('');
    const warn = $('prerun-gps-warning');
    warn.textContent = Tracker.isSupported() ? '' : 'Dieses Gerät/Browser unterstützt keine GPS-Ortung – ein Lauf ist nicht möglich.';
    $('btn-start-run').disabled = !Tracker.isSupported();
    show('prerun');
  }

  /* ================= Screen 4: Live-Lauf ================= */
  let wakeLock = null;
  function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wakeLock = l;
      l.addEventListener('release', function () { if (wakeLock === l) wakeLock = null; });
    }).catch(function () { /* nicht kritisch */ });
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* */ } wakeLock = null; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state.currentRun.active && !wakeLock) requestWakeLock();
  });

  function currentSegment() {
    const r = state.currentRun;
    return r.plan.segments[r.currentSegmentIdx];
  }

  function startRun() {
    const plan = state.selectedPlan;
    if (!plan) return;
    if (!Tracker.isSupported()) {
      toast('Keine GPS-Ortung verfügbar.', 'error');
      return;
    }
    Voice.unlock(); // innerhalb der Klick-Geste (iOS)

    const run = freshRun();
    run.active = true;
    run.plan = plan;
    state.currentRun = run;

    $('btn-pause').textContent = '⏸ Pause';
    setRunStatus('GPS-Signal wird gesucht …');
    updateRunUI();
    show('run');
    requestWakeLock();

    const ok = Tracker.start(run, plan, {
      onFirstFix: function () {
        setRunStatus('');
        Voice.onStart(plan.name, plan.segments[0]);
      },
      onPositionUpdate: function () { updateRunUI(); },
      onTick: function () { updateRunUI(); },
      onKmReached: function (km, splitSec) {
        let total = 0;
        run.kmSplits.forEach(function (s) { total += s.timeSeconds; });
        Voice.onKm(km, splitSec, total, total / km);
      },
      onPaceAlert: function (deltaSec) { Voice.onPaceWarning(deltaSec); },
      onSegmentChange: function (idx) {
        const prev = plan.segments[idx - 1];
        const next = plan.segments[idx];
        Voice.onSegmentChange(prev.name, next.name, next.distance, Fmt.pace(Fmt.segPaceSec(next)));
        updateRunUI();
      },
      onPlanComplete: function () {
        setRunStatus('Plan abgeschlossen – Stop drücken zum Beenden.', false);
        Voice.speak('Plan abgeschlossen. Du kannst den Lauf jetzt beenden.');
      },
      onError: function (msg, code) {
        setRunStatus(msg, code === 1 || code === 0);
      }
    });
    if (!ok) setRunStatus(Tracker.getError() || 'GPS nicht verfügbar.', true);
  }

  function setRunStatus(msg, isError) {
    const el = $('run-status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  function updateRunUI() {
    const r = state.currentRun;
    if (!r.plan) return;
    const plan = r.plan;
    const seg = currentSegment();
    const idx = r.currentSegmentIdx;
    const elapsedSec = Tracker.getElapsedMs() / 1000;

    $('run-segment-name').textContent = seg.name;
    $('run-segment-count').textContent = (idx + 1) + '/' + plan.segments.length;

    const segDone = Math.max(0, r.distanceKm - r.segmentStartKm);
    const frac = Math.min(1, segDone / (Number(seg.distance) || 1));
    $('run-progress-bar').style.width = (frac * 100).toFixed(1) + '%';
    $('run-segment-km').textContent = Fmt.km(Math.min(segDone, seg.distance), 2) + ' / ' + Fmt.km(seg.distance, 2) + ' km';

    $('run-time').textContent = Fmt.time(elapsedSec);
    $('run-distance').textContent = Fmt.km(r.distanceKm, 2);

    const target = Fmt.segPaceSec(seg);
    $('run-target').textContent = Fmt.pace(target);

    const box = $('run-pace-box');
    box.classList.remove('state-ok', 'state-near', 'state-bad');
    const pace = r.currentPaceSec;
    if (pace > 0) {
      $('run-pace').textContent = Fmt.pace(pace);
      const delta = Math.round(pace - target);
      const abs = Math.abs(delta);
      box.classList.add(abs <= 10 ? 'state-ok' : (abs <= 20 ? 'state-near' : 'state-bad'));
      $('run-pace-delta').textContent = abs <= 10 ? 'Im Ziel ✓'
        : (delta > 0 ? '+' + abs + ' s zu langsam' : '−' + abs + ' s zu schnell');
    } else {
      $('run-pace').textContent = '--:--';
      $('run-pace-delta').innerHTML = '&nbsp;';
    }
  }

  function togglePause() {
    if (!state.currentRun.active) return;
    if (Tracker.isPaused()) {
      Tracker.resume();
      $('btn-pause').textContent = '⏸ Pause';
      setRunStatus('');
      Voice.speak('Weiter geht’s.');
    } else {
      Tracker.pause();
      $('btn-pause').textContent = '▶ Weiter';
      setRunStatus('⏸ Pausiert');
      Voice.speak('Pausiert.');
    }
    updateRunUI();
  }

  function stopRun() {
    if (!state.currentRun.active) return;
    confirmDialog('Lauf beenden?', 'Der Lauf wird beendet und zusammengefasst.', 'Beenden', 'Weiterlaufen').then(function (ok) {
      if (ok) finishRun();
    });
  }

  function finishRun() {
    const r = state.currentRun;
    if (!r.active) return;
    Tracker.stop();
    r.active = false;
    releaseWakeLock();
    Voice.cancel();

    const totalSec = Math.round(r.elapsedMs / 1000);
    const dist = r.distanceKm;
    const avgPace = dist > 0.01 ? totalSec / dist : 0;
    const log = {
      id: PlanManager.uuid(),
      planId: r.plan.id,
      planName: r.plan.name,
      date: Fmt.todayISO(),
      startTime: r.startTime || new Date().toISOString(),
      totalDistanceKm: Math.round(dist * 100) / 100,
      totalTimeSeconds: totalSec,
      avgPaceMin: Math.floor(avgPace / 60),
      avgPaceSec: Math.round(avgPace) % 60,
      kmSplits: r.kmSplits.map(function (s) { return { km: s.km, timeSeconds: s.timeSeconds }; }),
      segmentResults: Tracker.getSegmentResults(),
      positions: (function () {
        var pts = r.positions || [];
        if (pts.length === 0) return [];
        // Auf max. 300 Punkte ausdünnen für localStorage
        var step = Math.max(1, Math.floor(pts.length / 300));
        var out = [];
        for (var i = 0; i < pts.length; i += step) {
          out.push({ lat: pts[i].lat, lon: pts[i].lon });
        }
        var last = pts[pts.length - 1];
        if (out[out.length - 1].lat !== last.lat) out.push({ lat: last.lat, lon: last.lon });
        return out;
      })()
    };
    // Rundungsfall 59,6 s → 60
    if (log.avgPaceSec === 60) { log.avgPaceMin += 1; log.avgPaceSec = 0; }

    state.pendingLog = log;
    state.pendingSaved = false;
    renderSummary();
    show('summary');
    Voice.onFinish(Math.round(dist * 100) / 100, totalSec, avgPace);
  }

  /* ================= Karte (Leaflet) ================= */
  function renderMap(positions, containerId) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (!positions || positions.length < 2) {
      el.classList.add('hidden');
      return;
    }
    if (typeof L === 'undefined') {
      el.classList.add('hidden');
      return;
    }
    try {
      var latlngs = positions.map(function (p) { return [p.lat, p.lon]; });
      var map = L.map(el, { zoomControl: false, attributionControl: false });
      // OpenStreetMap — kostenlos, kein API-Key
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
      }).addTo(map);
      var route = L.polyline(latlngs, { color: '#e94560', weight: 4, opacity: 0.95 }).addTo(map);
      L.circleMarker(latlngs[0], { radius: 9, color: '#fff', fillColor: '#4ecca3', fillOpacity: 1, weight: 2 })
        .bindTooltip('Start', { permanent: false }).addTo(map);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 9, color: '#fff', fillColor: '#e94560', fillOpacity: 1, weight: 2 })
        .bindTooltip('Ziel', { permanent: false }).addTo(map);
      map.fitBounds(route.getBounds(), { padding: [28, 28] });
    } catch (e) {
      el.innerHTML = '<div class="muted center" style="padding:20px">Karte nicht verfügbar</div>';
    }
  }

  /* ================= Screen 5: Zusammenfassung ================= */
  function logAvgPaceSec(log) { return log.avgPaceMin * 60 + log.avgPaceSec; }

  function resultHTML(log) {
    let html = '<div class="big-stats">' +
      '<div class="stat"><div class="stat-value">' + Fmt.time(log.totalTimeSeconds) + '</div><div class="stat-label">Zeit</div></div>' +
      '<div class="stat"><div class="stat-value">' + Fmt.km(log.totalDistanceKm, 2) + '</div><div class="stat-label">km</div></div>' +
      '<div class="stat"><div class="stat-value">' + (logAvgPaceSec(log) > 0 ? Fmt.pace(logAvgPaceSec(log)) : '–') + '</div><div class="stat-label">Ø min/km</div></div>' +
      '</div>';

    html += '<div class="section-title">Kilometer-Splits</div>';
    if (log.kmSplits.length) {
      const best = Math.min.apply(null, log.kmSplits.map(function (s) { return s.timeSeconds; }));
      html += '<div class="table-card"><table class="data"><thead><tr><th>Km</th><th class="r">Split</th></tr></thead><tbody>' +
        log.kmSplits.map(function (s) {
          return '<tr><td>' + s.km + '</td><td class="r' + (s.timeSeconds === best && log.kmSplits.length > 1 ? ' delta-ok' : '') + '">' + Fmt.pace(s.timeSeconds) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      html += '<div class="card muted">Keine vollständigen Kilometer.</div>';
    }

    html += '<div class="section-title">Segment-Auswertung</div>';
    if (log.segmentResults.length) {
      html += '<div class="table-card"><table class="data"><thead><tr><th>Segment</th><th class="r">Soll</th><th class="r">Ist</th></tr></thead><tbody>' +
        log.segmentResults.map(function (s) {
          const target = Fmt.parsePace(s.targetPace) || 0;
          const diff = s.actualPaceSec - target;
          const cls = Math.abs(diff) <= 10 ? 'delta-ok' : 'delta-bad';
          return '<tr><td>' + esc(s.name) + '</td><td class="r">' + esc(s.targetPace) + '</td>' +
            '<td class="r ' + cls + '">' + Fmt.pace(s.actualPaceSec) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    } else {
      html += '<div class="card muted">Keine Segmentdaten.</div>';
    }
    return html;
  }

  function renderSummary() {
    $('summary-content').innerHTML = '<div id="summary-map" class="run-map"></div>' + resultHTML(state.pendingLog);
    renderMap(state.pendingLog && state.pendingLog.positions, 'summary-map');
  }

  function savePendingLog() {
    if (!state.pendingLog || state.pendingSaved) return false;
    const logs = StorageManager.getLogs();
    logs.unshift(state.pendingLog);
    StorageManager.saveLogs(logs);
    state.logs = logs;
    state.pendingSaved = true;
    return true;
  }

  function summarySave() {
    if (savePendingLog()) toast('Lauf gespeichert', 'ok');
    state.pendingLog = null;
    renderLog();
    show('log');
  }

  function summaryDiscard() {
    confirmDialog('Lauf verwerfen?', 'Dieser Lauf wird nicht gespeichert.', 'Verwerfen').then(function (ok) {
      if (!ok) return;
      state.pendingLog = null;
      renderPlans();
      show('plans');
    });
  }

  function summaryNew() {
    if (savePendingLog()) toast('Lauf gespeichert', 'ok');
    state.pendingLog = null;
    renderPlans();
    show('plans');
  }

  /* ================= Screen 6: Tagebuch ================= */
  function renderLog() {
    state.logs = StorageManager.getLogs();
    $('log-detail').classList.add('hidden');
    $('log-list').classList.remove('hidden');
    $('log-back').classList.add('hidden');
    $('log-title').textContent = 'Lauftagebuch';
    const list = $('log-list');
    if (state.logs.length === 0) {
      list.innerHTML = '<div class="empty-state"><span class="big">📓</span>Noch keine Läufe gespeichert.</div>';
      return;
    }
    list.innerHTML = state.logs.map(function (l) {
      return '<div class="card tappable" data-log="' + esc(l.id) + '"><div class="log-row">' +
        '<div><div class="card-title">' + esc(l.planName) + '</div>' +
        '<div class="card-meta">' + Fmt.dateDE(l.date) + '</div></div>' +
        '<div class="right"><div class="big">' + Fmt.km(l.totalDistanceKm, 2) + ' km</div>' +
        '<div class="card-meta">' + Fmt.time(l.totalTimeSeconds) + ' · Ø ' + (logAvgPaceSec(l) > 0 ? Fmt.pace(logAvgPaceSec(l)) : '–') + '</div></div>' +
        '</div></div>';
    }).join('');
  }

  function openLogDetail(id) {
    const log = state.logs.find(function (l) { return l.id === id; });
    if (!log) return;
    $('log-list').classList.add('hidden');
    $('log-back').classList.remove('hidden');
    $('log-title').textContent = Fmt.dateDE(log.date);
    const d = $('log-detail');
    d.innerHTML = '<div id="log-map" class="run-map"></div><h2 style="margin:4px 0 12px">' + esc(log.planName) + '</h2>' + resultHTML(log) +
      '<div class="btn-stack"><button type="button" class="btn btn-danger btn-block" data-del-log="' + esc(log.id) + '">🗑 Lauf löschen</button></div>';
    d.classList.remove('hidden');
    renderMap(log.positions, 'log-map');
    window.scrollTo(0, 0);
  }

  function deleteLog(id) {
    confirmDialog('Lauf löschen?', 'Dieser Eintrag wird unwiderruflich gelöscht.', 'Löschen').then(function (ok) {
      if (!ok) return;
      const logs = StorageManager.getLogs().filter(function (l) { return l.id !== id; });
      StorageManager.saveLogs(logs);
      renderLog();
      toast('Eintrag gelöscht');
    });
  }

  /* ================= Events ================= */
  function bind() {
    $('plans-list').addEventListener('click', onPlansClick);
    $('btn-new-plan').addEventListener('click', function () { openEditor(null); });
    $('btn-import').addEventListener('click', function () { $('import-file').click(); });
    $('import-file').addEventListener('change', function (e) {
      const f = e.target.files && e.target.files[0];
      if (f) importPlans(f);
      e.target.value = '';
    });

    // Editor
    $('btn-add-segment').addEventListener('click', function () {
      collectEditor();
      state.editingPlan.segments.push(blankSegment());
      renderEditorSegments();
      const cards = document.querySelectorAll('#editor-segments .seg-card');
      const last = cards[cards.length - 1];
      if (last) { last.scrollIntoView({ block: 'center', behavior: 'smooth' }); last.querySelector('.seg-name').focus({ preventScroll: true }); }
    });
    $('editor-segments').addEventListener('click', function (e) {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      collectEditor();
      if (state.editingPlan.segments.length <= 1) { toast('Mindestens ein Segment nötig', 'error'); return; }
      state.editingPlan.segments.splice(parseInt(del.getAttribute('data-del'), 10), 1);
      renderEditorSegments();
    });
    $('editor-segments').addEventListener('input', updateEditorSummary);
    $('btn-editor-save').addEventListener('click', saveEditor);
    $('btn-editor-cancel').addEventListener('click', cancelEditor);
    $('editor-back').addEventListener('click', cancelEditor);
    $('btn-editor-export').addEventListener('click', function () {
      const plan = validateEditor();
      if (plan) PlanManager.exportToJSON(plan);
    });

    // Pre-Run
    $('prerun-back').addEventListener('click', function () { renderPlans(); show('plans'); });
    $('btn-start-run').addEventListener('click', startRun);

    // Run
    $('btn-pause').addEventListener('click', togglePause);
    $('btn-stop').addEventListener('click', stopRun);

    // Summary
    $('btn-summary-save').addEventListener('click', summarySave);
    $('btn-summary-discard').addEventListener('click', summaryDiscard);
    $('btn-summary-new').addEventListener('click', summaryNew);

    // Log
    $('log-list').addEventListener('click', function (e) {
      const card = e.target.closest('[data-log]');
      if (card) openLogDetail(card.getAttribute('data-log'));
    });
    $('log-detail').addEventListener('click', function (e) {
      const del = e.target.closest('[data-del-log]');
      if (del) deleteLog(del.getAttribute('data-del-log'));
    });
    $('log-back').addEventListener('click', renderLog);

    // Nav
    document.querySelectorAll('[data-nav]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-nav') === 'plans') { renderPlans(); show('plans'); }
        else { renderLog(); show('log'); }
      });
    });

    // Modal
    $('modal-ok').addEventListener('click', function () { closeModal(true); });
    $('modal-cancel').addEventListener('click', function () { closeModal(false); });

    // Versehentliches Schließen während des Laufs verhindern
    window.addEventListener('beforeunload', function (e) {
      if (state.currentRun.active) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /* ================= URL-Plan-Import ================= */
  // ?plan=2026-11-04 → lädt plans/2026-11-04.json und öffnet Pre-Run direkt
  function handleUrlPlan() {
    const slug = new URLSearchParams(window.location.search).get('plan');
    if (!slug) return;
    // Schon vorhanden? Dann direkt öffnen
    const existing = state.plans.find(function (p) { return p.id === 'plan-' + slug; });
    if (existing) { openPrerun(existing.id); return; }
    const url = 'plans/' + slug + '.json';
    fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error('Plan nicht gefunden (' + slug + ')');
        return r.json();
      })
      .then(function (data) {
        PlanManager.save(data);
        state.plans = PlanManager.getAll();
        renderPlans();
        toast('Plan \u201e' + data.name + '\u201c geladen', 'ok');
        openPrerun(data.id);
      })
      .catch(function (err) {
        console.warn('URL-Plan-Import:', err);
      });
  }

  /* ================= Init ================= */
  function init() {
    loadData();
    bind();
    renderPlans();
    renderLog();
    show('plans');
    $('app-version').textContent = APP_VERSION;
    handleUrlPlan();
    if (!Voice.isSupported()) {
      setTimeout(function () { toast('Sprachausgabe wird von diesem Browser nicht unterstützt.', 'error'); }, 500);
    }
  }

  window.PaceCoachState = state; // zum Debuggen
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
