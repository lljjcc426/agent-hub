import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { commitRepository, localCommitHistory, remoteCommitHistory } from '../src/chat-commit-trail.ts'

test('reads the registered checkout and folds actual merge commits under their parent', async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'roppo-trail-')))
  const signal = new AbortController().signal
  const git = (...args: string[]) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  try {
    git('init','-b','main')
    git('config','user.name','Test author')
    git('config','user.email','test@example.invalid')
    git('config','commit.gpgsign','false')
    mkdirSync(join(cwd,'notes'))
    writeFileSync(join(cwd,'notes','release.md'),'Guide')
    git('add','notes')
    git('commit','-m','docs: add guide')
    git('checkout','-b','feature/checks')
    writeFileSync(join(cwd,'notes','checks.md'),'Checks')
    git('add','notes')
    git('commit','-m','feat: add checks','-m','Verify all links before release.')
    const feature = git('rev-parse','HEAD')
    git('checkout','main')
    git('merge','--no-ff','feature/checks','-m','Merge checks')
    expect(await commitRepository(cwd,signal)).toBe(cwd)
    expect(await commitRepository(join(cwd,'notes'),signal)).toBeUndefined()
    const main = await localCommitHistory(cwd,undefined,signal)
    expect(main.branch).toBe('main')
    expect(main.commits.map(commit=>commit.message)).toEqual(['Merge checks','docs: add guide'])
    expect(main.commits[0]?.commits).toMatchObject([{id:feature,kind:'feature',
      body:'Verify all links before release.',author:{name:'Test author'}}])
    expect(main.hasMore).toBe(false)
    expect((await localCommitHistory(cwd,'feature/checks',signal)).commits[0]?.id).toBe(feature)
    git('checkout','--detach',feature)
    expect((await localCommitHistory(cwd,undefined,signal)).branch).toBe('HEAD')
  } finally {
    rmSync(cwd,{recursive:true,force:true})
  }
})

test('anchors bounded remote history at the selected tip and excludes main commits from merged branches', () => {
  const commit = (sha: string, parents: string[], message: string) => ({
    sha, parents:parents.map(sha=>({sha})),commit:{message},
  })
  const data = remoteCommitHistory([
    commit('side',['base'],'feat: branch change'),
    commit('merge',['main','side'],'Merge feature/checks'),
    commit('main',['base'],'fix: existing issue'),
    commit('base',['older'],'Initial commit'),
  ],'merge')
  expect(data.commits.map(entry=>entry.id)).toEqual(['merge','main','base'])
  expect(data.commits[0]?.commits?.map(entry=>entry.id)).toEqual(['side'])
  expect(data.hasMore).toBe(true)
})
