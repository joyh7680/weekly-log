import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createApp, seedProject } from '../server/app.mjs'
import { defaultProperties } from '../server/notion.mjs'

const notionUser = '395d872b-594c-815d-b255-00027e16284c'
const fixture = { hash: 'a'.repeat(40), name: 'dev', email: 'dev@example.com', date: '2026-11-10T10:00:00+09:00', message: 'fix: 키패드 오입력 초기화 개선', diff: '+state.input = ""', files: ['app/keypad.mjs'] }
function mockNotion({ failCreate = false, hierarchy = true, wrongDates = false } = {}) {
  const requests = [], rows = new Map(), schema = { id: seedProject.dataSourceId, properties: {} }
  for (const [key, name] of Object.entries(defaultProperties)) {
    const type = ({ title: 'title', description: 'rich_text', start: 'date', end: 'date', parent: 'relation', lead: 'people', team: 'multi_select', stage: 'select', status: 'select' })[key]
    schema.properties[name] = { id: key, type }
  }
  schema.properties.Objective.relation = { data_source_id: schema.id, type: 'dual_property', dual_property: { synced_property_id: 'children' } }
  schema.properties['팀'].multi_select = { options: [{ name: '04. 프론트' }] }
  schema.properties['단계'].select = { options: [{ name: '5. 세부 할 일' }] }
  schema.properties['상태'].select = { options: [{ name: '진행 중' }] }
  const old = { id: '11111111-1111-1111-1111-111111111111', url: 'https://www.notion.so/old', properties: { 업무명: { title: [{ text: { content: '기존 완료 업무' } }] }, 시작일: { date: { start: '2026-11-03' } }, 종료일: { date: { start: '2026-11-05' } } } }
  rows.set(old.id, old)
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname, method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null
    requests.push({ path, method, body })
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
    if (path === `/v1/data_sources/${schema.id}`) return reply(schema)
    if (path === `/v1/pages/${seedProject.parentId}`) return reply({ id: seedProject.parentId, parent: { data_source_id: schema.id }, url: 'https://www.notion.so/parent' })
    if (path.startsWith('/v1/users/')) return reply({ id: notionUser, type: 'person' })
    if (path.startsWith('/v1/views/')) return reply({ id: seedProject.viewId, type: 'timeline', data_source_id: schema.id, configuration: { date_property_id: 'start', end_date_property_id: wrongDates ? 'start' : 'end', subtasks: hierarchy ? { property_id: 'children', display_mode: 'show' } : null }, filter: { property: '리드', people: { contains: notionUser } }, url: 'https://www.notion.so/?v=test' })
    if (path.endsWith('/query')) return reply({ results: [...rows.values()], has_more: false })
    if (path === '/v1/pages' && method === 'POST') {
      if (failCreate) throw new Error('Connection lost after POST')
      const id = '22222222-2222-2222-2222-222222222222', row = { id, url: `https://www.notion.so/${id}`, properties: body.properties }
      rows.set(id, row); return reply(row)
    }
    if (path.startsWith('/v1/pages/')) return reply(rows.get(path.split('/').at(-1)) || {}, rows.has(path.split('/').at(-1)) ? 200 : 404)
    throw new Error(`Unexpected request ${method} ${path}`)
  }
  return { fetcher, requests, rows, old }
}
async function harness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'weeklylog-api-test-'))
  const mock = mockNotion(options)
  const { app, store } = createApp({ dataDir: dir, fetcher: mock.fetcher, collectLocal: async () => [fixture] })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`, jar = { cookie: '' }
  const call = async (path, method = 'GET', body, cookie = jar.cookie, origin = 'http://localhost:5173') => {
    const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (response.headers.get('set-cookie')) jar.cookie = response.headers.get('set-cookie').split(';')[0]
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') }
  }
  const bootstrap = async () => {
    await call('/register', 'POST', { name: '테스트 개발자', email: 'dev@example.com', password: 'test-password-1234' })
    await call('/profile', 'PUT', { gitName: 'dev', gitEmail: 'dev@example.com', notionUserId: notionUser })
    await call('/connections', 'PUT', { notion: 'test-secret-token' })
    return (await call('/analyze', 'POST', { projectId: seedProject.id, start: '2026-11-09', end: '2026-11-13', engine: 'rules' })).data
  }
  return { call, jar, store, mock, bootstrap, close: async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('team authentication, single-use invitations, and admin-only project/token access', async () => {
  const h = await harness()
  try {
    assert.equal((await h.call('/auth/google')).status, 404)
    assert.equal((await h.call('/auth/google/callback')).status, 404)
    assert.equal((await h.call('/bootstrap')).status, 401)
    const owner = await h.call('/register', 'POST', { name: '관리자', email: 'owner@example.com', password: 'owner-password123' })
    assert.equal(owner.data.user.role, 'admin'); assert.match(owner.cookie, /HttpOnly/); assert.match(owner.cookie, /SameSite=Lax/)
    const ownerCookie = h.jar.cookie
    const invite = await h.call('/invites', 'POST', {})
    assert.equal((await h.call('/register', 'POST', { name: '팀원', email: 'member@example.com', password: 'member-password123' })).status, 403)
    const member = await h.call('/register', 'POST', { name: '팀원', email: 'member@example.com', password: 'member-password123', invite: invite.data.code })
    assert.equal(member.data.user.role, 'member')
    assert.equal((await h.call('/logout', 'POST', {})).status, 200)
    assert.equal((await h.call('/bootstrap')).status, 401)
    const login = await h.call('/login', 'POST', { email: 'member@example.com', password: 'member-password123' })
    assert.equal(login.status, 200)
    assert.equal(login.data.user.id, member.data.user.id)
    assert.equal((await h.call('/connections', 'PUT', { notion: 'stolen' })).status, 403)
    assert.equal((await h.call('/projects/' + seedProject.id, 'PUT', seedProject)).status, 403)
    assert.equal((await h.call('/bootstrap')).data.projects[0].localPath, '')
    assert.equal((await h.call('/register', 'POST', { name: '중복', email: 'second@example.com', password: 'test-password123', invite: invite.data.code })).status, 403)
    assert.equal((await h.call('/profile', 'PUT', {}, ownerCookie, 'https://attacker.invalid')).status, 403)
    const raw = h.store.db.prepare('SELECT password FROM users LIMIT 1').get().password
    assert.ok(!raw.includes('owner-password123'))
  } finally { await h.close() }
})
test('only creates direct child pages, preserves old rows, blocks URLs and wrong dates, and deduplicates retries', async () => {
  const h = await harness()
  try {
    const analysis = await h.bootstrap(), before = JSON.stringify(h.mock.old), task = analysis.tasks[0]
    assert.equal(analysis.commits[0].diff, undefined)
    const send = tasks => h.call('/register-tasks', 'POST', { analysisId: analysis.id, tasks })
    assert.equal((await send([{ ...task, description: '관련 Git 커밋: https://github.com/test' }])).status, 400)
    assert.equal((await send([{ ...task, start: '2026-11-03' }])).status, 400)
    const result = await send([task]); assert.equal(result.status, 200)
    assert.equal(result.data.results[0].state, 'created')
    assert.equal(result.data.results[0].verification.visual, false)
    const writes = h.mock.requests.filter(r => r.method === 'POST' && r.path === '/v1/pages')
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].body.properties.Objective.relation, [{ id: seedProject.parentId }])
    assert.deepEqual(writes[0].body.properties['시작일'], { date: { start: '2026-11-10' } })
    assert.deepEqual(writes[0].body.properties['종료일'], { date: { start: '2026-11-10' } })
    assert.deepEqual(writes[0].body.properties['단계'], { select: { name: '5. 세부 할 일' } })
    assert.ok(!JSON.stringify(writes[0].body).includes(fixture.hash))
    assert.equal(writes[0].body.children, undefined)
    assert.equal(h.mock.requests.some(r => ['PATCH', 'DELETE'].includes(r.method)), false)
    assert.equal(JSON.stringify(h.mock.old), before)
    await send([task]); assert.equal(h.mock.requests.filter(r => r.method === 'POST' && r.path === '/v1/pages').length, 1)
    const again = await h.call('/analyze', 'POST', { projectId: seedProject.id, start: analysis.start, end: analysis.end, engine: 'rules' })
    assert.equal(again.data.tasks.length, 0)
    const id = result.data.results[0].id
    assert.equal((await h.call(`/history/${id}/visual`, 'POST', { confirmed: true })).data.history[0].state, 'verified')
  } finally { await h.close() }
})
test('does not write when native hierarchy or timeline mapping cannot be verified', async () => {
  for (const options of [{ hierarchy: false }, { wrongDates: true }]) {
    const h = await harness(options)
    try {
      const analysis = await h.bootstrap()
      assert.equal((await h.call('/register-tasks', 'POST', { analysisId: analysis.id, tasks: analysis.tasks })).status, 400)
      assert.equal(h.mock.requests.filter(r => r.path === '/v1/pages').length, 0)
    } finally { await h.close() }
  }
})
test('keeps uncertain writes reserved instead of blindly creating a second page', async () => {
  const h = await harness({ failCreate: true })
  try {
    const analysis = await h.bootstrap(), body = { analysisId: analysis.id, tasks: analysis.tasks }
    const first = await h.call('/register-tasks', 'POST', body)
    assert.equal(first.data.results[0].state, 'uncertain')
    await h.call('/register-tasks', 'POST', body)
    assert.equal(h.mock.requests.filter(r => r.method === 'POST' && r.path === '/v1/pages').length, 1)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM commit_claims').get().n, 1)
  } finally { await h.close() }
})

test('analysis ownership and changed-project protection prevent registering another context', async () => {
  const h = await harness()
  try {
    const analysis = await h.bootstrap(), ownerCookie = h.jar.cookie
    const invite = await h.call('/invites', 'POST', {})
    await h.call('/register', 'POST', { name: '다른 사용자', email: 'other@example.com', password: 'other-password123', invite: invite.data.code })
    assert.equal((await h.call('/analyses/' + analysis.id)).status, 404)
    assert.equal((await h.call('/register-tasks', 'POST', { analysisId: analysis.id, tasks: analysis.tasks })).status, 404)
    await h.call('/projects/' + seedProject.id, 'PUT', { ...seedProject, parentLabel: '다른 등록 위치' }, ownerCookie)
    assert.equal((await h.call('/register-tasks', 'POST', { analysisId: analysis.id, tasks: analysis.tasks }, ownerCookie)).status, 409)
    assert.equal(h.mock.requests.filter(r => r.method === 'POST' && r.path === '/v1/pages').length, 0)
  } finally { await h.close() }
})
