import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { Run, normalizeConfig, VERSION } from './runner.js'
import { listRuns, loadRun, deleteRun, framePath, dataHome } from './store.js'

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** 提供 ui/ 目录下的静态文件。只允许白名单扩展名,并防止路径穿越。 */
function serveUi(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return false
  }
  if (rel.includes('\0')) return false
  const full = path.resolve(UI_DIR, '.' + rel)
  if (!full.startsWith(UI_DIR + path.sep)) return false
  const type = MIME[path.extname(full).toLowerCase()]
  if (!type) return false
  let st
  try {
    st = fs.statSync(full)
  } catch {
    return false
  }
  if (!st.isFile()) return false
  send(res, 200, fs.readFileSync(full), { 'Content-Type': type })
  return true
}

const runs = new Map() // 内存里的运行实例(用于进度推送)
let current = null

function send(res, code, body, headers = {}) {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body)
  const payload = isObj ? JSON.stringify(body) : body
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('JSON 格式错误'))
      }
    })
    req.on('error', reject)
  })
}

export function createServer({ port }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])

  return http.createServer(async (req, res) => {
    try {
      // 1. 只接受发往 127.0.0.1 / localhost 的请求(防 DNS 重绑定)
      if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
        return send(res, 403, 'Forbidden host')
      }
      const url = new URL(req.url, `http://${req.headers.host}`)
      const p = url.pathname

      // 2. 写操作:必须同源 + 带自定义头(浏览器跨站请求无法同时满足)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, '').toLowerCase())) {
          return send(res, 403, { error: 'Forbidden origin' })
        }
        if (req.headers['x-perf-flow'] !== '1') return send(res, 403, { error: 'Missing header' })
      }

      // ---- 静态资源 ----
      if (p === '/favicon.ico') return send(res, 204, '')
      if (req.method === 'GET' && serveUi(p, res)) return

      // ---- API ----
      if (p === '/api/info' && req.method === 'GET') {
        return send(res, 200, { version: VERSION, platform: os.platform(), node: process.version, home: dataHome() })
      }

      if (p === '/api/runs' && req.method === 'GET') return send(res, 200, await listRuns())

      if (p === '/api/runs' && req.method === 'POST') {
        if (current && !current.finished) return send(res, 409, { error: '已有测量在进行中' })
        let cfg
        try {
          cfg = normalizeConfig(await readJson(req))
        } catch (e) {
          return send(res, 400, { error: e.message })
        }
        const run = new Run(cfg)
        runs.set(run.id, run)
        current = run
        run.execute() // 异步执行,不等待
        return send(res, 202, { id: run.id, config: cfg })
      }

      let m = /^\/api\/runs\/([\w-]+)$/.exec(p)
      if (m) {
        if (req.method === 'GET') {
          const r = await loadRun(m[1])
          return r ? send(res, 200, r) : send(res, 404, { error: '未找到' })
        }
        if (req.method === 'DELETE') {
          const live = runs.get(m[1])
          if (live && !live.finished) return send(res, 409, { error: '测量进行中,请先取消' })
          runs.delete(m[1])
          await deleteRun(m[1])
          return send(res, 200, { ok: true })
        }
      }

      m = /^\/api\/runs\/([\w-]+)\/cancel$/.exec(p)
      if (m && req.method === 'POST') {
        const run = runs.get(m[1])
        if (!run || run.finished) return send(res, 404, { error: '没有进行中的测量' })
        run.cancel()
        return send(res, 200, { ok: true })
      }

      m = /^\/api\/runs\/([\w-]+)\/events$/.exec(p)
      if (m && req.method === 'GET') {
        const run = runs.get(m[1])
        if (!run) return send(res, 404, { error: '未找到' })
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        })
        const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`)
        run.history.forEach(write)
        if (run.finished) return res.end()
        const onEv = (ev) => write(ev)
        const onEnd = () => res.end()
        run.on('event', onEv)
        run.on('end', onEnd)
        req.on('close', () => {
          run.off('event', onEv)
          run.off('end', onEnd)
        })
        return
      }

      m = /^\/api\/runs\/([\w-]+)\/frames\/([\w.]+)$/.exec(p)
      if (m && req.method === 'GET') {
        const fp = framePath(m[1], m[2])
        if (!fp || !fs.existsSync(fp)) return send(res, 404, 'Not found')
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' })
        return fs.createReadStream(fp).pipe(res)
      }

      return send(res, 404, { error: 'Not found' })
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: String((e && e.message) || e) })
      else res.end()
    }
  })
}

/** 从 startPort 起找一个可用端口并监听(仅 127.0.0.1) */
export async function listen(startPort) {
  for (let port = startPort; port < startPort + 20; port++) {
    const server = createServer({ port })
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (ok) return { server, port }
  }
  throw new Error(`端口 ${startPort}~${startPort + 19} 均被占用`)
}
