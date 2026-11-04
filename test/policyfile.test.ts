import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { checkPolicy } from '../src/policyfile.js';
import { type OrcoError, Store } from '../src/store.js';

const example = readFileSync('docs/policy.example.json', 'utf8');

describe('policies as a file (#120)', () => {
  it('checks a file: what it will do, or exactly what is wrong', () => {
    const good = checkPolicy(example);
    assert.equal(good.ok, true, good.errors.join('; '));
    assert.ok(good.summary.includes('org: modes capped at auto'));
    assert.ok(good.summary.includes('projects.ops: folder Infrastructure is owned by carlos'));
    const bad = checkPolicy(JSON.stringify({ version: 1, org: { modeCap: 'auto', lock: ['budgets'] }, projects: { ops: { modeCap: 'full', deployWindows: [{ spec: 'whenever' }] } }, extra: 1 }));
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.errors, [
      'Unknown key "extra" at the top',
      'org.lock: "budgets" cannot be locked; lockable: scopeGate, scopeSections, modeCap, guestLinks, defaultMode',
      'projects.ops.deployWindows[0]: A window is days and hours, like "Wed 13:00-17:00" or "Mon-Fri 06:00-17:00"',
      "projects.ops.modeCap full is broader than the org's auto: a project can only tighten",
    ]);
    assert.match(checkPolicy('{').errors[0]!, /^Not JSON/);
  });

  it('applies on load, locks settings in the app, and shows where each value came from', () => {
    const store = new Store(openDatabase(':memory:'));
    const carlos = store.createUser('carlos').participant;
    store.createProject(carlos, 'ops');
    store.tickets.createFolder(carlos, 'ops', { name: 'Infrastructure' });
    const dir = mkdtempSync(join(tmpdir(), 'orco-policy-'));
    const file = join(dir, 'policy.json');
    writeFileSync(file, example);
    assert.deepEqual(store.policyFile.load(file), []);
    assert.equal(store.modes.project(store.visibleProject(carlos, 'ops').id).cap, 'auto_edits');
    assert.ok(store.rules.list().find((r) => r.name === 'No Docker socket mounts')!.enabled);
    assert.deepEqual(store.owners.list(carlos, 'ops').map((o) => o.owner), ['carlos']);
    assert.throws(() => store.modes.setOrgCap(carlos, null), (err: OrcoError) => err.code === 'forbidden' && /managed by the policy file/.test(err.message));
    assert.throws(() => store.modes.setProject(carlos, 'ops', { cap: 'full' }), /managed by the policy file/);
    store.modes.setProject(carlos, 'ops', { defaultMode: 'auto_edits' }); // not locked
    const shown = store.policyFile.show(carlos).settings;
    assert.deepEqual(shown.find((s) => s.key === 'org.modeCap'), { key: 'org.modeCap', value: '{"mode":"auto","by":"the policy file"}', source: 'file', locked: true });
    assert.deepEqual(shown.find((s) => s.key === 'ops.defaultMode'), { key: 'ops.defaultMode', value: 'auto_edits', source: 'file', locked: false });
    assert.deepEqual(shown.find((s) => s.key === 'org.guestLinks')?.source, 'file');
  });
});
