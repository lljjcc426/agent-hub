const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')

async function serveFeed(directory) {
  const server = http.createServer(async (request, response) => {
    const resource = request.url.split('?')[0]
    if (request.headers.host !== '127.0.0.1:' + server.address().port ||
        !['GET', 'HEAD'].includes(request.method) ||
        !/^\/(appcast\.xml|Roppo-\d+\.\d+\.\d+-arm64\.zip)$/.test(resource)) {
      response.writeHead(404).end()
      return
    }
    let file
    try {
      file = await fs.promises.open(path.join(directory, resource.slice(1)), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('Not a file')
      response.writeHead(200, {
        'Content-Type': resource.endsWith('.xml') ? 'application/rss+xml' : 'application/zip',
        'Content-Length': stat.size, 'Cache-Control': 'no-store'
      })
      if (request.method === 'HEAD') response.end()
      else await pipeline(file.createReadStream({ autoClose: false }), response)
    } catch {
      if (!response.headersSent) response.writeHead(404).end()
      else response.destroy()
    } finally {
      if (file) await file.close()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/appcast.xml' }
}

module.exports = { serveFeed }
