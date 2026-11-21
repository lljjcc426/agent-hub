import { describe, expect, it } from 'vitest'
import { browserUrl } from '../web/chat/browser-url.ts'
import { initialTeamPanel } from '../web/chat/chat-panel-state.ts'

describe('conversation panel preferences', () => {
  const old = (kind: string, visible: boolean, view = 'tools') => JSON.stringify({
    tabs: [{ id: 'one', kind }], active: 'one', visible, view,
  })

  it('opens the new Agents view for an existing browser selection', () => {
    expect(initialTeamPanel('', old('browser', true), '')).toEqual({ open: true, tab: 'agents' })
    expect(initialTeamPanel('', '', 'browser')).toEqual({ open: true, tab: 'agents' })
  })

  it('opens Overview for files or the old team view and honors a saved close', () => {
    expect(initialTeamPanel('', old('files', true), '')).toEqual({ open: true, tab: 'activity' })
    expect(initialTeamPanel('', old('browser', true, 'team'), '')).toEqual({ open: true, tab: 'activity' })
    expect(initialTeamPanel('closed', old('browser', true), '')).toEqual({ open: false, tab: 'activity' })
    expect(initialTeamPanel('', old('browser', false), '')).toEqual({ open: false, tab: 'agents' })
    expect(initialTeamPanel('', old('memory', true), '')).toEqual({ open: false, tab: 'activity' })
  })

  it('restores a current tab and handles unavailable or malformed preferences', () => {
    expect(initialTeamPanel('schedules', old('browser', true), '')).toEqual({ open: true, tab: 'schedules' })
    expect(initialTeamPanel('launch-browser', '', '')).toEqual({ open: true, tab: 'agents', launchBrowser: true })
    expect(initialTeamPanel('', old('invalid', true), '')).toEqual({ open: false, tab: 'activity' })
    expect(initialTeamPanel('', 'bad JSON', 'closed')).toEqual({ open: false, tab: 'activity' })
  })
})

it('normalizes website addresses without accepting credentials or executable schemes', () => {
  expect(browserUrl('example.com/path')).toBe('https://example.com/path')
  expect(browserUrl('127.0.0.1:61566/login')).toBe('http://127.0.0.1:61566/login')
  expect(browserUrl('https://example.com/?q=hello')).toBe('https://example.com/?q=hello')
  for (const value of ['团队动态', 'javascript:alert(1)', 'file:///tmp/x',
    'https://user:password@example.com', 'hello world', 'data:text/html,a']) expect(browserUrl(value)).toBeNull()
})
