/* MedKeeper — main app orchestration. */
(function () {
  'use strict';

  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  // App state
  const state = {
    meds: [],
    logs: [],
    settings: null,
    selectedView: 'today',
    historyRange: 7,
    historyDay: null,
    deferredInstallPrompt: null,
    locked: false,
  };

  // -------------- Boot --------------

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => showAppError(err));
  });

  async function boot() {
    showLoading(true);
    try {
      // Register service worker
      if ('serviceWorker' in navigator) {
        try {
          await navigator.serviceWorker.register('sw.js', { scope: './' });
        } catch (e) {
          // Service worker is best-effort; the app still works without it.
        }
      }

      await window.MK_DB.open();
      state.settings = await window.MK_DB.allSettings();

      // PIN lock check
      if (state.settings.pinHash) {
        state.locked = true;
        showLockScreen();
        showLoading(false);
        return; // wait for unlock
      }

      await loadData();
      applyTheme(state.settings.theme);
      applyLargeText(state.settings.largeText);
      bindUI();
      bindInstallPrompt();
      if (!state.settings.onboarded) {
        showOnboarding();
      } else {
        showApp();
      }
    } catch (err) {
      showAppError(err);
    } finally {
      showLoading(false);
    }
  }

  function showLoading(show) {
    const l = document.getElementById('app-loading');
    if (l) l.hidden = !show;
  }
  function showAppError(err) {
    showLoading(false);
    const e = document.getElementById('app-error');
    const m = document.getElementById('app-error-message');
    if (m) m.textContent = (err && err.message) ? err.message : 'We could not start the app.';
    if (e) e.hidden = false;
    const retry = document.getElementById('app-error-retry');
    if (retry) {
      retry.onclick = () => { e.hidden = true; boot(); };
    }
  }

  async function loadData() {
    state.meds = await window.MK_DB.allMeds();
    state.logs = await window.MK_DB.allLogs();
    renderAll();
    // Re-schedule reminders
    try {
      await window.MK_NOTIF.reschedule(state.meds, state.settings, state.logs);
    } catch (_) { /* non-critical */ }
  }

  // -------------- Theme --------------

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
    else root.removeAttribute('data-theme');
  }
  function applyLargeText(on) {
    document.documentElement.setAttribute('data-largetext', on ? 'true' : 'false');
  }

  // -------------- UI binding --------------

  function bindUI() {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => selectView(tab.dataset.view));
    });

    document.querySelectorAll('[data-action="add-med"]').forEach((b) => {
      b.addEventListener('click', () => openMedDialog(null));
    });

    document.getElementById('theme-btn').addEventListener('click', cycleTheme);

    // History range
    document.querySelectorAll('#view-history .seg-btn[data-range]').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#view-history .seg-btn[data-range]').forEach((x) => x.setAttribute('aria-checked', 'false'));
        b.setAttribute('aria-checked', 'true');
        state.historyRange = parseInt(b.dataset.range, 10);
        renderHistory();
      });
    });

    document.getElementById('export-pdf').addEventListener('click', async () => {
      try {
        await window.MK_PDF.generate();
      } catch (e) {
        window.MK_UI.toast('Could not open print dialog');
      }
    });

    // Settings
    bindSettings();

    // Med dialog
    bindMedDialog();

    // Confirm dialog
    document.getElementById('confirm-cancel').addEventListener('click', () => {
      document.getElementById('confirm-dialog').close();
    });

    // Keyboard: Esc closes dialogs
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const open = document.querySelector('dialog[open]');
        if (open) open.close();
      }
    });

    // Periodic tick to refresh "due" statuses
    setInterval(() => {
      if (state.selectedView === 'today') renderToday();
    }, 30 * 1000);

    // Refresh reminders whenever the app comes back to the front
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        window.MK_NOTIF.reschedule(state.meds, state.settings, state.logs).catch(() => {});
      }
    });

    // SW message channel
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (ev) => {
        if (ev.data && ev.data.type === 'wake-reschedule') {
          window.MK_NOTIF.reschedule(state.meds, state.settings, state.logs).catch(() => {});
        }
      });
    }

    // Onboarding
    bindOnboarding();
    // Lock
    bindLock();
  }

  function bindSettings() {
    // Meals
    document.getElementById('meal-breakfast').value = state.settings.meals.breakfast || '08:00';
    document.getElementById('meal-lunch').value = state.settings.meals.lunch || '12:30';
    document.getElementById('meal-dinner').value = state.settings.meals.dinner || '18:30';

    ['meal-breakfast', 'meal-lunch', 'meal-dinner'].forEach((id) => {
      document.getElementById(id).addEventListener('change', async (e) => {
        const meals = { ...state.settings.meals };
        meals[id.replace('meal-', '')] = e.target.value;
        state.settings.meals = meals;
        await window.MK_DB.setSetting('meals', meals);
        window.MK_UI.toast('Meal times saved');
        await window.MK_NOTIF.reschedule(state.meds, state.settings, state.logs);
        renderToday();
      });
    });

    // Notifications
    const notif = document.getElementById('set-notifications');
    notif.checked = !!state.settings.notifications;
    notif.addEventListener('change', async (e) => {
      if (e.target.checked) {
        const perm = await window.MK_NOTIF.requestPermission();
        if (perm !== 'granted') {
          e.target.checked = false;
          window.MK_UI.toast('Permission denied — reminders off');
          state.settings.notifications = false;
          await window.MK_DB.setSetting('notifications', false);
          return;
        }
        state.settings.notifications = true;
        await window.MK_DB.setSetting('notifications', true);
        await window.MK_NOTIF.reschedule(state.meds, state.settings, state.logs);
        window.MK_UI.toast('Reminders enabled');
      } else {
        state.settings.notifications = false;
        await window.MK_DB.setSetting('notifications', false);
        window.MK_NOTIF.clearScheduled();
        window.MK_UI.toast('Reminders disabled');
      }
    });

    const lead = document.getElementById('set-leadtime');
    lead.value = String(state.settings.leadMinutes || 0);
    lead.addEventListener('change', async (e) => {
      state.settings.leadMinutes = parseInt(e.target.value, 10);
      await window.MK_DB.setSetting('leadMinutes', state.settings.leadMinutes);
      await window.MK_NOTIF.reschedule(state.meds, state.settings, state.logs);
    });

    // Theme
    const theme = document.getElementById('set-theme');
    theme.value = state.settings.theme || 'auto';
    theme.addEventListener('change', async (e) => {
      state.settings.theme = e.target.value;
      await window.MK_DB.setSetting('theme', e.target.value);
      applyTheme(e.target.value);
    });

    // Large text
    const lt = document.getElementById('set-largetext');
    lt.checked = !!state.settings.largeText;
    lt.addEventListener('change', async (e) => {
      state.settings.largeText = e.target.checked;
      await window.MK_DB.setSetting('largeText', e.target.checked);
      applyLargeText(e.target.checked);
    });

    // PIN
    bindPinSettings();

    // Data
    document.getElementById('data-export').addEventListener('click', exportBackup);
    document.getElementById('data-share').addEventListener('click', shareSchedule);
    document.getElementById('data-import').addEventListener('click', () => {
      document.getElementById('data-import-file').click();
    });
    document.getElementById('data-import-file').addEventListener('change', importBackup);
    document.getElementById('data-clear').addEventListener('click', clearAllData);
  }

  function bindPinSettings() {
    const row = document.getElementById('pin-set-row');
    const clearRow = document.getElementById('pin-clear-row');
    const has = !!state.settings.pinHash;
    row.hidden = has;
    clearRow.hidden = !has;
    document.getElementById('set-pin-save').addEventListener('click', async () => {
      const v = document.getElementById('set-pin').value;
      if (!/^[0-9]{4}$/.test(v)) {
        window.MK_UI.toast('Use a 4-digit PIN');
        return;
      }
      const salt = randomSalt();
      const hash = await hashPin(v, salt);
      state.settings.pinHash = hash;
      state.settings.pinSalt = salt;
      await window.MK_DB.setSetting('pinHash', hash);
      await window.MK_DB.setSetting('pinSalt', salt);
      window.MK_UI.toast('PIN set');
      document.getElementById('set-pin').value = '';
      row.hidden = true;
      clearRow.hidden = false;
    });
    document.getElementById('set-pin-clear').addEventListener('click', async () => {
      askConfirm('Remove PIN?', 'You can set a new PIN any time.', async () => {
        state.settings.pinHash = null;
        state.settings.pinSalt = null;
        await window.MK_DB.setSetting('pinHash', null);
        await window.MK_DB.setSetting('pinSalt', null);
        row.hidden = false;
        clearRow.hidden = true;
        window.MK_UI.toast('PIN removed');
      });
    });
  }

  function randomSalt() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function hashPin(pin, salt) {
    const enc = new TextEncoder();
    const data = enc.encode(salt + ':' + pin);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const idx = order.indexOf(state.settings.theme || 'auto');
    const next = order[(idx + 1) % order.length];
    state.settings.theme = next;
    document.getElementById('set-theme').value = next;
    window.MK_DB.setSetting('theme', next);
    applyTheme(next);
    window.MK_UI.toast('Theme: ' + next);
  }

  // -------------- Onboarding --------------

  function showOnboarding() {
    const o = document.getElementById('onboarding');
    o.hidden = false;
    o.setAttribute('aria-hidden', 'false');
    document.querySelector('main.app-main').setAttribute('aria-hidden', 'true');
  }
  function hideOnboarding() {
    const o = document.getElementById('onboarding');
    o.hidden = true;
    o.setAttribute('aria-hidden', 'true');
    document.querySelector('main.app-main').setAttribute('aria-hidden', 'false');
  }
  function bindOnboarding() {
    let step = 1;
    const steps = document.querySelectorAll('.onboard-step');
    const dots = document.querySelectorAll('.onboard-progress .dot');
    function show(n) {
      steps.forEach((s, i) => { s.hidden = i + 1 !== n; });
      dots.forEach((d, i) => { d.classList.toggle('active', i + 1 === n); });
    }
    document.querySelectorAll('[data-onb-next]').forEach((b) => {
      b.addEventListener('click', () => {
        step += 1;
        if (step > 3) finish(false);
        else show(step);
      });
    });
    document.querySelector('[data-onb-skip-notif]').addEventListener('click', () => finish(false));
    document.querySelector('[data-onb-enable-notif]').addEventListener('click', async () => {
      const perm = await window.MK_NOTIF.requestPermission();
      if (perm === 'granted') {
        state.settings.notifications = true;
        await window.MK_DB.setSetting('notifications', true);
      }
      finish(true);
    });
    async function finish(_enabled) {
      state.settings.onboarded = true;
      await window.MK_DB.setSetting('onboarded', true);
      hideOnboarding();
      showApp();
      // Prompt to add first medication
      if (state.meds.length === 0) openMedDialog(null);
    }
    show(step);
  }

  // -------------- Lock --------------

  function showLockScreen() {
    document.getElementById('lock-screen').hidden = false;
    document.querySelector('main.app-main').setAttribute('aria-hidden', 'true');
    document.querySelector('.app-header').setAttribute('aria-hidden', 'true');
    document.querySelector('.tabs').setAttribute('aria-hidden', 'true');
    document.getElementById('lock-pin').focus();
  }
  function hideLockScreen() {
    document.getElementById('lock-screen').hidden = true;
    document.querySelector('main.app-main').setAttribute('aria-hidden', 'false');
    document.querySelector('.app-header').setAttribute('aria-hidden', 'false');
    document.querySelector('.tabs').setAttribute('aria-hidden', 'false');
  }
  function bindLock() {
    const form = document.getElementById('lock-form');
    if (!form) return;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = document.getElementById('lock-pin').value;
      if (!/^[0-9]{4}$/.test(pin)) {
        showLockError('Enter a 4-digit PIN');
        return;
      }
      const salt = state.settings && state.settings.pinSalt;
      const hash = await hashPin(pin, salt || '');
      if (hash !== state.settings.pinHash) {
        showLockError('Incorrect PIN');
        try { navigator.vibrate && navigator.vibrate([60, 80, 60]); } catch (_) {}
        return;
      }
      state.locked = false;
      hideLockScreen();
      await loadData();
      applyTheme(state.settings.theme);
      applyLargeText(state.settings.largeText);
      bindUI();
      bindInstallPrompt();
      if (!state.settings.onboarded) showOnboarding();
      else showApp();
    });
  }
  function showLockError(msg) {
    const e = document.getElementById('lock-error');
    e.textContent = msg;
    e.hidden = false;
  }

  function showApp() {
    document.querySelector('main.app-main').setAttribute('aria-hidden', 'false');
    renderAll();
  }

  // -------------- Views --------------

  function selectView(view) {
    state.selectedView = view;
    document.querySelectorAll('.tab').forEach((t) => {
      t.setAttribute('aria-selected', t.dataset.view === view ? 'true' : 'false');
    });
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = v.id !== 'view-' + view;
    });
    renderAll();
  }

  function renderAll() {
    renderToday();
    renderMeds();
    renderHistory();
  }

  // -------------- Today view --------------

  function renderToday() {
    const list = document.getElementById('today-list');
    const empty = document.getElementById('today-empty');
    const summary = document.getElementById('today-summary');
    const dateEl = document.getElementById('today-date');
    list.innerHTML = '';
    const today = new Date();
    dateEl.textContent = today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    if (state.meds.length === 0) {
      empty.hidden = false;
      summary.hidden = true;
      return;
    }
    empty.hidden = true;

    // Build slots for today
    const items = [];
    state.meds.forEach((m) => {
      const slots = window.MK_SCHEDULE.slotsForDay(m, today, state.settings, state.logs);
      slots.forEach((slot) => {
        const status = window.MK_SCHEDULE.statusFor(m, slot, Date.now(), state.logs);
        items.push({ med: m, slot, status });
      });
    });

    // Sort: time order; PRN sorted last by name; available/wait grouped at end
    items.sort((a, b) => {
      const aTs = a.slot.scheduledAt.getTime();
      const bTs = b.slot.scheduledAt.getTime();
      if (a.slot.kind === 'prn' && b.slot.kind !== 'prn') return 1;
      if (b.slot.kind === 'prn' && a.slot.kind !== 'prn') return -1;
      return aTs - bTs;
    });

    items.forEach(({ med, slot, status }) => list.appendChild(renderDoseCard(med, slot, status)));

    // Adherence summary 7d
    const from = new Date(); from.setDate(from.getDate() - 7);
    const adh = window.MK_SCHEDULE.adherence(state.meds, state.logs, from, new Date(), state.settings);
    if (adh.scheduled > 0) {
      summary.hidden = false;
      document.getElementById('today-adherence').textContent =
        Math.round(adh.ratio * 100) + '%   (' + adh.taken + ' of ' + adh.scheduled + ' doses)';
    } else {
      summary.hidden = true;
    }
  }

  function renderDoseCard(med, slot, status) {
    const card = window.MK_UI.el('li', { class: 'dose-item ' + (status.status === 'taken' ? 'taken' : status.status === 'overdue' ? 'overdue' : status.status === 'due' ? 'due' : '') });
    card.setAttribute('aria-label', med.name + ' ' + (slot.kind === 'prn' ? 'as needed' : new Date(slot.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    const swatch = window.MK_UI.el('span', { class: 'swatch', style: 'background:' + (med.color || '#2563EB') });
    const main = window.MK_UI.el('div', { class: 'dose-main' });
    main.appendChild(window.MK_UI.el('div', { class: 'dose-name' }, med.name + ' — ' + (med.dose || '') + ' ' + (med.unit || '')));
    const meta = window.MK_UI.el('div', { class: 'dose-meta' });
    if (slot.kind === 'prn') {
      meta.textContent = 'As needed' + (med.schedule && med.schedule.minHours ? ' · min ' + med.schedule.minHours + ' h apart' : '');
    } else {
      meta.textContent = new Date(slot.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) +
        (med.notes ? ' · ' + med.notes : '');
    }
    main.appendChild(meta);

    // Supply warning
    const daysLeft = window.MK_SCHEDULE.projectSupplyDaysLeft(med, state.logs);
    if (isFinite(daysLeft) && med.supply > 0 && daysLeft <= 7) {
      const w = window.MK_UI.el('div', { class: 'dose-meta', style: 'color:var(--warn);font-weight:700;' },
        'Low supply — ' + daysLeft + ' days left'
      );
      main.appendChild(w);
    }

    const actions = window.MK_UI.el('div', { class: 'dose-actions' });
    const badge = window.MK_UI.el('span', { class: 'dose-status ' + status.status }, window.MK_UI.statusLabel(status));
    actions.appendChild(badge);

    if (status.status !== 'taken' && status.status !== 'skipped' && status.status !== 'wait') {
      const take = window.MK_UI.el('button', { class: 'btn btn-primary btn-small', 'aria-label': 'Mark ' + med.name + ' as taken' }, 'Take');
      take.addEventListener('click', () => onTake(med, slot));
      actions.appendChild(take);

      if (slot.kind !== 'prn') {
        const skip = window.MK_UI.el('button', { class: 'btn btn-secondary btn-small', 'aria-label': 'Skip ' + med.name }, 'Skip');
        skip.addEventListener('click', () => onSkip(med, slot));
        actions.appendChild(skip);
        const snooze = window.MK_UI.el('button', { class: 'btn btn-ghost btn-small', 'aria-label': 'Snooze ' + med.name + ' 15 minutes' }, 'Snooze 15m');
        snooze.addEventListener('click', () => onSnooze(med, slot));
        actions.appendChild(snooze);
      }
    } else if (status.status === 'taken' && status.logId) {
      const undo = window.MK_UI.el('button', { class: 'btn btn-ghost btn-small', 'aria-label': 'Undo take of ' + med.name }, 'Undo');
      undo.addEventListener('click', () => onUndo(status.logId, med));
      actions.appendChild(undo);
    }

    card.appendChild(swatch);
    card.appendChild(main);
    card.appendChild(actions);
    return card;
  }

  async function onTake(med, slot) {
    try {
      const log = {
        id: window.MK_DB.uid(),
        medId: med.id,
        scheduledAt: slot.scheduledAt.getTime(),
        takenAt: Date.now(),
        status: 'taken',
      };
      await window.MK_DB.putLog(log);
      // Decrement supply
      const perDose = parseFloat(med.perDose || 1);
      if (med.supply != null && med.supply > 0) {
        med.supply = Math.max(0, parseFloat(med.supply) - perDose);
        await window.MK_DB.putMed(med);
      }
      try { navigator.vibrate && navigator.vibrate(30); } catch (_) {}
      window.MK_UI.announce(med.name + ' marked as taken');
      window.MK_UI.toast(med.name + ' — taken');
      await loadData();
    } catch (e) {
      window.MK_UI.toast('Could not log dose');
    }
  }
  async function onSkip(med, slot) {
    try {
      const log = {
        id: window.MK_DB.uid(),
        medId: med.id,
        scheduledAt: slot.scheduledAt.getTime(),
        takenAt: null,
        status: 'skipped',
      };
      await window.MK_DB.putLog(log);
      try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch (_) {}
      window.MK_UI.announce(med.name + ' skipped');
      window.MK_UI.toast(med.name + ' — skipped');
      await loadData();
    } catch (e) {
      window.MK_UI.toast('Could not log skip');
    }
  }
  async function onSnooze(med, slot) {
    if (!state.settings.notifications) {
      window.MK_UI.toast('Reminders are off — turn on in Settings to snooze');
      return;
    }
    const fireAt = Date.now() + 15 * MIN;
    window.MK_NOTIF.scheduleOnce('Snoozed: ' + med.name,
      (med.dose || '') + ' ' + (med.unit || ''),
      'snooze-' + med.id + '-' + slot.scheduledAt.getTime(), fireAt);
    window.MK_UI.toast('Snoozed 15 minutes');
    window.MK_UI.announce('Snoozed ' + med.name + ' for 15 minutes');
    try { navigator.vibrate && navigator.vibrate(20); } catch (_) {}
  }
  async function onUndo(logId, med) {
    try {
      await window.MK_DB.deleteLog(logId);
      // Refund supply
      const perDose = parseFloat(med.perDose || 1);
      if (med.supply != null) {
        med.supply = parseFloat(med.supply || 0) + perDose;
        await window.MK_DB.putMed(med);
      }
      window.MK_UI.announce('Undid take of ' + med.name);
      window.MK_UI.toast('Undone');
      await loadData();
    } catch (e) {
      window.MK_UI.toast('Could not undo');
    }
  }

  // -------------- Meds view --------------

  function renderMeds() {
    const list = document.getElementById('meds-list');
    const empty = document.getElementById('meds-empty');
    list.innerHTML = '';
    if (state.meds.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    state.meds
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((m) => list.appendChild(renderMedCard(m)));
  }
  function renderMedCard(m) {
    const li = window.MK_UI.el('li', { class: 'med-item' });
    li.appendChild(window.MK_UI.el('span', { class: 'swatch', style: 'background:' + (m.color || '#2563EB') }));
    const body = window.MK_UI.el('div', {});
    body.appendChild(window.MK_UI.el('div', { class: 'dose-name' }, m.name + ' — ' + (m.dose || '') + ' ' + (m.unit || '')));
    const schedText = scheduleSummary(m);
    body.appendChild(window.MK_UI.el('div', { class: 'med-meta' }, schedText));
    if (m.supply != null && m.supply > 0) {
      const daysLeft = window.MK_SCHEDULE.projectSupplyDaysLeft(m, state.logs);
      const supplyText = m.supply + ' on hand' + (isFinite(daysLeft) ? ' · ~' + daysLeft + ' days' : '');
      const sd = window.MK_UI.el('div', { class: 'med-meta med-supply' + (isFinite(daysLeft) && daysLeft <= 7 ? ' low' : '') }, supplyText);
      body.appendChild(sd);
    }
    li.appendChild(body);

    const actions = window.MK_UI.el('div', { class: 'dose-actions' });
    const refill = window.MK_UI.el('button', { class: 'btn btn-secondary btn-small', 'aria-label': 'I refilled ' + m.name }, 'Refilled');
    refill.addEventListener('click', () => onRefill(m));
    actions.appendChild(refill);
    const edit = window.MK_UI.el('button', { class: 'btn btn-primary btn-small', 'aria-label': 'Edit ' + m.name }, 'Edit');
    edit.addEventListener('click', () => openMedDialog(m));
    actions.appendChild(edit);
    li.appendChild(actions);
    return li;
  }
  function scheduleSummary(m) {
    const s = m.schedule || {};
    if (s.type === 'fixed') return 'Fixed times: ' + ((s.times || []).join(', ') || '—');
    if (s.type === 'interval') return 'Every ' + s.hours + ' h (from ' + (s.start || '08:00') + ')';
    if (s.type === 'meals') {
      const f = s.meals || {};
      return 'With meals: ' + [f.breakfast && 'Breakfast', f.lunch && 'Lunch', f.dinner && 'Dinner'].filter(Boolean).join(', ');
    }
    if (s.type === 'prn') return 'As needed (PRN)' + (s.minHours ? ' · min ' + s.minHours + ' h' : '');
    return '—';
  }
  async function onRefill(m) {
    const inputDialog = window.prompt('Refill ' + m.name + ' — how many units (pills, ml, etc.) to add?', '30');
    if (inputDialog == null) return;
    const n = parseFloat(inputDialog);
    if (!isFinite(n) || n <= 0) {
      window.MK_UI.toast('Enter a positive number');
      return;
    }
    m.supply = parseFloat(m.supply || 0) + n;
    try {
      await window.MK_DB.putMed(m);
      window.MK_UI.toast('Refilled — ' + m.supply + ' on hand');
      await loadData();
    } catch (e) {
      window.MK_UI.toast('Could not save refill');
    }
  }

  // -------------- History view --------------

  function renderHistory() {
    const range = state.historyRange;
    const now = new Date();
    const from = new Date(); from.setDate(from.getDate() - (range - 1));
    from.setHours(0, 0, 0, 0);

    const empty = document.getElementById('history-empty');
    if (state.logs.length === 0 && state.meds.length === 0) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }

    // Overall + per-med stats
    const overall = window.MK_SCHEDULE.adherence(state.meds, state.logs, from, now, state.settings);
    const grid = document.getElementById('history-stats');
    grid.innerHTML = '';

    const overallCard = window.MK_UI.el('div', { class: 'stat' });
    overallCard.appendChild(window.MK_UI.el('div', { class: 'stat-label' }, 'Overall (' + range + 'd)'));
    overallCard.appendChild(window.MK_UI.el('div', { class: 'stat-value' }, overall.scheduled > 0 ? Math.round(overall.ratio * 100) + '%' : '—'));
    overallCard.appendChild(window.MK_UI.el('div', { class: 'stat-label' }, overall.taken + ' taken · ' + overall.skipped + ' skipped · ' + (overall.scheduled - overall.taken - overall.skipped) + ' missed'));
    grid.appendChild(overallCard);

    state.meds.forEach((m) => {
      const a = window.MK_SCHEDULE.adherence([m], state.logs, from, now, state.settings);
      const c = window.MK_UI.el('div', { class: 'stat' });
      c.appendChild(window.MK_UI.el('div', { class: 'stat-label' }, m.name));
      c.appendChild(window.MK_UI.el('div', { class: 'stat-value' }, a.scheduled > 0 ? Math.round(a.ratio * 100) + '%' : '—'));
      c.appendChild(window.MK_UI.el('div', { class: 'stat-label' }, a.taken + '/' + a.scheduled));
      grid.appendChild(c);
    });

    // Heatmap — 6 rows x 7 cols (last 42 days)
    const heat = document.getElementById('history-heatmap');
    heat.innerHTML = '';
    const cells = 42;
    const start = new Date();
    start.setDate(start.getDate() - (cells - 1));
    start.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < cells; i++) {
      const d = new Date(start); d.setDate(d.getDate() + i);
      const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
      const future = d > today;
      const adh = future ? null : window.MK_SCHEDULE.adherence(state.meds, state.logs, d, d, state.settings);
      const cell = window.MK_UI.el('button', { class: 'heat-cell', type: 'button', 'aria-label': d.toDateString() });
      if (future) cell.classList.add('future');
      else if (adh.scheduled === 0) {
        // nothing scheduled
      } else if (adh.ratio >= 0.95) cell.classList.add('adh-3');
      else if (adh.ratio >= 0.7) cell.classList.add('adh-2');
      else if (adh.ratio >= 0.4) cell.classList.add('adh-low');
      else cell.classList.add('adh-miss');
      cell.addEventListener('click', () => showDay(d));
      heat.appendChild(cell);
    }

    // Day panel
    if (state.historyDay) {
      showDay(new Date(state.historyDay));
    }
  }
  function showDay(d) {
    state.historyDay = d.getTime();
    const panel = document.getElementById('history-day-panel');
    panel.hidden = false;
    document.getElementById('history-day-title').textContent =
      'Doses — ' + d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const ul = document.getElementById('history-day-list');
    ul.innerHTML = '';
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);

    const items = [];
    state.meds.forEach((m) => {
      const slots = window.MK_SCHEDULE.slotsForDay(m, dayStart, state.settings, state.logs).filter((s) => s.kind === 'scheduled');
      slots.forEach((slot) => {
        if (slot.scheduledAt > new Date()) return; // skip future
        const log = state.logs.find((l) => l.medId === m.id && Math.abs(l.scheduledAt - slot.scheduledAt.getTime()) < 4 * HOUR);
        items.push({ med: m, slot, log });
      });
    });
    if (items.length === 0) {
      ul.appendChild(window.MK_UI.el('li', { class: 'muted' }, 'No scheduled doses on this day.'));
      return;
    }
    items.sort((a, b) => a.slot.scheduledAt - b.slot.scheduledAt);
    items.forEach((it) => {
      const li = window.MK_UI.el('li');
      li.appendChild(window.MK_UI.el('span', {}, it.med.name + ' — ' + new Date(it.slot.scheduledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      const status = it.log ? it.log.status : 'missed';
      li.appendChild(window.MK_UI.el('span', { class: 'dose-status ' + status }, status));
      ul.appendChild(li);
    });
  }

  // -------------- Med dialog --------------

  function bindMedDialog() {
    const dlg = document.getElementById('med-dialog');
    dlg.querySelectorAll('[data-close-dialog]').forEach((b) => b.addEventListener('click', () => dlg.close()));

    // Schedule segmented control
    const segButtons = dlg.querySelectorAll('.seg-btn[data-schedule]');
    segButtons.forEach((b) => {
      b.addEventListener('click', () => {
        segButtons.forEach((x) => x.setAttribute('aria-checked', 'false'));
        b.setAttribute('aria-checked', 'true');
        const which = b.dataset.schedule;
        dlg.querySelectorAll('.sched-panel').forEach((p) => { p.hidden = p.dataset.panel !== which; });
        checkNightWarning();
      });
    });

    // Fixed times
    document.getElementById('fixed-add').addEventListener('click', () => {
      window.MK_UI.addTimeRow(document.getElementById('fixed-times'), '08:00');
      checkNightWarning();
    });
    document.getElementById('fixed-times').addEventListener('change', checkNightWarning);
    document.getElementById('interval-start').addEventListener('change', checkNightWarning);

    // Submit
    document.getElementById('med-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveMedFromDialog();
    });
    // Also handle the explicit "Save" button click since the form is method=dialog
    document.querySelector('#med-form button[type="submit"]').addEventListener('click', async (e) => {
      e.preventDefault();
      await saveMedFromDialog();
    });

    document.getElementById('med-delete').addEventListener('click', deleteMedFromDialog);
  }

  function checkNightWarning() {
    const dlg = document.getElementById('med-dialog');
    const which = dlg.querySelector('.seg-btn[data-schedule][aria-checked="true"]').dataset.schedule;
    const warn = document.getElementById('night-warn');
    let isNight = false;
    if (which === 'fixed') {
      const times = window.MK_UI.readFixedTimes(document.getElementById('fixed-times'));
      isNight = times.some((t) => window.MK_SCHEDULE.isNightHour(t));
    } else if (which === 'interval') {
      const t = document.getElementById('interval-start').value;
      isNight = window.MK_SCHEDULE.isNightHour(t || '08:00');
    }
    warn.hidden = !isNight;
  }

  function openMedDialog(med) {
    const dlg = document.getElementById('med-dialog');
    document.getElementById('med-dialog-title').textContent = med ? 'Edit medication' : 'Add medication';
    document.getElementById('med-form-error').hidden = true;
    document.getElementById('med-form-error').textContent = '';
    // Reset field errors
    dlg.querySelectorAll('.field-error').forEach((e) => e.textContent = '');

    document.getElementById('med-id').value = med ? med.id : '';
    document.getElementById('med-name').value = med ? med.name : '';
    document.getElementById('med-dose').value = med ? (med.dose || '') : '';
    document.getElementById('med-unit').value = med ? (med.unit || 'mg') : 'mg';
    document.getElementById('med-prescriber').value = med ? (med.prescriber || '') : '';
    document.getElementById('med-start').value = med && med.startDate ? med.startDate : '';
    document.getElementById('med-end').value = med && med.endDate ? med.endDate : '';
    document.getElementById('med-supply').value = med && med.supply != null ? med.supply : '';
    document.getElementById('med-perdose').value = med && med.perDose != null ? med.perDose : 1;
    document.getElementById('med-notes').value = med ? (med.notes || '') : '';

    window.MK_UI.buildColorRow(document.getElementById('color-row'), med ? med.color : '#2563EB');
    window.MK_UI.buildShapeRow(document.getElementById('shape-row'), med ? med.shape : 'Round');

    // Schedule
    const sched = (med && med.schedule) || { type: 'fixed', times: ['08:00'] };
    dlg.querySelectorAll('.seg-btn[data-schedule]').forEach((b) => {
      b.setAttribute('aria-checked', b.dataset.schedule === sched.type ? 'true' : 'false');
    });
    dlg.querySelectorAll('.sched-panel').forEach((p) => { p.hidden = p.dataset.panel !== sched.type; });

    window.MK_UI.buildFixedTimes(document.getElementById('fixed-times'), sched.type === 'fixed' ? sched.times : ['08:00']);
    document.getElementById('interval-hours').value = sched.type === 'interval' ? (sched.hours || 8) : 8;
    document.getElementById('interval-start').value = sched.type === 'interval' ? (sched.start || '08:00') : '08:00';
    dlg.querySelectorAll('[data-meal]').forEach((cb) => {
      cb.checked = sched.type === 'meals' && sched.meals && !!sched.meals[cb.dataset.meal];
    });
    document.getElementById('prn-min').value = sched.type === 'prn' ? (sched.minHours || 4) : 4;

    // Missed rule
    const missed = (med && med.missed) || { rule: 'skip', asapHours: 2 };
    document.querySelectorAll('input[name=missed]').forEach((r) => { r.checked = r.value === missed.rule; });
    document.getElementById('missed-asap-hours').value = missed.asapHours || 2;

    document.getElementById('med-delete').hidden = !med;

    checkNightWarning();

    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => document.getElementById('med-name').focus(), 50);
  }

  async function saveMedFromDialog() {
    const dlg = document.getElementById('med-dialog');
    const id = document.getElementById('med-id').value || null;
    const name = document.getElementById('med-name').value.trim();
    const dose = document.getElementById('med-dose').value;
    const unit = document.getElementById('med-unit').value;
    const color = window.MK_UI.getRadioValue(document.getElementById('color-row')) || '#2563EB';
    const shape = window.MK_UI.getRadioValue(document.getElementById('shape-row')) || 'Round';
    const prescriber = document.getElementById('med-prescriber').value.trim();
    const startDate = document.getElementById('med-start').value || null;
    const endDate = document.getElementById('med-end').value || null;
    const supply = document.getElementById('med-supply').value;
    const perDose = parseFloat(document.getElementById('med-perdose').value || 1);
    const notes = document.getElementById('med-notes').value.trim();

    // Validation
    const nameErr = dlg.querySelector('[data-for=med-name]');
    nameErr.textContent = '';
    if (!name) { nameErr.textContent = 'Name is required.'; document.getElementById('med-name').focus(); return; }
    if (!dose || parseFloat(dose) < 0) {
      showFormError('Dose amount is required and cannot be negative.');
      document.getElementById('med-dose').focus();
      return;
    }
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) {
      showFormError('End date must be after start date.');
      return;
    }

    const which = dlg.querySelector('.seg-btn[data-schedule][aria-checked="true"]').dataset.schedule;
    let schedule;
    if (which === 'fixed') {
      const times = window.MK_UI.readFixedTimes(document.getElementById('fixed-times'));
      if (times.length === 0) { showFormError('Add at least one dose time.'); return; }
      schedule = { type: 'fixed', times };
    } else if (which === 'interval') {
      const hours = parseFloat(document.getElementById('interval-hours').value);
      if (!isFinite(hours) || hours <= 0 || hours > 48) { showFormError('Interval must be between 1 and 48 hours.'); return; }
      schedule = { type: 'interval', hours, start: document.getElementById('interval-start').value || '08:00' };
    } else if (which === 'meals') {
      const meals = {};
      dlg.querySelectorAll('[data-meal]').forEach((cb) => { meals[cb.dataset.meal] = cb.checked; });
      if (!meals.breakfast && !meals.lunch && !meals.dinner) { showFormError('Pick at least one meal.'); return; }
      schedule = { type: 'meals', meals };
    } else if (which === 'prn') {
      const minHours = parseFloat(document.getElementById('prn-min').value || 0);
      schedule = { type: 'prn', minHours: isFinite(minHours) ? minHours : 0 };
    }

    const rule = document.querySelector('input[name=missed]:checked').value;
    const missed = { rule, asapHours: parseFloat(document.getElementById('missed-asap-hours').value || 2) };

    const med = {
      id, name,
      dose: parseFloat(dose),
      unit, color, shape,
      prescriber: prescriber || '',
      startDate, endDate,
      supply: supply === '' ? 0 : parseFloat(supply),
      perDose: perDose || 1,
      notes,
      schedule, missed,
    };

    try {
      await window.MK_DB.putMed(med);
      dlg.close();
      window.MK_UI.toast(id ? 'Medication updated' : 'Medication added');
      window.MK_UI.announce(med.name + (id ? ' updated' : ' added'));
      await loadData();
      selectView(state.meds.length === 1 ? 'today' : state.selectedView);
    } catch (e) {
      showFormError('Could not save: ' + e.message);
    }
  }

  function showFormError(msg) {
    const e = document.getElementById('med-form-error');
    e.textContent = msg;
    e.hidden = false;
  }

  function deleteMedFromDialog() {
    const id = document.getElementById('med-id').value;
    if (!id) return;
    const med = state.meds.find((m) => m.id === id);
    askConfirm('Delete medication?', 'This will also delete all dose logs for ' + (med ? med.name : 'this medication') + '. Cannot be undone.', async () => {
      await window.MK_DB.deleteMed(id);
      document.getElementById('med-dialog').close();
      window.MK_UI.toast('Deleted');
      await loadData();
    });
  }

  // -------------- Confirm dialog --------------

  function askConfirm(title, body, onOk) {
    const dlg = document.getElementById('confirm-dialog');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-body').textContent = body;
    const ok = document.getElementById('confirm-ok');
    const newOk = ok.cloneNode(true);
    ok.replaceWith(newOk);
    newOk.addEventListener('click', () => {
      dlg.close();
      onOk();
    });
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  // -------------- Data ports --------------

  async function exportBackup() {
    try {
      const data = await window.MK_DB.exportAll();
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const filename = 'medkeeper-backup-' + new Date().toISOString().slice(0, 10) + '.json';

      if ('showSaveFilePicker' in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{ description: 'MedKeeper backup', accept: { 'application/json': ['.json'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          window.MK_UI.toast('Backup saved');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          // fall through to <a download>
        }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
      window.MK_UI.toast('Backup downloaded');
    } catch (e) {
      window.MK_UI.toast('Could not export backup');
    }
  }

  async function importBackup(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      askConfirm('Import backup?', 'Merge ' + (data.medications ? data.medications.length : 0) + ' medications and ' + (data.logs ? data.logs.length : 0) + ' logs. Tap Confirm to merge with existing data.', async () => {
        await window.MK_DB.importAll(data, 'merge');
        window.MK_UI.toast('Imported');
        await loadData();
      });
    } catch (e) {
      window.MK_UI.toast('Could not read backup file');
    }
  }

  async function shareSchedule() {
    try {
      const text = buildShareText();
      if (navigator.share) {
        await navigator.share({ title: 'MedKeeper schedule', text });
      } else {
        // Fallback: copy to clipboard
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          window.MK_UI.toast('Schedule copied to clipboard');
        } else {
          const blob = new Blob([text], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'medkeeper-schedule.txt';
          document.body.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
        }
      }
    } catch (e) {
      // user cancelled share — silent
    }
  }

  function buildShareText() {
    const lines = ['MedKeeper schedule — generated ' + new Date().toLocaleString(), ''];
    if (state.meds.length === 0) lines.push('No medications added yet.');
    state.meds.forEach((m) => {
      lines.push('• ' + m.name + ' — ' + (m.dose || '') + ' ' + (m.unit || ''));
      lines.push('  ' + scheduleSummary(m));
      if (m.notes) lines.push('  Notes: ' + m.notes);
    });
    lines.push('');
    lines.push('This is a personal record, not medical advice.');
    return lines.join('\n');
  }

  async function clearAllData() {
    askConfirm('Clear all MedKeeper data?', 'This deletes every medication, every log, and every setting. There is no undo. Tap Confirm to continue.', () => {
      askConfirm('Really clear everything?', 'Tap Confirm a second time to delete all data.', async () => {
        try {
          await window.MK_DB.clearAll();
          window.MK_UI.toast('All data cleared');
          state.settings = await window.MK_DB.allSettings();
          state.meds = [];
          state.logs = [];
          applyTheme(state.settings.theme);
          renderAll();
        } catch (e) {
          window.MK_UI.toast('Could not clear data');
        }
      });
    });
  }

  // -------------- Install prompt --------------

  function bindInstallPrompt() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      document.getElementById('install-btn').hidden = false;
      document.getElementById('install-banner').hidden = false;
    });
    document.getElementById('install-btn').addEventListener('click', triggerInstall);
    document.getElementById('install-accept').addEventListener('click', triggerInstall);
    document.getElementById('install-dismiss').addEventListener('click', () => {
      document.getElementById('install-banner').hidden = true;
    });
  }
  async function triggerInstall() {
    if (!state.deferredInstallPrompt) {
      window.MK_UI.toast('Install option not available in this browser');
      return;
    }
    state.deferredInstallPrompt.prompt();
    try {
      const choice = await state.deferredInstallPrompt.userChoice;
      if (choice && choice.outcome === 'accepted') {
        window.MK_UI.toast('Installing…');
      }
    } catch (_) { /* ignore */ }
    state.deferredInstallPrompt = null;
    document.getElementById('install-btn').hidden = true;
    document.getElementById('install-banner').hidden = true;
  }

})();
