const { app, dialog, Notification, session } = require('electron')
const path = require('node:path')
const { startMonitor } = require('./monitor.cjs')

const labels = {
  done: ['任务已完成', 'Task completed'],
  workerDone: ['子任务已完成', 'Worker task completed'],
  workerStopped: ['子任务已停止', 'Worker task stopped'],
  revalidate: ['有问题需要重新确认', 'A question needs confirmation'],
  ready: ['任务已准备好交付', 'Task ready for delivery'],
  ended: ['任务已结束', 'Task closed'],
  failed: ['任务执行失败', 'Task failed'],
  stopped: ['任务已停止', 'Task stopped'],
  uncertain: ['执行结果需要核对', 'Outcome needs checking'],
  waiting: ['任务需要你处理', 'Task needs your attention'],
  question: ['有问题需要你回答', 'A question needs your answer'],
  choice: ['需要你做个决定', 'A decision is needed'],
  approval: ['有操作等待批准', 'Approval requested'],
  file: ['有文件等待审阅', 'File review requested'],
  review: ['有工作等待审核', 'Review requested']
}

function desktopNotifications(workspace, navigate) {
  const chinese = app.getPreferredSystemLanguages()[0]?.startsWith('zh') ?? true
  const L = (zh, en) => chinese ? zh : en
  const live = new Map()
  async function get(route) {
    const response = await session.defaultSession.fetch(new URL(route, workspace).href, {
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12000)
    })
    if (!response.ok) throw Object.assign(Error('AgentHub request failed'), {status: response.status})
    return response.json()
  }
  function clear() {
    for (const note of live.values()) note.close()
    live.clear()
  }
  function explainTestFailure() {
    void dialog.showMessageBox({type: 'info', message: L('测试通知未能送达', 'Test notification could not be delivered'),
      detail: L('请在「系统设置 → 通知 → Roppo」中允许通知。', 'Allow Roppo in System Settings → Notifications.')})
  }
  function show(key, title, body, click) {
    if (!Notification.isSupported()) {
      if (key === 'test') explainTestFailure()
      return
    }
    live.get(key)?.close()
    const note = new Notification({ title, body })
    live.set(key, note)
    const remove = () => { if (live.get(key) === note) live.delete(key) }
    note.once('close', remove)
    note.once('failed', () => {
      remove()
      if (key === 'test') explainTestFailure()
    })
    note.once('click', () => { remove(); void click() })
    note.show()
  }
  const monitor = startMonitor({
    file: path.join(app.getPath('userData'), 'desktop-notifications.json'),
    get, clear,
    notify({kind, path: route, context, count}, owner) {
      const body = route.startsWith('/chat#') ? L('打开对应对话', 'Open the conversation') :
        route.endsWith('#attention') ? L('查看待处理事项', 'Open items needing attention') : L('查看运行记录', 'Open activity')
      const label = L(...labels[kind])
      show(owner + route + kind, count ? label + ' × ' + count : label, context || body, async () => {
        if (await monitor.canOpen(owner)) navigate(new URL(route, workspace).href)
      })
    }
  })
  app.once('before-quit', () => monitor.stop())
  return {
    label: L('桌面通知', 'Desktop notifications'),
    submenu: [
      { label: L('接收任务通知', 'Receive task notifications'), type: 'checkbox', checked: monitor.enabled,
        click: item => monitor.setEnabled(item.checked) },
      { label: L('发送测试通知', 'Send test notification'), click: () => {
        show('test', L('Roppo 通知测试', 'Roppo notification test'), L('桌面通知可以显示。', 'Desktop notifications are available.'), () => navigate(workspace.href))
      } }
    ]
  }
}

module.exports = { desktopNotifications }
