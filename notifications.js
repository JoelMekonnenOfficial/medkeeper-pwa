/* MedKeeper notifications.
 * Two modes, both fully on-device (nothing is sent anywhere):
 * - Inside the iPhone app: reminder times are handed to iOS, which shows them as local
 *   notifications even when the app is closed. iOS keeps at most 64 pending notifications,
 *   so we schedule the next doses (up to 14 days / 59 reminders) and refresh the list every
 *   time the app is opened or a dose is logged.
 * - In a browser: Notification permission + setTimeout chains for the next 24h
 *   (these only fire while the page or its service worker is alive).
 */
(function () {
  'use strict';

  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const MAX_HORIZON = 24 * HOUR;
  const NATIVE_DAYS = 14;
  const NATIVE_MAX = 59; // + 1 "open the app" nudge = 60, under the iOS limit of 64
  const timers = new Set();

  function nativeHandlers() {
    try {
      const h = window.webkit && window.webkit.messageHandlers;
      return (h && h['local-reminders']) ? h : null;
    } catch (_) {
      return null;
    }
  }
  function isNative() { return !!nativeHandlers(); }

  function nativePost(action, items) {
    const h = nativeHandlers();
    if (!h) return;
    try {
      h['local-reminders'].postMessage(JSON.stringify({ action: action, items: items || [] }));
    } catch (_) { /* best-effort */ }
  }

  function supported() {
    return isNative() || 'Notification' in window;
  }

  function nativeRequestPermission() {
    return new Promise((resolve) => {
      const h = nativeHandlers();
      let done = false;
      function finish(v) {
        if (done) return;
        done = true;
        window.removeEventListener('push-permission-request', onResult);
        resolve(v);
      }
      function onResult(e) { finish(e && e.detail === 'granted' ? 'granted' : 'denied'); }
      window.addEventListener('push-permission-request', onResult);
      try {
        h['push-permission-request'].postMessage('request');
      } catch (_) {
        finish('denied');
      }
      setTimeout(() => finish('denied'), 2 * 60 * 1000);
    });
  }

  async function requestPermission() {
    if (isNative()) return nativeRequestPermission();
    if (!supported()) return 'unsupported';
    try {
      const res = await Notification.requestPermission();
      return res;
    } catch (e) {
      return 'denied';
    }
  }

  function clearTimers() {
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
  }

  function clearScheduled() {
    clearTimers();
    if (isNative()) nativePost('set', []);
  }

  function fireNotification(title, body, tag) {
    if (isNative()) {
      nativePost('add', [{ id: 'keep-' + (tag || 'now-' + Date.now()), title: title, body: body || '', at: Date.now() + 1500 }]);
      return;
    }
    if (!supported() || Notification.permission !== 'granted') return;
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body,
            tag: tag || 'medkeeper-dose',
            icon: 'icons/icon-192.png',
            badge: 'icons/icon-96.png',
            renotify: true,
            requireInteraction: false,
          }).catch(() => {
            try { new Notification(title, { body, tag, icon: 'icons/icon-192.png' }); } catch (_) { /* permission edge case */ }
          });
        });
      } else {
        new Notification(title, { body, tag, icon: 'icons/icon-192.png' });
      }
    } catch (e) {
      // Notification API is best-effort; never throw to UI.
    }
  }

  // One reminder at a given time (used for "snooze").
  function scheduleOnce(title, body, tag, atMs) {
    if (isNative()) {
      nativePost('add', [{ id: 'keep-' + tag, title: title, body: body || '', at: atMs }]);
      return;
    }
    const id = setTimeout(() => fireNotification(title, body, tag), Math.max(0, atMs - Date.now()));
    timers.add(id);
  }

  // Upcoming, not-yet-taken scheduled doses for the next `days` days, soonest first.
  function upcoming(meds, settings, logs, days) {
    const now = Date.now();
    const lead = parseInt((settings && settings.leadMinutes) || 0, 10);
    const out = [];
    for (const med of meds || []) {
      for (let dayOffset = 0; dayOffset < days; dayOffset++) {
        const day = new Date();
        day.setDate(day.getDate() + dayOffset);
        const slots = window.MK_SCHEDULE.slotsForDay(med, day, settings, logs)
          .filter((s) => s.kind === 'scheduled');
        for (const slot of slots) {
          const fireAt = slot.scheduledAt.getTime() - lead * MIN;
          if (fireAt - now <= 0) continue;
          const taken = (logs || []).some((l) =>
            l.medId === med.id && l.status === 'taken' &&
            Math.abs(l.scheduledAt - slot.scheduledAt.getTime()) < 4 * HOUR
          );
          if (taken) continue;
          out.push({
            id: 'med-' + med.id + '-' + slot.scheduledAt.getTime(),
            title: 'Time for ' + med.name,
            body: formatDose(med) + ' — ' + formatTime(slot.scheduledAt),
            at: fireAt,
          });
        }
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  async function reschedule(meds, settings, logs) {
    clearTimers();

    if (isNative()) {
      if (!settings || !settings.notifications) { nativePost('set', []); return 0; }
      const items = upcoming(meds, settings, logs, NATIVE_DAYS).slice(0, NATIVE_MAX);
      if (items.length) {
        items.push({
          id: 'refresh',
          title: 'Open MedKeeper to keep reminders on',
          body: 'Reminders are set a couple of weeks ahead. Open the app to schedule the next ones.',
          at: items[items.length - 1].at + 30 * MIN,
        });
      }
      nativePost('set', items);
      return items.length;
    }

    if (!supported() || Notification.permission !== 'granted') return 0;
    if (!settings || settings.notifications === false) return 0;

    const now = Date.now();
    let scheduledCount = 0;
    for (const item of upcoming(meds, settings, logs, 2)) {
      const delay = item.at - now;
      if (delay > MAX_HORIZON) continue;
      const id = setTimeout(() => fireNotification(item.title, item.body, item.id), delay);
      timers.add(id);
      scheduledCount++;
    }

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.ready;
        if (reg && 'periodicSync' in reg) {
          try {
            await reg.periodicSync.register('medkeeper-reschedule', { minInterval: 12 * HOUR });
          } catch (_) { /* permission not granted */ }
        }
      }
    } catch (_) { /* ignore */ }

    return scheduledCount;
  }

  function formatDose(med) {
    const u = med.unit || '';
    return (med.dose || '') + (u ? ' ' + u : '');
  }
  function formatTime(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  window.MK_NOTIF = {
    supported,
    isNative,
    requestPermission,
    reschedule,
    clearScheduled,
    fireNotification,
    scheduleOnce,
  };
})();
