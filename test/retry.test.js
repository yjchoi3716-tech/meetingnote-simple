import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../retry.js';

const FAST = [10, 10, 10];
const err = (status, msg = 'x') => Object.assign(new Error(msg), status ? { status } : {});

test('일시적 오류(503) 후 성공하면 결과 반환', async () => {
  let n = 0;
  const r = await withRetry('t', async () => { if (++n < 3) throw err(503); return 'ok'; }, FAST);
  assert.equal(r, 'ok'); assert.equal(n, 3);
});

test('429·네트워크 오류도 재시도', async () => {
  let n = 0;
  const r = await withRetry('t', async () => { n++; if (n === 1) throw err(429); if (n === 2) throw err(0 || undefined, 'fetch failed'); return 'ok'; }, FAST);
  assert.equal(r, 'ok'); assert.equal(n, 3);
});

test('재시도 횟수를 다 쓰면 마지막 오류를 던짐 (총 4번 시도)', async () => {
  let n = 0;
  await assert.rejects(withRetry('t', async () => { n++; throw err(500, 'boom'); }, FAST), /boom/);
  assert.equal(n, 4);
});

test('키 오류(400/403) 같은 영구 오류는 재시도하지 않음', async () => {
  for (const s of [400, 403, 404]) {
    let n = 0;
    await assert.rejects(withRetry('t', async () => { n++; throw err(s); }, FAST));
    assert.equal(n, 1, `status ${s}`);
  }
});
