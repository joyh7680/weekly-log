import test from 'node:test'
import assert from 'node:assert/strict'
import { bitbucketCommits } from '../server/git.mjs'

test('Bitbucket reads all pages, scopes actual diffs, excludes merge and wrong-author commits', async () => {
  const calls = [], hash = 'a'.repeat(40), other = 'b'.repeat(40)
  const root = 'https://api.bitbucket.org/2.0/repositories/team/repo'
  const fetcher = async (url, options) => {
    calls.push({ url, options })
    if (url.includes('/diff/')) return new Response('diff --git a/contents/app/index.vue b/contents/app/index.vue\n+new UI\ndiff --git a/private/ignored b/private/ignored\n+not included\n')
    const values = url.includes('page=2') ? [{ hash, date: '2026-11-10T10:00:00+09:00', parents: [{ hash: other }], author: { raw: 'dev <dev@example.com>' }, message: 'fix: UI' }] : [
      { hash: other, date: '2026-11-10T10:00:00+09:00', parents: [{}, {}], author: { raw: 'dev <dev@example.com>' } },
      { hash: other, date: '2026-11-10T10:00:00+09:00', parents: [{}], author: { raw: 'another <other@example.com>' } },
      { hash: other, date: '2026-11-01T10:00:00+09:00', parents: [{}], author: { raw: 'dev <dev@example.com>' } },
    ]
    return Response.json({ values, ...(url.includes('page=2') ? {} : { next: `${root}/commits/master?page=2` }) })
  }
  const result = await bitbucketCommits({ workspace: 'team', repo: 'repo', branch: 'master', pathFilter: 'contents/app' }, { gitEmail: 'dev@example.com' }, '2026-11-09', '2026-11-13', 'token', 'api@example.com', fetcher)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].files, ['contents/app/index.vue'])
  assert.ok(!result[0].diff.includes('private/ignored'))
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from('api@example.com:token').toString('base64')}`)
  assert.equal(calls.length, 3)
})
test('Bitbucket pagination never forwards credentials to a foreign host', async () => {
  let count = 0
  await assert.rejects(() => bitbucketCommits({ workspace: 'team', repo: 'repo', branch: 'master' }, { gitName: 'dev' }, '2026-11-09', '2026-11-13', 'secret', '', async () => {
    count++; return Response.json({ values: [], next: 'https://attacker.example/collect' })
  }), /다음 페이지 주소/)
  assert.equal(count, 1)
})
