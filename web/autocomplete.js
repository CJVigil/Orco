// @name suggestions for a textarea. `candidates()` returns [{ name, kind, owner }] for the current room;
// kind "all" is the @all entry.

const TOKEN = /(?:^|\s)@([a-z0-9-]{0,32})$/;
const LIMIT = 8;

export function attachMentionAutocomplete(textarea, candidates, el) {
  const menu = el('ul', { class: 'mention-menu', role: 'listbox', hidden: true });
  textarea.parentElement.append(menu);
  let items = [];
  let active = 0;
  let start = -1;

  const close = () => {
    menu.hidden = true;
    items = [];
    textarea.removeAttribute('aria-activedescendant');
  };

  const render = () => {
    menu.replaceChildren(
      ...items.map((p, i) =>
        el(
          'li',
          {
            id: `mention-${p.name}`,
            role: 'option',
            class: i === active ? 'active' : null,
            'aria-selected': i === active ? 'true' : 'false',
            onmousedown: (event) => {
              event.preventDefault();
              choose(i);
            },
          },
          el('span', { class: 'mention-name', text: `@${p.name}` }),
          el('span', { class: 'muted small', text: p.kind === 'all' ? 'everyone here (people only)' : p.kind === 'agent' ? `agent · ${p.owner}` : 'person' }),
        ),
      ),
    );
    menu.hidden = items.length === 0;
    if (items.length) textarea.setAttribute('aria-activedescendant', `mention-${items[active].name}`);
  };

  const choose = (i) => {
    const pick = items[i];
    if (!pick) return;
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(caret);
    const insert = `@${pick.name} `;
    textarea.value = before + insert + after;
    const pos = before.length + insert.length;
    textarea.setSelectionRange(pos, pos);
    textarea.dispatchEvent(new Event('input'));
    close();
  };

  const update = async () => {
    const caret = textarea.selectionStart;
    const match = TOKEN.exec(textarea.value.slice(0, caret));
    if (!match) return close();
    const query = match[1];
    start = caret - query.length - 1;
    const all = await candidates();
    const starts = all.filter((p) => p.name.startsWith(query));
    const contains = all.filter((p) => !p.name.startsWith(query) && p.name.includes(query));
    items = [...starts, ...contains].slice(0, LIMIT);
    active = 0;
    render();
  };

  textarea.addEventListener('input', () => void update());
  textarea.addEventListener('blur', () => setTimeout(close, 100));
  textarea.addEventListener(
    'keydown',
    (event) => {
      if (menu.hidden) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        render();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        choose(active);
      } else if (event.key === 'Escape') {
        close();
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}
