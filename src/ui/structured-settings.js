function structuredWritable(key) {
  return S.authed && !!S.draft && !S.busy && !entryState.busy && keys().includes(key)
}
function structuredProfile(id) {
  if (id === null) return { path: 'execution.router', profile: S.draft.execution.router || {} }
  const workers = teamWorkers()
  const index = workers.findIndex(worker => worker.id === id)
  if (index < 0) return null
  return { path: 'execution.workers.' + index, profile: workers[index] }
}
function structuredWrite(path, value) {
  clearRelated(path)
  if (same(get(S.draft, path), value)) return
  set(S.draft, path, value)
  S.preview = null
  if (S.notice?.level === 'success') S.notice = null
}
function structuredWriteAgent(id, changes) {
  const current = structuredProfile(id)
  if (!current) return false
  if (id !== null) teamMaterializeWorkers()
  for (const [key, value] of Object.entries(changes)) structuredWrite(current.path + '.' + key, value)
  return true
}
function structuredFinishTeamEdit(hadDraft) {
  updateBar()
  if (!hadDraft) void save()
  return true
}
function structuredEditMember(id, edit) {
  if (!structuredWritable('execution')) return false
  const current = structuredProfile(id)
  if (!current) return false
  const hadDraft = dirty(), route = executionDraft()
  const activeBackend = id === null ? route.router : current.profile.backend
  const changes = {}
  if (Object.hasOwn(edit, 'label')) changes.label = edit.label?.trim() || undefined
  if (Object.hasOwn(edit, 'state') && id !== null) changes.state = edit.state
  if (edit.backend !== undefined && edit.backend !== activeBackend) {
    if (!controlConnections().some(connection => connection.id === edit.backend)) return false
    changes.backend = edit.backend
    changes.nativeTool = undefined
  }
  if (Object.hasOwn(edit, 'model')) changes.model = edit.model?.trim() || undefined
  if (id === null && Object.hasOwn(changes, 'model') && !changes.model && S.draft.models?.router) {
    structuredWrite('models.router', undefined)
  }
  structuredWriteAgent(id, changes)
  return structuredFinishTeamEdit(hadDraft)
}
function structuredAddWorker(edit, copyId) {
  if (!structuredWritable('execution')) return false
  const workers = teamWorkers(), source = workers.find(worker => worker.id === copyId)
  if (workers.length >= teamWorkerLimit() || (copyId && !source) || !edit.label.trim() ||
    !controlConnections().some(connection => connection.id === edit.backend)) return false
  const hadDraft = dirty()
  const profile = source ? clone(source) : {}
  if (profile.backend !== edit.backend) delete profile.nativeTool
  const id = teamNextWorkerId(workers)
  Object.assign(profile, {
    id, backend: edit.backend, label: edit.label.trim(), model: edit.model?.trim() || undefined,
    state: 'enabled'
  })
  workers.push(profile)
  // Appending does not shift other members' field paths or pending text.
  S.draft.execution.workers = workers
  S.preview = null
  structuredWrite('concurrency', workers.length)
  structuredFinishTeamEdit(hadDraft)
  return id
}
function structuredRemoveWorker(id) {
  if (!structuredWritable('execution') || !teamWorkers().some(worker => worker.id === id)) return false
  const hadDraft = dirty()
  removeWorkerDraft(id)
  return structuredFinishTeamEdit(hadDraft)
}
function structuredNumber(path, text, scale, max, change, labels) {
  clearRelated(path)
  if (text === undefined) {
    change(undefined)
    return
  }
  const value = Math.round(Number(text) * scale)
  const valid = Number.isSafeInteger(value) && value >= (scale === 1 ? 1 : 1000) && value <= max &&
    (scale !== 1 || Number.isSafeInteger(Number(text)))
  if (!valid) S.errors.set(path, labels)
  else change(value)
  if (!valid || String(value / scale) !== text) S.buffers.set(path, { type: 'num', text })
}
function structuredSettings() {
  if (!S.authed || !S.draft || !S.base ||
    !(entryState.page === 'execution' && executionView.mode === 'configuration' ||
      entryState.page === 'advanced' && ['configuration', 'browser'].includes(entryState.advancedPage))) return null
  const route = executionDraft(), execution = S.draft.execution, connectionCatalog = controlConnections()
  const projectMember = (profile, id, kind, name, backend, model) => ({
    id, kind, name, label: profile.label, backend, model,
    displayModel: model || connectionCatalog.find(connection => connection.id === backend)?.model,
    state: profile.state, effort: profile.effort, timeoutMs: profile.timeoutMs, browserAccess: profile.browser?.enabled
  })
  const updateAgent = (id, values) => {
    if (!structuredWritable('execution')) return
    structuredWriteAgent(id, values)
    updateBar()
  }
  const router = projectMember(execution.router || {}, 'router', 'router',
    execution.router?.label || 'Router', route.router, route.routerModel)
  if (execution.router?.mode === 'client') router.displayModel = L('Connected client', '已连接客户端')
  return {
    scope: workspaceContext.epoch,
    revision: S.base.revision,
    router,
    workers: route.workers.map((worker, index) => projectMember(worker, worker.id, 'worker',
      worker.label || L('Worker ', '执行者 ') + (index + 1), worker.backend, worker.model)),
    connections: connectionCatalog.map(connection => ({
      id: connection.id, label: connection.label, model: connection.model, kind: connection.kind,
      effort: S.snap?.agentCapabilities?.[connection.id]?.efforts,
      decisionEligible: connection.connectionType === 'api'
    })),
    defaultWorkerBackend: execution.roles?.worker ?? route.router,
    routerMode: execution.router?.mode || 'assessment',
    workerLimit: teamWorkerLimit(),
    routerManagesWorkers: execution.management?.enabled === true,
    canEditTeam: keys().includes('execution'),
    canEditDecision: keys().includes('decision'),
    canProbe: keys().includes('decision') && !S.snap?.preview && !S.errors.size && !S.latest && !S.busy && !entryState.busy,
    decision: S.draft.decision || { mode: 'off', parameters: {} },
    savedDecision: S.base.config.decision || { mode: 'off', parameters: {} },
    decisionCalls: S.snap?.decisionCalls || [],
    problems: Object.fromEntries([...S.errors].map(([path, labels]) => [path, L(...labels)])),
    buffers: Object.fromEntries([...S.buffers].map(([path, buffer]) => [path, buffer.text])),
    editMember: structuredEditMember,
    addWorker: structuredAddWorker,
    removeWorker: structuredRemoveWorker,
    setRouterMode: mode => {
      if (!structuredWritable('execution')) return
      structuredWrite('execution.router.mode', mode)
      if (mode !== 'host') structuredWrite('execution.router.nativeTool', undefined)
      updateBar()
    },
    setWorkerLimit: text => {
      if (!structuredWritable('execution')) return
      structuredNumber('execution.management.maxWorkers', text, 1, Number.MAX_SAFE_INTEGER, value => {
        if (value === undefined && !S.base.config.execution.management &&
          !S.draft.execution.management?.enabled && !S.draft.execution.management?.backends) {
          structuredWrite('execution.management', undefined)
        } else if (execution.management || value !== undefined) {
          structuredWrite('execution.management', { enabled: false, ...S.draft.execution.management, maxWorkers: value ?? 32 })
        }
      }, ['Enter a positive whole number.', '请输入大于 0 的整数。'])
      updateBar()
    },
    setRouterManagesWorkers: enabled => {
      if (!structuredWritable('execution')) return
      structuredWrite('execution.management.enabled', enabled)
      updateBar()
    },
    setEffort: (id, value) => updateAgent(id, { effort: value }),
    setTimeout: (id, minutes) => {
      if (!structuredWritable('execution')) return
      const current = structuredProfile(id)
      if (!current) return
      structuredNumber(current.path + '.timeoutMs', minutes, 60_000, 14_400_000,
        value => structuredWriteAgent(id, { timeoutMs: value }),
        ['Enter a duration between 1 second and 240 minutes.', '请填写 1 秒至 240 分钟之间的时长。'])
      updateBar()
    },
    setBrowserAccess: (id, allowed) => {
      const current = structuredProfile(id)
      if (!current) return
      const browser = { ...current.profile.browser }
      if (allowed === undefined) delete browser.enabled
      else browser.enabled = allowed
      updateAgent(id, { browser: Object.keys(browser).length ? browser : undefined })
    },
    setDecision: (value, problem) => {
      if (!structuredWritable('decision')) return
      structuredWrite('decision', value)
      if (problem) {
        S.errors.set(problem.path, problem.labels)
        S.buffers.set(problem.path, { type: 'decision', text: '' })
      }
      updateBar()
    },
    probeDecision: text => {
      if (!structuredWritable('decision') || !S.draft.decision?.provider || S.errors.size || S.latest || S.snap?.preview)
        throw Error(L('Finish the configuration before testing.', '请完善配置后再测试。'))
      if (S.draft.decision.provider.kind === 'backend' && !same(S.base.config.backends, S.draft.backends))
        throw Error(L('Save the model connection first.', '请先保存模型连接。'))
      return api('/decision/probe', { config: clone(S.draft.decision), text })
    }
  }
}
