import { chromium, devices } from 'playwright-core'
import { installProbe, collectPage } from './probe.js'

/** 启动 Chrome:优先用 PERF_FLOW_CHROME 指定的路径,否则找本机已安装的 Google Chrome */
export async function launchBrowser({ headless }) {
  const opts = { headless: !!headless }
  const exe = process.env.PERF_FLOW_CHROME
  try {
    if (exe) return await chromium.launch({ ...opts, executablePath: exe })
    return await chromium.launch({ ...opts, channel: 'chrome' })
  } catch (e) {
    const msg = String((e && e.message) || e).split('\n')[0]
    throw new Error(
      '无法启动 Chrome:' + msg + '\n请确认已安装 Google Chrome,或设置环境变量 PERF_FLOW_CHROME 指向 Chrome 可执行文件。'
    )
  }
}

const DEVICES = {
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
  mobile: devices['Pixel 7'],
}

/**
 * 测一轮。每轮使用全新的浏览器上下文(冷缓存)。
 * @param {object} p
 * @param {import('playwright-core').Browser} p.browser
 * @param {object} p.cfg  { url, device, settleMs, timeoutMs, detectors }
 * @param {boolean} p.annotate 是否录屏(用于画面标注;会略微影响耗时,所以只在单独的一轮开启)
 * @param {{cancelled:boolean}} p.signal
 */
export async function measureRound({ browser, cfg, annotate, signal }) {
  const preset = DEVICES[cfg.device] || DEVICES.desktop
  const context = await browser.newContext({ ...preset })
  const out = { ok: false, error: null, data: null, frames: [] }
  try {
    const page = await context.newPage()
    await page.addInitScript(installProbe, { detectors: cfg.detectors })

    let cdp = null
    const raw = []
    if (annotate) {
      cdp = await context.newCDPSession(page)
      cdp.on('Page.screencastFrame', (f) => {
        raw.push({ ts: f.metadata.timestamp, data: f.data })
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
      })
      const vp = preset.viewport
      const k = Math.min(preset.deviceScaleFactor || 1, 2)
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 70,
        everyNthFrame: 1,
        maxWidth: Math.round(vp.width * k),
        maxHeight: Math.round(vp.height * k),
      })
    }

    // 跟踪在途请求:load 迟迟不触发时,要能说出是哪些请求还没完成
    const inflight = new Map()
    page.on('request', (r) => inflight.set(r, { url: r.url(), type: r.resourceType(), at: Date.now() }))
    page.on('requestfinished', (r) => inflight.delete(r))
    page.on('requestfailed', (r) => inflight.delete(r))

    const started = Date.now()
    try {
      // 只等到收到响应头;页面能不能"加载完成"(load)单独判断,load 不触发不应该让整轮失败
      await page.goto(cfg.url, { waitUntil: 'commit', timeout: cfg.timeoutMs })
    } catch (e) {
      throw new Error('页面加载失败:' + String((e && e.message) || e).split('\n')[0])
    }
    let loadTimedOut = false
    try {
      await page.waitForLoadState('load', { timeout: Math.max(1000, cfg.timeoutMs - (Date.now() - started)) })
    } catch {
      loadTimedOut = true
    }

    // load 之后再等 settleMs,让后到的 LCP 候选出现
    await sleep(cfg.settleMs, signal)

    // 如果还有未命中的自定义检测,继续等,直到全部命中或超时
    while (!signal.cancelled && Date.now() - started < cfg.timeoutMs) {
      const pending = await page.evaluate(() => (window.__pf && window.__pf.pending ? window.__pf.pending() : false))
      if (!pending) break
      await sleep(100, signal)
    }
    if (signal.cancelled) throw new Error('已取消')

    // 给 rAF 回调写入 presented 留点时间;录屏时再多等一会儿,让最后一帧送达
    await sleep(annotate ? 450 : 120, signal)

    const data = await page.evaluate(collectPage)
    data.loadTimedOut = loadTimedOut || !(data.nav && data.nav.loadEvent > 0)
    if (data.loadTimedOut) {
      // 仍未完成的请求(排除主文档本身)。起点换算成与页面时间线一致的"相对导航开始的毫秒"
      const now = Date.now()
      data.pendingRequests = [...inflight.values()]
        .filter((r) => r.type !== 'document')
        .slice(0, 400)
        .map((r) => ({ name: r.url.length > 300 ? r.url.slice(0, 300) : r.url, type: r.type, start: Math.round((r.at - data.timeOrigin) * 10) / 10, end: Math.round((now - data.timeOrigin) * 10) / 10 }))
        .filter((r) => r.start >= 0)
        .sort((a, b) => a.start - b.start)
    }
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => {})
      out.frames = raw.map((f) => ({ ms: Math.round((f.ts * 1000 - data.timeOrigin) * 10) / 10, data: f.data }))
    }
    out.data = data
    out.ok = true
  } catch (e) {
    out.error = String((e && e.message) || e)
  } finally {
    await context.close().catch(() => {})
  }
  return out
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal) signal.onCancel = () => (clearTimeout(t), resolve())
  })
}
