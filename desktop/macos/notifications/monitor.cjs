const fs = require('node:fs')
const { collect } = require('./activity.cjs')

function startMonitor({ file, get, notify, clear, interval = 15000 }) {
  let data = { version: 1, enabled: true, owner: null, snapshot: null }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (saved.version === 1 && typeof saved.enabled === 'boolean') {
      data.enabled = saved.enabled
      const snapshot = saved.snapshot
      if (typeof saved.owner === 'string' && Number.isFinite(snapshot?.startedAt) && snapshot.chats &&
          Object.values(snapshot.chats).every(chat => chat?.states && Array.isArray(chat.active) && Array.isArray(chat.tickets))) {
        data.owner = saved.owner
        data.snapshot = snapshot
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Roppo notification checkpoint could not be read.')
  }
  let lastWritten, pending, stopped = false, revision = 0
  function save(next) {
    const body = JSON.stringify(next, (key, value) => key === 'checkedAt' ? undefined : value)
    if (body !== lastWritten) {
      fs.writeFileSync(file + '.tmp', body, { mode: 0o600 })
      fs.renameSync(file + '.tmp', file)
      lastWritten = body
    }
    data = next
  }
  async function account() {
    const session = await get('/session')
    return session.operator ? session.account?.user?.id || 'local-operator' : null
  }
  function setOwner(owner) {
    if (owner !== data.owner) {
      clear()
      save({ ...data, owner, snapshot: null })
    }
  }
  async function read(token) {
    const owner = await account()
    if (token !== revision) return
    setOwner(owner)
    if (!owner) return
    const result = await collect(get, data.snapshot, Date.now())
    if (token !== revision) return
    const confirmed = await account()
    if (token !== revision) return
    if (confirmed !== owner) { setOwner(confirmed); return }
    save({ ...data, snapshot: result.snapshot })
    for (const notice of result.notices) notify(notice, owner)
  }
  function poll() {
    if (pending || stopped || !data.enabled) return pending
    pending = read(revision).catch(() => {
      // The next pass retries from the last successful checkpoint. A click rechecks the session too.
    }).finally(() => { pending = undefined })
    return pending
  }
  const timer = setInterval(poll, interval)
  timer.unref()
  void poll()
  return {
    poll,
    get enabled() { return data.enabled },
    setEnabled(value) {
      revision++
      clear()
      save({ ...data, enabled: value, snapshot: null })
      if (value) void poll()
    },
    async canOpen(owner) {
      if (!data.enabled || stopped || data.owner !== owner) return false
      try { return await account() === owner && data.owner === owner && data.enabled && !stopped }
      catch { return false }
    },
    stop() { stopped = true; revision++; clearInterval(timer); clear() }
  }
}

module.exports = { startMonitor }
