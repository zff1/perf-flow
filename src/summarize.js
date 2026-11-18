/** 把单轮原始数据推导成指标 */
export function deriveRound(data) {
  const n = data.nav
  const lcpList = data.lcp || []
  const lcpFinal = lcpList.length ? lcpList[lcpList.length - 1] : null
  const fcp = data.fcp

  // 浏览器没有提供"FCP 对应哪个元素"的接口。
  // 近似:取与 FCP 同一时刻(±25ms)出现的最早 LCP 候选。结果标记为"推断"。
  let fcpCandidate = null
  if (fcp != null) {
    fcpCandidate = lcpList.find((c) => Math.abs(c.t - fcp) <= 25) || null
  }

  // FCP 之前最后完成的渲染阻塞资源
  let lastBlocker = null
  if (fcp != null) {
    for (const b of data.blocking || []) {
      if (b.end <= fcp + 16 && (!lastBlocker || b.end > lastBlocker.end)) lastBlocker = b
    }
  }

  const m = {
    ttfb: n ? n.responseStart : null,
    htmlDone: n ? n.responseEnd : null,
    fp: data.fp,
    fcp,
    lcp: lcpFinal ? lcpFinal.t : null,
    domInteractive: n ? n.domInteractive : null,
    domContentLoaded: n ? n.domContentLoaded : null,
    load: n ? n.loadEvent : null,
  }
  if (n) {
    m.redirect = n.redirectCount ? round(n.redirectEnd - n.redirectStart) : 0
    m.dns = round(n.domainLookupEnd - n.domainLookupStart)
    m.connect = round(n.connectEnd - n.connectStart)
    m.serverWait = round(n.responseStart - n.requestStart)
    m.htmlDownload = round(n.responseEnd - n.responseStart)
  }
  if (m.htmlDone != null && fcp != null) m.htmlDoneToFcp = round(fcp - m.htmlDone)

  return {
    metrics: m,
    lcpFinal: lcpFinal && { t: lcpFinal.t, size: lcpFinal.size, url: lcpFinal.url, el: lcpFinal.el },
    fcpElement: fcpCandidate && { inferred: true, t: fcpCandidate.t, size: fcpCandidate.size, url: fcpCandidate.url, el: fcpCandidate.el },
    lastBlocker,
  }
}

const round = (x) => Math.round(x * 10) / 10

function median(arr) {
  const s = arr.filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b)
  if (!s.length) return null
  const k = s.length
  return k % 2 ? s[(k - 1) / 2] : round((s[k / 2 - 1] + s[k / 2]) / 2)
}

function stat(values) {
  const v = values.filter((x) => typeof x === 'number' && isFinite(x))
  return {
    median: median(v),
    min: v.length ? Math.min(...v) : null,
    max: v.length ? Math.max(...v) : null,
    values,
    count: v.length,
  }
}

/** 跨轮汇总 */
export function summarize(rounds, detectorDefs) {
  const ok = rounds.filter((r) => r.ok)
  const keys = ['ttfb', 'htmlDone', 'fp', 'fcp', 'lcp', 'domInteractive', 'domContentLoaded', 'load', 'redirect', 'dns', 'connect', 'serverWait', 'htmlDownload', 'htmlDoneToFcp']
  const metrics = {}
  for (const k of keys) metrics[k] = stat(ok.map((r) => r.derived.metrics[k]))

  // LCP / FCP 元素在各轮中是否一致(这个页面的 LCP 元素可能不稳定)
  const tally = (pick) => {
    const map = new Map()
    for (const r of ok) {
      const e = pick(r)
      const key = e && e.el ? e.el.selector || e.el.tag : e ? '(元素已被移除)' : '(无)'
      map.set(key, (map.get(key) || 0) + 1)
    }
    return [...map.entries()].map(([selector, count]) => ({ selector, count })).sort((a, b) => b.count - a.count)
  }

  const detectors = {}
  for (const d of detectorDefs) {
    const hits = ok.map((r) => (r.data.detectors[d.id] ? r.data.detectors[d.id] : null))
    const times = hits.map((h) => (h && h.hit != null ? (h.presented != null ? h.presented : h.hit) : null))
    detectors[d.id] = {
      ...stat(times),
      hitCount: times.filter((t) => t != null).length,
      rounds: ok.length,
      error: (hits.find((h) => h && h.error) || {}).error || null,
    }
  }

  return {
    okRounds: ok.length,
    totalRounds: rounds.length,
    metrics,
    lcpElements: tally((r) => r.derived.lcpFinal),
    fcpElements: tally((r) => r.derived.fcpElement),
    detectors,
    resourceCount: stat(ok.map((r) => r.data.resourceCount)),
  }
}

/**
 * 从录屏帧里挑出要保存的:每个事件时刻(FCP / LCP 候选 / 自定义检测命中)对应的帧,
 * 再加上最后一帧(页面最终状态)。
 */
export function pickFrames(frames, eventTimes) {
  const f = frames.filter((x) => x.ms >= 0).sort((a, b) => a.ms - b.ms)
  if (!f.length) return { picked: [], eventFrame: () => null }
  // 录屏帧时间戳和页面时间线是两个时钟,有几毫秒偏差:允许帧比事件早最多一帧
  const TOL = 17
  const nearest = (t) => {
    let i = f.findIndex((x) => x.ms >= t - TOL)
    if (i === -1) i = f.length - 1
    return i
  }
  const keep = new Set([f.length - 1])
  for (const t of eventTimes) if (t != null) keep.add(nearest(t))
  const picked = [...keep].sort((a, b) => a - b).map((i) => f[i])
  return {
    picked,
    eventFrame: (t) => (t == null ? null : f[nearest(t)].ms),
  }
}
