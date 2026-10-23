import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

/** Serves the built Mesh2Motion app on 127.0.0.1 with an OS-assigned port. */
export class StaticServer {
  private server: http.Server | null = null
  private base_url = ''

  constructor (private readonly root: string) {}

  get url (): string {
    return this.base_url
  }

  async start (): Promise<string> {
    if (this.server !== null) return this.base_url

    const root = path.resolve(this.root)
    this.server = http.createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
      const file_path = path.resolve(root, '.' + pathname)

      if (file_path !== root && !file_path.startsWith(root + path.sep)) {
        response.writeHead(403).end()
        return
      }

      fs.stat(file_path, (error, stats) => {
        if (error !== null || !stats.isFile()) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[path.extname(file_path).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': stats.size,
          'Cache-Control': 'no-cache'
        })
        if (request.method === 'HEAD') {
          response.end()
          return
        }
        fs.createReadStream(file_path).pipe(response)
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address() as AddressInfo
    this.base_url = `http://127.0.0.1:${address.port}`
    return this.base_url
  }

  async stop (): Promise<void> {
    if (this.server === null) return
    const server = this.server
    this.server = null
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
}
