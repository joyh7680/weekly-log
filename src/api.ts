export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } })
  const data = await response.json().catch(() => ({ error: '서버 응답을 확인할 수 없습니다.' }))
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.')
  return data
}
export const json = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) })
export function currentWeek(day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())) {
  const date = new Date(`${day}T00:00:00Z`), weekday = date.getUTCDay() || 7
  const start = new Date(date.getTime() - (weekday - 1) * 86400000).toISOString().slice(0, 10)
  const end = new Date(date.getTime() - Math.max(0, weekday - 5) * 86400000).toISOString().slice(0, 10)
  return { start, end }
}
export const addDays = (date: string, count: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + count * 86400000).toISOString().slice(0, 10)
export const shortDate = (date: string) => date.slice(5).replace('-', '.')
export const formatDate = (date: string) => new Date(date).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' })
