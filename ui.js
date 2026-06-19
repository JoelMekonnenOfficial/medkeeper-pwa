/* MedKeeper UI helpers — DOM rendering, focus management, toasts. */
(function () {
  'use strict';

  const COLORS = [
    { name: 'blue', value: '#2563EB' },
    { name: 'green', value: '#10b981' },
    { name: 'amber', value: '#f59e0b' },
    { name: 'rose', value: '#e11d48' },
    { name: 'purple', value: '#9333ea' },
    { name: 'teal', value: '#14b8a6' },
    { name: 'slate', value: '#64748b' },
    { name: 'pink', value: '#ec4899' },
  ];
  const SHAPES = ['Round', 'Oval', 'Capsule', 'Tablet', 'Square', 'Other'];

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'on') {
          for (const [evt, fn] of Object.entries(v)) node.addEventListener(evt, fn);
        }
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (v === true) node.setAttribute(k, '');
        else if (v === false || v == null) { /* skip */ }
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function announce(message) {
    const live = document.getElementById('sr-live');
    if (!live) return;
    live.textContent = '';
    setTimeout(() => { live.textContent = message; }, 50);
  }

  let toastTimer = null;
  function toast(message, ms) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = message;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2200);
  }

  function statusLabel(s) {
    switch (s.status) {
      case 'taken': return 'Taken';
      case 'skipped': return 'Skipped';
      case 'overdue':
        if (s.advice === 'asap') return 'Overdue — take ASAP';
        if (s.advice === 'never-double') return 'Overdue — do not double';
        if (s.advice === 'contact') return 'Overdue — contact prescriber';
        return 'Overdue — skip';
      case 'due': return 'Due now';
      case 'upcoming': return 'Upcoming';
      case 'available': return 'Available';
      case 'wait': return 'Wait until ' + new Date(s.nextAllowed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      default: return s.status;
    }
  }

  function buildColorRow(container, selected) {
    container.innerHTML = '';
    COLORS.forEach((c) => {
      const dot = el('button', {
        type: 'button',
        class: 'color-dot',
        role: 'radio',
        'aria-checked': selected === c.value ? 'true' : 'false',
        'aria-label': 'Color ' + c.name,
        'data-value': c.value,
        style: 'background:' + c.value,
      });
      dot.addEventListener('click', () => {
        container.querySelectorAll('.color-dot').forEach((d) => d.setAttribute('aria-checked', 'false'));
        dot.setAttribute('aria-checked', 'true');
      });
      container.appendChild(dot);
    });
  }
  function buildShapeRow(container, selected) {
    container.innerHTML = '';
    SHAPES.forEach((s) => {
      const b = el('button', {
        type: 'button',
        class: 'shape-pick',
        role: 'radio',
        'aria-checked': selected === s ? 'true' : 'false',
        'data-value': s,
      }, s);
      b.addEventListener('click', () => {
        container.querySelectorAll('.shape-pick').forEach((d) => d.setAttribute('aria-checked', 'false'));
        b.setAttribute('aria-checked', 'true');
      });
      container.appendChild(b);
    });
  }
  function getRadioValue(container) {
    const sel = container.querySelector('[aria-checked="true"]');
    return sel ? sel.dataset.value : null;
  }

  function buildFixedTimes(container, times) {
    container.innerHTML = '';
    const list = (times && times.length) ? times : ['08:00'];
    list.forEach((t) => addTimeRow(container, t));
  }
  function addTimeRow(container, value) {
    const row = el('div', { class: 'time-row' });
    const input = el('input', { type: 'time', value: value || '08:00', 'aria-label': 'Dose time' });
    const remove = el('button', { type: 'button', class: 'btn btn-icon', 'aria-label': 'Remove time' });
    remove.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    remove.addEventListener('click', () => {
      if (container.children.length > 1) row.remove();
    });
    row.appendChild(input);
    row.appendChild(remove);
    container.appendChild(row);
  }
  function readFixedTimes(container) {
    return Array.from(container.querySelectorAll('input[type=time]')).map((i) => i.value).filter(Boolean);
  }

  window.MK_UI = {
    COLORS, SHAPES,
    el, announce, toast, statusLabel,
    buildColorRow, buildShapeRow, getRadioValue,
    buildFixedTimes, addTimeRow, readFixedTimes,
  };
})();
