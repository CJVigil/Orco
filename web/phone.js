import { qrElement } from './qr.js';

/*
 * Links for phones (#137): a QR code for a sign-in or invite link, built from an address a phone can
 * reach. ORCO_PUBLIC_URL first; else the address this page is open at, unless that is this PC itself
 * (localhost, 127.0.0.1); else one of the server's LAN addresses, with a picker when there are several.
 * Never loopback: a phone scanning 127.0.0.1 would dial itself.
 */
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/;

export async function phoneBases(api) {
  const here = new URL('.', location.href).href.replace(/\/$/, '');
  let info = { publicUrl: null, lan: [], localOnly: null };
  try {
    info = await api('/phone-addresses');
  } catch {
    // Older server: fall back to this page's address.
  }
  if (info.publicUrl) return { bases: [info.publicUrl], note: null };
  if (!LOCAL.test(location.hostname)) return { bases: [here], note: null };
  if (info.lan.length) return { bases: info.lan, note: null };
  return {
    bases: [],
    note:
      info.localOnly === false
        ? 'This server has no network address a phone could use. Set ORCO_PUBLIC_URL to the address people open.'
        : 'Phones cannot reach this Orco: it listens on this PC only. Restart it with ORCO_HOST=0.0.0.0 (and allow the port in the firewall), then make the code again.',
  };
}

/** The QR code for `hash` (like "#signin=abc"), with the link under it and a picker between addresses. */
export async function phoneLinkBlock({ el, api }, hash, { size = 220 } = {}) {
  const { bases, note } = await phoneBases(api);
  if (!bases.length) return el('p', { class: 'small warning-note', text: note });
  const holder = el('div', { class: 'qr-holder' });
  const text = el('code', { class: 'small qr-url' });
  const show = (base) => {
    const url = `${base}/${hash}`;
    holder.replaceChildren(qrElement(url, size));
    text.textContent = url;
  };
  show(bases[0]);
  const picker =
    bases.length > 1
      ? el(
          'label',
          { class: 'small muted' },
          'Address for the phone: ',
          el('select', { onchange: (event) => show(event.target.value) }, bases.map((b) => el('option', { value: b, text: new URL(b).host }))),
        )
      : null;
  return el('div', { class: 'phone-link' }, el('p', { class: 'small', text: 'Or scan this with the phone’s camera:' }), holder, text, picker);
}
