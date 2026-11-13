import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
export const uuid = (value) => {
  const match = String(value || '').match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i)
  if (!match) throw new AppError('올바른 Notion ID 또는 URL을 입력해 주세요.')
  return match[0].replaceAll('-', '').toLowerCase().replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}
export const sameId = (a, b) => String(a).replaceAll('-', '').toLowerCase() === String(b).replaceAll('-', '').toLowerCase()
export const kstDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date))
export function weekRange(day = kstDay()) {
  const date = new Date(`${day}T12:00:00+09:00`)
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7
  const start = new Date(date.getTime() - (weekday - 1) * 86400000)
  const end = weekday > 5 ? new Date(date.getTime() - (weekday - 5) * 86400000) : date
  return { start: kstDay(start), end: kstDay(end) }
}
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}, '실제 존재하는 날짜를 입력해 주세요.')
export function validateRange(start, end) {
  if (!daySchema.safeParse(start).success || !daySchema.safeParse(end).success) throw new AppError('날짜 형식을 확인해 주세요.')
  if (start > end) throw new AppError('시작일이 종료일보다 늦습니다.')
  const monday = weekRange(start).start
  if (end > new Date(new Date(`${monday}T00:00:00Z`).getTime() + 6 * 86400000).toISOString().slice(0, 10)) throw new AppError('한 주 안의 기간을 선택해 주세요.')
  if (end > kstDay()) throw new AppError('아직 지나지 않은 날짜의 업무는 분석할 수 없습니다.')
}
export const textOnly = value => String(value || '').replace(/<[^>]*>/g, '').trim()
export function assertCleanText(value) {
  if (/(?:https?:\/\/|www\.|(?:bitbucket\.org|github\.com)|\b[0-9a-f]{7,40}\b|관련\s*Git\s*커밋)/i.test(value)) throw new AppError('업무명과 설명에는 링크, 커밋 해시, 커밋 목록을 넣을 수 없습니다.')
}
export const taskSchema = z.object({
  id: z.string().max(80), title: z.string().trim().min(2).max(100), description: z.string().trim().min(5).max(1200),
  start: daySchema, end: daySchema, commitIds: z.array(z.string().regex(/^[0-9a-f]{40}$/i)).min(1).max(300),
})
export function validateTask(input, analysis) {
  const task = taskSchema.parse(input)
  assertCleanText(`${task.title}\n${task.description}`)
  if (task.start < analysis.start || task.end > analysis.end || task.start > task.end) throw new AppError('업무 일정은 선택한 주간 기간 안에 있어야 합니다.')
  const commits = task.commitIds.map(id => analysis.commits.find(c => c.hash === id))
  if (commits.some(c => !c)) throw new AppError('분석 결과에 없는 커밋이 포함되어 있습니다.')
  const dates = commits.map(c => kstDay(c.date)).sort()
  if (task.start !== dates[0] || task.end !== dates.at(-1)) throw new AppError('일정은 선택한 커밋의 첫 작성일과 마지막 작성일이어야 합니다.')
  return task
}
export const normalizeTitle = value => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
export const fingerprint = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex')
export function excludeChanges(commits) {
  const reverted = new Set(), reasons = []
  const seen = new Map()
  for (const commit of [...commits].sort((a, b) => b.date.localeCompare(a.date))) {
    if (reverted.has(commit.hash)) continue
    const target = commit.message.match(/This reverts commit ([0-9a-f]{40})/i)?.[1]
    if (target && commits.some(c => c.hash === target)) {
      reverted.add(target); reverted.add(commit.hash)
      reasons.push({ hash: target, reason: '조회 기간 안에서 되돌려진 변경' }, { hash: commit.hash, reason: '되돌리기 커밋' })
    }
  }
  const kept = commits.filter(c => !reverted.has(c.hash)).sort((a, b) => a.date.localeCompare(b.date))
  return { commits: kept.filter(c => {
    const patch = c.patchId || fingerprint(c.diff.replace(/^index .*$/gm, '').replace(/^@@.*$/gm, '').trim())
    if (c.diff.trim() && seen.has(patch)) { reasons.push({ hash: c.hash, reason: '동일한 변경 내용' }); return false }
    seen.set(patch, c.hash); return true
  }), excluded: reasons }
}
const categories = [
  { key: 'audio', test: /sound|audio|bgm|sfx|소리|음원|성공음|효과음|배경음|볼륨/i, title: '소리 설정 연동 및 음원 재생 개선', description: '소리 설정과 음원 재생에 관련된 동작을 보완했습니다.' },
  { key: 'keypad', test: /키패드.*(?:초기화|오입력|오답|판정)|(?:오입력|오답).*키패드|wrongInput|state\.inputError/i, title: '키패드 오입력 처리 및 재입력 흐름 개선', description: '키패드의 입력 상태와 오류 안내 이후 재입력 흐름을 보완했습니다.' },
  { key: 'transition', test: /문 전환|이미지 중첩|doorAnimations|openingDoor|fade|페이드|엔딩/i, title: '화면 전환 및 장면 표시 개선', description: '장면 전환 과정에서 화면 요소가 표시되는 방식과 전환 동작을 보완했습니다.' },
  { key: 'design', test: /디자인|여백|정렬|딤 처리|딤처리|스타일|반응형|\.css\b|\.scss\b/i, title: '화면 배치 및 사용자 인터페이스 개선', description: '화면 구성 요소의 배치와 표시 스타일을 조정했습니다.' },
  { key: 'integration', test: /API|api|연동|인증|권한|세션|서버|로그인/i, title: '서비스 연동 및 데이터 처리 개선', description: '서비스 연동과 데이터 처리에 관련된 동작을 보완했습니다.' },
]
export function groupCommits(commits) {
  const groups = new Map()
  for (const commit of commits) {
    const firstLine = commit.message.split('\n')[0]
    const category = categories.find(c => c.test.test(firstLine)) || categories.find(c => c.test.test(commit.files.join(' ') + '\n' + commit.diff))
    const cleaned = firstLine.replace(/^(?:fix|feat|chore|refactor|test|docs|style|perf)(?:\([^)]*\))?\s*:?\s*/i, '').replace(/\b[0-9a-f]{7,40}\b/gi, '').trim()
    const key = category?.key || normalizeTitle(cleaned)
    if (!groups.has(key)) groups.set(key, { title: category?.title || cleaned || '기능 동작 개선', description: category?.description, commits: [] })
    groups.get(key).commits.push(commit)
  }
  return [...groups.values()].map(group => {
    const dates = group.commits.map(c => kstDay(c.date)).sort()
    const summaries = [...new Set(group.commits.map(c => c.message.split('\n')[0].replace(/^(?:fix|feat|chore|refactor|test|docs|style|perf)(?:\([^)]*\))?\s*:?\s*/i, '').replace(/https?:\/\/\S+|\b[0-9a-f]{7,40}\b/gi, '').trim()))]
    return { id: randomUUID(), title: group.title, description: group.description || summaries.slice(-3).join('. ').slice(0, 1000) + '.', start: dates[0], end: dates.at(-1), commitIds: group.commits.map(c => c.hash) }
  })
}
