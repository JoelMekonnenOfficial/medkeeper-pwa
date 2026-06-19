/* MedKeeper notifications.
 * - Requests Notification permission (called from a user gesture).
 * - Computes the next 24h of dose reminders and schedules them via setTimeout chains.
 * - On SW message, dispatches notifications from the page if it's open;
 *   otherwise the SW shows them itself.
 */
(function () {
  'use strict';

  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const MAX_HORIZON = 24 * HOUR;
  const timers = new Set();

  function supported() {
    return 'Notification' in window;
  }

  async function requestPermission() {
    if (!supported()) return 'unsupported';
    try {
      const res = await Notification.requestPermission();
      return res;
    } catch (e) {
      return 'denied';
    }
  }

  function clearScheduled() {
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
  }

  function fireNotification(title, body, tag) {
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

  // Build the next 24h of reminders for all medications.
  async function reschedule(meds, settings, logs) {
    clearScheduled();
    if (!supported() || Notification.permission !== 'granted') return 0;
    if (!settings || settings.notifications === false) return 0;

    const now = Date.now();
    const lead = parseInt(settings.leadMinutes || 0, 10);

    let scheduledCount = 0;
    for (const med of meds) {
      // For interval, fixed, meals — compute today + tomorrow slot
      for (const dayOffset of [0, 1]) {
        const day = new Date();
        day.setDate(day.getDate() + dayOffset);
        const slots = window.MK_SCHEDULE.slotsForDay(med, day, settings, logs)
          .filter((s) => s.kind === 'scheduled');
        for (const slot of slots) {
          const fireAt = slot.scheduledAt.getTime() - lead * MIN;
          const delay = fireAt - now;
          if (delay <= 0 || delay > MAX_HORIZON) continue;
          // Skip if already taken
          const taken = (logs || []).some((l) =>
            l.medId === med.id && l.status === 'taken' &&
            Math.abs(l.scheduledAt - slot.scheduledAt.getTime()) < 4 * HOUR
          );
          if (taken) continue;
          const title = 'Time for ' + med.name;
          const body = formatDose(med) + ' — ' + formatTime(slot.scheduledAt);
          const id = setTimeout(() => fireNotification(title, body, 'med-' + med.id + '-' + slot.scheduledAt.getTime()), delay);
          timers.add(id);
          scheduledCount++;
        }
      }
    }

    // Try registering periodic sync where supported (Android Chrome)
    if ('serviceWorker' in navigator && 'periodicSync' in (navigator.serviceWorker && {} || {})) {
      // The `periodicSync` interface lives on registration, not navigator.
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
    requestPermission,
    reschedule,
    clearScheduled,
    fireNotification,
  };
})();
