import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolvePlaywright, launchPlaywright, startServer, watchErrors } from './harness.js';
import { draftSpec, addOperation, reviseOperation } from '../requirements.js';
import { writeLocalProposalWitness } from '../store.js';
import { operationContent, type ProposalWitness } from '../schema.js';
import { discard } from '../test-tmp.js';
const pw = resolvePlaywright();
test('operation sign-off provenance distinguishes human authority, agent execution and remaining ratification', { skip: pw ? false : 'playwright not resolvable' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'codemap-operation-ui-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined, browser: any;
  try {
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'bob@acme.test'], ['config', 'user.name', 'Bob']]) {
      assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
    }
    mkdirSync(join(root, '.codemap'));
    writeFileSync(join(root, 'code.ts'), 'export const credit = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'seed'], { cwd: root });
    const spec = await draftSpec(root, { title: 'Credit approval' });
    assert.ok('id' in spec);
    const op = await addOperation(root, { specId: spec.id, kind: 'add_requirement', title: 'Credit bound', section: 'Credit', statement: 'Bound credit.', provenance: 'Owner', rationale: 'Exposure', reversibility: 'reversible' });
    assert.ok('operation' in op);
    // Seed only the view contract; authority admission/replay is exercised by the two-clone ops tests.
    await writeLocalProposalWitness(root, { id: 'ui-signoff', specId: spec.id, operationId: op.id, reviewer: { principal: 'alice@acme.test' }, at: '2026-09-26T12:00:00Z', content: operationContent(op.operation), application: { ruling: { answerId: 'human-answer-alice' }, executor: { principal: 'bob@acme.test', via: { kind: 'agent' } }, reader: { session: 'independent-reader', rationale: 'Exact shown operation approved.' } } } as ProposalWitness);
    server = await startServer(root);
    browser = await launchPlaywright(pw);
    const page = await browser.newPage();
    const { errors } = watchErrors(page);
    const universes = await (await fetch(server.url + '/api/universes')).json() as any;
    await page.goto(`${server.url}/#/u/${universes.primary}/standard/spec/${spec.id}/`);
    await page.waitForSelector('.operation-signoff-receipt');
    const text = await page.textContent('.operation-signoff-receipt');
    assert.match(text, /Exact operation signed by alice@acme.test/);
    assert.match(text, /Human answer human-answer-alice.*executed by bob@acme.test via agent/s);
    assert.match(text, /Independent reader independent-reader/);
    assert.match(text, /framing approval and ratification remain separate/);
    // B9 (F41): once the operation is revised, the same sign-off is history, not an exact sign-off.
    assert.ok(!('error' in await reviseOperation(root, { operationId: op.id, statement: 'Changed credit bound.', reason: 'tighter' })));
    await page.reload();
    await page.waitForSelector('.operation-signoff-receipt');
    const stale = await page.textContent('.operation-signoff-receipt');
    assert.doesNotMatch(stale, /Exact operation signed/);
    assert.match(stale, /earlier text of this operation/);
    assert.deepEqual(errors, []);
    await page.close();
  }
  finally {
    await browser?.close();
    server?.stop();
    discard(root);
  }
});
