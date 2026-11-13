import test from 'node:test'
import assert from 'node:assert/strict'
import { weekRange, kstDay, validateRange, validateTask, excludeChanges, groupCommits, assertCleanText, uuid } from '../server/domain.mjs'
import { matchesAuthor, safePath, safeRef } from '../server/git.mjs'
import { hashPassword, checkPassword, createStore } from '../server/store.mjs'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = n => n.toString(16).padStart(40, '0')
const commit = (n, date, message, diff = `+change ${n}`) => ({ hash: h(n), name: 'dev', email: 'dev@example.com', date, message, diff, files: ['src/mission.css'] })
test('KST calendar handles UTC boundary, weekends, and year transition', () => {
  assert.equal(kstDay('2026-11-08T15:01:00Z'), '2026-11-09')
  assert.deepEqual(weekRange('2026-11-13'), { start: '2026-11-09', end: '2026-11-13' })
  assert.deepEqual(weekRange('2026-11-15'), { start: '2026-11-09', end: '2026-11-13' })
  assert.deepEqual(weekRange('2027-01-01'), { start: '2026-12-28', end: '2027-01-01' })
  assert.throws(() => validateRange('2026-02-30', '2026-03-01'))
  assert.throws(() => validateRange('2026-11-09', '2026-11-16'))
})
test('registration requires actual commit dates within selected week and link-free text', () => {
  const commits = [commit(1, '2026-11-10T10:00:00+09:00', 'fix: keypad'), commit(2, '2026-11-12T10:00:00+09:00', 'fix: keypad')]
  const analysis = { start: '2026-11-09', end: '2026-11-13', commits }
  const task = { id: '1', title: '키패드 개선', description: '키패드 초기화 시점을 조정했습니다.', start: '2026-11-10', end: '2026-11-12', commitIds: [h(1), h(2)] }
  assert.deepEqual(validateTask(task, analysis), task)
  assert.throws(() => validateTask({ ...task, start: '2026-11-03' }, analysis))
  assert.throws(() => validateTask({ ...task, start: '2026-11-09' }, analysis))
  assert.throws(() => validateTask({ ...task, commitIds: [h(3)] }, analysis))
  assert.throws(() => validateTask({ ...task, description: '관련 Git 커밋: https://bitbucket.org/repo/commits/abcdef123' }, analysis))
  assert.throws(() => assertCleanText('커밋 abcdef123 를 적용했습니다.'))
})
test('reverts, revert-of-revert, and duplicate patches preserve the effective change', () => {
  const first = commit(1, '2026-11-10T00:00:00Z', 'fix: audio')
  const revert = commit(2, '2026-11-11T00:00:00Z', `Revert audio\nThis reverts commit ${first.hash}.`)
  assert.equal(excludeChanges([first, revert]).commits.length, 0)
  const restore = commit(3, '2026-11-12T00:00:00Z', `Revert revert\nThis reverts commit ${revert.hash}.`)
  assert.deepEqual(excludeChanges([first, revert, restore]).commits.map(c => c.hash), [first.hash])
  assert.equal(excludeChanges([first, { ...first, hash: h(4) }]).commits.length, 1)
})
test('grouping combines a purpose across dates instead of one row per commit', () => {
  const tasks = groupCommits([commit(1, '2026-11-10T10:00:00+09:00', 'fix: 배경음 설정'), commit(2, '2026-11-12T10:00:00+09:00', 'fix: 효과음 재생')])
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].start, '2026-11-10')
  assert.equal(tasks[0].end, '2026-11-12')
})
test('author matching is exact, and Git arguments cannot become flags or escape paths', () => {
  assert.equal(matchesAuthor(commit(1, '2026-11-10', ''), { gitName: 'dev, dev2' }), true)
  assert.equal(matchesAuthor(commit(1, '2026-11-10', ''), { gitName: 'de' }), false)
  assert.equal(safePath('contents\\ai-escape-code'), 'contents/ai-escape-code')
  for (const path of ['../private', 'C:\\private', '/etc', ':(glob)**']) assert.throws(() => safePath(path))
  for (const ref of ['--all', 'main..other', 'main^{tree}', 'HEAD~2']) assert.throws(() => safeRef(ref))
  assert.equal(uuid('https://www.notion.so/2a63188c425b828ab8b28194c885c43f'), '2a63188c-425b-828a-b8b2-8194c885c43f')
})
test('passwords are salted and connection tokens are encrypted on disk', async () => {
  const password = hashPassword('a-long-password')
  assert.equal(checkPassword('a-long-password', password), true)
  assert.equal(checkPassword('incorrect', password), false)
  assert.notEqual(password, hashPassword('a-long-password'))
  const dir = await mkdtemp(join(tmpdir(), 'weeklylog-store-test-'))
  const store = createStore(dir)
  try {
    store.setSecret('notion', 'very-secret-test-token')
    assert.equal(store.getSecret('notion'), 'very-secret-test-token')
    const raw = store.db.prepare('SELECT value FROM secrets').get().value
    assert.ok(!raw.includes('very-secret-test-token'))
    store.setSecret('notion', '')
    assert.equal(store.getSecret('notion'), '')
  } finally { store.close(); await rm(dir, { recursive: true, force: true }) }
})
