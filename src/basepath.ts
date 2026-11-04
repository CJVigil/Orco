/*
 * Serving under a sub-path (#142). ORCO_BASE_PATH (default "/") is the prefix people and agents use,
 * like "/orco/", when a proxy in front strips it before Orco sees the request. Routes stay at the
 * root; everything Orco writes out (redirects, cookie paths, links in pages) gets the prefix. The web
 * app itself uses relative URLs, so it works under any prefix.
 */

export function normalizeBase(raw: string | undefined): string {
  const trimmed = (raw ?? '/').trim().replace(/^\/+|\/+$/g, '');
  if (trimmed && !/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(trimmed)) throw new Error(`ORCO_BASE_PATH is a path like /orco/, got ${raw}`);
  return trimmed ? `/${trimmed}/` : '/';
}

/** The prefix, read when used so tests and the CLI can set it. Always starts and ends with "/". */
export function basePath(): string {
  return normalizeBase(process.env.ORCO_BASE_PATH);
}

/** A path under the prefix: at('oauth/consent') is "/orco/oauth/consent" with ORCO_BASE_PATH=/orco/. */
export function at(path: string): string {
  return `${basePath()}${path.replace(/^\/+/, '')}`;
}
