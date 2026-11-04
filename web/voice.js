// Voice input (#122): a mic button beside a text box. Speech becomes text in the draft and nothing
// else: it never sends or creates anything. A transcript that arrives after the draft was edited or
// replaced while recording is dropped rather than written over it, and Cancel discards it at once.
// Uses the browser's own speech recognition; where there is none, no button appears.

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export const voiceAvailable = () => Boolean(Recognition);

/**
 * Adds a mic button for a textarea or input, returned to place next to it (null without speech
 * recognition). onNote shows a short message (dropped transcript, no permission).
 */
export function voiceButton(box, el, icon, onNote = () => {}) {
  if (!Recognition) return null;
  let recognition = null;
  let revision = 0;
  let startedAt = 0;
  let startValue = '';
  box.addEventListener('input', () => revision++);
  const button = el('button', { class: 'ghost icon voice-button', type: 'button', title: 'Speak (the text goes in the draft; nothing is sent)', 'aria-label': 'Speak into this box', 'aria-pressed': 'false' }, icon('mic'));
  const stop = (keep) => {
    if (!recognition) return;
    const r = recognition;
    recognition = null;
    r.onresult = keep ? r.onresult : null;
    try {
      keep ? r.stop() : r.abort();
    } catch {
      // Already stopped.
    }
    button.classList.remove('recording');
    button.setAttribute('aria-pressed', 'false');
    button.title = 'Speak (the text goes in the draft; nothing is sent)';
  };
  button.addEventListener('click', () => {
    if (recognition) return stop(true);
    recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    startedAt = revision;
    startValue = box.value;
    recognition.onresult = (event) => {
      const text = [...event.results].map((r) => r[0]?.transcript ?? '').join(' ').trim();
      if (!text) return;
      // The draft changed while recording (typed into, sent, or replaced): do not write over it.
      if (revision !== startedAt || box.value !== startValue) {
        onNote('Speech dropped: the draft changed while you were recording');
        return;
      }
      box.value = `${startValue}${startValue && !/\s$/.test(startValue) ? ' ' : ''}${text}`;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      revision = startedAt = revision + 1;
      box.focus();
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') onNote('The browser did not allow the microphone');
      stop(false);
    };
    recognition.onend = () => stop(true);
    try {
      recognition.start();
      button.classList.add('recording');
      button.setAttribute('aria-pressed', 'true');
      button.title = 'Recording: tap to stop. Escape cancels';
    } catch {
      recognition = null;
    }
  });
  // Escape while recording cancels, and the result is thrown away.
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && recognition) {
      event.preventDefault();
      event.stopPropagation();
      stop(false);
      onNote('Recording cancelled');
    }
  });
  return button;
}
