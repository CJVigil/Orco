import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { installSkill, skillText } from '../src/skill.js';

const root = new URL('..', import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));

describe('agent skill packs', () => {
  it('ships a valid Agent Skill', () => {
    const text = skillText();
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1] ?? '';
    assert.match(front, /^name: orco\r?$/m, 'the name matches its folder');
    const description = /^description: (.+?)\r?$/m.exec(front)?.[1] ?? '';
    assert.ok(description.length > 50 && description.length <= 1024, 'the description fits the Agent Skills limit');
  });

  it('installs where each tool looks, or into a given folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'orco-skill-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'orco-skill-repo-'));
    assert.equal(installSkill({ target: 'claude', home, cwd }), join(home, '.claude', 'skills', 'orco', 'SKILL.md'));
    assert.equal(installSkill({ target: 'codex', home, cwd }), join(home, '.agents', 'skills', 'orco', 'SKILL.md'));
    assert.equal(installSkill({ target: 'codex', project: true, home, cwd }), join(cwd, '.agents', 'skills', 'orco', 'SKILL.md'));
    assert.equal(installSkill({ dir: 'tools/skills', home, cwd }), join(cwd, 'tools', 'skills', 'orco', 'SKILL.md'));
    assert.equal(readFileSync(join(home, '.claude', 'skills', 'orco', 'SKILL.md'), 'utf8'), skillText());
    assert.throws(() => installSkill({ target: 'nope', home, cwd }), /--for claude\|codex\|agents/);
    assert.throws(() => installSkill({ home, cwd }), /--dir/);
  });

  it('has a Claude Code plugin and marketplace that point at real files', () => {
    const marketplace = json('.claude-plugin/marketplace.json');
    const entry = marketplace.plugins.find((p: { name: string }) => p.name === 'orco');
    assert.equal(entry.source, './integrations/claude-code');
    const plugin = json('integrations/claude-code/.claude-plugin/plugin.json');
    assert.equal(plugin.name, 'orco');
    assert.equal(plugin.mcpServers.orco.url, '${user_config.server_url}/mcp');
    assert.equal(plugin.userConfig.token.sensitive, true, 'the token goes to the credential store, not settings.json');
    for (const file of ['commands/inbox.md', 'commands/handoff.md', 'skills/orco/SKILL.md']) {
      assert.ok(existsSync(new URL(`integrations/claude-code/${file}`, root)), file);
    }
  });
});
