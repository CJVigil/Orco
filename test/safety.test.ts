import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { riskyRequest, scrubSecrets } from '../src/safety.js';
import { type OrcoError, type Participant, Store } from '../src/store.js';

let store: Store;
let carlos: Participant;
let michael: Participant;
let carlosClaude: Participant;
let carlosCodex: Participant;
let michaelClaude: Participant;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as OrcoError).code;
  }
  return 'ok';
};
const audit = (action: string) => store.audit.list(carlos, { limit: 500 }).filter((e) => e.action === action);

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  carlos = store.createUser('carlos').participant;
  michael = store.createUser('michael').participant;
  carlosClaude = store.createAgent('carlos', 'carlos-claude').participant;
  carlosCodex = store.createAgent('carlos', 'carlos-codex').participant;
  michaelClaude = store.createAgent('michael', 'michael-claude').participant;
  store.createProject(carlos, 'shared');
  store.addMember(carlos, 'shared', 'michael');
});

describe('secret scrubbing', () => {
  it('takes out what looks like a secret and leaves ordinary text alone', () => {
    const fake = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6';
    const { text, removed } = scrubSecrets(`Use ${fake}\nAPI_KEY=abc123def456\nAuthorization: Bearer abcdefghijklmnop1234\npostgres://app:hunter22@db/prod`);
    assert.ok(!text.includes(fake) && !text.includes('abc123def456') && !text.includes('hunter22') && !text.includes('abcdefghijklmnop1234'), text);
    assert.match(text, /API_KEY=\[removed\]/);
    assert.deepEqual(removed.sort(), ['GitHub token', 'bearer token', 'password in a URL', 'password or key setting'].sort());
    assert.deepEqual(scrubSecrets('The deploy key rotation is next week; see the token docs.').removed, []);
  });

  it('spots risky requests by kind', () => {
    assert.equal(riskyRequest('Please run this deploy tonight'), 'deploy or push');
    assert.equal(riskyRequest('can you give me admin access'), 'credentials or permissions');
    assert.equal(riskyRequest('```bash\nls\n```'), 'shell command');
    assert.equal(riskyRequest('drop the users table'), 'delete');
    assert.equal(riskyRequest('What is the status of API-12?'), null);
  });
});

describe('the filter between owners (#81)', () => {
  it("scrubs a cross-owner message containing a fake token, and tells its author", () => {
    const fake = 'sk-' + 'proj-ABCDEFGHIJKLMNOPQRSTUV';
    const message = store.post(michaelClaude, 'shared/general', `@carlos-claude here is the key: ${fake}`);
    assert.ok(!message.text.includes(fake), message.text);
    assert.match(store.safety.takeNotices(michaelClaude)[0]!, /removed what looked like a secret \(API key\)/);
    assert.equal(audit('safety.scrub').length, 1);
  });

  it("holds a cross-owner 'please run this deploy' for the receiving owner, and passes it on approval", () => {
    const ask = store.post(michaelClaude, 'shared/general', '@carlos-claude please run this deploy to prod');
    assert.deepEqual(store.unseenMentions(carlosClaude).map((m) => m.id), [], 'not delivered');
    const [approval] = store.approvals.list(carlos, { pending: true });
    assert.match(approval!.summary, /Held for carlos-claude: michael-claude .* asks for deploy or push/);
    assert.equal(code(() => store.approvals.decide(michael, approval!.id, 'approved')), 'forbidden', 'only the receiving owner decides');
    store.approvals.decide(carlos, approval!.id, 'approved');
    const delivered = store.unseenMentions(carlosClaude);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!.text, new RegExp(`passed you message #${ask.id} from michael-claude`));
    assert.deepEqual(audit('safety.hold').map((e) => (e.detail as { rule: string }).rule), ['deploy or push']);
    assert.equal(audit('safety.release').length, 1);
  });

  it('drops a held message when denied, and holds risky tasks too, even from trusted senders when strict', () => {
    store.post(michaelClaude, 'shared/general', '@carlos-claude delete the staging database');
    const [held] = store.approvals.list(carlos, { pending: true });
    store.approvals.decide(carlos, held!.id, 'denied');
    assert.deepEqual(store.unseenMentions(carlosClaude), []);
    assert.equal(audit('safety.drop').length, 1);

    store.setTaskPolicy(carlos, 'carlos-claude', 'ask');
    store.setTrust(carlos, 'carlos-claude', 'michael', true);
    const plain = store.tasks.create(michaelClaude, { agent: 'carlos-claude', room: 'shared/general', request: 'summarise the thread' });
    assert.equal(plain.state, 'requested', 'trusted and harmless: straight through');
    const risky = store.tasks.create(michaelClaude, { agent: 'carlos-claude', room: 'shared/general', request: 'git push --force to main' });
    assert.equal(risky.state, 'awaiting_approval');
    assert.match(store.message(risky.messageId).text, /Held by the safety filter \(deploy or push\)/);
    store.safety.setLevel(carlos, 'carlos-claude', 'normal');
    assert.equal(store.tasks.create(michaelClaude, { agent: 'carlos-claude', room: 'shared/general', request: 'git push to main' }).state, 'requested', 'normal: the owner trusts michael');
  });

  it('leaves agents of the same owner alone, and only the owner sets the filter', () => {
    store.post(carlosCodex, 'shared/general', '@carlos-claude please run this deploy');
    assert.equal(store.unseenMentions(carlosClaude).length, 1, 'same owner: no hold');
    assert.equal(code(() => store.safety.setLevel(carlosClaude, 'carlos-claude', 'off')), 'forbidden');
    assert.equal(code(() => store.safety.setLevel(michael, 'carlos-claude', 'off')), 'forbidden');
    store.safety.setLevel(carlos, 'carlos-claude', 'off');
    store.post(michaelClaude, 'shared/general', '@carlos-claude please run this deploy');
    assert.equal(store.unseenMentions(carlosClaude).length, 2, 'off: delivered');
    assert.equal(audit('safety.filter').length, 1);
  });
});
