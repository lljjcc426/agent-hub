// Project existing, authenticated AgentHub views. Only identifiers and states enter the checkpoint.
const activeRuns = new Set(['queued', 'running', 'waiting', 'cancel_requested'])
const runKinds = { completed: 'done', failed: 'failed', cancelled: 'stopped', waiting: 'waiting' }
const attentionKinds = {
  task_question: 'question', native_question: 'question', native_approval: 'approval',
  workflow_review: 'review', project_review: 'review', effect_unknown: 'uncertain'
}
const actionable = new Set(['needs_reply', 'waiting_permission', 'needs_review', 'outcome_unknown'])
const conversationId = /^[a-f0-9-]{36}$/

function cardKind(card) {
  switch (card.kind) {
    case 'choice': return card.decision?.defaultOption ? null : 'choice'
    case 'question': return ['expired', 'stale'].includes(card.question?.status) ? 'revalidate' : 'question'
    case 'approval': return card.request?.method === 'item/tool/requestUserInput' ? 'question' : 'approval'
    case 'file': return 'file'
    default: return null
  }
}

async function chatActivity(get, chat, previous, now, newChat) {
  const url = '/api/chat/conversations/' + chat.id
  const view = await get(url + '?withPending=1')
  const runs = new Map()
  const follow = new Set(previous?.active || [])
  if (view.run) follow.add(view.run.id)
  const messages = view.messages
  const sequence = messages.at(-1)?.sequence ?? previous?.sequence ?? 0
  if (previous || newChat) {
    const after = previous?.sequence || 0
    // A second turn may start before the next poll. Follow the earlier turn to its own final state.
    let page = view
    while (true) {
      for (const m of page.messages) if (m.sequence > after && m.runId) follow.add(m.runId)
      const first = page.messages[0]?.sequence
      if (!page.hasMore || !first || first <= after + 1) break
      page = await get(url + '?before=' + first)
      if (page.messages.length && page.messages[0].sequence >= first) throw Error('Invalid chat page')
    }
  }
  for (const id of follow) {
    // The run-scoped view also checks Worker failures, delivery receipts and live goals.
    try {
      const snapshot = await get(url + '?run=' + encodeURIComponent(id))
      if (snapshot.run?.id === id) runs.set(id, snapshot.run)
    } catch (error) {
      if (error.status !== 404) throw error
    }
  }
  const states = {}
  const cardTickets = new Set()
  for (const card of view.pendingCards) {
    const kind = cardKind(card)
    if (!kind) continue
    const version = card.question?.version || ''
    states['card:' + card.id + ':' + version] = kind
    const ticket = card.question?.ticketId || card.request?.ticketId
    if (ticket) cardTickets.add(ticket)
  }
  const hasCards = Object.keys(states).length > 0
  const active = []
  // Keep a small tail of final run states so late transcript rows don't repeat a notification.
  const history = new Map(previous?.history || [])
  for (const run of runs.values()) {
    const kind = runKinds[run.state]
    if (activeRuns.has(run.state)) active.push(run.id)
    if (kind && kind !== 'waiting') history.set(run.id, kind)
    else history.delete(run.id)
    if (kind === 'waiting') states['run:' + run.id] = kind
  }
  const recent = Array.from(history).slice(-256)
  for (const [id, kind] of recent) states['run:' + id] = kind
  for (const task of view.tasks) {
    if (task.state === 'completed') states['task:' + task.id] = 'workerDone'
    if (task.state === 'cancelled') states['task:' + task.id] = 'workerStopped'
    if (task.state === 'waiting' && !cardTickets.has(task.id)) {
      states['task:' + task.id] = task.question ? 'question' : 'waiting'
    }
  }
  for (const request of view.approvals) {
    if (request.executionState === 'failed' || request.executionState === 'uncertain') {
      states['operation:' + request.id] = request.executionState
    }
  }
  const busy = active.length > 0 || hasCards || view.tasks.some(task => ['queued', 'running', 'waiting'].includes(task.state))
  return { states, active, busy, history: recent, sequence, tickets: view.tasks.map(task => task.id),
    hasCards, updatedAt: chat.updatedAt, checkedAt: now }
}

async function pages(get, path, key) {
  const items = []
  let offset = 0
  for (;;) {
    const page = await get(path + '?limit=100&offset=' + offset)
    const rows = page[key]
    items.push(...rows)
    if (!page.more) return items
    if (!rows.length || page.offset !== offset) throw Error('Invalid workspace page')
    offset += rows.length
  }
}

async function workspaceActivity(get, ticketChats) {
  const tasks = await pages(get, '/entry-workspace', 'tasks')
  const attention = await pages(get, '/entry-workspace/attention', 'items')
  const states = {}, destinations = {}
  const covered = new Set()
  for (const item of attention) {
    if (!actionable.has(item.state) || !attentionKinds[item.kind]) continue
    const ticket = item.taskRef?.id
    const chat = ticketChats.get(ticket)
    if (ticket) covered.add(ticket)
    // Chat has its own permission/question cards. External reviews and unknown outcomes may exist only here.
    if (chat && ['task_question','native_question','native_approval'].includes(item.kind)) continue
    const key = 'attention:' + item.id
    states[key] = attentionKinds[item.kind]
    destinations[key] = chat ? '/chat#conversation/' + chat : '/configure#attention'
  }
  for (const task of tasks) {
    if (ticketChats.has(task.id) || covered.has(task.id)) continue
    const kind = task.deliveryUncertain ? 'uncertain' : task.question ? 'question' :
      task.approvalIds?.length ? 'approval' : { attention:'waiting', ready:'ready', replied:'done', closed:'ended' }[task.state]
    if (!kind) continue
    const key = 'task:' + task.id
    states[key] = kind
    destinations[key] = ['done','ended','ready'].includes(kind) ? '/configure#tasks/history' : '/configure#attention'
  }
  return { states, destinations }
}

function changed(previous, current, destination) {
  const groups = new Map()
  for (const [key, kind] of Object.entries(current.states)) {
    if (previous?.states[key] === kind || (kind === 'waiting' && key.startsWith('run:') && current.hasCards)) continue
    const path = destination || current.destinations[key]
    const groupKey = path + ':' + kind
    const group = groups.get(groupKey)
    if (!group) groups.set(groupKey, { kind, path })
    else if (!destination) group.count = (group.count || 1) + 1
  }
  return Array.from(groups.values())
}

async function collect(get, saved, now) {
  const { conversations } = await get('/api/chat/conversations')
  const chats = {}, notices = [], ticketChats = new Map()
  const startedAt = saved?.startedAt ?? now
  for (const chat of conversations) {
    if (!conversationId.test(chat.id)) continue
    const previous = saved?.chats[chat.id]
    const newChat = !!saved && chat.createdAt >= startedAt
    // Watch active work every poll. Idle chats also get a periodic reconciliation for non-message changes.
    if (previous && previous.updatedAt === chat.updatedAt && !previous.busy && now - (previous.checkedAt || 0) < 90000) {
      chats[chat.id] = previous
    } else {
      let next
      try { next = await chatActivity(get, chat, previous, now, newChat) }
      catch (error) {
        if (error.status === 401) throw error
        if (error.status === 404 || error.status === 403 || !previous) continue
        next = previous // Keep this conversation eligible for retry while delivering the others.
      }
      chats[chat.id] = next
      if (previous || newChat) {
        for (const notice of changed(previous, next, '/chat#conversation/' + chat.id)) {
          if (chat.title) notice.context = chat.title.slice(0, 96)
          notices.push(notice)
        }
      }
    }
    for (const ticket of chats[chat.id].tickets) ticketChats.set(ticket, chat.id)
  }
  let workspace = saved?.workspace || null
  try {
    workspace = await workspaceActivity(get, ticketChats)
    if (saved?.workspace) notices.push(...changed(saved.workspace, workspace))
  } catch (error) {
    if (error.status === 401) throw error
  }
  // Several sources may describe the same event. A question or permission prompt takes precedence over "waiting".
  const specific = new Set(notices.filter(n => ['question', 'revalidate', 'approval', 'choice', 'file', 'failed', 'uncertain', 'review'].includes(n.kind)).map(n => n.path))
  const unique = new Map(notices.map(n => [n.path + ':' + n.kind, n]))
  for (const path of specific) unique.delete(path + ':waiting')
  for (const { path, kind } of notices) {
    if (kind === 'done') unique.delete(path + ':workerDone')
    if (kind === 'stopped') unique.delete(path + ':workerStopped')
  }
  return { snapshot: { startedAt, chats, workspace: workspace && {states: workspace.states} }, notices: [...unique.values()] }
}

module.exports = { collect }
