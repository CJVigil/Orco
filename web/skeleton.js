/** Placeholder rows while a view loads (UI pass 2): the shape of what is coming, not a word. */
export function skeleton(el, rows = 5, { kind = 'rows' } = {}) {
  return el(
    'div',
    { class: `skeleton skeleton-${kind}`, role: 'status', 'aria-label': 'Loading' },
    Array.from({ length: rows }, (_, i) =>
      el('div', { class: 'skeleton-row' }, el('span', { class: 'skeleton-dot' }), el('span', { class: 'skeleton-bar', style: `width: ${55 + ((i * 17) % 35)}%` })),
    ),
  );
}
