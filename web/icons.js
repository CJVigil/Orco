// Stroke icons on a 24×24 grid, drawn for Orco. `icon(name)` builds the SVG with DOM calls only.

const ICONS = {
  search: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M21 21l-4.6-4.6'],
  inbox: ['M3 13h5l2 3h4l2-3h5', 'M5.5 5h13L21 13v6H3v-6z'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  users: ['M9 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M2 21c0-3.9 3.1-6 7-6s7 2.1 7 6', 'M16 4.3a4 4 0 0 1 0 7.4', 'M18.5 15.3c2.1.6 3.5 2.6 3.5 5.7'],
  'user-plus': ['M9 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M2 21c0-3.9 3.1-6 7-6s7 2.1 7 6', 'M19 8v6', 'M16 11h6'],
  list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.5', 'M4 12h.5', 'M4 18h.5'],
  paperclip: ['M20.5 11.5l-8.4 8.4a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 4.9 4.9l-8.6 8.6a1.7 1.7 0 0 1-2.5-2.5l7.9-7.9'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  bot: ['M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M12 8V4.5', 'M10.5 3.5h3', 'M9 13.5v1', 'M15 13.5v1', 'M2 13v3', 'M22 13v3'],
  'folder-plus': ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z', 'M12 11v6', 'M9 14h6'],
  plus: ['M12 5v14', 'M5 12h14'],
  sun: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  monitor: ['M3 4h18v12H3z', 'M8 20h8', 'M12 16v4'],
  'log-out': ['M14 4h5v16h-5', 'M9 8l-4 4 4 4', 'M5 12h11'],
  message: ['M4 5h16v11H9l-5 4z'],
  at: ['M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z', 'M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1'],
  task: ['M9 4h6v3H9z', 'M15 5.5h3v15H6v-15h3', 'M9 13.5l2 2 4-4'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'],
  'bell-off': ['M6 16V11a6 6 0 0 1 9.5-4.9', 'M18 11v5l1.5 2H8', 'M10 20.5a2 2 0 0 0 4 0', 'M3 3l18 18'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  clock: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z', 'M12 7v5l3 2'],
};

const SVG = 'http://www.w3.org/2000/svg';

export function icon(name, className = 'svg-icon') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
