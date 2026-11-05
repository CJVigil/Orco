/*
 * Five seconds to undo a tap (#136).
 *
 * hold(label, send): for approvals and answers. Nothing is sent for five seconds while a toast says
 * "Approving… Undo". Undo, or closing the page, means it is never sent: a held approval fails safe.
 * A new hold sends the one before it at once, so taps never queue up silently.
 *
 * offer(label, revert): for taps that take effect at once (Later, a status or folder move). Undo calls
 * revert, which reverses the change only if nothing newer has changed the item.
 *
 * Ctrl/Cmd+Z runs the latest Undo when focus is not in a text box. Built with textContent only.
 */
const SECONDS = 5;

let current = null; // { kind: 'hold' | 'offer', undo, flush, timer, tick, node }

function toastNode(text, onUndo) {
  const node = document.createElement('div');
  node.className = 'undo-toast';
  node.setAttribute('role', 'status');
  const label = document.createElement('span');
  label.textContent = text;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'small undo-button';
  // Inline, so no page-wide button style can turn it white on white.
  button.style.cssText = 'background:transparent;color:inherit;border:1px solid rgba(255,255,255,.4);min-width:5.5rem;font-weight:600';
  button.addEventListener('click', onUndo);
  node.append(label, button);
  document.body.append(node);
  return { node, button };
}

function clear() {
  if (!current) return;
  clearInterval(current.tick);
  clearTimeout(current.timer);
  current.node.remove();
  current = null;
}

function countdown(button, seconds, onEnd) {
  let left = seconds;
  button.textContent = `Undo (${left})`;
  const tick = setInterval(() => {
    left -= 1;
    button.textContent = `Undo (${Math.max(left, 0)})`;
  }, 1000);
  const timer = setTimeout(onEnd, seconds * 1000);
  return { tick, timer };
}

/** Holds a send for five seconds. Resolves with its result, or with undefined when undone. */
export function hold(label, send) {
  // The one before goes now: a second tap is a second decision, not a reason to drop the first.
  if (current?.kind === 'hold') current.flush();
  else clear();
  return new Promise((resolve, reject) => {
    const go = () => {
      clear();
      Promise.resolve()
        .then(send)
        .then(resolve, reject);
    };
    const undo = () => {
      clear();
      resolve(undefined);
    };
    const { node, button } = toastNode(`${label}…`, undo);
    const { tick, timer } = countdown(button, SECONDS, go);
    current = { kind: 'hold', undo, flush: go, tick, timer, node };
  });
}

/** Offers to reverse something that already happened. */
export function offer(label, revert) {
  if (current?.kind === 'hold') current.flush();
  else clear();
  const undo = () => {
    clear();
    Promise.resolve()
      .then(revert)
      .catch((err) => {
        const { node } = toastNode(`Could not undo: ${err.message}`, () => node.remove());
        node.querySelector('button').textContent = 'OK';
        setTimeout(() => node.remove(), 5000);
      });
  };
  const { node, button } = toastNode(label, undo);
  const { tick, timer } = countdown(button, SECONDS, clear);
  current = { kind: 'offer', undo, flush: clear, tick, timer, node };
}

/** True while something is being held, for tests and for the page's leave warning. */
export const holding = () => current?.kind === 'hold';

document.addEventListener('keydown', (event) => {
  if (!current || event.key.toLowerCase() !== 'z' || !(event.ctrlKey || event.metaKey) || event.shiftKey) return;
  const active = document.activeElement;
  if (active && (active.matches('input, textarea, select') || active.isContentEditable)) return;
  event.preventDefault();
  current.undo();
});
