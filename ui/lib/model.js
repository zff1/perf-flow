// 把原始测量数据整理成界面要用的结构:时间线的行、事件列表。
import { EXPLAIN, describeDetector, precisionOf } from './text.js'
import { isNum, fmt } from './format.js'
import { explainDclLoad, KIND_LABEL, baseName, GAP, keyOf } from './loadphases.js'

/** 拖住 DCL / load 的请求按类型着色 */
export const GATE_COLOR = { sync: '#e0605a', defer: '#e8a13a', async: '#4f8cff', script: '#4f8cff', sheet: '#8a93a3', img: '#1fa971', css: '#9b3fd0', link: '#8a93a3', iframe: '#c05bb0', other: '#8a93a3' }

export const COLORS = {
  redirect: '#b9a3ff',
  dns: '#7ed0c4',
  connect: '#f2b35e',
  wait: '#e0605a',
  html: '#4f8cff',
  block: '#8a93a3',
  fp: '#1fa971',
  fcp: '#1fa971',
  lcp: '#e8590c',
  det: '#9b3fd0',
  page: '#6b7482',
  srv: '#0b7285',
  exec: '#a8652a', // 脚本执行
}

/**
 * 聚焦选项。每一项对应一个"时间点"(或服务端),聚焦后只显示到这个时间点为止、一路上的关键阻塞。
 * 按这个顺序排列;某个选项只有在这一轮有对应的数据时才出现(行的 milestone 字段标明了它是谁的父行)。
 */
export const FOCUS = [
  { id: 'srv', label: '服务端' },
  { id: 'fcp', label: 'FCP' },
  { id: 'lcp', label: 'LCP' },
  { id: 'dcl', label: 'DOMContentLoaded' },
  { id: 'load', label: 'load' },
  { id: 'det', label: '我的检测' },
]
const ALL = ['srv', 'fcp', 'lcp', 'dcl', 'load', 'det']
const M4 = ['fcp', 'lcp', 'dcl', 'load']
const PAINT = ['fcp', 'lcp']
const PAGE = ['dcl', 'load']
const END = 1e9 // 没有时间的说明行排序用:放到最后(不会参与时间轴的范围计算)

/** 总览的图例;unknownN 是这一轮被隐藏的“无法识别”空白有几段 */
export const legendFor = (unknownN) =>
  '按时间顺序列出全部请求和时间点。条 = 请求的下载起止,菱形 = 时间点;“决定 FCP”这类标签表示它是决定那个时间点的请求。' +
  (unknownN ? `总览不显示“无法识别”的空白(这一轮有 ${unknownN} 段),请在上面的聚焦里查看。` : '')

/** 聚焦时,时间线上方的一句说明(每个时间点“被什么推迟”的路径)。与这条路径并行、不阻塞的请求不显示,总览里有 */
export const FOCUS_HINT = {
  srv: '“等待服务器响应”这段时间里服务端做了什么:缩进的行是它发出的上游调用,没有被调用覆盖的空白是无法识别的部分。',
  fcp: 'FCP 之前一路上的阻塞:请求 → 渲染阻塞资源 → 无法识别的空白。并行的阻塞资源只取结束最晚的那一条,其余的在总览里。',
  lcp: 'LCP 之前一路上的阻塞:请求 → 渲染阻塞资源 → FCP → LCP 元素本身的下载 → 无法识别的空白。更早的 LCP 候选在总览里。',
  dcl: 'DOMContentLoaded 之前一路上的阻塞:请求 → 同步脚本 → HTML 解析完成 → defer 脚本。并行的其他脚本只取结束最晚的那一条,其余的在总览里。',
  load: 'load 之前一路上的阻塞:DOMContentLoaded 之前的全部阻塞,加上 DOMContentLoaded 之后仍拖住 load 的请求。并行的只取结束最晚的那一条,其余的在总览里。',
  det: '你的检测的时间点。工具没有记录是什么在阻塞它们,所以这里只列出请求阶段和检测本身。',
}

/** 长动画帧里记录的脚本执行,按类型的叫法 */
export const RUN_TYPE = {
  'classic-script': '脚本执行',
  'module-script': '模块脚本执行',
  'event-listener': '事件回调',
  'user-callback': '回调(定时器、rAF 等)',
  'resolve-promise': 'Promise 回调',
  'reject-promise': 'Promise 回调',
}

/** [from, to] 这段里,脚本执行覆盖了多少毫秒(重叠的只算一次) */
export function runCoverage(runs, from, to) {
  const iv = (runs || []).map((r) => [Math.max(r.start, from), Math.min(r.start + r.dur, to)]).filter(([a, b]) => b - a > 0).sort((a, b) => a[0] - b[0])
  let cov = 0
  let cur = null
  for (const [a, b] of iv) {
    if (!cur || a > cur[1]) {
      if (cur) cov += cur[1] - cur[0]
      cur = [a, b]
    } else cur[1] = Math.max(cur[1], b)
  }
  return cur ? cov + cur[1] - cur[0] : cov
}

/** 把 [from, to] 这段空白切成:脚本执行的部分({ run, start, end })和剩下仍然无法识别的部分({ gap, start, end }) */
function splitGap(from, to, runs) {
  const rs = (runs || [])
    .map((r) => ({ r, s: Math.max(r.start, from), e: Math.min(r.start + r.dur, to) }))
    .filter((x) => x.e - x.s > 1)
    .sort((a, b) => a.s - b.s)
  const parts = []
  let cur = from
  for (const x of rs) {
    const s = Math.max(x.s, cur)
    if (x.e <= s) continue
    if (s - cur > 0) parts.push({ gap: true, start: cur, end: s })
    parts.push({ run: x.r, start: s, end: x.e })
    cur = x.e
  }
  if (to - cur > 0) parts.push({ gap: true, start: cur, end: to })
  return parts
}

/**
 * 时间线的行(不分组,稍后统一按时间排序)。每一行:
 *   kind   'bar' | 'mark' | 'note'
 *   key    行的唯一标识
 *   label  左侧名称;sub 左侧第二行(元素名等)
 *   start / end(bar)或 t(mark)
 *   tip / data  悬停时用来生成提示内容
 *   on     这一行在哪些时间点的"关键路径"上(聚焦到那个时间点时显示;总览显示全部)
 *   milestone  这一行本身就是某个聚焦选项的时间点(FOCUS 里的 id)
 *   focusOnly  只在聚焦时显示,总览里隐藏
 *   unknown    “无法识别”的空白:总览里不显示(太多会看不清),只在聚焦里显示
 *   sortT  没有时间的说明行用它指定排在哪里
 *   depth  缩进层级(只有服务端发出的上游调用缩进一级)
 */
export function buildTimelineRows(round, summary, cfg) {
  const d = round.data
  const n = d.nav
  const rows = []
  const add = (r) => rows.push({ on: [], depth: 0, ...r })

  // 浏览器端的“无法识别”空白:先把长动画帧里记录到的脚本执行切出来(标成“执行 xxx.js”),剩下的才是无法识别。
  // 没有脚本执行记录(浏览器不支持,或旧记录)时,整段仍是无法识别
  const runs = d.scriptRuns || []
  const MIN_REMAINDER = 20 // 切掉脚本执行后,剩下的空白不到这个毫秒数就不再单独画
  // [from, to] 里,没有被某个时间点路径上已有的条覆盖的部分
  const uncovered = (from, to, id) => {
    const iv = rows
      .filter((x) => x.kind === 'bar' && x.on.includes(id) && isNum(x.start) && isNum(x.end) && x.end > from && x.start < to)
      .map((x) => [Math.max(x.start, from), Math.min(x.end, to)])
      .sort((a, b) => a[0] - b[0])
    const out = []
    let cur = from
    for (const [a, b] of iv) {
      if (a > cur) out.push([cur, a])
      cur = Math.max(cur, b)
    }
    if (cur < to) out.push([cur, to])
    return out
  }
  const gapRows = (key, from, to, sub, scope) => {
    const parts = splitGap(from, to, runs)
    const hasRun = parts.some((p) => p.run)
    parts.forEach((p, i) => {
      if (p.run) {
        const r = p.run
        // 同一次脚本执行可能落在好几段空白里(FCP 的、LCP 的、DCL 的……):只画一行,把它属于哪些时间点合并起来
        const id = `run|${r.src}|${r.type}|${r.invoker}|${r.start}|${r.dur}`
        const dup = rows.find((x) => x.runId === id)
        if (dup) {
          dup.on = [...new Set([...dup.on, ...scope])]
          dup.start = Math.min(dup.start, p.start)
          dup.end = Math.max(dup.end, p.end)
          dup.data.clipped = dup.start > r.start + 0.5 || dup.end < r.start + r.dur - 0.5
          return
        }
        const inline = r.src && d.url && keyOf(r.src) === keyOf(d.url) // 页面里的内联脚本:来源就是页面本身
        add({
          runId: id, kind: 'bar', key: `${key}-run${i}`, label: r.src && !inline ? '' : inline ? '页面内联脚本' : r.invoker || RUN_TYPE[r.type] || '脚本',
          fileUrl: r.src && !inline ? r.src : null, badge: '执行', badgeCls: 'execbadge',
          sub: (RUN_TYPE[r.type] || r.type || '脚本执行') + (r.fn ? ` · ${r.fn}` : ''), color: COLORS.exec,
          start: p.start, end: p.end, tip: 'scriptrun', data: { run: r, clipped: p.start > r.start + 0.5 || p.end < r.start + r.dur - 0.5 }, on: [...scope],
        })
      } else if (!hasRun || p.end - p.start > MIN_REMAINDER) {
        add({ kind: 'bar', key: hasRun ? `${key}-gap${i}` : key, label: '无法识别', sub, unknown: true, color: '#e8a13a', start: p.start, end: p.end, tip: 'unknown', data: { from: p.start, to: p.end, loaf: d.loafSupported }, on: scope })
      }
    })
  }

  // ---- 请求与服务器:所有时间点的路径都从这里开始 ----
  const sv = d.server
  const srvShown = !!(n && sv && (sv.request || (sv.probe && sv.probe.state === 'failed') || sv.unmatched || (sv.timing || []).length))
  if (n) {
    const N = (r) => add({ on: ALL, ...r })
    if (n.redirectCount && n.redirectEnd > n.redirectStart)
      N({ kind: 'bar', key: 'redirect', label: '重定向', color: COLORS.redirect, start: n.redirectStart, end: n.redirectEnd, tip: 'redirect' })
    if (n.domainLookupEnd - n.domainLookupStart >= 0.5)
      N({ kind: 'bar', key: 'dns', label: 'DNS 查询', color: COLORS.dns, start: n.domainLookupStart, end: n.domainLookupEnd, tip: 'dns' })
    if (n.connectEnd - n.connectStart >= 0.5)
      N({ kind: 'bar', key: 'connect', label: '建立连接(TCP / TLS)', color: COLORS.connect, start: n.connectStart, end: n.connectEnd, tip: 'connect' })
    // 有服务端数据时,"等待服务器响应"自己就是服务端的父行:服务端处理就是这段时间,不另列一行
    N({
      kind: 'bar', key: 'wait', label: '等待服务器响应', sub: `TTFB ${Math.round(n.responseStart)} ms`, color: COLORS.wait, start: n.requestStart, end: n.responseStart, tip: 'wait', strong: true,
      data: sv && sv.request ? { q: sv.request, probe: sv.probe } : null, milestone: srvShown ? 'srv' : undefined,
    })
    N({ kind: 'bar', key: 'html', label: '下载 HTML', color: COLORS.html, start: n.responseStart, end: n.responseEnd, tip: 'html' })
    if (srvShown) buildServerRows(sv, add, n.requestStart + 0.01)
  }

  // ---- FCP:阻塞它的是 Chrome 标记的渲染阻塞资源;并行的只取结束最晚的那一条 ----
  {
    const fe = round.derived && round.derived.fcpElement
    if (isNum(d.fcp))
      add({ kind: 'mark', key: 'fcp', label: 'FCP 首次内容绘制', sub: fe && fe.el ? fe.el.selector : '', color: COLORS.fcp, t: d.fcp, tip: 'fcp', data: fe, link: 'fcp', strong: true, on: PAINT, milestone: 'fcp' })
    else add({ kind: 'note', key: 'fcp', label: 'FCP 首次内容绘制', color: COLORS.fcp, text: '本轮没有获得', warn: true, on: ['fcp'], milestone: 'fcp', sortT: END })

    const blocks = d.blocking || []
    if (blocks.length) {
      const lastB = round.derived && round.derived.lastBlocker
      const detB = lastB ? blocks.find((b) => b.name === lastB.name) : null
      const path = detB ? serialChain(blocks, detB) : new Set()
      blocks.forEach((b, i) => {
        const det = b === detB
        const onPath = path.has(b)
        add({
          kind: 'bar', key: 'block' + i, label: '', fileUrl: b.name, badge: det ? '决定 FCP' : '阻塞', badgeCls: det ? 'dbadge' : null, role: det ? 'FCP 的决定者(Chrome 标记的渲染阻塞资源)' : 'Chrome 标记的渲染阻塞资源', color: COLORS.block,
          start: b.start, end: b.end, tip: 'block', data: b, on: onPath ? PAINT : [],
        })
      })
    } else {
      add({ kind: 'note', key: 'noblock', focusOnly: true, on: ['fcp'], sortT: isNum(d.fcp) ? d.fcp - 0.5 : END, text: d.blockingSupported === false ? '无法识别:当前 Chrome 不提供渲染阻塞信息' : '没有发现被 Chrome 标记为渲染阻塞的网络请求(内联脚本、内联样式、字体、主线程繁忙等不在其内,无法识别)' })
    }
    // 工具能解释的最后一个时刻之后、FCP 之前的空白(内联脚本、样式计算、字体、主线程忙……)
    const fgap = unexplainedGap(round)
    if (fgap && fgap.significant) gapRows('unk-fcp', fgap.from, fgap.fcp, fgap.basis === 'blocker' ? '最后一个阻塞请求结束之后' : 'HTML 收完之后', PAINT)
    if (isNum(d.fp) && isNum(d.fcp) && Math.abs(d.fp - d.fcp) > 8)
      add({ kind: 'mark', key: 'fp', label: 'FP 首次绘制', color: COLORS.fp, t: d.fp, tip: 'fp' })
  }

  // ---- LCP:除了渲染阻塞,还要等 LCP 元素自己(图片要下载);更早的候选只是并行的参考 ----
  {
    const lcp = d.lcp || []
    const last = lcp.length ? lcp[lcp.length - 1] : null
    lcp.forEach((c, i) => {
      const isLast = c === last
      const prev = i > 0 ? lcp[i - 1].size : 0
      add({
        kind: 'mark', key: 'lcp' + i,
        label: isLast ? 'LCP 最终' : `LCP 候选 ${i + 1}`,
        sub: c.el ? c.el.selector : '(元素已移除)',
        covered: !!(c.el && c.el.covered),
        color: COLORS.lcp, faded: !isLast, t: c.t, tip: 'lcp', data: { c, isLast, prev }, link: isLast ? 'lcp-final' : null, strong: isLast,
        on: isLast ? ['lcp'] : [], milestone: isLast ? 'lcp' : undefined,
      })
    })
    if (last && n) {
      // LCP 的路径里已经有 FCP 路径的那些行(阻塞资源、FCP 之前的空白、脚本执行):空白只算它们没覆盖到的部分,
      // 否则同一段时间会被说两遍
      const unk = (key, from, to, sub) =>
        uncovered(from, to, 'lcp').filter(([a, b]) => b - a > MIN_REMAINDER).forEach(([a, b], i) => gapRows(i ? `${key}-${i}` : key, a, b, sub, ['lcp']))
      // LCP 元素如果是图片(或 CSS 背景图),在资源列表里找到它的下载
      const res = last.url && Array.isArray(d.resources) ? d.resources.find((r) => keyOf(r.name) === keyOf(last.url)) : null
      if (res) {
        if (res.start - n.responseEnd > GAP) unk('unk-lcp-pre', n.responseEnd, res.start, 'HTML 收完之后、发出这张图片的请求之前')
        add({
          kind: 'bar', key: 'lcpimg', label: '', fileUrl: res.name, badge: '决定 LCP', badgeCls: 'dbadge', role: 'LCP 元素的下载(LCP 的决定者)',
          sub: (res.type === 'img' ? '图片' : res.type === 'css' ? 'CSS 背景图' : res.type) + ' · LCP 元素', color: COLORS.lcp,
          start: res.start, end: res.end, tip: 'lcpimg', data: { res, c: last }, on: ['lcp'],
        })
        // 图片下载完成之后,如果渲染还被阻塞资源拖着,这段时间已经有解释了,只把解释不了的部分标成无法识别
        const lb = round.derived && round.derived.lastBlocker
        const from = Math.max(res.end, lb && isNum(lb.end) && lb.end <= last.t ? lb.end : 0)
        if (last.t - from > GAP) unk('unk-lcp-post', from, last.t, from > res.end ? '最后一个阻塞请求结束之后、绘制之前' : '图片下载完成之后、绘制之前')
      } else if (isNum(d.fcp) && last.t - d.fcp > GAP) {
        unk('unk-lcp', d.fcp, last.t, 'FCP 之后、LCP 之前(没有找到 LCP 元素对应的下载)')
      }
    }
  }

  // ---- 你的检测 ----
  const defs = cfg.detectors || []
  defs.forEach((def, i) => {
    const x = d.detectors[def.id] || {}
    const t = isNum(x.presented) ? x.presented : x.hit
    add({
      kind: isNum(t) ? 'mark' : 'note', key: 'det' + def.id,
      label: `${def.label || def.value.slice(0, 18)}`, num: i, color: COLORS.det, t,
      text: x.error ? x.error : '本轮未命中', tip: 'det', data: { def, x, sum: summary.detectors[def.id] }, link: 'det' + def.id,
      on: ['det'], milestone: 'det', sortT: isNum(t) ? undefined : END,
    })
  })

  // ---- DOMContentLoaded 与 load:阻塞它们的请求 ----
  if (n) {
    const ex = explainDclLoad(round)

    // 副标题:类型;同步脚本再带上位置和是否阻塞渲染(实测:head 里的会推迟 FCP / LCP,body 里的只推迟它后面的内容)
    const gateSub = (c) => {
      let t = KIND_LABEL[c.kind] || c.kind
      if (c.kind === 'sync') t += c.inHead === true ? ' · head · 阻塞渲染' : c.inHead === false ? ' · body' : ''
      return t
    }
    // 一条"拖住某个时间点的请求":决定者在路径上,并行的其他请求收起
    const gate = (c, det, phase, remain, scope, word) =>
      add({
        kind: 'bar', key: `gate-${phase}-${c.name}`, label: '', fileUrl: c.name,
        badge: det ? '决定 ' + word : null, badgeCls: det ? 'dbadge' : null,
        role: (phase === 'parse' ? '解析阶段的同步脚本' : phase === 'defer' ? 'defer / module 脚本' : '拖住 load 的请求') + (det ? `(${word} 的决定者)` : ''),
        sub: gateSub(c), color: GATE_COLOR[c.kind] || COLORS.block,
        start: c.start, end: c.end, tip: 'gate', data: { c, det, phase, remain }, on: det ? scope : [],
      })
    // 无法识别的时间段:画成一条带斜纹的横线,起止就是这段空白的起止
    const unknownBar = (key, from, to, sub, scope) => gapRows(key, from, to, sub, scope)

    // DOMContentLoaded:HTML 解析被同步脚本拖住 → HTML 解析完成 → defer / module 脚本 → DCL。load 也要等它,所以两条路径都包含这些行。
    // “HTML 解析完成”先加:两者时间相同时(没有 defer 脚本),它排在 DCL 前面
    if (n.domInteractive > 0) add({ kind: 'mark', key: 'dom', label: 'HTML 解析完成', sub: 'domInteractive', color: COLORS.page, t: n.domInteractive, tip: 'dom', on: PAGE })
    add(n.domContentLoaded > 0
      ? { kind: 'mark', key: 'dcl', label: 'DOMContentLoaded', color: COLORS.page, t: n.domContentLoaded, tip: 'dcl', strong: true, on: PAGE, milestone: 'dcl' }
      : { kind: 'note', key: 'dcl', label: 'DOMContentLoaded', color: COLORS.page, text: '观察期内没有触发', warn: true, on: PAGE, milestone: 'dcl', sortT: END - 3 })
    if (ex && ex.noResources) {
      add({ kind: 'note', key: 'noRes', warn: true, on: PAGE, sortT: n.domContentLoaded > 0 ? n.domContentLoaded + 0.5 : END - 4, text: '这条记录是旧版本测量的,没有每个请求的明细,无法归因。重新测量一次即可。' })
    } else if (ex) {
      // 样式表只有在它就是决定者时才列出(它已经在 FCP 的"渲染阻塞资源"里出现过,不重复)
      const keepGate = (p, c) => c.kind !== 'sheet' || p.det === c
      if (ex.parse) ex.parse.list.filter((c) => keepGate(ex.parse, c)).forEach((c) => gate(c, ex.parse.det === c, 'parse', ex.parse.unknown, PAGE, 'DCL'))
      if (ex.parse && ex.parse.dur > GAP && ex.parse.unknown > GAP)
        unknownBar('unk-parse', ex.parse.to - ex.parse.unknown, ex.parse.to, ex.parse.det ? '决定者下载完之后' : 'HTML 收完之后', PAGE)
      if (ex.deferPhase) {
        ex.deferPhase.list.forEach((c) => gate(c, ex.deferPhase.det === c, 'defer', ex.deferPhase.unknown, PAGE, 'DCL'))
        if (ex.deferPhase.dur > GAP && ex.deferPhase.unknown > GAP)
          unknownBar('unk-defer', ex.deferPhase.to - ex.deferPhase.unknown, ex.deferPhase.to, ex.deferPhase.det ? '决定者下载完之后' : '解析完成之后', PAGE)
      }
    }

    // load:DOMContentLoaded 之后还拖着它的请求
    const fired = n.loadEvent > 0
    const partial = isNum(d.loadFired) && round.count && d.loadFired < round.count // 汇总时,只有一部分轮次触发了 load
    add(fired
      ? { kind: 'mark', key: 'load', label: 'load 事件', color: COLORS.page, t: n.loadEvent, tip: 'load', strong: true, on: ['load'], milestone: 'load' }
      : { kind: 'note', key: 'load', label: 'load 事件', color: COLORS.page, text: '观察期内没有触发', warn: true, on: ['load'], milestone: 'load', sortT: END })
    if (ex && !ex.noResources && ex.load) {
      ex.load.list.forEach((c) => gate(c, ex.load.det === c, 'load', ex.load.unknown, ['load'], 'load'))
      if (ex.load.dur > GAP && ex.load.unknown > GAP)
        unknownBar('unk-load', ex.load.to - ex.load.unknown, ex.load.to, ex.load.det ? '决定者下载完之后' : 'DCL 之后', ['load'])
      if (ex.uncertain.length)
        add({ kind: 'note', key: 'uncertain', warn: true, on: ['load'], sortT: fired ? n.loadEvent - 0.5 : END - 2, text: `另有 ${ex.uncertain.length} 个类型未经验证的请求(video / audio / other)在这段时间内完成,工具无法确认它们是否拖住 load:${ex.uncertain.slice(0, 2).map((r) => baseName(r.name)).join('、')}${ex.uncertain.length > 2 ? ' 等' : ''}` })
    }
    // 汇总时,只有一部分轮次触发了 load:一条说明讲清楚,并在有仍未完成的请求时一并提示
    if (fired && partial) {
      const pn = (d.pendingRequests || []).length
      add({ kind: 'note', key: 'loadPartial', warn: true, on: ['load'], sortT: n.loadEvent + 0.5, text: `只有 ${d.loadFired} / ${round.count} 轮触发了 load 事件,上面的时间只来自这 ${d.loadFired} 轮;其余 ${round.count - d.loadFired} 轮在观察期内没有触发。${pn ? `没触发的那些轮里,观察结束时仍未完成的请求(${pn} 个)见下:` : ''}` })
    }
    // load 没触发(整轮没触发,或汇总里有轮次没触发):说明原因,并列出观察结束时仍未完成的请求
    if (d.loadTimedOut) {
      const pend = d.pendingRequests || []
      if (!fired)
        add({
          kind: 'note', key: 'noLoad', warn: true, on: ['load'], sortT: pend.length ? pend[0].start - 0.5 : END - 1,
          text: `load 事件在观察期内没有触发。通常是页面一直有会拖住它的请求在途(图片、脚本、iframe 等),或某个请求一直没结束。fetch / XHR 不会拖住 load。${pend.length ? `下面是观察结束时仍未完成的 ${pend.length} 个请求(条的右端是观察结束的时刻)。` : '没有发现仍未完成的请求。'}`,
        })
      pend.slice(0, 8).forEach((r, i) =>
        add({
          kind: 'bar', key: 'pend' + i, label: '', fileUrl: r.name, badge: '未完成', badgeCls: 'dbadge',
          sub: (r.type === 'image' ? '图片' : r.type === 'script' ? '脚本' : r.type === 'stylesheet' ? '样式表' : r.type) + ' · 仍在进行', pending: true,
          color: '#8a93a3', start: r.start, end: r.end, tip: 'pending', data: r, on: ['load'],
        })
      )
    }
  }
  return mergeSameResource(rows)
}

/**
 * 关键路径上的串行链:从决定者往前找,前一个请求结束后紧接着(25 ms 内)发出下一个,就算在路径上
 * (例如样式表 @import 另一个样式表,要等前一个结束才发出)。与它们并行的其他请求不在其中。
 * 浏览器的记录里没有“谁导致了谁”,所以前后关系只能按时间推断。
 */
function serialChain(list, det) {
  const chain = new Set()
  for (let cur = det; cur; ) {
    chain.add(cur)
    let best = null
    for (const x of list) {
      if (chain.has(x) || !isNum(x.end) || !isNum(cur.start)) continue
      if (x.end <= cur.start + 5 && cur.start - x.end <= 25 && (!best || x.end > best.end)) best = x
    }
    cur = best
  }
  return chain
}

/**
 * 同一个资源在好几个时间点的路径里都有角色(比如一个同步脚本既是 FCP 的阻塞资源,又是 DCL 的决定者,还拖住 load),
 * 之前各画一行,同一个文件出现好几次。这里把它们合并成一行:保留第一行,路径取并集,角色写进标签和悬浮卡片。
 */
function mergeSameResource(rows) {
  const k = (u) => {
    try {
      const x = new URL(u)
      return x.origin + x.pathname
    } catch {
      return String(u)
    }
  }
  const out = []
  for (const r of rows) {
    if (r.kind === 'bar' && r.fileUrl && r.role) {
      const g = out.find((x) => x.role && x.fileUrl && k(x.fileUrl) === k(r.fileUrl) && Math.abs(x.start - r.start) <= 2 && Math.abs(x.end - r.end) <= 2)
      if (g) {
        g.on = [...new Set([...g.on, ...r.on])]
        g.roles.push(r.role)
        g.badges.push(r.badge)
        continue
      }
      r.roles = [r.role]
      r.badges = [r.badge]
    }
    out.push(r)
  }
  for (const r of out) {
    if (!r.roles || r.roles.length < 2) continue
    const deciders = [...new Set(r.badges.filter((b) => b && b.startsWith('决定')))]
    r.badge = deciders.length ? deciders.join(' · ') : r.badges.find(Boolean) || null
    r.badgeCls = deciders.length ? 'dbadge' : null
    r.also = r.roles.slice(1)
  }
  return out
}

/** 行在时间线上的位置:条按开始时间,时间点按发生时间;没有时间的说明行用 sortT */
const sortKey = (r) => (isNum(r.sortT) ? r.sortT : r.kind === 'bar' ? r.start : r.kind === 'mark' ? r.t : END)
/**
 * 决定时间线显示哪些行、按什么顺序。没有“收起 / 展开”:
 *   总览   全部行,按时间顺序;但不显示“无法识别”的空白(太多会看不清),它们只在聚焦里显示
 *   聚焦   只显示到这个时间点为止的关键路径;与路径并行、不阻塞的请求不显示(总览里有)
 *   focus  'all'(总览)或某个时间点的 id;没有这个时间点的数据时按总览处理
 * 返回 { focus, available, items, axisRows, hiddenUnknown }:
 *   available     这一轮有数据、可以聚焦的时间点
 *   items         按时间排好的行 { row, depth }
 *   hiddenUnknown 总览里被隐藏的“无法识别”空白有几段(在图例里告知)
 */
export function layoutTimeline(rows, focus) {
  const available = FOCUS.filter((o) => rows.some((r) => r.milestone === o.id))
  const f = available.some((o) => o.id === focus) ? focus : 'all'
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => sortKey(a.r) - sortKey(b.r) || a.i - b.i).map((x) => x.r)
  const visible = f === 'all' ? sorted.filter((r) => !r.focusOnly && !r.unknown) : sorted.filter((r) => r.on.includes(f))
  return {
    focus: f,
    available,
    items: visible.map((row) => ({ row, depth: row.depth })),
    axisRows: visible,
    hiddenUnknown: f === 'all' ? sorted.filter((r) => r.unknown).length : 0,
  }
}

/** 服务端里"没有任何上游调用"的空白超过这个时长,就明说无法识别。要足够小:等待服务器响应应该能由调用和这些空白加起来对上 */
export const SRV_GAP = 10
const VIA = { http: 'http', fetch: 'fetch' }
const splitTarget = (t) => {
  const i = String(t).indexOf('/')
  return i < 0 ? { host: String(t), path: '/' } : { host: t.slice(0, i), path: t.slice(i) }
}

/** 服务端各行(都是"等待服务器响应"的子项,缩进一级)。sv 是 data.server(单轮,或汇总合成的,结构相同) */
function buildServerRows(sv, add, at) {
  const S = (r) => add({ depth: 1, ...r })
  const q = sv.request
  const timing = sv.timing || []
  const failed = sv.probe && sv.probe.state === 'failed'
  const SRV_ALL = [...M4, 'srv']

  if (q) {
    const winStart = q.offset
    const winEnd = q.offset + q.firstByteAt

    // 决定者:在响应写出之前结束的调用里,结束得最晚的那个。并行的其他调用只在聚焦“服务端”或展开时显示
    let det = null
    q.spans.forEach((sp) => {
      if (isNum(sp.end) && sp.end <= winEnd + 1 && (!det || sp.end > det.end)) det = sp
    })
    // 关键路径:决定者,加上串行在它前面完成的调用;与它们并行的其他调用不阻塞,只在展开时显示
    const chain = det ? serialChain(q.spans, det) : new Set()
    q.spans.forEach((sp, i) => {
      const { host, path } = splitTarget(sp.target)
      const isDet = sp === det
      const onPath = chain.has(sp)
      S({
        kind: 'bar', key: 'srvcall' + i + sp.key, label: `${sp.method} ${path}`, sub: `${host} · ${VIA[sp.via] || sp.via}`,
        color: '#2b9fb3', start: sp.start, end: sp.end, tip: 'srvcall', data: { sp, det: isDet, chain: onPath && !isDet, winEnd },
        badge: isDet ? '决定 TTFB' : sp.error ? '出错' : null, badgeCls: isDet ? 'dbadge' : null,
        on: onPath ? SRV_ALL : ['srv'],
      })
    })

    // 窗口里没有被任何调用覆盖的空白:服务端自己在干什么,探针看不到
    const iv = q.spans.filter((sp) => isNum(sp.start) && isNum(sp.end)).map((sp) => [Math.max(sp.start, winStart), Math.min(sp.end, winEnd)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
    let cur = winStart
    const gaps = []
    for (const [a, b] of iv) {
      if (a > cur) gaps.push([cur, a])
      cur = Math.max(cur, b)
    }
    if (cur < winEnd) gaps.push([cur, winEnd])
    gaps.filter(([a, b]) => b - a > SRV_GAP).forEach(([a, b], i) => {
      const where = a === winStart ? '收到请求之后、第一次上游调用之前' : b === winEnd ? '最后一次上游调用之后、响应写出之前' : '两次上游调用之间'
      S({ kind: 'bar', key: 'srvunk' + i, label: '无法识别', sub: where, unknown: true, color: '#e8a13a', start: a, end: b, tip: 'srvunk', data: { from: a, to: b, where }, on: SRV_ALL })
    })
  } else if (failed) {
    S({ kind: 'note', key: 'srvnote', warn: true, on: SRV_ALL, sortT: at, text: '服务端部分无法识别:' + (sv.probe.message || '服务端分析不可用') })
  } else if (sv.unmatched) {
    S({ kind: 'note', key: 'srvnote', warn: true, on: SRV_ALL, sortT: at, text: '服务端部分无法识别:' + sv.unmatched })
  }

  // Server-Timing:服务端自己上报的阶段。只有时长,没有起点,所以只能列出来,不能画在时间轴上
  timing.forEach((t, i) =>
    S({
      kind: 'note', key: 'srvtime' + i, label: t.name, sub: t.desc || '', color: COLORS.srv, text: `${fmt(t.dur)} · 服务端上报,没有起点`, tip: 'srvtiming', data: t,
      sortT: at, on: q ? ['srv'] : SRV_ALL,
    })
  )
}

/** 时间线的最大时间(留一点右边距) */
export function timelineMax(rows) {
  let max = 500
  for (const r of rows) {
    if (r.kind === 'bar') max = Math.max(max, r.end)
    if (r.kind === 'mark' && isNum(r.t)) max = Math.max(max, r.t)
  }
  return max * 1.06
}

/** 选一个"好看"的刻度步长,使刻度数不超过 10 个 */
export function niceStep(max) {
  return [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000].find((s) => max / s <= 10) || 20000
}

/**
 * 元素表的事件列表。
 *   round     单轮,或者汇总轮(见 aggregate.js);两者结构相同
 *   annotated 参考录屏轮;只用来给事件附上"对应的画面帧"(可以为 null)
 */
export function buildEvents(round, annotated) {
  const d = round.data
  const derived = round.derived
  const evs = []
  const at = annotated && annotated.ok ? annotated.frameAt : null
  if (isNum(d.fcp)) {
    const fe = derived.fcpElement
    evs.push({ key: 'fcp', kind: 'fcp', name: 'FCP', t: d.fcp, el: fe && fe.el, size: fe && fe.size, url: fe && fe.url, inferred: true, n: fe && fe.n, of: fe && fe.of, frame: at && at.fcp })
  }
  const last = d.lcp.length - 1
  d.lcp.forEach((c, i) => {
    evs.push({ key: 'lcp' + i, kind: 'lcp', name: i === last ? 'LCP 最终' : `LCP 候选 ${i + 1}`, t: c.t, el: c.el, size: c.size, url: c.url, isLast: i === last, n: c.n, of: c.of, frame: at && at.candidates[i] })
  })
  Object.values(d.detectors).forEach((x) => {
    if (x.hit == null) return
    evs.push({ key: 'det' + x.id, kind: 'det', name: x.label || String(x.value).slice(0, 18), t: isNum(x.presented) ? x.presented : x.hit, el: x.el, req: x.type === 'request', def: x, n: x.n, of: x.of, frame: at && at.detectors[x.id] })
  })
  return evs.sort((a, b) => a.t - b.t)
}

/**
 * 表格里的一个事件 → 参考录屏里对应的事件(用来找画面帧和画框)。
 * 匹配规则:FCP 对 FCP;自定义检测按编号;LCP 先按"同一个元素"找,找不到再看是不是都是"最终 LCP"。
 * 找不到返回 null:参考录屏里没有出现这个元素。
 */
export function matchAnnotated(ev, annEvs) {
  if (!ev || !annEvs || !annEvs.length) return null
  if (ev.kind === 'fcp') return annEvs.find((x) => x.kind === 'fcp') || null
  if (ev.kind === 'det') return annEvs.find((x) => x.key === ev.key) || null
  if (ev.kind === 'lcp') {
    const sel = ev.el && ev.el.selector
    const same = sel ? annEvs.find((x) => x.kind === 'lcp' && x.el && x.el.selector === sel) : null
    if (same) return same
    if (ev.isLast) return annEvs.find((x) => x.isLast) || null
  }
  return null
}

export { describeDetector, precisionOf, EXPLAIN }

/**
 * 汇总需要提醒用户的问题。每一项:
 *   level 'warn' | 'info'      text 标签上的一句话
 *   rows  [[键, 值], ...]       悬浮卡片里的明细(可选)
 *   note  悬浮卡片里的解释(可选)
 *   action  点击后的动作:{type:'round', index} 切换时间线到某一轮 / {type:'scroll', id} 滚动到某个区域
 */
export function buildWarnings(result) {
  const out = []
  const s = result.summary
  const ok = result.rounds.filter((r) => r.ok)
  const failed = result.rounds.filter((r) => !r.ok)
  const nameOf = (d) => d.label || String(d.value).slice(0, 18)

  if (failed.length) {
    out.push({ id: 'failed', level: 'warn', text: `${failed.length} 轮测量失败`, rows: failed.map((f) => [`第 ${f.index} 轮`, f.error]) })
  }

  if (ok.length > 0 && ok.length < 3) {
    out.push({
      id: 'few', level: 'warn', text: `只有 ${ok.length} 轮有效,中位数不可靠`,
      note: '轮数太少时,一次偶发的慢请求就会拉偏中位数。建议至少测 3 轮。',
    })
  }

  // 某一轮明显偏慢(样本 ≥ 3 轮时才判断;偏离中位数 1.5 倍以上且至少多 150 ms)
  if (ok.length >= 3) {
    const per = new Map()
    for (const [k, label] of [['ttfb', 'TTFB'], ['fcp', 'FCP'], ['lcp', 'LCP']]) {
      const m = s.metrics[k]
      if (!isNum(m.median)) continue
      ok.forEach((r) => {
        const v = r.derived.metrics[k]
        if (isNum(v) && v > m.median * 1.5 && v - m.median > 150) {
          const arr = per.get(r.index) || []
          arr.push([label, v, m.median])
          per.set(r.index, arr)
        }
      })
    }
    for (const [idx, arr] of per) {
      const isEx = result.excluded && result.excluded.has(idx)
      out.push({
        id: 'slow' + idx, level: isEx ? 'info' : 'warn', text: `第 ${idx} 轮明显偏慢(${arr.map((a) => a[0]).join('、')})${isEx ? ',已排除' : ''}`,
        rows: arr.map(([l, v, m]) => [l, `${fmtMs(v)}(中位数 ${fmtMs(m)})`]),
        note: isEx ? '这一轮已被你排除,不计入上面的统计。' : '首轮偏慢常见于 DNS、连接或缓存的冷启动。如果你只关心稳定状态,可以在时间线里取消勾选这一轮的“计入统计”。',
        action: { type: 'round', index: idx },
      })
    }
  }

  // 服务端分析:用户勾选了但没拿到数据,必须明说原因;浏览器端的测量不受影响
  if (result.config.serverProbe && ok.length) {
    const svs = ok.map((r) => r.data.server).filter(Boolean)
    const got = svs.filter((x) => x.request).length
    if (!got) {
      const f = svs.find((x) => x.probe && x.probe.state === 'failed')
      const why = f ? f.probe.message : (svs.find((x) => x.unmatched) || {}).unmatched || '没有记录到服务端数据'
      out.push({
        id: 'srv-none', level: 'warn', text: '服务端分析没有拿到数据',
        rows: [['原因', why]],
        note: '浏览器端的测量(TTFB、FCP、LCP 等)不受影响。时间线的“服务端”一组里会写明无法识别的原因。',
        action: { type: 'scroll', id: 'timeline-anchor' },
      })
    } else if (got < ok.length) {
      out.push({ id: 'srv-part', level: 'info', text: `服务端明细只在 ${got} / ${ok.length} 轮里匹配到页面请求`, note: '其余轮次没有找到对应的服务端请求(可能经过另一个进程,或探针中途失效),这些轮次没有服务端数据。' })
    }
  }

  // 最终 LCP 元素被遮挡
  const covered = ok.filter((r) => r.derived.lcpFinal && r.derived.lcpFinal.el && r.derived.lcpFinal.el.covered)
  if (covered.length && covered.length * 2 >= ok.length) {
    const el = covered[0].derived.lcpFinal.el
    out.push({
      id: 'covered', level: 'warn', text: '最终的 LCP 元素被遮挡,用户未必看到',
      rows: [['LCP 元素', el.selector], ['盖住它的元素', el.coveredBy || '其他元素']],
      note: '浏览器仍把它计为 LCP,但用户当时看到的是别的东西。建议用“自定义检测”测你真正关心的节点。',
      action: { type: 'scroll', id: 'shot-anchor' },
    })
  }

  if (s.lcpElements.length > 1) {
    out.push({
      id: 'lcp-unstable', level: 'warn', text: `LCP 元素在各轮间不一致(${s.lcpElements.length} 种)`,
      rows: s.lcpElements.map((t) => [`${t.count} 轮`, t.selector]),
      note: '元素不固定时,不同轮次的 LCP 时间对应的不是同一个东西,不可直接比较。',
    })
  }
  if (s.fcpElements.length > 1) {
    out.push({
      id: 'fcp-unstable', level: 'info', text: `FCP 元素在各轮间不一致(${s.fcpElements.length} 种)`,
      rows: s.fcpElements.map((t) => [`${t.count} 轮`, t.selector]),
    })
  }

  // 自定义检测
  result.config.detectors.forEach((d) => {
    const x = s.detectors[d.id]
    if (!x) return
    if (x.error) {
      out.push({ id: 'det-err' + d.id, level: 'warn', text: `检测“${nameOf(d)}”出错:${x.error}` })
    } else if (x.rounds > 0 && x.hitCount === 0) {
      out.push({
        id: 'det-miss' + d.id, level: 'warn', text: `检测“${nameOf(d)}”没有命中`,
        note: '条件在超时之前始终不成立。请检查选择器 / 关键字是否正确,或适当调大超时。',
      })
    } else if (x.hitCount < x.rounds) {
      out.push({ id: 'det-part' + d.id, level: 'info', text: `检测“${nameOf(d)}”只在 ${x.hitCount}/${x.rounds} 轮命中` })
    }
  })

  // LCP 的时间来自"图片加载完成",而不是真正的渲染时间
  const loadSrc = ok.filter((r) => r.data.lcp.length && r.data.lcp[r.data.lcp.length - 1].src === 'load')
  if (loadSrc.length && loadSrc.length * 2 >= ok.length) {
    out.push({
      id: 'lcp-loadtime', level: 'warn', text: 'LCP 时间可能偏早:拿不到图片的渲染时间',
      note: '最终的 LCP 是一张跨域图片,且服务器没有返回 Timing-Allow-Origin,浏览器只能给出它加载完成的时间,真正绘制到屏幕会更晚。这个页面的 LCP 数值不可当作精确的渲染时间。',
      action: { type: 'scroll', id: 'shot-anchor' },
    })
  }

  // FCP 之前:一部分是脚本执行(长动画帧里记录到的,已识别),剩下的才是无法识别
  const gaps = ok.map((r) => unexplainedGap(r)).filter((g) => g && g.significant)
  const med = (arr) => [...arr].sort((a, b) => a - b)[Math.floor((arr.length - 1) / 2)]
  const unk = gaps.filter((g) => g.remaining > GAP_MS)
  if (unk.length && unk.length * 2 >= ok.length) {
    out.push({
      id: 'gap', level: 'info', text: `FCP 之前有约 ${fmtMs(med(unk.map((g) => g.remaining)))} 无法识别原因`,
      rows: [['范围', `${unk.length} / ${ok.length} 轮超过 ${GAP_MS} ms`], med(unk.map((g) => g.scriptMs)) > 5 ? ['另外已识别为脚本执行', fmtMs(med(unk.map((g) => g.scriptMs)))] : null].filter(Boolean),
      note: UNEXPLAINED_TEXT,
      action: { type: 'scroll', id: 'timeline-anchor' },
    })
  }
  const execs = gaps.filter((g) => g.scriptMs >= 50)
  if (execs.length && execs.length * 2 >= ok.length) {
    const named = execs.map((g) => g.topRun).filter(Boolean)
    const nm = named.length ? String((named[0].src || named[0].invoker || '').split('/').pop().split('?')[0] || '') : ''
    out.push({
      id: 'exec', level: 'info', text: `FCP 之前约 ${fmtMs(med(execs.map((g) => g.scriptMs)))} 花在执行脚本上${nm ? '(最长的是 ' + nm + ')' : ''}`,
      rows: [['范围', `${execs.length} / ${ok.length} 轮`], ...(nm ? [['最长的一次', `${nm} ${fmtMs(med(named.map((r) => r.dur)))}`]] : [])],
      note: '脚本执行占着主线程,这期间浏览器画不出页面。同步脚本还会让后面的 HTML 解析也停下。来源:Chrome 的长动画帧(Long Animation Frames)接口,只记录所在帧长于 50 ms、自身执行不少于 5 ms 的脚本;脚本在页面第一次绘制之前执行时,Chrome 不一定会报告,所以这个数字可能偏小。',
      action: { type: 'scroll', id: 'timeline-anchor' },
    })
  }

  // 发生了跳转
  const first = ok[0]
  if (first && first.data.url) {
    const strip = (u) => String(u).replace(/\/$/, '')
    if (strip(first.data.url) !== strip(result.config.url)) {
      out.push({ id: 'redirect', level: 'info', text: '页面发生了跳转', rows: [['输入', result.config.url], ['最终', first.data.url]] })
    }
  }

  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'warn' ? -1 : 1))
}

function fmtMs(ms) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

/** 超过这个时长的"空白"就必须明说原因无法识别 */
export const GAP_MS = 150

/**
 * FCP 之前,工具能解释的最后一个时刻是:Chrome 标记的渲染阻塞资源的结束时间;
 * 没有这样的资源时,就是 HTML 收完的时刻。从那之后到 FCP 之间还有多久?
 * 返回 null 表示不适用(FCP 在它之前,或缺数据)。
 */
export function unexplainedGap(round) {
  const d = round && round.data
  if (!d || !isNum(d.fcp)) return null
  const lb = round.derived && round.derived.lastBlocker
  const n = d.nav
  let from = null
  let basis = null
  if (lb && isNum(lb.end)) {
    from = lb.end
    basis = 'blocker'
  } else if (n && isNum(n.responseEnd)) {
    from = n.responseEnd
    basis = 'html'
  }
  if (from == null || d.fcp <= from) return null
  // 其中有多少是脚本执行(长动画帧里记录到的),有多少仍然无法识别
  const scriptMs = runCoverage(d.scriptRuns, from, d.fcp)
  const top = (d.scriptRuns || []).filter((r) => r.start < d.fcp && r.start + r.dur > from).sort((a, b) => b.dur - a.dur)[0] || null
  return { gap: d.fcp - from, from, basis, blocker: lb || null, fcp: d.fcp, significant: d.fcp - from > GAP_MS, scriptMs, remaining: d.fcp - from - scriptMs, topRun: top }
}

/** 无法识别的说明:按这一轮有没有脚本执行记录来补充 */
export const unexplainedNote = (loaf) =>
  loaf === true
    ? '已经把长动画帧里记录到的脚本执行扣掉了(棕色的条)。剩下的这段,可能是更短的脚本(自身执行不到 5 ms,或所在的帧不到 50 ms)、还在等待下载的同步脚本、样式计算与布局、字体加载、主线程繁忙等,工具仍然无法识别。注意:如果脚本在页面第一次绘制之前执行,Chrome 不一定会报告它(实测同一个页面 8 次里只有 1 次报告),所以这里面仍可能有没被记录到的脚本执行。'
    : loaf === false
      ? '当前 Chrome 不提供脚本执行记录(需要 Chrome 123 及以上),所以脚本执行也在这段里。'
      : '这条记录是旧版本测量的,没有脚本执行记录;重新测量一次,就能把脚本执行从这里分出来。'
export const UNEXPLAINED_TEXT =
  '工具无法识别这段时间花在哪里。可能是内联脚本或内联样式的执行、样式计算与布局、字体加载、主线程繁忙等,这些都没有被 Chrome 标记,也不是网络请求。'
