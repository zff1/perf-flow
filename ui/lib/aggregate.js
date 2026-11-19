// 把参与统计的多轮数据合成一条"汇总轮":每一行(各阶段起止、FCP、LCP、自定义检测……)
// 分别取各轮的中位数或平均值。它的结构与单轮完全相同,所以时间线和元素表可以直接复用。
// 注意:汇总轮是合成的,各项数值来自不同的轮次,不对应某一次真实的加载。
import { isNum } from './format.js'

const r1 = (x) => Math.round(x * 10) / 10

/** 与 stats.js 里的中位数算法一致 */
export function pickStat(values, stat) {
  const v = values.filter(isNum)
  if (!v.length) return null
  if (stat === 'mean') return r1(v.reduce((a, b) => a + b, 0) / v.length)
  const s = [...v].sort((a, b) => a - b)
  const k = s.length
  return k % 2 ? s[(k - 1) / 2] : r1((s[k / 2 - 1] + s[k / 2]) / 2)
}

const NAV_KEYS = [
  'redirectStart', 'redirectEnd', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'secureConnectionStart',
  'connectEnd', 'requestStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoaded', 'dclEnd',
  'domComplete', 'loadEvent', 'loadEnd',
]

const selOf = (c) => (c && c.el ? c.el.selector || c.el.tag : '(元素已被移除)')

function tally(items, keyOf) {
  const m = new Map()
  for (const it of items) {
    const k = keyOf(it)
    m.set(k, (m.get(k) || 0) + 1)
  }
  return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
}

/**
 * 服务端明细:各轮的探针记录按"调用"归并,时间取各轮的中位数或平均值。
 * 汇总里至少有一半的轮次匹配到页面请求才保留;某个调用至少出现在一半的有记录的轮次里才保留。
 */
function mergeServer(datas, P) {
  const svs = datas.map((d) => d.server).filter(Boolean)
  if (!svs.length) return undefined
  const total = datas.length
  const probes = svs.map((s) => s.probe).filter(Boolean)
  const okN = probes.filter((p) => p.state === 'ok').length
  const probe = okN
    ? { ...probes.find((p) => p.state === 'ok'), rounds: okN, of: total }
    : probes.find((p) => p.state === 'failed') || probes[0] || { state: 'off' }

  const reqs = svs.map((s) => s.request).filter(Boolean)
  let request = null
  if (reqs.length && reqs.length >= Math.ceil(total / 2)) {
    const needSpan = Math.ceil(reqs.length / 2)
    const groups = new Map()
    reqs.forEach((q) =>
      q.spans.forEach((sp) => {
        const g = groups.get(sp.key) || { ...sp, starts: [], ends: [], bad: 0 }
        g.starts.push(sp.start)
        g.ends.push(sp.end)
        if (sp.error) g.bad++
        groups.set(sp.key, g)
      })
    )
    const spans = [...groups.values()]
      .filter((g) => g.starts.length >= needSpan)
      .map((g) => ({ key: g.key, via: g.via, method: g.method, target: g.target, start: P(g.starts), end: P(g.ends), status: g.status, error: g.bad ? '部分轮次出错' : undefined, n: g.starts.length }))
      .sort((a, b) => a.start - b.start)
    request = {
      offset: P(reqs.map((q) => q.offset)),
      firstByteAt: P(reqs.map((q) => q.firstByteAt)),
      total: P(reqs.map((q) => q.total)),
      status: reqs[0].status,
      slack: P(reqs.map((q) => q.slack)),
      spans,
      n: reqs.length,
      of: total,
    }
  }

  // Server-Timing:按名称归并,至少出现在一半的轮次里
  const tg = new Map()
  svs.forEach((s) =>
    (s.timing || []).forEach((t) => {
      const k = t.name + '|' + t.desc
      const g = tg.get(k) || { name: t.name, desc: t.desc, durs: [] }
      g.durs.push(t.dur)
      tg.set(k, g)
    })
  )
  const timing = [...tg.values()].filter((g) => g.durs.length >= Math.ceil(total / 2)).map((g) => ({ name: g.name, desc: g.desc, dur: P(g.durs), n: g.durs.length }))

  return { probe, request, unmatched: request ? null : svs.map((s) => s.unmatched).find(Boolean) || null, timing }
}

/**
 * 脚本执行(长动画帧):各轮按"脚本 + 类型 + 第几次执行"归并,至少出现在一半的轮次里才保留,起点和耗时取统计值。
 * 只要有一轮的浏览器不支持,就整体当作不支持(混着用会让"已识别 / 未识别"对不上)。
 */
function mergeRuns(datas, P, need) {
  const groups = new Map()
  datas.forEach((d) => {
    const seen = new Map()
    ;(d.scriptRuns || []).forEach((r) => {
      const base = `${r.src}|${r.type}|${r.invoker}|${r.fn}`
      const k = (seen.get(base) || 0) + 1
      seen.set(base, k)
      const key = base + '#' + k
      const g = groups.get(key) || { ...r, starts: [], durs: [], forced: [] }
      g.starts.push(r.start)
      g.durs.push(r.dur)
      g.forced.push(r.forced || 0)
      groups.set(key, g)
    })
  })
  return [...groups.values()]
    .filter((g) => g.starts.length >= need)
    .map((g) => ({ src: g.src, type: g.type, invoker: g.invoker, fn: g.fn, start: P(g.starts), dur: P(g.durs), forced: P(g.forced), n: g.starts.length }))
    .sort((a, b) => a.start - b.start)
}

/** @param usedRounds 参与统计的、成功的轮次  @param stat 'median' | 'mean' */
export function buildAggregateRound(usedRounds, stat) {
  const P = (vals) => pickStat(vals, stat)
  const datas = usedRounds.map((r) => r.data)
  const total = datas.length

  // ---- 导航计时 ----
  const navs = datas.map((d) => d.nav).filter(Boolean)
  let nav = null
  if (navs.length) {
    nav = Object.fromEntries(NAV_KEYS.map((k) => [k, P(navs.map((n) => n[k]))]))
    nav.redirectCount = Math.max(...navs.map((n) => n.redirectCount || 0))
    nav.protocol = navs[0].protocol
  }

  // ---- 渲染阻塞资源:按地址归并,至少出现在一半的轮次里才保留 ----
  const byName = new Map()
  datas.forEach((d) =>
    (d.blocking || []).forEach((b) => {
      const e = byName.get(b.name) || { name: b.name, type: b.type, starts: [], ends: [] }
      e.starts.push(b.start)
      e.ends.push(b.end)
      byName.set(b.name, e)
    })
  )
  const need = Math.ceil(total / 2)
  const blocking = [...byName.values()]
    .filter((e) => e.starts.length >= need)
    .map((e) => ({ name: e.name, type: e.type, start: P(e.starts), end: P(e.ends), n: e.starts.length }))
    .sort((a, b) => a.start - b.start)

  // ---- 资源与 script 属性(用来归因 DCL / load)。按去掉查询参数的 URL 归并(埋点图片每次的参数都不同) ----
  const hasRes = datas.every((d) => Array.isArray(d.resources))
  let resources = undefined
  let scripts = undefined
  if (hasRes) {
    const rk = (name) => {
      try {
        const u = new URL(name)
        return u.origin + u.pathname
      } catch {
        return name
      }
    }
    const groups = new Map()
    datas.forEach((d) =>
      d.resources.forEach((r) => {
        const k = rk(r.name)
        const g = groups.get(k) || { name: r.name, type: r.type, rb: r.rb, starts: [], ends: [] }
        g.starts.push(r.start)
        g.ends.push(r.end)
        groups.set(k, g)
      })
    )
    resources = [...groups.entries()]
      .filter(([, g]) => g.starts.length >= need)
      .map(([k, g]) => ({ name: g.name, type: g.type, rb: g.rb, start: P(g.starts), end: P(g.ends), size: 0, n: g.starts.length }))
      .sort((a, b) => a.start - b.start)
    // script 标签属性:取第一个出现它的轮次;src 与合并后的资源名对齐,归因时才能对上
    const nameByKey = new Map(resources.map((r) => [rk(r.name), r.name]))
    const seen = new Set()
    scripts = []
    datas.forEach((d) =>
      (d.scripts || []).forEach((sc) => {
        const k = rk(sc.src)
        if (seen.has(k) || !nameByKey.has(k)) return
        seen.add(k)
        scripts.push({ ...sc, src: nameByKey.get(k) })
      })
    )
  }

  // ---- load 有没有触发:各轮可能不一致,汇总不能把"没触发"的轮次悄悄略掉 ----
  const loadFired = datas.filter((d) => d.nav && d.nav.loadEvent > 0).length
  const loadTimedOut = loadFired < total
  // 没触发的那些轮里仍未完成的请求,按去掉查询参数的 URL 归并(链式请求每次的参数都不同)
  let pendingRequests = undefined
  if (loadTimedOut) {
    const pk = (name) => {
      try {
        const u = new URL(name)
        return u.origin + u.pathname
      } catch {
        return name
      }
    }
    const pg = new Map()
    datas.filter((d) => Array.isArray(d.pendingRequests)).forEach((d) =>
      d.pendingRequests.forEach((r) => {
        const k = pk(r.name)
        const g = pg.get(k) || { name: r.name, type: r.type, starts: [], ends: [], n: 0 }
        g.starts.push(r.start)
        g.ends.push(r.end)
        g.n++
        pg.set(k, g)
      })
    )
    pendingRequests = [...pg.values()].map((g) => ({ name: g.name, type: g.type, start: P(g.starts), end: P(g.ends), n: g.n })).sort((a, b) => a.start - b.start)
  }

  // ---- FP / FCP ----
  const fp = P(datas.map((d) => d.fp))
  const fcp = P(datas.map((d) => d.fcp))

  // ---- LCP:最终元素取"出现次数最多的";时间与卡片上的 LCP 一致(各轮最终 LCP 时间的统计值) ----
  const finals = usedRounds.map((r) => (r.data.lcp.length ? r.data.lcp[r.data.lcp.length - 1] : null))
  const finalsOk = finals.filter(Boolean)
  let lcp = []
  let lcpVariants = []
  if (finalsOk.length) {
    lcpVariants = tally(finalsOk, selOf)
    const topSel = lcpVariants[0].key
    const sameRounds = finalsOk.filter((c) => selOf(c) === topSel)
    const final = {
      t: P(finalsOk.map((c) => c.t)),
      size: P(sameRounds.map((c) => c.size)),
      url: sameRounds[0].url,
      el: sameRounds[0].el,
      n: sameRounds.length, // 这个元素在几轮里是最终的 LCP
      of: finalsOk.length,
    }
    // 其余候选按元素归并
    const groups = new Map()
    usedRounds.forEach((r) =>
      r.data.lcp.slice(0, -1).forEach((c) => {
        const k = selOf(c)
        const arr = groups.get(k) || []
        arr.push(c)
        groups.set(k, arr)
      })
    )
    const cands = [...groups.values()]
      .map((arr) => ({ t: P(arr.map((c) => c.t)), size: P(arr.map((c) => c.size)), url: arr[0].url, el: arr[0].el, n: arr.length, of: total }))
      .sort((a, b) => a.t - b.t)
    lcp = [...cands, final]
  }

  // ---- 自定义检测 ----
  const detectors = {}
  const ids = datas.length ? Object.keys(datas[0].detectors) : []
  for (const id of ids) {
    const xs = datas.map((d) => d.detectors[id]).filter(Boolean)
    const hits = xs.map((x) => (isNum(x.presented) ? x.presented : isNum(x.hit) ? x.hit : null)).filter(isNum)
    const t = hits.length ? P(hits) : null
    detectors[id] = {
      ...xs[0],
      hit: t,
      presented: t,
      el: (xs.find((x) => x.el) || {}).el || null,
      error: (xs.find((x) => x.error) || {}).error || null,
      n: hits.length,
      of: xs.length,
    }
  }

  // ---- 派生:FCP 元素(取出现最多的)、FCP 之前最后完成的阻塞资源 ----
  const fcpEls = usedRounds.map((r) => r.derived.fcpElement).filter(Boolean)
  let fcpElement = null
  if (fcpEls.length) {
    const top = tally(fcpEls, selOf)[0]
    const same = fcpEls.filter((c) => selOf(c) === top.key)
    fcpElement = { inferred: true, t: fcp, size: P(same.map((c) => c.size)), url: same[0].url, el: same[0].el, n: top.count, of: total }
  }
  let lastBlocker = null
  if (isNum(fcp)) {
    for (const b of blocking) if (b.end <= fcp + 16 && (!lastBlocker || b.end > lastBlocker.end)) lastBlocker = b
  }

  return {
    index: 'all',
    ok: true,
    aggregate: true,
    stat,
    count: total,
    data: { url: datas[0] && datas[0].url, fp, fcp, lcp, detectors, nav, blocking, blockingSupported: true, resources, scripts, loadFired, loadTimedOut, pendingRequests, server: mergeServer(datas, P), loafSupported: datas.every((d) => d.loafSupported === true) ? true : datas.some((d) => d.loafSupported === false) ? false : undefined, scriptRuns: datas.every((d) => d.loafSupported === true) ? mergeRuns(datas, P, need) : undefined },
    derived: { fcpElement, lastBlocker, lcpFinal: lcp.length ? lcp[lcp.length - 1] : null, lcpVariants },
  }
}
