import type { Labels } from './memory-api.ts'

export type WorkPageProps = { L: Labels; language: 'en' | 'zh-CN' }
export type WorkTask = { id: string; displayTitle: string; state: string; question: string; createdAt: string; updatedAt: string }
export type Workflow = {
  id: string
  state: string
  next?: { name: string }
  view?: { label: string; current?: { name: string } }
  effectSummary?: { kind: string; attemptedAt?: number; observedAt?: number }
}
export type WorkItems = {
  tasks: WorkTask[]; activeTasks: WorkTask[]; attention: WorkTask[]
  workflowActions: Workflow[]
  projectReviews: { id: string; title: string }[]
}

export function workspaceTasks(work?: WorkItems) {
  return new Map(work && [...work.tasks, ...work.activeTasks, ...work.attention].map(task => [task.id, task] as const))
}

export function workHref(hash: string) {
  return '/configure' + location.search + '#' + hash
}

export function originalTaskHref(id: string) {
  const url = new URL(workHref('tasks/attention'), location.href)
  url.searchParams.set('focusTask', id)
  return url.pathname + url.search + url.hash
}

export function workDate(at: number | string, language: WorkPageProps['language']) {
  return new Date(at).toLocaleString(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
