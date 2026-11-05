import { networkInterfaces } from 'node:os';

/*
 * Addresses phones can reach (#137): this machine's IPv4 addresses on its local networks, never
 * loopback ("a phone scanning 127.0.0.1 would dial itself") and never link-local 169.254.x.x.
 * Private ranges come first, since those are the Wi-Fi a phone shares with the PC.
 */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.') || a.address.startsWith('127.')) continue;
      found.push(a.address);
    }
  }
  const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return [...new Set(found)].sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)));
}

/** True when the server listens only on this machine, so nothing else can reach it. */
export const localOnly = (host: string | undefined) => !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';

/** What to tell the person starting the server about phones. */
export function phoneHints(host: string | undefined, port: number, platform = process.platform): string[] {
  const lan = lanAddresses();
  if (localOnly(host)) {
    return [
      `  Phones and other computers cannot reach this: it listens on ${host || '127.0.0.1'} only.`,
      `  To use Orco from a phone on the same Wi-Fi, start it with ORCO_HOST=0.0.0.0${lan.length ? `, then open http://${lan[0]}:${port}` : ''}.`,
    ];
  }
  if (!lan.length) return [];
  return [
    `  Phones on the same Wi-Fi: http://${lan[0]}:${port}${lan.length > 1 ? ` (or ${lan.slice(1).map((ip) => `http://${ip}:${port}`).join(', ')})` : ''}`,
    ...(platform === 'win32'
      ? [`  Windows Firewall may block them; allow the port once (admin PowerShell): New-NetFirewallRule -DisplayName "Orco" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Private`]
      : []),
  ];
}
