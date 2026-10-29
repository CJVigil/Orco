import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// #32: routes registered on `app` instead of the `api` router missed the secret masking middleware.
// Every authenticated route that parses a JSON body must do it through jsonBody, which masks.
describe('http routes', () => {
  it('parse authenticated JSON bodies only through jsonBody', () => {
    const source = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8');
    const routes = [...source.matchAll(/^\s*(?:app|api)\.(?:post|put|patch|delete)\(([^\n]*)/gm)].map((m) => m[1]!);
    const unmasked = routes.filter((line) => /\bauth\b/.test(line) && /express\.json\(/.test(line));
    assert.deepEqual(unmasked, []);
    assert.match(source, /api\.use\(auth, \.\.\.jsonBody\(/, 'the api router masks every body');
  });
});
