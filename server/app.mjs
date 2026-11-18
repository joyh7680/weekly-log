import express from 'express'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { createStore, hashPassword, checkPassword } from './store.mjs'
import { AppError, weekRange, validateRange, validateTask, excludeChanges, fingerprint, uuid, kstDay } from './domain.mjs'
import { localCommits, bitbucketCommits, safePath, safeRef } from './git.mjs'
import { analyzeTasks } from './ai.mjs'
import { createNotion, defaultProperties } from './notion.mjs'
import { googleIdentity } from './google.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const stamp = () => new Date().toISOString()
const userSchema = z.object({ name: z.string().trim().min(1).max(40), email: z.email().max(180).transform(s => s.toLowerCase()), password: z.string().min(10).max(128), invite: z.string().max(100).optional() })
const profileSchema = z.object({ gitName: z.string().trim().max(200), gitEmail: z.string().trim().max(300), notionUserId: z.string().trim().max(250), notionViewId: z.string().trim().max(250).optional().default('') })
const projectSchema = z.object({
  name: z.string().trim().min(1).max(100), source: z.enum(['local', 'bitbucket']), branch: z.string().trim().min(1).max(100),
  localPath: z.string().trim().max(1000), pathFilter: z.string().trim().max(500), workspace: z.string().trim().max(100), repo: z.string().trim().max(100),
  parentLabel: z.string().trim().min(1).max(150), dataSourceId: z.string().max(250), parentId: z.string().max(250), viewId: z.string().max(250), hierarchyViewId: z.string().max(250).optional().default(''), team: z.string().min(1).max(50),
  properties: z.object(Object.fromEntries(Object.keys(defaultProperties).map(key => [key, z.string().trim().min(1).max(100)]))),
})
export const seedProject = {
  id: 'codmos-ai-escape', name: 'AI 탈출 코드', source: 'local', branch: 'master', localPath: 'C:\\workspace\\codmos-cms', pathFilter: 'contents/ai-escape-code', workspace: 'Logicong-Dev', repo: 'codmos-cms',
  parentLabel: '1차시 · 개발 (1)', dataSourceId: '93f3188c-425b-8263-bbea-073f6063b4a1', parentId: '2a63188c-425b-828a-b8b2-8194c885c43f', viewId: '3f93188c-425b-80ed-9d64-000ce6594b10', hierarchyViewId: '', team: '04. 프론트', properties: defaultProperties,
}

export function createApp({ dataDir = resolve('data'), fetcher = fetch, collectLocal = localCommits, analyze = analyzeTasks, google = {
  clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  origin: process.env.APP_ORIGIN || 'http://localhost:4310', allowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN || '',
} } = {}) {
  const store = createStore(dataDir), { db } = store
  if (!db.prepare('SELECT id FROM projects LIMIT 1').get()) db.prepare('INSERT INTO projects VALUES (?,?,?)').run(seedProject.id, JSON.stringify(seedProject), stamp())
  const app = express(), inFlight = new Set(), attempts = new Map()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cache-Control', 'no-store')
    if (process.env.NODE_ENV === 'production') res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
    if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin
      const allowed = new Set([process.env.APP_ORIGIN || 'http://localhost:4310', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4310'])
      if (origin && !allowed.has(origin)) return res.status(403).json({ error: '허용되지 않은 요청 출처입니다.' })
      if (!req.is('application/json')) return res.status(415).json({ error: 'JSON 형식으로 요청해 주세요.' })
    }
    next()
  })
  app.use(express.json({ limit: '1mb' }))
  const publicUser = row => ({ id: row.id, name: row.name, email: row.email, role: row.role, profile: JSON.parse(row.profile), createdAt: row.created_at })
  const session = req => {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('weekly_session='))?.slice(15)
    if (!token) return null
    return db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(hash(token), Date.now())
  }
  const signIn = (res, id) => {
    const token = randomBytes(32).toString('hex')
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now())
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), id, Date.now() + 7 * 86400000)
    res.cookie('weekly_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 7 * 86400000, path: '/' })
  }
  const googleEnabled = !!(google.clientId && google.clientSecret)
  const googleCookie = { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path: '/api/auth/google' }
  function addUser(name, email, password, invite, domainApproved = false) {
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw new AppError(googleEnabled ? '이미 등록된 이메일입니다. 기존 계정으로 로그인한 뒤 내 설정에서 구글 계정을 연결해 주세요.' : '이미 등록된 이메일입니다.', 409)
    const setup = !db.prepare('SELECT id FROM users LIMIT 1').get()
    const code = invite ? db.prepare('SELECT * FROM invites WHERE token=? AND expires>? AND used_by IS NULL').get(invite, Date.now()) : null
    if (!setup && !code && !domainApproved) throw new AppError('유효한 팀 초대 코드가 필요합니다.', 403)
    const id = randomUUID()
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id, email, name, password, setup ? 'admin' : 'member', '{}', stamp())
    if (code) db.prepare('UPDATE invites SET used_by=? WHERE token=?').run(id, code.token)
    return id
  }
  const required = (req, res, next) => { const user = session(req); if (!user) return res.status(401).json({ error: '로그인해 주세요.' }); req.user = publicUser(user); next() }
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: '관리자만 변경할 수 있습니다.' })
  function limit(req, max = 15) {
    const now = Date.now(), key = `${req.ip}:${req.path}`
    if (attempts.size > 1000) for (const [key, value] of attempts) if (value.until < now) attempts.delete(key)
    const value = attempts.get(key)
    if (!value || value.until < now) { attempts.set(key, { n: 1, until: now + 900000 }); return }
    if (++value.n > max) throw new AppError('요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429)
  }
  const projectById = id => {
    const row = db.prepare('SELECT config FROM projects WHERE id=?').get(id)
    if (!row) throw new AppError('프로젝트를 찾을 수 없습니다.', 404)
    return JSON.parse(row.config)
  }
  const forUser = (project, user) => ({ ...project, ...(user.profile.notionViewId ? { viewId: uuid(user.profile.notionViewId) } : {}) })
  const notion = () => createNotion(store.getSecret('notion'), fetcher)
  const history = user => db.prepare(`SELECT r.*, u.name AS user_name FROM registrations r JOIN users u ON u.id=r.user_id ${user.role === 'admin' ? '' : 'WHERE r.user_id=?'} ORDER BY r.created_at DESC LIMIT 300`).all(...(user.role === 'admin' ? [] : [user.id])).map(r => ({ id: r.id, userId: r.user_id, userName: r.user_name, projectId: r.project_id, task: JSON.parse(r.task), state: r.state, notionId: r.notion_id, notionUrl: r.notion_url, verification: JSON.parse(r.verification || 'null'), error: r.error, createdAt: r.created_at }))

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }))
  app.get('/api/session', (req, res) => { const row = session(req); res.json({ user: row ? publicUser(row) : null, setupRequired: !db.prepare('SELECT id FROM users LIMIT 1').get(), googleEnabled, googleDomain: google.allowedDomain || '', range: weekRange() }) })
  app.get('/api/auth/google', (req, res) => {
    limit(req)
    if (!googleEnabled) throw new AppError('구글 로그인 설정이 필요합니다.', 503)
    const invite = z.string().max(100).parse(req.query.invite || '')
    const user = session(req)
    const state = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url')
    db.prepare('DELETE FROM google_login_states WHERE expires<=?').run(Date.now())
    db.prepare('INSERT INTO google_login_states VALUES (?,?,?,?,?)').run(hash(state), verifier, invite ? hash(invite) : '', user?.id || null, Date.now() + 10 * 60000)
    res.cookie('weekly_google_state', state, { ...googleCookie, maxAge: 10 * 60000 })
    const params = new URLSearchParams({ client_id: google.clientId, redirect_uri: `${google.origin}/api/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' })
    if (google.allowedDomain) params.set('hd', google.allowedDomain)
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
  })
  app.get('/api/auth/google/callback', async (req, res) => {
    try {
      limit(req)
      if (!googleEnabled) throw new AppError('구글 로그인 설정이 필요합니다.', 503)
      const state = z.string().regex(/^[a-f0-9]{64}$/).safeParse(req.query.state)
      const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('weekly_google_state='))?.slice(20)
      if (!state.success || cookie !== state.data) throw new AppError('로그인 요청이 만료되었거나 올바르지 않습니다. 다시 시작해 주세요.', 400)
      res.clearCookie('weekly_google_state', googleCookie)
      const pending = db.prepare('DELETE FROM google_login_states WHERE token=? RETURNING *').get(hash(state.data))
      if (!pending || pending.expires <= Date.now()) throw new AppError('로그인 요청이 만료되었습니다. 다시 시작해 주세요.', 400)
      if (req.query.error) throw new AppError('구글 로그인을 취소했습니다.', 400)
      const code = z.string().min(1).max(4096).parse(req.query.code)
      const identity = await googleIdentity(code, pending.verifier, google, fetcher)
      if (google.allowedDomain && identity.hd?.toLowerCase() !== google.allowedDomain.toLowerCase()) throw new AppError('허용된 회사 구글 계정으로 로그인해 주세요.', 403)
      let id
      db.exec('BEGIN IMMEDIATE')
      try {
        const linked = db.prepare('SELECT user_id FROM google_accounts WHERE subject=?').get(identity.sub)
        if (pending.user_id) {
          const user = session(req)
          if (!user || user.id !== pending.user_id) throw new AppError('기존 계정에 다시 로그인한 뒤 구글 계정을 연결해 주세요.', 401)
          if (user.email !== identity.email || (linked && linked.user_id !== user.id)) throw new AppError('기존 계정과 이메일이 같은 구글 계정을 선택해 주세요.', 403)
          const previous = db.prepare('SELECT subject FROM google_accounts WHERE user_id=?').get(user.id)
          if (previous && previous.subject !== identity.sub) throw new AppError('이 계정에는 다른 구글 계정이 연결되어 있습니다.', 409)
          id = user.id
        } else {
          id = linked?.user_id || addUser((identity.name?.trim() || identity.email.split('@')[0]).slice(0, 40), identity.email, '', pending.invite, !!google.allowedDomain)
        }
        if (!linked) db.prepare('INSERT INTO google_accounts VALUES (?,?)').run(identity.sub, id)
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      signIn(res, id)
      res.redirect(`${google.origin}/`)
    } catch (error) {
      const message = error instanceof AppError ? error.message : '구글 로그인에 실패했습니다. 잠시 후 다시 시도해 주세요.'
      res.redirect(`${google.origin}/?${new URLSearchParams({ authError: message })}`)
    }
  })
  app.post('/api/register', (req, res) => {
    limit(req)
    const input = userSchema.parse(req.body), password = hashPassword(input.password)
    let id
    db.exec('BEGIN IMMEDIATE')
    try {
      id = addUser(input.name, input.email, password, input.invite ? hash(input.invite) : '')
      db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    signIn(res, id); res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) })
  })
  app.post('/api/login', (req, res) => {
    limit(req)
    const input = z.object({ email: z.string().max(180), password: z.string().max(128) }).parse(req.body)
    const row = db.prepare('SELECT * FROM users WHERE email=?').get(input.email.trim().toLowerCase())
    const valid = checkPassword(input.password, row?.password || '00000000000000000000000000000000:' + '00'.repeat(64))
    if (!row || !valid) throw new AppError('이메일 또는 비밀번호를 확인해 주세요.', 401)
    signIn(res, row.id); res.json({ user: publicUser(row) })
  })
  app.post('/api/logout', required, (req, res) => {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('weekly_session='))?.slice(15)
    if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token))
    res.clearCookie('weekly_session', { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true' }); res.json({ ok: true })
  })
  app.get('/api/bootstrap', required, (req, res) => res.json({ user: req.user, projects: db.prepare('SELECT config FROM projects ORDER BY created_at').all().map(r => { const p = JSON.parse(r.config); return req.user.role === 'admin' ? p : { ...p, localPath: '' } }), history: history(req.user), range: weekRange(), connections: { notion: !!store.getSecret('notion'), bitbucket: !!store.getSecret('bitbucket') } }))
  app.put('/api/profile', required, (req, res) => {
    const profile = profileSchema.parse(req.body)
    if (profile.notionUserId) profile.notionUserId = uuid(profile.notionUserId)
    if (profile.notionViewId) profile.notionViewId = uuid(profile.notionViewId)
    db.prepare('UPDATE users SET profile=? WHERE id=?').run(JSON.stringify(profile), req.user.id)
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) })
  })
  app.get('/api/team', required, (req, res) => res.json({ users: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(r => ({ id: r.id, name: r.name, role: r.role, ...(req.user.role === 'admin' ? { email: r.email, profile: JSON.parse(r.profile) } : {}), createdAt: r.created_at })) }))
  app.post('/api/invites', required, admin, (req, res) => {
    limit(req, 30)
    const code = randomBytes(12).toString('base64url')
    db.prepare('INSERT INTO invites VALUES (?,?,?,NULL)').run(hash(code), req.user.id, Date.now() + 7 * 86400000)
    res.status(201).json({ code, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() })
  })
  app.put('/api/connections', required, admin, (req, res) => {
    const input = z.object({ notion: z.string().trim().max(1000).optional(), bitbucket: z.string().trim().max(1000).optional(), bitbucketEmail: z.string().trim().max(200).optional() }).parse(req.body)
    for (const [key, value] of Object.entries(input)) if (value !== undefined) store.setSecret(key, value)
    res.json({ ok: true, notion: !!store.getSecret('notion'), bitbucket: !!store.getSecret('bitbucket') })
  })
  const saveProject = (req, res) => {
    const config = projectSchema.parse(req.body)
    safeRef(config.branch); safePath(config.pathFilter)
    for (const name of ['dataSourceId', 'parentId', 'viewId']) config[name] = uuid(config[name])
    if (config.hierarchyViewId) config.hierarchyViewId = uuid(config.hierarchyViewId)
    if (config.source === 'local' && !config.localPath) throw new AppError('서버에서 접근할 저장소 경로를 입력해 주세요.')
    if (config.source === 'bitbucket' && (!config.workspace || !config.repo)) throw new AppError('Bitbucket 워크스페이스와 저장소를 입력해 주세요.')
    const id = req.params.id || randomUUID()
    if (req.params.id) projectById(id)
    const value = { ...config, id }
    db.prepare('INSERT INTO projects VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config').run(id, JSON.stringify(value), stamp())
    res.json({ project: value })
  }
  app.post('/api/projects', required, admin, saveProject)
  app.put('/api/projects/:id', required, admin, saveProject)
  app.post('/api/projects/:id/check', required, async (req, res) => {
    const project = forUser(projectById(req.params.id), req.user)
    const context = await notion().check(project, req.user.profile.notionUserId)
    res.json({ nativeHierarchy: context.nativeHierarchy, timelineDates: context.timelineDates, visibility: context.visibility, parent: context.parent.url, view: context.view.url || `https://www.notion.so/${uuid(project.parentId).replaceAll('-', '')}?v=${uuid(project.viewId).replaceAll('-', '')}`, message: '실제 하위 항목 관계와 날짜 연결을 확인했습니다. 화면의 일정 막대는 등록 후 직접 확인해 주세요.' })
  })
  app.post('/api/analyze', required, async (req, res) => {
    limit(req, 60)
    const input = z.object({ projectId: z.string(), start: z.string(), end: z.string(), engine: z.enum(['rules', 'codex']).default('rules') }).parse(req.body)
    validateRange(input.start, input.end)
    if (!req.user.profile.gitName && !req.user.profile.gitEmail) throw new AppError('내 설정에서 Git 작성자 이름 또는 이메일을 먼저 입력해 주세요.')
    const project = projectById(input.projectId)
    const raw = project.source === 'local' ? await collectLocal(project, req.user.profile, input.start, input.end) : await bitbucketCommits(project, req.user.profile, input.start, input.end, store.getSecret('bitbucket'), store.getSecret('bitbucketEmail'), fetcher)
    const filtered = excludeChanges(raw)
    const available = [], excluded = [...filtered.excluded]
    for (const commit of filtered.commits) {
      const previous = db.prepare('SELECT registration_id FROM commit_claims WHERE project_id=? AND parent_id=? AND commit_hash=?').get(project.id, uuid(project.parentId), commit.hash)
      if (previous) excluded.push({ hash: commit.hash, reason: '이미 등록되었거나 등록 결과 확인이 필요한 작업' }); else available.push(commit)
    }
    const result = available.length ? await analyze(available, input, input.engine) : { tasks: [], engine: input.engine, notes: [] }
    const id = randomUUID(), payload = { id, projectId: project.id, projectSnapshot: fingerprint(project), start: input.start, end: input.end, commits: available, tasks: result.tasks, excluded, engine: result.engine, notes: result.notes, totalCommits: raw.length }
    db.prepare('INSERT INTO analyses VALUES (?,?,?,?,?)').run(id, req.user.id, project.id, JSON.stringify(payload), stamp())
    res.json({ ...payload, commits: available.map(({ diff, patchId, ...c }) => c) })
  })
  app.get('/api/analyses/:id', required, (req, res) => {
    const row = db.prepare('SELECT * FROM analyses WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
    if (!row) throw new AppError('분석 결과를 찾을 수 없습니다.', 404)
    const payload = JSON.parse(row.payload); res.json({ ...payload, commits: payload.commits.map(({ diff, patchId, ...c }) => c) })
  })
  app.post('/api/register-tasks', required, async (req, res) => {
    const input = z.object({ analysisId: z.string(), tasks: z.array(z.unknown()).min(1).max(100) }).parse(req.body)
    const row = db.prepare('SELECT * FROM analyses WHERE id=? AND user_id=?').get(input.analysisId, req.user.id)
    if (!row) throw new AppError('본인의 분석 결과에서 등록해 주세요.', 404)
    const analysis = JSON.parse(row.payload), savedProject = projectById(row.project_id), project = forUser(savedProject, req.user)
    if (analysis.projectSnapshot !== fingerprint(savedProject)) throw new AppError('분석 이후 프로젝트 설정이 변경되었습니다. 다시 분석한 뒤 등록해 주세요.', 409)
    if (!req.user.profile.notionUserId) throw new AppError('내 설정에서 Notion 담당자 ID를 입력해 주세요.')
    const tasks = input.tasks.map(t => validateTask(t, analysis)), allHashes = tasks.flatMap(t => t.commitIds)
    if (new Set(allHashes).size !== allHashes.length) throw new AppError('하나의 커밋을 여러 업무에 중복 등록할 수 없습니다.')
    const lockKey = `${project.id}:${uuid(project.parentId)}`
    if (inFlight.has(lockKey)) throw new AppError('이 프로젝트의 다른 등록이 진행 중입니다. 잠시 후 다시 시도해 주세요.', 409)
    inFlight.add(lockKey)
    try {
      const client = notion(), context = await client.check(project, req.user.profile.notionUserId)
      if (context.visibility === false) throw new AppError('현재 보기는 다른 담당자로 필터링되어 있습니다. 내 설정에 본인이 사용하는 기존 타임라인 보기 ID를 입력해 주세요.')
      const existing = await client.children(project), results = []
      for (const task of tasks) {
        const fp = fingerprint(project.dataSourceId, project.parentId, [...task.commitIds].sort())
        const prior = db.prepare('SELECT id,state,notion_url FROM registrations WHERE fingerprint=?').get(fp)
        if (prior) { results.push({ title: task.title, state: prior.state, id: prior.id, notionUrl: prior.notion_url, message: '이미 처리한 작업입니다.' }); continue }
        if (task.commitIds.some(h => db.prepare('SELECT 1 FROM commit_claims WHERE project_id=? AND parent_id=? AND commit_hash=?').get(project.id, uuid(project.parentId), h))) { results.push({ title: task.title, state: 'duplicate', message: '동일한 커밋이 다른 업무에서 처리되었습니다.' }); continue }
        const duplicate = client.duplicate(existing, task, context.properties), id = randomUUID()
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare('INSERT INTO registrations(id,user_id,project_id,analysis_id,fingerprint,task,commit_ids,state,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, req.user.id, project.id, analysis.id, fp, JSON.stringify(task), JSON.stringify(task.commitIds), duplicate ? 'duplicate' : 'pending', stamp())
          for (const h of task.commitIds) db.prepare('INSERT INTO commit_claims VALUES (?,?,?,?)').run(project.id, uuid(project.parentId), h, id)
          db.exec('COMMIT')
        } catch (e) { db.exec('ROLLBACK'); throw e }
        if (duplicate) {
          db.prepare('UPDATE registrations SET notion_id=?,notion_url=? WHERE id=?').run(duplicate.id, duplicate.url, id)
          results.push({ id, title: task.title, state: 'duplicate', notionUrl: duplicate.url }); continue
        }
        let created
        try {
          created = await client.create(project, task, req.user.profile.notionUserId, context)
          if (!created?.id) throw new AppError('Notion 응답에 페이지 ID가 없어 저장 여부를 확인해야 합니다.')
          db.prepare('UPDATE registrations SET notion_id=?,notion_url=?,state=? WHERE id=?').run(created.id, created.url, 'needs-review', id)
          const checked = await client.verify(project, task, created.id, req.user.profile.notionUserId, context)
          const state = checked.ok ? 'created' : 'needs-review'
          db.prepare('UPDATE registrations SET state=?,verification=? WHERE id=?').run(state, JSON.stringify(checked.verification), id)
          existing.push(checked.row)
          results.push({ id, title: task.title, state, notionUrl: created.url, verification: checked.verification })
        } catch (e) {
          const definiteRejection = !created && e.remoteStatus >= 400 && e.remoteStatus < 500 && ![408, 409, 429].includes(e.remoteStatus)
          const state = created ? 'needs-review' : definiteRejection ? 'failed' : 'uncertain'
          db.prepare('UPDATE registrations SET state=?,error=? WHERE id=?').run(state, '저장 또는 재조회가 완료되지 않았습니다. 이력에서 확인해 주세요.', id)
          if (definiteRejection) { db.prepare('DELETE FROM commit_claims WHERE registration_id=?').run(id); db.prepare('UPDATE registrations SET fingerprint=? WHERE id=?').run(`${fp}:rejected:${id}`, id) }
          results.push({ id, title: task.title, state, notionUrl: created?.url, message: e.message })
        }
      }
      res.json({ results, history: history(req.user), viewUrl: context.view.url || `https://www.notion.so/?v=${uuid(project.viewId).replaceAll('-', '')}` })
    } finally { inFlight.delete(lockKey) }
  })
  app.post('/api/history/:id/recheck', required, async (req, res) => {
    const record = db.prepare('SELECT * FROM registrations WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
    if (!record) throw new AppError('등록 이력을 찾을 수 없습니다.', 404)
    const client = notion(), project = forUser(projectById(record.project_id), req.user), task = JSON.parse(record.task)
    const context = await client.check(project, req.user.profile.notionUserId)
    let pageId = record.notion_id
    if (!pageId) {
      const match = client.duplicate(await client.children(project), task, context.properties)
      if (!match) throw new AppError('일치하는 페이지를 찾지 못했습니다. 중복 생성을 막기 위해 자동 재등록하지 않습니다. Notion에서 저장 여부를 확인해 주세요.')
      pageId = match.id
    }
    const checked = await client.verify(project, task, pageId, req.user.profile.notionUserId, context)
    if (!checked.ok) throw new AppError('노션 속성이 등록 내용과 일치하지 않습니다. 기존 페이지는 수정하지 않았습니다.')
    db.prepare('UPDATE registrations SET state=?,notion_id=?,notion_url=?,verification=?,error=NULL WHERE id=?').run('created', pageId, checked.row.url, JSON.stringify(checked.verification), record.id)
    res.json({ history: history(req.user) })
  })
  app.post('/api/history/:id/visual', required, (req, res) => {
    const record = db.prepare('SELECT * FROM registrations WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
    if (!record || record.state !== 'created') throw new AppError('속성 검증을 통과한 본인의 업무만 확인할 수 있습니다.')
    if (req.body.confirmed !== true) throw new AppError('Notion 화면에서 일정 막대를 확인한 뒤 선택해 주세요.')
    const v = { ...JSON.parse(record.verification || '{}'), visual: true, visuallyConfirmedAt: stamp() }
    db.prepare('UPDATE registrations SET state=?,verification=? WHERE id=?').run('verified', JSON.stringify(v), record.id)
    res.json({ history: history(req.user) })
  })
  const dist = resolve('dist')
  if (existsSync(dist)) { app.use(express.static(dist, { index: false })); app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(join(dist, 'index.html'))) }
  app.use('/api', (_req, res) => res.status(404).json({ error: '요청한 기능을 찾을 수 없습니다.' }))
  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: '입력 내용을 확인해 주세요.', details: error.issues.map(i => `${i.path.join('.')}: ${i.message}`) })
    const status = error.status || 500
    if (status >= 500) console.error('[weekly-log]', error.name, error.code || '', error instanceof AppError ? error.message : 'Internal request failed')
    res.status(status).json({ error: error instanceof AppError ? error.message : status === 413 ? '요청 데이터가 너무 큽니다.' : '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' })
  })
  return { app, store }
}
