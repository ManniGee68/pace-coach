/* PaceCoach – Telegram Auto-Export v1.0 */
(function (global) {
  'use strict';

  const KEY_TOKEN  = 'pacecoach_tg_token';
  const KEY_CHATID = 'pacecoach_tg_chatid';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtPace(sec) {
    sec = Math.round(sec);
    return Math.floor(sec / 60) + ':' + pad(sec % 60);
  }

  function fmtDate(iso) { // "2026-11-05" → "05.11.2026"
    var p = (iso || '').split('-');
    return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : (iso || '');
  }

  function logToJSON(log) {
    return {
      datum: fmtDate(log.date),
      plan: log.planName,
      distanz_km: Math.round((log.totalDistanceKm || 0) * 10) / 10,
      gesamtzeit: fmtPace(log.totalTimeSeconds || 0),
      avg_pace: fmtPace((log.avgPaceMin || 0) * 60 + (log.avgPaceSec || 0)),
      kilometer_splits: (log.kmSplits || []).map(function (s) {
        return { km: s.km, split: fmtPace(s.timeSeconds) };
      }),
      segment_auswertung: (log.segmentResults || []).map(function (s) {
        return { segment: s.name, soll: s.targetPace, ist: fmtPace(s.actualPaceSec) };
      })
    };
  }

  function post(token, chatId, text, onSuccess, onError) {
    fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text })
    })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r.ok) { if (onSuccess) onSuccess(); }
        else       { if (onError)  onError(r.description || 'Telegram-Fehler'); }
      })
      .catch(function (e) { if (onError) onError(e.message); });
  }

  var TelegramExport = {
    isConfigured: function () {
      var token  = localStorage.getItem(KEY_TOKEN)  || '';
      var chatId = localStorage.getItem(KEY_CHATID) || '';
      return token.length > 10 && chatId.length > 3;
    },
    getConfig: function () {
      return {
        token:  localStorage.getItem(KEY_TOKEN)  || '',
        chatId: localStorage.getItem(KEY_CHATID) || ''
      };
    },
    saveConfig: function (token, chatId) {
      localStorage.setItem(KEY_TOKEN,  token.trim());
      localStorage.setItem(KEY_CHATID, chatId.trim());
    },
    send: function (log, onSuccess, onError) {
      if (!this.isConfigured()) { if (onError) onError('Nicht konfiguriert'); return; }
      var c = this.getConfig();
      var text = JSON.stringify(logToJSON(log), null, 2);
      post(c.token, c.chatId, text, onSuccess, onError);
    },
    sendTest: function (onSuccess, onError) {
      if (!this.isConfigured()) { if (onError) onError('Nicht konfiguriert'); return; }
      var c = this.getConfig();
      post(c.token, c.chatId, '✅ PaceCoach Verbindungstest OK! Automatischer Export ist aktiv.', onSuccess, onError);
    }
  };

  // Auto-Setup via URL-Hash: #tg=TOKEN:CHATID
  // Wird nach dem Speichern aus der URL entfernt
  TelegramExport.tryAutoSetup = function () {
    var hash = window.location.hash;
    if (!hash || hash.indexOf('tg=') === -1) return false;
    try {
      var val = decodeURIComponent(hash.replace(/^#tg=/, ''));
      var sep = val.lastIndexOf(':');
      if (sep < 10) return false;
      var token  = val.substring(0, sep);
      var chatId = val.substring(sep + 1);
      if (token.length > 10 && chatId.length > 3) {
        TelegramExport.saveConfig(token, chatId);
        // Hash aus URL entfernen (kein Reload, kein Browser-Verlauf)
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }
        return true;
      }
    } catch (e) {}
    return false;
  };

  global.TelegramExport = TelegramExport;
})(window);
