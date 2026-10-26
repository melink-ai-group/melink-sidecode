import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReviewFindings, reviewReferences, selectReviewReferences, recoverSubagentActivities } from './modelReview.ts';

test('model assessments distinguish valid empty findings from malformed or out-of-scope findings', () => {
  assert.deepEqual(modelReviewFindings('[]', ['src/a.ts']), []);
  const finding = { path: 'src/a.ts', line: 2, severity: 'warning', message: 'Missing guard.' };
  assert.deepEqual(modelReviewFindings('```json\n' + JSON.stringify([finding]) + '\n```', ['src/a.ts']), [finding]);
  for (const response of ['Looks fine.', '{}', '[{}]', JSON.stringify([{ ...finding, path: '../unrelated.ts' }]),
    JSON.stringify([{ ...finding, line: 0 }]), JSON.stringify([{ ...finding, severity: 'critical' }])]) {
    assert.throws(() => modelReviewFindings(response, ['src/a.ts']));
  }
});

test('reference selection reserves comparison controls and bounds model context', () => {
  const changed = Array.from({ length: 20 }, (_, index) => `src/pages/new${index}.tsx`);
  const selected = selectReviewReferences([...changed, 'src/components/Button.tsx', 'src/pages/old.tsx', 'secret.env'], changed);
  assert.ok(selected.includes('src/components/Button.tsx'));
  assert.ok(selected.includes('src/pages/old.tsx'));
  assert.ok(!selected.includes('secret.env'));
  assert.ok(selected.length <= 12);
  assert.deepEqual(selectReviewReferences(['index.html', 'form.css'], ['index.html']), ['index.html', 'form.css']);
  assert.equal(reviewReferences([]), '(no reference files available)');
  assert.ok(reviewReferences(Array.from({ length: 12 }, () => ({ path: 'a.ts', text: 'x'.repeat(9000) }))).length <= 36_000);
});

test('host restart marks unfinished workers cancelled without altering settled assessments', () => {
  const completed = { id: 'done', kind: 'notice' as const, agentActivity: { role: 'Review', reason: 'Code changed', status: 'completed' as const } };
  const recovered = recoverSubagentActivities([
    { ...completed, id: 'running', agentActivity: { ...completed.agentActivity, status: 'running' } }, completed
  ]);
  assert.equal(recovered[0].agentActivity?.status, 'cancelled');
  assert.equal(recovered[1], completed);
});
