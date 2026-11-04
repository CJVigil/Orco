/*
 * Links into the web app (#129), for agents to put in reports and alerts. They are built from
 * ORCO_PUBLIC_URL only and left out when it is unset or names this machine (a localhost link is
 * useless to anyone else). The app's routes: #~<project>/<REF> a ticket, #!m/<id> a message,
 * #!t/<id> a task.
 */
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export function appLink(route: string, base = process.env.ORCO_PUBLIC_URL): string | undefined {
  const root = base?.trim().replace(/\/+$/, '');
  if (!root) return undefined;
  try {
    if (LOCAL.has(new URL(root).hostname)) return undefined;
  } catch {
    return undefined;
  }
  return `${root}/#${route}`;
}

export const ticketLink = (project: string, ref: string, base?: string) => appLink(`~${project}/${ref}`, base);
export const messageLink = (id: number, base?: string) => appLink(`!m/${id}`, base);
export const taskLink = (id: number, base?: string) => appLink(`!t/${id}`, base);

/** `{ url }` when there is one, else nothing: spread into a result. */
export const withUrl = (url: string | undefined) => (url ? { url } : {});
