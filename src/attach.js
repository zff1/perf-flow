// 把只读探针挂到"本机已经在运行的 Node 服务"上:不改代码,不重启。
//
// 流程:按端口找到进程 → 确认它是同一用户的 Node 进程 → SIGUSR1 让它打开调试端口 →
//       通过调试端口注入 server-probe.js → 每轮测量前后清空 / 取回数据 → 测完卸载并关闭调试端口。
//
// 安全:
//  - 只允许本机地址(解析结果必须全是回环地址)
//  - 发 SIGUSR1 之前,必须确认目标是同一用户的 Node 进程。SIGUSR1 对非 Node 进程的默认动作是终止它。
//  - 注入前核对:调试端口那一头的进程 pid 必须就是我们要找的那个,否则不注入
//  - 调试端口是我们打开的,就由我们关闭;原本就开着的(用户自己 --inspect),不去动它
import { execFile } from 'node:child_process'
import dns from 'node:dns/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { installServerProbe } from './server-probe.js'

const run = promisify(execFile)
const INSPECT_PORT = 9229

export class AttachError extends Error {}
const fail = (m) => {
  throw new AttachError(m)
}

const isLoopbackAddr = (a) => /^127\./.test(a) || a === '::1' || a === '::ffff:127.0.0.1'

async function assertLoopback(host) {
  const h = host.replace(/^\[|\]$/g, '')
  if (isLoopbackAddr(h) || h === 'localhost' || h.endsWith('.localhost')) return
  let addrs
  try {
    addrs = await dns.lookup(h, { all: true })
  } catch {
    fail(`无法解析主机名 ${host}`)
  }
  if (!addrs.length || !addrs.every((x) => isLoopbackAddr(x.address))) {
    fail(`${host} 不是本机地址。服务端分析只支持本机上运行的服务(127.0.0.1 / localhost,或解析到本机的域名)`)
  }
}

/** 监听某个端口的进程 pid(去重) */
async function listeningPids(port) {
  if (process.platform === 'win32') fail('服务端分析暂不支持 Windows')
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 5000 })
    return [...new Set(stdout.split('\n').map((s) => Number(s.trim())).filter(Boolean))]
  } catch (e) {
    if (e && e.code === 'ENOENT') fail('没有找到 lsof 命令,无法按端口定位进程')
    return [] // lsof 没找到时退出码为 1
  }
}

/** 确认是同一用户的 Node 进程;返回描述信息 */
async function inspectProcess(pid) {
  let uid, comm, args
  try {
    uid = Number((await run('ps', ['-o', 'uid=', '-p', String(pid)])).stdout.trim())
    comm = (await run('ps', ['-o', 'comm=', '-p', String(pid)])).stdout.trim()
    args = (await run('ps', ['-o', 'command=', '-p', String(pid)])).stdout.trim()
  } catch {
    fail(`读不到进程 ${pid} 的信息`)
  }
  if (typeof process.getuid === 'function' && uid !== process.getuid()) fail(`进程 ${pid} 不属于当前用户,不能附加`)
  // comm 是实际执行的程序,不会被 process.title 改写(Next.js 之类会改标题)
  const exe = path.basename(comm)
  if (!/^node(js)?$/.test(exe)) {
    fail(`监听这个端口的进程不是 Node(是 ${exe})。服务端分析目前只支持 Node 服务;其他语言的服务可以输出 Server-Timing 响应头,工具会自动读取`)
  }
  if (/--disable-sigusr1/.test(args)) fail('这个 Node 进程用 --disable-sigusr1 启动,不允许从外部打开调试端口')
  return { exe: comm, args }
}

async function listTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`, { signal: AbortSignal.timeout(800) })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 在被测进程里按版本依次尝试取得内置模块。Node 18 的 ESM 服务里既没有 require 也没有 getBuiltinModule,
// 只有调试上下文(includeCommandLineAPI,DevTools 用的就是它)提供的 require,而且只有表达式最外层看得到,
// 所以在最外层取到后传进去。
const TOP_REQUIRE = "typeof require === 'function' ? require : null"
const GET_MODULE = `((topRequire) => async (n) => {
  if (typeof process.getBuiltinModule === 'function') return process.getBuiltinModule(n)
  if (typeof topRequire === 'function') return topRequire(n)
  if (typeof require === 'function') return require(n)
  if (process.mainModule && process.mainModule.require) return process.mainModule.require(n)
  return import(n)
})(${TOP_REQUIRE})`

class Inspector {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false })
    this.nid = 0
    this.pending = new Map()
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
      this.ws.on('message', (m) => {
        let d
        try {
          d = JSON.parse(String(m))
        } catch {
          return
        }
        const p = d.id && this.pending.get(d.id)
        if (p) {
          this.pending.delete(d.id)
          p(d)
        }
      })
      this.ws.on('close', () => {
        for (const p of this.pending.values()) p({ error: { message: '与被测进程的连接已断开' } })
        this.pending.clear()
      })
    })
  }
  /** 在被测进程里执行一段表达式,返回值(必须可 JSON 序列化) */
  evaluate(expression, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nid
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AttachError('被测进程没有及时响应(可能正忙于同步计算)'))
      }, timeoutMs)
      this.pending.set(id, (d) => {
        clearTimeout(timer)
        if (d.error) return reject(new AttachError(d.error.message || '调试协议错误'))
        const r = d.result
        if (r.exceptionDetails) return reject(new AttachError('被测进程里执行出错:' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text)))
        resolve(r.result.value)
      })
      try {
        this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true } }))
      } catch (e) {
        clearTimeout(timer)
        reject(new AttachError('无法与被测进程通信:' + e.message))
      }
    })
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/**
 * 附加到 url 对应的本机 Node 服务。失败时抛出 AttachError(信息可直接展示给用户)。
 * @returns {{ pid, node, reset(): Promise, take(): Promise<object[]>, detach(): Promise }}
 */
export async function attachProbe(url) {
  const u = new URL(url)
  await assertLoopback(u.hostname)
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))

  const pids = await listeningPids(port)
  if (!pids.length) fail(`本机没有进程在监听端口 ${port}。服务是否已启动?`)
  // 多个进程共用一个端口时(集群),先试第一个;处理请求的可能是别的进程,匹配不到时界面会如实说明
  const pid = pids[0]
  await inspectProcess(pid)

  // 调试端口:原本就开着(用户自己 --inspect)就不去动它;否则我们打开,也由我们关闭
  const before = await listTargets()
  let weOpened = false
  let targets = before
  if (!before) {
    try {
      process.kill(pid, 'SIGUSR1')
    } catch (e) {
      fail(`无法向进程 ${pid} 发送信号:${e.message}`)
    }
    weOpened = true
    for (let i = 0; i < 25 && !targets; i++) {
      await sleep(120)
      targets = await listTargets()
    }
  }
  if (!targets || !targets.length) fail('被测进程没有打开调试端口(它可能自己处理了 SIGUSR1,或启动时禁用了调试)')

  const target = targets.find((t) => t.webSocketDebuggerUrl) || targets[0]
  const insp = new Inspector(target.webSocketDebuggerUrl)
  try {
    await insp.open()
  } catch (e) {
    fail('无法连接到被测进程的调试端口:' + ((e && e.message) || e))
  }
  const closeInspectorIfOurs = async () => {
    // 调试端口是我们打开的,就让被测进程自己把它关掉
    if (weOpened) await insp.evaluate(`${GET_MODULE}('inspector').then((i) => { setTimeout(() => i.close(), 50); return 1 })`).catch(() => {})
  }
  try {
    // 核对:调试端口对面确实是我们要找的进程(9229 可能被别的进程占着)
    const got = await insp.evaluate('process.pid')
    if (got !== pid) {
      insp.close()
      fail(`调试端口 ${INSPECT_PORT} 被另一个进程(pid ${got})占用,没有附加。请先关闭它,或让被测服务使用其他调试端口`)
    }
    const opts = { ttlMs: 15 * 60 * 1000, closeInspectorOnExpire: weOpened }
    const info = await insp.evaluate(`(${installServerProbe.toString()})(${JSON.stringify(opts)}, ${TOP_REQUIRE})`)
    if (!info || !info.ok) {
      await closeInspectorIfOurs()
      insp.close()
      fail((info && info.error) || '注入探针失败')
    }
    let detached = false
    return {
      pid,
      node: info.node,
      reset: () => insp.evaluate('globalThis.__pfServer && globalThis.__pfServer.reset()'),
      take: async () => {
        const s = await insp.evaluate('globalThis.__pfServer ? globalThis.__pfServer.take() : null')
        if (s == null) fail('探针已不在被测进程里(服务可能被重启了)')
        return JSON.parse(s)
      },
      detach: async () => {
        if (detached) return
        detached = true
        await insp.evaluate(`globalThis.__pfServer && globalThis.__pfServer.cleanup(${weOpened})`).catch(() => {})
        insp.close()
      },
    }
  } catch (e) {
    insp.close()
    throw e
  }
}
