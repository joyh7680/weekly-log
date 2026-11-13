import { AppError, assertCleanText, normalizeTitle, sameId, uuid } from './domain.mjs'

export const NOTION_VERSION = '2026-03-11'
export const defaultProperties = { title: '업무명', description: '설명', start: '시작일', end: '종료일', parent: 'Objective', lead: '리드', team: '팀', stage: '단계', status: '상태' }
const plain = rich => (rich || []).map(t => t.plain_text || t.text?.content || '').join('')
const filterMatches = (filter, properties, userId) => {
  if (!filter) return true
  if (filter.and) { const values = filter.and.map(f => filterMatches(f, properties, userId)); return values.includes(false) ? false : values.every(v => v === true) ? true : null }
  if (filter.or) { const values = filter.or.map(f => filterMatches(f, properties, userId)); return values.includes(true) ? true : values.every(v => v === false) ? false : null }
  const p = properties[filter.property] || Object.values(properties).find(p => p.id === filter.property)
  if (filter.people && p?.type === 'people') {
    if (filter.people.contains) return sameId(filter.people.contains, userId)
    if (filter.people.does_not_contain) return !sameId(filter.people.does_not_contain, userId)
  }
  // Unknown filters must not be reported as verified visibility.
  return null
}
export function createNotion(token, fetcher = fetch) {
  if (!token) throw new AppError('관리자가 Notion 연결 토큰을 먼저 저장해야 합니다.')
  async function request(path, body, method = body ? 'POST' : 'GET') {
    if (!['GET', 'POST'].includes(method)) throw new AppError('기존 Notion 항목 수정은 허용하지 않습니다.')
    const response = await fetcher(`https://api.notion.com/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000), redirect: 'error',
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new AppError(`Notion 요청 실패 (${response.status}). 연결 권한과 속성 설정을 확인해 주세요.`, 502)
      error.remoteStatus = response.status; throw error
    }
    return data
  }
  async function check(project, userId) {
    const p = { ...defaultProperties, ...project.properties }
    const [schema, parent, view] = await Promise.all([
      request(`/data_sources/${uuid(project.dataSourceId)}`), request(`/pages/${uuid(project.parentId)}`), request(`/views/${uuid(project.viewId)}`),
    ])
    const props = schema.properties
    for (const [key, types] of Object.entries({ title: ['title'], description: ['rich_text'], start: ['date'], end: ['date'], parent: ['relation'], lead: ['people'], team: ['multi_select', 'select'], stage: ['select'], status: ['select', 'status'] })) {
      if (!props[p[key]] || !types.includes(props[p[key]].type)) throw new AppError(`Notion '${p[key]}' 속성의 이름과 유형을 확인해 주세요.`)
    }
    if (!sameId(parent.parent?.data_source_id, schema.id)) throw new AppError('부모 항목이 지정한 데이터 소스에 속하지 않습니다.')
    const relation = props[p.parent]
    if (!sameId(relation.relation?.data_source_id || relation.relation?.database_id, schema.id)) throw new AppError('상위 항목 관계는 동일 데이터 소스를 참조해야 합니다.')
    const hierarchyView = project.hierarchyViewId && !sameId(project.hierarchyViewId, project.viewId) ? await request(`/views/${uuid(project.hierarchyViewId)}`) : view
    if (!sameId(hierarchyView.data_source_id, schema.id)) throw new AppError('하위 항목 확인용 보기가 같은 데이터 소스에 속하지 않습니다.')
    const subtask = hierarchyView.configuration?.subtasks
    const subProperty = subtask?.property_id
    if (!subProperty || subtask.display_mode !== 'show' || ![relation.id, relation.relation?.dual_property?.synced_property_id].filter(Boolean).some(id => decodeURIComponent(id) === decodeURIComponent(subProperty))) {
      throw new AppError('실제 하위 항목 연결을 확인할 수 없습니다. 연결 설정에서 하위 항목을 표시하는 기존 표 보기 ID와 상위 관계 속성을 지정해 주세요. 보기 설정은 변경하지 않습니다.')
    }
    const config = view.configuration
    if (view.type !== 'timeline' || !sameId(view.data_source_id, schema.id) || config?.date_property_id !== props[p.start].id || config?.end_date_property_id !== props[p.end].id) throw new AppError('기존 타임라인의 시작일·종료일 연결이 설정과 일치하지 않습니다. 보기 설정은 변경하지 않습니다.')
    if (config?.subtasks?.display_mode === 'disabled' || config?.subtasks?.display_mode === 'hidden') throw new AppError('현재 타임라인은 하위 항목을 표시하지 않습니다. 다른 기존 보기를 선택해 주세요.')
    if (userId) await request(`/users/${uuid(userId)}`)
    const teamOptions = props[p.team][props[p.team].type]?.options || []
    const stageOptions = props[p.stage].select?.options || []
    const statusOptions = props[p.status][props[p.status].type]?.options || []
    if (!teamOptions.some(x => x.name === project.team) || !stageOptions.some(x => x.name === '5. 세부 할 일') || !statusOptions.some(x => x.name === '진행 중')) throw new AppError('팀·단계·진행 중 옵션이 기존 데이터베이스에 있는지 확인해 주세요.')
    const visible = userId ? filterMatches(view.filter, props, uuid(userId)) : null
    return { schema, parent, view, properties: p, visibility: visible, nativeHierarchy: true, timelineDates: true }
  }
  async function children(project) {
    const p = { ...defaultProperties, ...project.properties }, result = []
    let cursor
    do {
      const page = await request(`/data_sources/${uuid(project.dataSourceId)}/query`, { page_size: 100, filter: { property: p.parent, relation: { contains: uuid(project.parentId) } }, ...(cursor ? { start_cursor: cursor } : {}) })
      result.push(...page.results)
      cursor = page.has_more ? page.next_cursor : undefined
      if (result.length > 10000) throw new AppError('기존 업무가 너무 많아 중복 검사를 완료하지 못했습니다.')
    } while (cursor)
    return result
  }
  function duplicate(rows, task, properties) {
    return rows.find(row => normalizeTitle(plain(row.properties[properties.title]?.title)) === normalizeTitle(task.title) && row.properties[properties.start]?.date?.start === task.start && row.properties[properties.end]?.date?.start === task.end)
  }
  async function create(project, task, userId, context) {
    const p = context.properties
    assertCleanText(`${task.title}\n${task.description}`)
    const description = `${task.description}\nGit 커밋 기준 확인 기간: ${task.start} ~ ${task.end} (Asia/Seoul). 전체 착수·완료일 및 최종 QA·배포 완료 여부는 별도 확인이 필요합니다.`
    const select = (name, value) => context.schema.properties[name].type === 'multi_select' ? { multi_select: [{ name: value }] } : context.schema.properties[name].type === 'status' ? { status: { name: value } } : { select: { name: value } }
    const properties = {
      [p.title]: { title: [{ text: { content: task.title } }] }, [p.description]: { rich_text: [{ text: { content: description } }] },
      [p.start]: { date: { start: task.start } }, [p.end]: { date: { start: task.end } },
      [p.parent]: { relation: [{ id: uuid(project.parentId) }] }, [p.lead]: { people: [{ object: 'user', id: uuid(userId) }] },
      [p.team]: select(p.team, project.team), [p.stage]: select(p.stage, '5. 세부 할 일'), [p.status]: select(p.status, '진행 중'),
    }
    return request('/pages', { parent: { type: 'data_source_id', data_source_id: uuid(project.dataSourceId) }, properties })
  }
  async function verify(project, task, pageId, userId, context) {
    const row = await request(`/pages/${uuid(pageId)}`), p = context.properties
    const props = row.properties
    const nativeHierarchy = props[p.parent]?.relation?.length === 1 && sameId(props[p.parent].relation[0].id, project.parentId)
    const dates = props[p.start]?.date?.start === task.start && props[p.end]?.date?.start === task.end
    const assignee = props[p.lead]?.people?.some(u => sameId(u.id, userId))
    const noLinks = !/(?:https?:\/\/|\b[0-9a-f]{7,40}\b)/i.test(plain(props[p.description]?.rich_text) + plain(props[p.title]?.title))
    const verification = { nativeHierarchy, dates, assignee, noLinks, timelineDates: context.timelineDates, visibility: context.visibility, visual: false }
    return { row, verification, ok: nativeHierarchy && dates && assignee && noLinks }
  }
  return { check, children, duplicate, create, verify, request }
}
