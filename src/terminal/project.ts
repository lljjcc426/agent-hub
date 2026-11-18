import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, relative, sep, isAbsolute } from 'node:path'
import { configSchema, type Config } from '../config.ts'
import { setupWorkspace } from '../onboarding.ts'

const git = promisify(execFile)
export async function projectRoot(path: string, sources: Config['sources'] = []) {
  if (!isAbsolute(path) || !statSync(path).isDirectory())
    throw Error('Choose an existing project directory.')
  const cwd = realpathSync(path)
  // A registered subfolder can live inside a larger checkout (including the host's own parent).
  // Keep its identity and workspace scope when launched from one of its subdirectories.
  const within = (root: string, child: string) => {
    const rest = relative(root, child)
    return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest)
  }
  const registered = sources
    .filter((s) => s.enabled && s.kind === 'local' && existsSync(s.cwd))
    .map((s) => realpathSync(s.cwd))
    .filter((root) => within(root, cwd))
    .sort((a, b) => b.length - a.length)[0]
  try {
    const { stdout } = await git('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000
    })
    const root = realpathSync(stdout.replace(/\r?\n$/, ''))
    if (registered && registered !== root && within(root, registered))
      return { cwd: registered, git: false, committed: false }
    // Worktree creation requires an existing commit.
    const committed = await git('git', ['-C', root, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      timeout: 3000
    }).then(
      () => true,
      () => false
    )
    return { cwd: root, git: true, committed }
  } catch {
    return { cwd: registered ?? cwd, git: false, committed: false }
  }
}
export function projectSource(
  config: Config,
  project: Awaited<ReturnType<typeof projectRoot>>,
  accepts: (id: string) => boolean
) {
  setupWorkspace(config, project.cwd)
  const matching = config.sources.filter(
    (s) =>
      s.kind === 'local' && s.enabled && existsSync(s.cwd) && realpathSync(s.cwd) === project.cwd
  )
  const existing = matching.find((s) => accepts(s.id)) ?? matching[0]
  const source =
    existing ??
    configSchema.shape.sources.element.parse({
      id: 'terminal-' + createHash('sha256').update(project.cwd).digest('hex').slice(0, 16),
      kind: 'local',
      label: basename(project.cwd),
      cwd: project.cwd,
      allowedActors: ['operator'],
      sandbox: project.committed ? 'workspace-write' : 'read-only',
      workspace: { mode: project.committed ? 'git-worktree' : 'source' }
    })
  return { project, source, registered: !!existing }
}
