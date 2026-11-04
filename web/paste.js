/*
 * Big pastes become text attachments (#126): agents reading the room then get the file's name, size
 * and first lines, and fetch the rest only when they need it. Ctrl+Shift+V (Cmd+Shift+V) keeps a
 * paste inline. A message holds at most MAX_MESSAGE_CHARS; a longer draft stays in the box.
 */
export const PASTE_LIMIT = 16_000;
export const MAX_MESSAGE_CHARS = 16_000;

/** Watches a text box for big pastes; calls onFile with a text File when one should be attached. */
export function catchBigPastes(box, onFile, limit = PASTE_LIMIT) {
  let inline = false;
  box.addEventListener('keydown', (event) => {
    inline = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v';
  });
  box.addEventListener('paste', (event) => {
    const keep = inline;
    inline = false;
    if (keep || event.clipboardData?.files?.length) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text.length <= limit) return;
    event.preventDefault();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = new File([text], `paste-${stamp}.txt`, { type: 'text/plain' });
    const lines = text.split('\n').length;
    onFile(file);
    const note = `(pasted ${lines.toLocaleString()} lines, ${Math.ceil(file.size / 1024)} KB, as ${file.name})`;
    box.setRangeText(note, box.selectionStart, box.selectionEnd, 'end');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
