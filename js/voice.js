/* PaceCoach – Sprachausgabe (Web Speech API, de-DE) */
(function (global) {
  'use strict';

  const synth = global.speechSynthesis || null;
  const LANG = 'de-DE';

  /** 308 → "5 Minuten 8", 390 → "6 Minuten 30", 300 → "5 Minuten", 68 → "1 Minute 8" */
  function formatPaceSpeech(totalSec) {
    const t = Math.max(0, Math.round(Number(totalSec) || 0));
    const m = Math.floor(t / 60);
    const s = t % 60;
    if (m === 0) return s + (s === 1 ? ' Sekunde' : ' Sekunden');
    const minWord = m === 1 ? 'Minute' : 'Minuten';
    return s === 0 ? m + ' ' + minWord : m + ' ' + minWord + ' ' + s;
  }

  /** Gesamtzeiten: ab 1 Stunde "1 Stunde 5 Minuten", sonst wie formatPaceSpeech */
  function formatDurationSpeech(totalSec) {
    const t = Math.max(0, Math.round(Number(totalSec) || 0));
    if (t < 3600) return formatPaceSpeech(t);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const hw = h === 1 ? 'Stunde' : 'Stunden';
    if (m === 0) return h + ' ' + hw;
    return h + ' ' + hw + ' ' + m + (m === 1 ? ' Minute' : ' Minuten');
  }

  /** "5:30" oder Zahl (Sekunden) → Sekunden */
  function toPaceSec(p) {
    if (typeof p === 'number') return p;
    const m = /^(\d+):(\d{1,2})$/.exec(String(p || '').trim());
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
  }

  function kmSpeech(km) {
    let s = (Math.round((Number(km) || 0) * 100) / 100).toString().replace('.', ',');
    return s + ' Kilometer';
  }

  let cachedVoice = null;
  function pickVoice() {
    if (!synth) return null;
    const voices = synth.getVoices() || [];
    if (cachedVoice && voices.indexOf(cachedVoice) >= 0) return cachedVoice;
    const de = voices.filter(function (v) { return /^de([-_]|$)/i.test(v.lang); });
    cachedVoice = de.find(function (v) { return v.lang.replace('_', '-') === LANG; }) || de[0] || null;
    return cachedVoice;
  }
  if (synth && typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', function () { cachedVoice = null; });
  }

  const Voice = {
    enabled: true,
    formatPaceSpeech: formatPaceSpeech,
    formatDurationSpeech: formatDurationSpeech,

    isSupported() { return !!(synth && global.SpeechSynthesisUtterance); },
    isBusy() { return !!(synth && (synth.speaking || synth.pending)); },

    /** Muss innerhalb eines Klicks aufgerufen werden (iOS/Safari verlangt eine Nutzer-Geste). */
    unlock() {
      if (!this.isSupported()) return;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        u.lang = LANG;
        synth.speak(u);
      } catch (e) { /* ignorieren */ }
    },

    speak(text) {
      if (!this.enabled || !this.isSupported() || !text) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = LANG;
        const v = pickVoice();
        if (v) u.voice = v;
        u.rate = 1;
        u.pitch = 1;
        u.volume = 1;
        synth.speak(u);
      } catch (e) { console.warn('Speech error', e); }
    },

    cancel() { if (synth) { try { synth.cancel(); } catch (e) { /* */ } } },

    onStart(planName, segment) {
      const dist = kmSpeech(segment.distance);
      const pace = formatPaceSpeech(Fmt.segPaceSec(segment));
      this.speak(planName + ' gestartet. Segment 1: ' + segment.name + ', ' + dist + ' bei ' + pace + '.');
    },

    onKm(km, splitSec, totalSec, avgPaceSec) {
      this.speak('Kilometer ' + km + '. Letzter Split: ' + formatPaceSpeech(splitSec) +
        '. Gesamtzeit: ' + formatDurationSpeech(totalSec) +
        '. Schnitt: ' + formatPaceSpeech(avgPaceSec) + '.');
    },

    onPaceWarning(deltaSec) {
      // Warnungen nicht stapeln: läuft gerade eine Ansage, entfällt die Warnung
      if (this.isBusy()) return;
      const d = Math.round(Math.abs(deltaSec));
      if (d === 0) return;
      const word = d === 1 ? 'Sekunde' : 'Sekunden';
      this.speak('Du bist ' + d + ' ' + word + (deltaSec > 0 ? ' zu langsam.' : ' zu schnell.'));
    },

    onSegmentChange(oldName, newName, distKm, paceStr) {
      this.speak(oldName + ' abgeschlossen. Jetzt: ' + newName + ' — ' + kmSpeech(distKm) +
        ' bei ' + formatPaceSpeech(toPaceSec(paceStr)) + '.');
    },

    onFinish(totalKm, totalSec, avgPaceSec) {
      this.speak('Lauf beendet! ' + kmSpeech(totalKm) + ' in ' + formatDurationSpeech(totalSec) +
        '. Durchschnitt ' + formatPaceSpeech(avgPaceSec) + ' pro Kilometer.');
    }
  };

  global.Voice = Voice;
})(window);
