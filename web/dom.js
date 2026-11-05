/*
 * DOM children without "null" (#147). el() drops null children, but replaceChildren, append and
 * prepend turn null and undefined into the text "null" / "undefined". Views often pass
 * `cond ? node : null`, so the empty case printed a stray word. children() flattens and drops the
 * empty values; replace() uses it; guardDom() makes the three DOM methods do the same everywhere,
 * so this class of bug cannot come back from a direct call.
 */
export function children(list) {
  return list.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
}

export function replace(parent, ...kids) {
  parent.replaceChildren(...children(kids));
  return parent;
}

export function guardDom(proto = globalThis.Element?.prototype) {
  if (!proto || proto.__orcoGuarded) return;
  for (const name of ['replaceChildren', 'append', 'prepend']) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value(...kids) {
        return original.apply(this, kids.filter((n) => n !== null && n !== undefined && n !== false));
      },
    });
  }
  Object.defineProperty(proto, '__orcoGuarded', { value: true });
}
