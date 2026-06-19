/* MedKeeper schedule engine.
 *
 * Computes scheduled dose slots for a given day, taking into account:
 *   - schedule.type: 'fixed' | 'interval' | 'meals' | 'prn'
 *   - start/end dates
 *   - logs taken so far (to advance interval and PRN windows)
 *   - missed-dose rules (which affect display status, not whether the slot exists)
 *
 * Status values returned for a slot on the Today view:
 *   'taken' | 'skipped' | 'overdue' | 'due' | 'upcoming' |
 *   'asap' | 'never-double' | 'contact' | 'available' (PRN)
 */
(function () {
  'use strict';

  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }
  function endOfDay(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }
  function timeStringToDate(dateAnchor, hhmm) {
    const [h, m] = (hhmm || '08:00').split(':').map((n) => parseInt(n, 10));
    const x = new Date(dateAnchor);
    x.setHours(h || 0, m || 0, 0, 0);
    return x;
  }
  function isWithinDateBounds(med, when) {
    if (med.startDate) {
      const s = new Date(med.startDate);
      s.setHours(0, 0, 0, 0);
      if (when < s) return false;
    }
    if (med.endDate) {
      const e = new Date(med.endDate);
      e.setHours(23, 59, 59, 999);
      if (when > e) return false;
    }
    return true;
  }

  // Builds the list of scheduled dose times for `med` on the date `day`.
  // Returns array of { scheduledAt: Date, kind: 'scheduled'|'prn' }
  function slotsForDay(med, day, settings, logs) {
    if (!isWithinDateBounds(med, day)) return [];
    const sched = med.schedule || {};
    const dayStart = startOfDay(day);
    const dayEnd = endOfDay(day);

    if (sched.type === 'fixed') {
      const times = Array.isArray(sched.times) ? sched.times : [];
      return times
        .filter(Boolean)
        .map((hhmm) => ({
          scheduledAt: timeStringToDate(dayStart, hhmm),
          kind: 'scheduled',
        }));
    }

    if (sched.type === 'meals') {
      const meals = settings && settings.meals ? settings.meals : { breakfast: '08:00', lunch: '12:30', dinner: '18:30' };
      const flags = sched.meals || {};
      const out = [];
      if (flags.breakfast) out.push({ scheduledAt: timeStringToDate(dayStart, meals.breakfast), kind: 'scheduled' });
      if (flags.lunch) out.push({ scheduledAt: timeStringToDate(dayStart, meals.lunch), kind: 'scheduled' });
      if (flags.dinner) out.push({ scheduledAt: timeStringToDate(dayStart, meals.dinner), kind: 'scheduled' });
      return out;
    }

    if (sched.type === 'interval') {
      const hours = Math.max(1, parseFloat(sched.hours || 8));
      const startHHMM = sched.start || '08:00';
      // Anchor: today's first dose time. If a dose was taken before now today, anchor on it + hours.
      let next = timeStringToDate(dayStart, startHHMM);
      // If the medication has logs taken today, the *next* slot is last-taken + hours.
      const todayLogs = (logs || [])
        .filter((l) => l.medId === med.id && l.status === 'taken' && new Date(l.takenAt) >= dayStart && new Date(l.takenAt) <= dayEnd)
        .sort((a, b) => a.takenAt - b.takenAt);
      if (todayLogs.length > 0) {
        const last = new Date(todayLogs[todayLogs.length - 1].takenAt);
        next = new Date(last.getTime() + hours * HOUR);
      }
      const out = [];
      // Generate all expected slots for the day from start time
      let cursor = timeStringToDate(dayStart, startHHMM);
      while (cursor <= dayEnd && out.length < 24) {
        if (cursor >= dayStart) out.push({ scheduledAt: new Date(cursor), kind: 'scheduled' });
        cursor = new Date(cursor.getTime() + hours * HOUR);
      }
      // If there are logs, project the *next* slot from the last taken dose
      if (todayLogs.length > 0) {
        // Remove fixed slots that are in the past but not taken (interval is dynamic)
        // Replace with a single "next" slot
        const projected = next;
        if (projected <= dayEnd) {
          // Keep only past slots that correspond to taken logs + one future slot
          const taken = todayLogs.map((l) => ({ scheduledAt: new Date(l.takenAt), kind: 'scheduled' }));
          return taken.concat([{ scheduledAt: projected, kind: 'scheduled', projected: true }]);
        }
        return todayLogs.map((l) => ({ scheduledAt: new Date(l.takenAt), kind: 'scheduled' }));
      }
      return out;
    }

    if (sched.type === 'prn') {
      // PRN doses are not scheduled; just show a placeholder card for "available".
      return [{ scheduledAt: dayStart, kind: 'prn' }];
    }

    return [];
  }

  // Decide status for a scheduled slot given current time and logs and missed-dose rule.
  function statusFor(med, slot, now, logs) {
    if (slot.kind === 'prn') {
      // Look up most recent PRN take; check minimum interval.
      const prnLogs = (logs || [])
        .filter((l) => l.medId === med.id && l.status === 'taken')
        .sort((a, b) => b.takenAt - a.takenAt);
      const minHours = parseFloat((med.schedule && med.schedule.minHours) || 0);
      if (prnLogs.length > 0 && minHours > 0) {
        const last = prnLogs[0].takenAt;
        const nextAllowed = last + minHours * HOUR;
        if (now < nextAllowed) {
          return { status: 'wait', nextAllowed };
        }
      }
      return { status: 'available' };
    }

    // Scheduled slot
    const slotTs = slot.scheduledAt.getTime();
    // Find a log that matches this slot (within +/- 4h window) or status set explicitly
    const match = (logs || []).find((l) => {
      if (l.medId !== med.id) return false;
      if (!l.scheduledAt) return false;
      return Math.abs(l.scheduledAt - slotTs) < 4 * HOUR && (l.status === 'taken' || l.status === 'skipped');
    });
    if (match) {
      return { status: match.status, logId: match.id, takenAt: match.takenAt };
    }

    const diff = now - slotTs;
    const dueWindow = 15 * MIN;
    if (diff < -dueWindow) {
      return { status: 'upcoming' };
    }
    if (diff >= -dueWindow && diff <= dueWindow) {
      return { status: 'due' };
    }
    // Overdue — apply missed-dose rule
    const rule = (med.missed && med.missed.rule) || 'skip';
    if (rule === 'skip') return { status: 'overdue', advice: 'skip' };
    if (rule === 'asap') {
      const within = ((med.missed && med.missed.asapHours) || 2) * HOUR;
      if (diff <= within) return { status: 'overdue', advice: 'asap' };
      return { status: 'overdue', advice: 'skip' };
    }
    if (rule === 'never-double') return { status: 'overdue', advice: 'never-double' };
    if (rule === 'contact') return { status: 'overdue', advice: 'contact' };
    return { status: 'overdue' };
  }

  // Adherence over a date range.
  // Returns { takenCount, scheduledCount, skipped, ratio }.
  function adherence(meds, logs, fromDate, toDate, settings) {
    let scheduled = 0;
    let taken = 0;
    let skipped = 0;
    const oneDay = 24 * HOUR;
    const cursor = startOfDay(fromDate);
    const stop = startOfDay(toDate);
    while (cursor <= stop) {
      for (const m of meds) {
        const slots = slotsForDay(m, cursor, settings, logs).filter((s) => s.kind === 'scheduled');
        for (const slot of slots) {
          // Only count slots in the past
          if (slot.scheduledAt > new Date()) continue;
          scheduled++;
          const st = statusFor(m, slot, Date.now(), logs);
          if (st.status === 'taken') taken++;
          else if (st.status === 'skipped') skipped++;
        }
      }
      cursor.setTime(cursor.getTime() + oneDay);
    }
    return {
      scheduled,
      taken,
      skipped,
      ratio: scheduled > 0 ? taken / scheduled : 0,
    };
  }

  function isNightHour(hhmm) {
    const [h] = hhmm.split(':').map((n) => parseInt(n, 10));
    return h >= 23 || h < 6;
  }

  function projectSupplyDaysLeft(med, logs) {
    // Estimate daily usage from the last 14 days of taken logs.
    const now = Date.now();
    const fourteen = 14 * 24 * HOUR;
    const recent = (logs || []).filter((l) => l.medId === med.id && l.status === 'taken' && l.takenAt >= now - fourteen);
    const perDose = parseFloat(med.perDose || 1);
    const totalUsed = recent.length * perDose;
    const dailyUse = totalUsed / 14 || estimateDailyUseFromSchedule(med);
    if (!dailyUse || dailyUse <= 0) return Infinity;
    const supply = parseFloat(med.supply || 0);
    return Math.floor(supply / dailyUse);
  }

  function estimateDailyUseFromSchedule(med) {
    const s = med.schedule || {};
    const perDose = parseFloat(med.perDose || 1);
    if (s.type === 'fixed') return (s.times || []).length * perDose;
    if (s.type === 'meals') {
      const m = s.meals || {};
      return (m.breakfast ? 1 : 0) + (m.lunch ? 1 : 0) + (m.dinner ? 1 : 0);
    }
    if (s.type === 'interval') {
      const hours = parseFloat(s.hours || 8);
      return Math.floor(24 / hours) * perDose;
    }
    return 0; // PRN
  }

  window.MK_SCHEDULE = {
    slotsForDay,
    statusFor,
    adherence,
    isNightHour,
    projectSupplyDaysLeft,
    startOfDay,
    endOfDay,
  };
})();
