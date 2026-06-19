/* MedKeeper Doctor Report — builds a print-ready DOM and calls window.print().
 * No external libraries; the user picks "Save as PDF" from the print dialog.
 */
(function () {
  'use strict';

  const HOUR = 60 * 60 * 1000;

  function fmtDate(d) {
    return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function fmtTime(d) {
    return new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function fmtSchedule(med, settings) {
    const s = med.schedule || {};
    if (s.type === 'fixed') return 'Fixed: ' + (s.times || []).join(', ');
    if (s.type === 'interval') return 'Every ' + s.hours + ' h from ' + (s.start || '08:00');
    if (s.type === 'meals') {
      const flags = s.meals || {};
      const parts = [];
      if (flags.breakfast) parts.push('Breakfast');
      if (flags.lunch) parts.push('Lunch');
      if (flags.dinner) parts.push('Dinner');
      return 'With meals: ' + (parts.join(', ') || '—');
    }
    if (s.type === 'prn') return 'As needed (min ' + (s.minHours || 0) + ' h)';
    return '—';
  }

  async function generate() {
    try {
      const meds = await window.MK_DB.allMeds();
      const settings = await window.MK_DB.allSettings();
      const logs = await window.MK_DB.allLogs();

      const now = new Date();
      const from = new Date(now); from.setDate(from.getDate() - 30);
      const adh30 = window.MK_SCHEDULE.adherence(meds, logs, from, now, settings);

      // Build a print-only view in the DOM
      let print = document.getElementById('print-view');
      if (!print) {
        print = document.createElement('section');
        print.id = 'print-view';
        print.className = 'view print-only';
        print.setAttribute('aria-hidden', 'true');
        document.querySelector('main.app-main').appendChild(print);
      }
      print.innerHTML = '';

      const doc = document.createElement('div');
      doc.className = 'print-doc';

      const h1 = document.createElement('h1');
      h1.textContent = 'Medication Report';
      doc.appendChild(h1);

      const meta = document.createElement('p');
      meta.textContent = 'Generated ' + fmtDate(now) + ' at ' + fmtTime(now);
      doc.appendChild(meta);

      const h2a = document.createElement('h2');
      h2a.textContent = 'Current medications';
      doc.appendChild(h2a);

      if (meds.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No medications recorded.';
        doc.appendChild(empty);
      } else {
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Name</th><th>Dose</th><th>Schedule</th><th>Prescriber</th><th>Notes</th></tr></thead>';
        const tbody = document.createElement('tbody');
        for (const m of meds) {
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + esc(m.name) + '</td>' +
            '<td>' + esc(m.dose || '') + ' ' + esc(m.unit || '') + '</td>' +
            '<td>' + esc(fmtSchedule(m, settings)) + '</td>' +
            '<td>' + esc(m.prescriber || '') + '</td>' +
            '<td>' + esc(m.notes || '') + '</td>';
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        doc.appendChild(table);
      }

      const h2b = document.createElement('h2');
      h2b.textContent = 'Adherence — last 30 days';
      doc.appendChild(h2b);

      const stats = document.createElement('p');
      const pct = adh30.scheduled > 0 ? Math.round(adh30.ratio * 100) : 0;
      stats.textContent =
        'Scheduled doses: ' + adh30.scheduled +
        ' — Taken: ' + adh30.taken +
        ' — Skipped: ' + adh30.skipped +
        ' — Adherence: ' + pct + '%';
      doc.appendChild(stats);

      const br = document.createElement('div');
      br.className = 'page-break';
      doc.appendChild(br);

      const h2c = document.createElement('h2');
      h2c.textContent = 'Dose log — last 30 days';
      doc.appendChild(h2c);

      const recent = logs
        .filter((l) => l.scheduledAt && (now.getTime() - l.scheduledAt) <= 30 * 24 * HOUR)
        .sort((a, b) => b.scheduledAt - a.scheduledAt);

      if (recent.length === 0) {
        const p = document.createElement('p');
        p.textContent = 'No logged doses in this period.';
        doc.appendChild(p);
      } else {
        const t = document.createElement('table');
        t.innerHTML = '<thead><tr><th>Date</th><th>Time</th><th>Medication</th><th>Status</th><th>Taken at</th></tr></thead>';
        const tb = document.createElement('tbody');
        const byId = Object.fromEntries(meds.map((m) => [m.id, m]));
        for (const l of recent) {
          const m = byId[l.medId];
          const tr = document.createElement('tr');
          tr.innerHTML =
            '<td>' + esc(fmtDate(l.scheduledAt)) + '</td>' +
            '<td>' + esc(fmtTime(l.scheduledAt)) + '</td>' +
            '<td>' + esc(m ? m.name : 'Deleted medication') + ' ' + esc(m ? (m.dose + ' ' + m.unit) : '') + '</td>' +
            '<td>' + esc(l.status) + '</td>' +
            '<td>' + (l.takenAt ? esc(fmtTime(l.takenAt)) : '—') + '</td>';
          tb.appendChild(tr);
        }
        t.appendChild(tb);
        doc.appendChild(t);
      }

      const footer = document.createElement('p');
      footer.className = 'footer-note';
      footer.textContent =
        'This report was generated by MedKeeper for your own records. ' +
        'It is not medical advice. Please review with a licensed clinician.';
      doc.appendChild(footer);

      print.appendChild(doc);

      // Wait a tick so layout settles, then print
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      window.print();
      return true;
    } catch (err) {
      // Surfaced to the caller, which shows a toast.
      throw err;
    }
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.MK_PDF = { generate };
})();
