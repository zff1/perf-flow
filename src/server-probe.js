/**
 * 注入到"被测的本地 Node 服务"里的只读探针。
 *
 * 不改你的代码、不需要重启:perf-flow 通过 Node 的调试端口把这个函数的源码送进进程里执行。
 * 它只做一件事:订阅 Node 内置的诊断事件(diagnostics_channel),记录
 *   - 每个入站 HTTP 请求:方法、路径、第一个字节写出的时刻、结束时刻、状态码
 *   - 这个请求期间发出的出站调用:http / https 模块,以及原生 fetch(undici)
 * 不记录请求头(除了判断"这是不是页面导航请求"需要的 sec-fetch-dest 和 accept)、cookie、请求体、查询参数。
 *
 * 这个函数会被 toString() 之后送进目标进程,所以必须完全自包含:不能引用外面的任何变量。
 * 返回值必须能被 JSON 序列化。
 * topRequire:调试上下文里的 require(只有表达式最外层看得到,嵌套函数里看不到,所以由外面传进来)。
 */
export async function installServerProbe(opts, topRequire) {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) return { ok: false, error: `被测服务的 Node 版本是 ${process.version},探针需要 Node 18 或更高` }

  // 上一次 perf-flow 异常退出时可能留下旧探针,先卸掉
  if (globalThis.__pfServer && typeof globalThis.__pfServer.cleanup === 'function') {
    try { globalThis.__pfServer.cleanup(false) } catch {}
  }

  // 按版本和模块系统依次尝试取得内置模块(ESM 项目里没有 require)
  const req = async (name) => {
    if (typeof process.getBuiltinModule === 'function') return process.getBuiltinModule(name)
    if (typeof topRequire === 'function') return topRequire(name) // perf-flow 在表达式最外层取到的 require(调试上下文提供)
    if (typeof require === 'function') return require(name)
    if (process.mainModule && process.mainModule.require) return process.mainModule.require(name)
    return import(name)
  }
  let dc, AsyncLocalStorage, inspector
  try {
    dc = await req('diagnostics_channel')
    AsyncLocalStorage = (await req('async_hooks')).AsyncLocalStorage
    inspector = await req('inspector')
  } catch (e) {
    return { ok: false, error: '无法在被测进程里加载 Node 内置模块:' + String((e && e.message) || e) }
  }

  const als = new AsyncLocalStorage()
  const now = () => Number(process.hrtime.bigint()) / 1e6
  const r1 = (n) => Math.round(n * 10) / 10
  const MAX_TRACES = opts.maxTraces || 300
  const MAX_SPANS = opts.maxSpans || 200
  const S = (globalThis.__pfServer = { traces: [], subs: [] })
  const sub = (name, fn) => {
    dc.subscribe(name, fn)
    S.subs.push([name, fn])
  }

  // ---- 入站请求 ----
  sub('http.server.request.start', ({ request, response }) => {
    const h = request.headers || {}
    const t = {
      method: request.method,
      path: String(request.url || '').split('?')[0].slice(0, 300),
      dest: h['sec-fetch-dest'] ? String(h['sec-fetch-dest']).slice(0, 20) : null,
      accept: h.accept ? String(h.accept).slice(0, 80) : null,
      t0: now(),
      spans: [],
    }
    S.traces.push(t)
    if (S.traces.length > MAX_TRACES) S.traces.shift()
    als.enterWith(t)
    // 第一个字节真正写出去的时刻(而不是 writeHead:头要等到第一次 write / end 才会发出)
    const first = () => {
      if (t.firstByteAt == null) t.firstByteAt = r1(now() - t.t0)
    }
    for (const m of ['write', 'end', 'flushHeaders']) {
      const orig = response[m]
      if (typeof orig !== 'function') continue
      response[m] = function (...a) {
        first()
        return orig.apply(this, a)
      }
    }
    const fin = () => {
      if (t.total == null) {
        t.total = r1(now() - t.t0)
        t.status = response.statusCode
      }
    }
    response.once('finish', fin)
    response.once('close', fin)
  })

  // ---- 出站:http / https 模块 ----
  sub('http.client.request.start', ({ request }) => {
    const t = als.getStore()
    if (!t || t.spans.length >= MAX_SPANS) return
    let host = ''
    try {
      host = String((request.getHeader && request.getHeader('host')) || request.host || '')
    } catch {}
    const s = { via: 'http', method: request.method, target: host + String(request.path || '/').split('?')[0].slice(0, 200), start: r1(now() - t.t0) }
    t.spans.push(s)
    request.once('response', (res) => {
      s.status = res.statusCode
      res.once('end', () => { s.end = r1(now() - t.t0) })
      res.once('close', () => { if (s.end == null) s.end = r1(now() - t.t0) })
    })
    request.once('error', (e) => {
      s.error = (e && e.code) || 'ERR'
      s.end = r1(now() - t.t0)
    })
  })

  // ---- 出站:原生 fetch(undici) ----
  const byReq = new WeakMap()
  sub('undici:request:create', ({ request }) => {
    const t = als.getStore()
    if (!t || t.spans.length >= MAX_SPANS) return
    const origin = String(request.origin || '').replace(/^https?:\/\//, '')
    const s = { via: 'fetch', method: request.method, target: origin + String(request.path || '/').split('?')[0].slice(0, 200), start: r1(now() - t.t0) }
    t.spans.push(s)
    byReq.set(request, { s, t })
  })
  sub('undici:request:headers', ({ request, response }) => {
    const x = byReq.get(request)
    if (x) x.s.status = response.statusCode
  })
  sub('undici:request:trailers', ({ request }) => {
    const x = byReq.get(request)
    if (x) x.s.end = r1(now() - x.t.t0)
  })
  sub('undici:request:error', ({ request, error }) => {
    const x = byReq.get(request)
    if (x) {
      x.s.error = (error && error.code) || 'ERR'
      x.s.end = r1(now() - x.t.t0)
    }
  })

  // ---- 给 perf-flow 调用的方法 ----
  S.reset = () => {
    S.traces.length = 0
    return true
  }
  S.take = () => JSON.stringify(S.traces.map((t) => ({ ...t, t0: undefined })))
  S.cleanup = (closeInspector) => {
    for (const [n, f] of S.subs) {
      try { dc.unsubscribe(n, f) } catch {}
    }
    S.subs.length = 0
    S.traces.length = 0
    clearTimeout(S.timer)
    delete globalThis.__pfServer
    if (closeInspector) setTimeout(() => { try { inspector.close() } catch {} }, 50)
    return 'cleaned'
  }
  // 保险:perf-flow 如果异常退出没来得及清理,探针过一会儿自己撤掉(调试端口是否关闭由 perf-flow 在 opts 里告知)
  S.timer = setTimeout(() => S.cleanup(!!opts.closeInspectorOnExpire), opts.ttlMs || 15 * 60 * 1000)
  if (S.timer.unref) S.timer.unref()

  return { ok: true, pid: process.pid, node: process.version }
}
