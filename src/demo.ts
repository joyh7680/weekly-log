import { currentWeek, addDays } from './api'
import type { Analysis, Bootstrap, Task, User } from './types'

const range = currentWeek()
export const demoUser: User = { id: 'demo', name: '황지원', email: 'jiwon@example.com', role: 'admin', profile: { gitName: 'jiwonhwang', gitEmail: 'jiwon@example.com', notionUserId: '' }, createdAt: new Date().toISOString() }
const specs = [
  ['대화창·선택 UI 및 딤 처리 개선', '화면 비율에 맞게 대화창 여백과 선택 카드를 조정하고, 메뉴와 닫기 버튼의 정렬 및 딤 처리를 개선했습니다.', 1, 3, 7],
  ['오입력 후 키패드 초기화 개선', '오입력 안내가 끝난 뒤 입력값과 오류 표시를 초기화하도록 재입력 흐름을 개선했습니다.', 1, 1, 2],
  ['도어락 성공 후 문 이미지 전환 수정', '문이 열릴 때 이전 이미지가 겹쳐 보이지 않도록 장면 전환을 수정했습니다.', 1, 1, 1],
  ['LMS 소리 설정 및 미션 음원 재생 개선', '배경음과 효과음 설정을 각각 반영하고 미션 성공음의 재생 경로를 수정했습니다.', 2, 3, 5],
] as const
const tasks: Task[] = specs.map(([title, description, start, end, count], i) => ({ id: `demo-${i}`, title, description, start: addDays(range.start, Math.min(start, new Date(range.end).getUTCDay() - 1)), end: addDays(range.start, Math.min(end, new Date(range.end).getUTCDay() - 1)), commitIds: Array.from({ length: count }, (_, j) => (i * 10 + j + 1).toString(16).padStart(40, '0')) }))
export const demoAnalysis: Analysis = { id: 'demo', projectId: 'demo-project', ...range, tasks, commits: tasks.flatMap(task => task.commitIds.map(hash => ({ hash, name: 'jiwonhwang', email: 'jiwon@example.com', date: `${task.start}T10:00:00+09:00`, message: `fix: ${task.title}`, files: ['app/components/Mission.vue', 'app/assets/styles/mission.css'] }))), excluded: [{ hash: '1'.repeat(40), reason: '조회 기간 안에서 되돌려진 변경' }, { hash: '2'.repeat(40), reason: '되돌리기 커밋' }], engine: 'demo', notes: ['이 데이터는 화면 체험용 예시입니다. 실제 Git 또는 Notion에 접근하지 않습니다.'], totalCommits: 17 }
export const demoBootstrap: Bootstrap = {
  user: demoUser, range, connections: { notion: false, bitbucket: false },
  projects: [{ id: 'demo-project', name: 'AI 탈출 코드', source: 'local', branch: 'master', localPath: 'C:\\workspace\\codmos-cms', pathFilter: 'contents/ai-escape-code', workspace: 'Logicong-Dev', repo: 'codmos-cms', parentLabel: '1차시 · 개발 (1)', dataSourceId: '', parentId: '', viewId: '', hierarchyViewId: '', team: '04. 프론트', properties: { title: '업무명', description: '설명', start: '시작일', end: '종료일', parent: 'Objective', lead: '리드', team: '팀', stage: '단계', status: '상태' } }],
  history: tasks.slice(0, 3).map((task, i) => ({ id: `demo-history-${i}`, userId: 'demo', userName: '황지원', projectId: 'demo-project', task, state: i === 0 ? 'verified' : 'created', verification: { nativeHierarchy: true, dates: true, noLinks: true, visibility: true, visual: i === 0 }, createdAt: new Date().toISOString() })),
}
