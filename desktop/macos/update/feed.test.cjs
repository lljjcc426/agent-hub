const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { serveFeed } = require('./feed.cjs')

test('serves signed release files on loopback without exposing the publishing directory', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'roppo-updates-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const archive = 'Roppo-1.2.3-arm64.zip'
  await fs.writeFile(path.join(directory, 'appcast.xml'), '<rss/>')
  await fs.writeFile(path.join(directory, archive), 'complete package')
  await fs.writeFile(path.join(directory, '.publish.lock'), 'not an update')
  await fs.symlink(path.join(directory, '.publish.lock'), path.join(directory, 'Roppo-1.2.4-arm64.zip'))
  const { url, server } = await serveFeed(directory)
  t.after(() => {
    server.closeAllConnections()
    return new Promise(resolve => server.close(resolve))
  })

  assert.equal(new URL(url).hostname, '127.0.0.1')
  assert.equal(await (await fetch(url)).text(), '<rss/>')
  const head = await fetch(new URL(archive, url), { method: 'HEAD' })
  assert.equal(head.headers.get('content-length'), '16')
  assert.equal(await head.text(), '')
  assert.equal(await (await fetch(new URL(archive, url))).text(), 'complete package')
  for (const file of ['.publish.lock', 'Roppo-1.2.4-arm64.zip', 'Roppo-1.2.5-arm64.zip', '']) {
    assert.equal((await fetch(new URL('/' + file, url))).status, 404)
  }
  assert.equal((await fetch(url, { method: 'POST' })).status, 404)
  const status = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'other.example' } }, response => {
      response.resume()
      resolve(response.statusCode)
    }).on('error', reject)
  })
  assert.equal(status, 404)
})
