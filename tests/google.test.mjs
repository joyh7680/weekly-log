import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createApp } from '../server/app.mjs'

const config = { clientId: 'test-client', clientSecret: 'test-client-secret', origin: 'http://localhost:5173', allowedDomain: '' }
const identity = { sub: 'google-owner', email: 'owner@example.com', email_verified: true, name: '구글 사용자' }
const cookie = (response, name) => response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';')[0] || ''
const failure = response => new URL(response.headers.get('location')).searchParams.get('authError')

async function harness(google = config) {
  const dir = await mkdtemp(join(tmpdir(), 'weeklylog-google-test-'))
  const profiles = new Map(), requests = []
  let serial = 0
  const fetcher = async (url, init) => {
    requests.push({ url, init })
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(init.body)
      assert.equal(body.get('client_id'), config.clientId)
      assert.equal(body.get('client_secret'), config.clientSecret)
      assert.equal(body.get('redirect_uri'), `${config.origin}/api/auth/google/callback`)
      assert.equal(body.get('grant_type'), 'authorization_code')
      const pending = profiles.get(body.get('code'))
      if (pending.error) throw new Error('provider error with test-client-secret')
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), pending.challenge)
      return Response.json({ access_token: body.get('code') })
    }
    assert.equal(url, 'https://openidconnect.googleapis.com/v1/userinfo')
    return Response.json(profiles.get(init.headers.Authorization.slice(7)).profile)
  }
  const { app, store } = createApp({ dataDir: dir, google, fetcher })
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const request = (path, options = {}) => fetch(base + '/api' + path, { redirect: 'manual', ...options })
  const post = (path, body, sessionCookie = '') => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie, Origin: config.origin }, body: JSON.stringify(body) })
  const start = async (profile = identity, { invite = '', sessionCookie = '', error = false } = {}) => {
    const response = await request(`/auth/google?${new URLSearchParams({ invite })}`, { headers: { Cookie: sessionCookie } })
    assert.equal(response.status, 302)
    const target = new URL(response.headers.get('location')), code = `mock-code-${++serial}`
    assert.equal(target.origin, 'https://accounts.google.com')
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(target.searchParams.get('scope'), 'openid email profile')
    assert.ok(!target.search.includes(config.clientSecret))
    assert.match(response.headers.get('set-cookie'), /HttpOnly/)
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/)
    profiles.set(code, { profile, challenge: target.searchParams.get('code_challenge'), error })
    return { state: target.searchParams.get('state'), code, cookie: [cookie(response, 'weekly_google_state'), sessionCookie].filter(Boolean).join('; ') }
  }
  const finish = flow => request(`/auth/google/callback?${new URLSearchParams({ state: flow.state, code: flow.code })}`, { headers: { Cookie: flow.cookie } })
  const localOwner = () => post('/register', { name: '기존 관리자', email: identity.email, password: 'owner-password123' })
  return { request, post, start, finish, localOwner, store, requests, close: async () => { await new Promise(resolve => server.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('Google login is unavailable without server credentials', async () => {
  const h = await harness({ ...config, clientSecret: '' })
  try {
    assert.equal((await (await h.request('/session')).json()).googleEnabled, false)
    assert.equal((await h.request('/auth/google')).status, 503)
    assert.equal(h.requests.length, 0)
  } finally { await h.close() }
})

test('Google signup creates one admin and subsequent login uses the immutable Google subject', async () => {
  const h = await harness()
  try {
    const first = await h.finish(await h.start())
    assert.equal(first.headers.get('location'), config.origin + '/')
    const sessionCookie = cookie(first, 'weekly_session')
    assert.ok(sessionCookie)
    assert.match(first.headers.getSetCookie().find(value => value.startsWith('weekly_session=')), /HttpOnly/)
    const user = (await (await h.request('/session', { headers: { Cookie: sessionCookie } })).json()).user
    assert.equal(user.role, 'admin')
    assert.equal(user.email, identity.email)
    assert.equal(user.name, identity.name)
    const again = await h.finish(await h.start({ ...identity, email: 'renamed@example.com' }))
    const next = (await (await h.request('/session', { headers: { Cookie: cookie(again, 'weekly_session') } })).json()).user
    assert.equal(next.id, user.id)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1)
    assert.equal(h.store.db.prepare('SELECT password FROM users').get().password, '')
    assert.equal((await h.post('/login', { email: identity.email, password: '' })).status, 401)
  } finally { await h.close() }
})

test('Google signup preserves invitations and checks their validity after the provider returns', async () => {
  const h = await harness()
  try {
    const owner = cookie(await h.localOwner(), 'weekly_session')
    const member = { ...identity, sub: 'member-google', email: 'member@example.com' }
    assert.match(failure(await h.finish(await h.start(member))), /초대 코드/)
    const invite = await (await h.post('/invites', {}, owner)).json()
    const first = await h.start(member, { invite: invite.code })
    const second = await h.start({ ...member, sub: 'another-google', email: 'other@example.com' }, { invite: invite.code })
    const results = await Promise.all([h.finish(first), h.finish(second)])
    assert.equal(results.filter(result => !failure(result)).length, 1)
    assert.equal(results.filter(result => /초대 코드/.test(failure(result))).length, 1)
    assert.equal(h.store.db.prepare("SELECT COUNT(*) n FROM users WHERE role='member'").get().n, 1)
    assert.ok(h.store.db.prepare('SELECT used_by FROM invites').get().used_by)
    const expired = await (await h.post('/invites', {}, owner)).json()
    const flow = await h.start({ ...member, sub: 'expired-google', email: 'expired@example.com' }, { invite: expired.code })
    h.store.db.prepare('UPDATE invites SET expires=0').run()
    assert.match(failure(await h.finish(flow)), /초대 코드/)
  } finally { await h.close() }
})

test('a configured Workspace domain allows invitation-free members and rejects unverified or foreign identities', async () => {
  const h = await harness({ ...config, allowedDomain: 'example.com' })
  try {
    await h.localOwner()
    const member = { ...identity, sub: 'company-member', email: 'member@example.com', hd: 'example.com' }
    assert.equal(failure(await h.finish(await h.start(member))), null)
    const row = h.store.db.prepare('SELECT role FROM users WHERE email=?').get(member.email)
    assert.equal(row.role, 'member')
    for (const profile of [
      { ...member, hd: undefined },
      { ...member, hd: 'other.example.com' },
      { ...member, hd: 'example.com.attacker.invalid' },
      { ...member, email_verified: false },
      { ...member, sub: '' },
    ]) {
      assert.ok(failure(await h.finish(await h.start(profile))))
    }
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM users').get().n, 2)
  } finally { await h.close() }
})

test('OAuth rejects missing or mismatched cookies, expiration, cancellation and replay before contacting Google', async () => {
  const h = await harness()
  try {
    const flow = await h.start()
    assert.ok(failure(await h.finish({ ...flow, cookie: '' })))
    assert.ok(failure(await h.finish({ ...flow, state: 'a'.repeat(64) })))
    assert.equal(h.requests.length, 0)
    h.store.db.prepare('UPDATE google_login_states SET expires=0').run()
    assert.match(failure(await h.finish(flow)), /만료/)
    assert.equal(h.requests.length, 0)
    const cancelled = await h.start()
    const response = await h.request(`/auth/google/callback?${new URLSearchParams({ state: cancelled.state, error: 'access_denied' })}`, { headers: { Cookie: cancelled.cookie } })
    assert.match(failure(response), /취소/)
    assert.equal(h.requests.length, 0)
    assert.ok(failure(await h.finish(cancelled)))
    const valid = await h.start()
    assert.equal(failure(await h.finish(valid)), null)
    assert.ok(failure(await h.finish(valid)))
    assert.equal(h.requests.length, 2)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1)
  } finally { await h.close() }
})

test('existing accounts are linked only with the original authenticated session and matching email', async () => {
  const h = await harness()
  try {
    const owner = cookie(await h.localOwner(), 'weekly_session')
    assert.match(failure(await h.finish(await h.start())), /기존 계정/)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM google_accounts').get().n, 0)
    const lost = await h.start(identity, { sessionCookie: owner })
    assert.match(failure(await h.finish({ ...lost, cookie: lost.cookie.split(';')[0] })), /다시 로그인/)
    assert.match(failure(await h.finish(await h.start({ ...identity, email: 'attacker@example.com' }, { sessionCookie: owner }))), /이메일/)
    assert.equal(failure(await h.finish(await h.start(identity, { sessionCookie: owner }))), null)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM users').get().n, 1)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM google_accounts').get().n, 1)
    assert.equal(failure(await h.finish(await h.start())), null)
    assert.match(failure(await h.finish(await h.start({ ...identity, sub: 'another-subject' }, { sessionCookie: owner }))), /다른 구글 계정/)
  } finally { await h.close() }
})

test('provider failure creates no account or session and does not expose secrets in the redirect', async () => {
  const h = await harness()
  try {
    const response = await h.finish(await h.start(identity, { error: true }))
    assert.match(failure(response), /잠시 후 다시/)
    assert.ok(!response.headers.get('location').includes(config.clientSecret))
    assert.equal(cookie(response, 'weekly_session'), '')
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM users').get().n, 0)
    assert.equal(h.store.db.prepare('SELECT COUNT(*) n FROM google_accounts').get().n, 0)
  } finally { await h.close() }
})
