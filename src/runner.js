import { EventEmitter } from 'node:events'
import { launchBrowser, measureRound } from './measure.js'
import { deriveRound, summarize, pickFrames } from './summarize.js'
import { newId, saveRun } from './store.js'
import { attachProbe } from './attach.js'
import { buildServerData } from './server-trace.js'

export const VERSION = '0.1.0'

const TYPES = ['selector', 'text', 'request', 'js']

/** 校验并规范化配置。非法输入抛出带中文说明的 Error。 */
export function normalizeConfig(raw) {
  const bad = (m) => {
    throw new Error(m)
  }
  if (!raw || typeof raw !== 'object') bad('请求格式错误')
  let url = String(raw.url || '').trim()
  if (!url) bad('请输入网址')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url
  let u
  try {
    u = new URL(url)
  } catch {
    bad('网址格式不正确')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('只支持 http / https 网址')

  const int = (v, def, min, max, name) => {
    if (v === undefined || v === null || v === '') return def
    const n = Number(v)
    if (!Number.isFinite(n) || n < min || n > max) bad(`${name} 需要在 ${min} ~ ${max} 之间`)
    return Math.round(n)
  }
  const detectors = []
  const list = Array.isArray(raw.detectors) ? raw.detectors : []
  if (list.length > 10) bad('自定义检测最多 10 项')
  list.forEach((d, i) => {
    if (!d || typeof d !== 'object') return
    const value = String(d.value ?? '').trim()
    if (!value) return // 空行直接忽略
    if (!TYPES.includes(d.type)) bad(`第 ${i + 1} 项检测类型不支持`)
    if (value.length > 500) bad(`第 ${i + 1} 项检测内容过长`)
    detectors.push({
      id: 'd' + (detectors.length + 1),
      label: String(d.label || '').slice(0, 40),
      type: d.type,
      value,
      state: d.state === 'gone' ? 'gone' : 'visible',
      when: d.when === 'start' ? 'start' : 'end',
    })
  })

  return {
    url: u.href,
    rounds: int(raw.rounds, 3, 1, 20, '轮数'),
    device: raw.device === 'mobile' ? 'mobile' : 'desktop',
    headless: !!raw.headless,
    settleMs: int(raw.settleMs, 3000, 0, 30000, '加载后等待'),
    timeoutMs: int(raw.timeoutMs, 30000, 5000, 120000, '超时'),
    annotate: raw.annotate !== false,
    serverProbe: !!raw.serverProbe, // 附加到本机 Node 服务,记录服务端明细
    detectors,
  }
}

export class Run extends EventEmitter {
  constructor(cfg) {
    super()
    this.id = newId()
    this.startedAt = new Date().toISOString() // 测量开始的时刻(createdAt 是写入结果的时刻,会晚一个测量时长)
    this.cfg = cfg
    this.signal = { cancelled: false, onCancel: null }
    this.browser = null
    this.history = [] // 已发出的事件,供晚连上的 SSE 回放
    this.finished = false
  }

  push(ev) {
    this.history.push(ev)
    this.emit('event', ev)
  }

  cancel() {
    this.signal.cancelled = true
    if (this.signal.onCancel) this.signal.onCancel()
    if (this.browser) this.browser.close().catch(() => {})
  }

  async execute() {
    const { cfg } = this
    try {
      this.push({ type: 'status', message: '正在启动 Chrome…' })
      this.browser = await launchBrowser({ headless: cfg.headless })
      const browserVersion = this.browser.version()

      // 预热:浏览器首次创建页面进程有额外开销,会让第一轮偏慢。不计入结果。
      try {
        const ctx = await this.browser.newContext()
        const pg = await ctx.newPage()
        await pg.goto('about:blank')
        await ctx.close()
      } catch {}

      // 服务端探针(可选)。连不上不会让测量失败:照常测,并在结果里如实写明为什么没有服务端数据
      let probe = null
      let probeState = { state: 'off' }
      if (cfg.serverProbe) {
        this.push({ type: 'status', message: '正在连接本机服务进程…' })
        try {
          probe = await attachProbe(cfg.url)
          this.probe = probe
          probeState = { state: 'ok', pid: probe.pid, node: probe.node }
          this.push({ type: 'status', message: `已连接服务进程 pid ${probe.pid}(Node ${probe.node})` })
        } catch (e) {
          probeState = { state: 'failed', message: String((e && e.message) || e) }
          this.push({ type: 'status', message: '服务端分析不可用:' + probeState.message })
        }
      }

      const rounds = []
      for (let i = 1; i <= cfg.rounds; i++) {
        if (this.signal.cancelled) throw new Error('已取消')
        this.push({ type: 'progress', phase: 'round', index: i, total: cfg.rounds })
        let pstate = probeState
        if (probe && pstate.state === 'ok') {
          try {
            await probe.reset()
          } catch (e) {
            pstate = { state: 'failed', message: String((e && e.message) || e) }
            probeState = pstate
          }
        }
        const r = await measureRound({ browser: this.browser, cfg, annotate: false, signal: this.signal })
        if (this.signal.cancelled) throw new Error('已取消')
        if (r.ok) {
          let traces = null
          if (probe && pstate.state === 'ok') {
            try {
              traces = await probe.take()
            } catch (e) {
              pstate = { state: 'failed', message: String((e && e.message) || e) }
              probeState = pstate
            }
          }
          const server = buildServerData({ data: r.data, probe: pstate, traces })
          if (server) r.data.server = server
        }
        const entry = { index: i, ok: r.ok, error: r.error, data: r.data, derived: r.ok ? deriveRound(r.data) : null }
        rounds.push(entry)
        this.push({ type: 'round', index: i, ok: r.ok, error: r.error })
      }
      if (!rounds.some((r) => r.ok)) {
        throw new Error(rounds[0].error || '所有轮次均失败')
      }

      let annotated = null
      let frameFiles = []
      if (cfg.annotate) {
        this.push({ type: 'progress', phase: 'annotate', index: 1, total: 1 })
        const r = await measureRound({ browser: this.browser, cfg, annotate: true, signal: this.signal })
        if (this.signal.cancelled) throw new Error('已取消')
        if (r.ok) {
          const derived = deriveRound(r.data)
          const times = [
            r.data.fcp,
            ...r.data.lcp.map((c) => c.t),
            ...Object.values(r.data.detectors).map((d) => (d.presented != null ? d.presented : d.hit)),
          ]
          const { picked, eventFrame } = pickFrames(r.frames, times)
          frameFiles = picked.map((f) => ({ file: `f${Math.round(f.ms)}.jpg`, ms: f.ms, data: f.data }))
          annotated = {
            ok: true,
            data: r.data,
            derived,
            viewport: r.data.viewport,
            frames: frameFiles.map((f) => ({ ms: f.ms, file: f.file })),
            frameAt: {
              fcp: eventFrame(r.data.fcp),
              lcp: eventFrame(derived.lcpFinal && derived.lcpFinal.t),
              candidates: r.data.lcp.map((c) => eventFrame(c.t)),
              detectors: Object.fromEntries(
                Object.values(r.data.detectors).map((d) => [d.id, eventFrame(d.presented != null ? d.presented : d.hit)])
              ),
            },
          }
        } else {
          annotated = { ok: false, error: r.error }
        }
      }

      const result = {
        schemaVersion: 4, // 4:新增脚本执行(data.scriptRuns);3:新增服务端明细(data.server);2:新增资源列表、script 属性、DCL / load 的开始与结束时刻
        id: this.id,
        tool: { name: 'perf-flow', version: VERSION },
        startedAt: this.startedAt,
        createdAt: new Date().toISOString(),
        config: cfg,
        browser: { name: 'chrome', version: browserVersion },
        rounds,
        summary: summarize(rounds, cfg.detectors),
        annotated,
      }
      await saveRun(this.id, result, frameFiles)
      this.push({ type: 'done', id: this.id })
    } catch (e) {
      this.push({ type: 'error', message: String((e && e.message) || e) })
    } finally {
      this.finished = true
      // 无论成功、失败还是取消,都要把探针从被测进程里撤掉,并关闭我们打开的调试端口
      if (this.probe) await this.probe.detach().catch(() => {})
      if (this.browser) await this.browser.close().catch(() => {})
      this.emit('end')
    }
  }
}
