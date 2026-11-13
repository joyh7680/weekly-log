import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath } from 'node:fs/promises'
import { AppError, kstDay, fingerprint } from './domain.mjs'

const exec = promisify(execFile)
const git = async (cwd, args) => (await exec('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', timeout: 45000, maxBuffer: 20 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout
export function safeRef(ref) {
  if (!ref || ref.startsWith('-') || /[\s\x00-\x1f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')) throw new AppError('브랜치 이름이 올바르지 않습니다.')
  return ref
}
export function safePath(path = '') {
  const clean = path.replaceAll('\\', '/').replace(/^\.\//, '')
  if (clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').includes('..') || clean.startsWith(':') || clean.includes('\0')) throw new AppError('프로젝트 범위는 저장소 안의 상대 경로로 지정해 주세요.')
  return clean
}
export async function localCommits(project, profile, start, end) {
  const cwd = await realpath(project.localPath).catch(() => { throw new AppError('서버에서 저장소 경로를 찾을 수 없습니다. 연결 설정을 확인해 주세요.') })
  const branch = safeRef(project.branch), scope = safePath(project.pathFilter)
  const raw = await git(cwd, ['log', branch, '--no-merges', '--max-count=10001', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e', '--', scope || '.'])
  const all = raw.split('\x1e').map(s => s.trim()).filter(Boolean).map(line => {
    const [hash, name, email, date, ...message] = line.split('\x1f')
    return { hash, name, email, date, message: message.join('\x1f').trim() }
  })
  if (all.length > 10000) throw new AppError('조회 범위의 이력이 너무 많습니다. 프로젝트 하위 경로를 지정해 주세요.')
  const matches = all.filter(c => kstDay(c.date) >= start && kstDay(c.date) <= end && matchesAuthor(c, profile))
  if (matches.length > 300) throw new AppError('커밋이 300개를 넘습니다. 프로젝트 범위를 좁혀 주세요.')
  const result = []
  for (const commit of matches) {
    const diff = await git(cwd, ['show', '--format=', '--no-ext-diff', '--no-textconv', '--unified=2', commit.hash, '--', scope || '.'])
    const files = (await git(cwd, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit.hash, '--', scope || '.'])).trim().split('\n').filter(Boolean)
    result.push({ ...commit, diff, files })
  }
  return result
}
export function matchesAuthor(commit, profile) {
  const names = (profile.gitName || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  const emails = (profile.gitEmail || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  return names.includes(commit.name.toLowerCase()) || emails.includes(commit.email.toLowerCase())
}
export async function bitbucketCommits(project, profile, start, end, token, email, fetcher = fetch) {
  if (!token) throw new AppError('관리자가 Bitbucket 연결 정보를 먼저 저장해야 합니다.')
  const workspace = encodeURIComponent(project.workspace), repo = encodeURIComponent(project.repo)
  const root = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repo}`
  const auth = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`
  const request = async url => {
    if (!url.startsWith(`${root}/`)) throw new AppError('Bitbucket 응답의 다음 페이지 주소가 올바르지 않습니다.')
    const res = await fetcher(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(45000), redirect: 'error' })
    if (!res.ok) throw new AppError(`Bitbucket 조회 실패 (${res.status}). 저장소 접근 권한과 연결 정보를 확인해 주세요.`, 502)
    return res
  }
  let url = `${root}/commits/${encodeURIComponent(safeRef(project.branch))}?pagelen=100`, pages = 0
  const commits = []
  while (url) {
    if (++pages > 100) throw new AppError('이력이 10,000개를 넘습니다. 서버에 저장소를 복제한 뒤 로컬 Git 소스를 사용해 주세요.')
    const page = await (await request(url)).json()
    for (const item of page.values || []) {
      if (item.parents?.length > 1 || kstDay(item.date) < start || kstDay(item.date) > end) continue
      const author = item.author?.raw || ''
      const commit = { hash: item.hash, name: author.replace(/\s*<.*>$/, ''), email: author.match(/<([^>]+)>/)?.[1] || '', date: item.date, message: item.message || '' }
      if (matchesAuthor(commit, profile)) commits.push(commit)
    }
    url = page.next || ''
  }
  if (commits.length > 300) throw new AppError('커밋이 300개를 넘습니다. 조회 기간을 줄여 주세요.')
  const scope = safePath(project.pathFilter)
  const result = []
  for (const commit of commits) {
    const diff = await (await request(`${root}/diff/${commit.hash}`)).text()
    const sections = diff.split(/(?=^diff --git )/m).filter(s => !scope || s.split('\n')[0]?.includes(` b/${scope}/`) || s.split('\n')[0]?.endsWith(` b/${scope}`))
    if (!sections.length) continue
    const filtered = sections.join('')
    const files = [...filtered.matchAll(/^diff --git a\/(.*?) b\/(.*)$/gm)].map(m => m[2])
    result.push({ ...commit, diff: filtered, files, patchId: fingerprint(filtered.replace(/^index .*$/gm, '').replace(/^@@.*$/gm, '')) })
  }
  return result
}
