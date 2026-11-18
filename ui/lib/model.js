// 把原始测量数据整理成界面要用的结构:时间线的行、事件列表。
import { EXPLAIN, describeDetector, precisionOf } from './text.js'
import { isNum } from './format.js'
import { explainDclLoad, KIND_LABEL, baseName, GAP } from './loadphases.js'

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
}

/**
 * 时间线按"依赖链"组织。每条链是一棵小树:父行是一个时间点(FCP、LCP、DOMContentLoaded、load),
 * 缩进的子行是决定或推迟它的东西。"请求与服务器"和"你的检测"是平铺的,不是树。
 *   focus  聚焦时,这条链对应的按钮文字
 */
export const CHAINS = [
  { id: 'net', title: '请求与服务器', flat: true },
  { id: 'fcp', focus: 'FCP' },
  { id: 'lcp', focus: 'LCP' },
  { id: 'det', title: '你的检测', flat: true, focus: '我的检测' },
  { id: 'dcl', focus: 'DOMContentLoaded' },
  { id: 'load', focus: 'load' },
]

/**
 * 总览时每条链默认最多展示几条"可收起"的行;超出的收起,点链末尾的按钮展开。
 * 带 pin 的行始终显示(父行、决定者、最终 LCP、无法识别……),不计入条数。
 * 聚焦到某条链时,这条链全部展开。
 */
export const CHAIN_LIMIT = { fcp: 2, lcp: 2, dcl: 2, load: 2 }

/** 时间线上方的一行图例 */
export const LEGEND = '每组按时间从早到晚排列,最后一行是这个时间点本身,它上面缩进的行是推迟它的原因。条 = 请求的下载起止;斜纹 = 无法识别。'

/**
 * 时间线的行。每一行:
 *   chain 所属的链(见 CHAINS);depth 缩进层级,0 是链的父行
 *   focusOnly 只在聚焦到这条链时显示(总览里隐藏,免得啰嗦)
 *   kind  'bar' | 'mark' | 'note'
 *   key   行的唯一标识
 *   label 左侧名称;sub 左侧第二行(元素名等)
 *   start/end(bar)或 t(mark)
 *   tip / data  悬停时用来生成提示内容
 */
export function buildTimelineRows(round, summary, cfg) {
  const d = round.data
  const n = d.nav
  const rows = []
  const add = (chain, depth, r) => rows.push({ ...r, chain, depth })

  // ---- 请求与服务器(平铺) ----
  if (n) {
    const G = (r) => add('net', 0, r)
    if (n.redirectCount && n.redirectEnd > n.redirectStart)
      G({ kind: 'bar', key: 'redirect', label: '重定向', color: COLORS.redirect, start: n.redirectStart, end: n.redirectEnd, tip: 'redirect' })
    if (n.domainLookupEnd - n.domainLookupStart >= 0.5)
      G({ kind: 'bar', key: 'dns', label: 'DNS 查询', color: COLORS.dns, start: n.domainLookupStart, end: n.domainLookupEnd, tip: 'dns' })
    if (n.connectEnd - n.connectStart >= 0.5)
      G({ kind: 'bar', key: 'connect', label: '建立连接(TCP / TLS)', color: COLORS.connect, start: n.connectStart, end: n.connectEnd, tip: 'connect' })
    G({ kind: 'bar', key: 'wait', label: '等待服务器响应', sub: `TTFB ${Math.round(n.responseStart)} ms`, color: COLORS.wait, start: n.requestStart, end: n.responseStart, tip: 'wait', strong: true })
    G({ kind: 'bar', key: 'html', label: '下载 HTML', color: COLORS.html, start: n.responseStart, end: n.responseEnd, tip: 'html' })
  }

  // ---- FCP 链:父行 FCP;子行是 Chrome 标记的渲染阻塞请求、FCP 之前无法识别的空白、FP ----
  {
    const F = (depth, r) => add('fcp', depth, r)
    const fe = round.derived && round.derived.fcpElement
    if (isNum(d.fcp))
      F(0, { kind: 'mark', key: 'fcp', label: 'FCP 首次内容绘制', sub: fe && fe.el ? fe.el.selector : '', color: COLORS.fcp, t: d.fcp, tip: 'fcp', data: fe, link: 'fcp', strong: true, pin: true })
    else F(0, { kind: 'note', key: 'fcp', label: 'FCP 首次内容绘制', color: COLORS.fcp, text: '本轮没有获得', warn: true, pin: true })

    const blocks = d.blocking || []
    if (blocks.length) {
      const lastB = round.derived && round.derived.lastBlocker
      blocks.forEach((b, i) => F(1, { kind: 'bar', key: 'block' + i, label: '', fileUrl: b.name, badge: '阻塞', color: COLORS.block, start: b.start, end: b.end, tip: 'block', data: b, pin: !!(lastB && lastB.name === b.name) }))
    } else {
      F(1, { kind: 'note', key: 'noblock', focusOnly: true, text: d.blockingSupported === false ? '无法识别:当前 Chrome 不提供渲染阻塞信息' : '没有发现被 Chrome 标记为渲染阻塞的网络请求(内联脚本、内联样式、字体、主线程繁忙等不在其内,无法识别)' })
    }
    // 工具能解释的最后一个时刻之后、FCP 之前的空白(内联脚本、样式计算、字体、主线程忙……)
    const fgap = unexplainedGap(round)
    if (fgap && fgap.significant)
      F(1, { kind: 'bar', key: 'unk-fcp', label: '无法识别', sub: fgap.basis === 'blocker' ? '最后一个阻塞请求结束之后' : 'HTML 收完之后', unknown: true, color: '#e8a13a', start: fgap.from, end: fgap.fcp, tip: 'unknown', data: { from: fgap.from, to: fgap.fcp }, pin: true })
    if (isNum(d.fp) && isNum(d.fcp) && Math.abs(d.fp - d.fcp) > 8)
      F(1, { kind: 'mark', key: 'fp', label: 'FP 首次绘制', color: COLORS.fp, t: d.fp, tip: 'fp' })
  }

  // ---- LCP 链:父行是最终 LCP;子行是更早出现的候选 ----
  {
    const lcp = d.lcp || []
    const last = lcp.length ? lcp[lcp.length - 1] : null
    const mk = (c, i, depth) => {
      const isLast = c === last
      const prev = i > 0 ? lcp[i - 1].size : 0
      add('lcp', depth, {
        kind: 'mark', key: 'lcp' + i,
        label: isLast ? 'LCP 最终' : `LCP 候选 ${i + 1}`,
        sub: c.el ? c.el.selector : '(元素已移除)',
        covered: !!(c.el && c.el.covered),
        color: COLORS.lcp, faded: !isLast, t: c.t, tip: 'lcp', data: { c, isLast, prev }, link: isLast ? 'lcp-final' : null, strong: isLast, pin: isLast,
      })
    }
    if (last) {
      mk(last, lcp.length - 1, 0)
      lcp.forEach((c, i) => { if (c !== last) mk(c, i, 1) })
    }
  }

  // ---- 你的检测(平铺) ----
  const defs = cfg.detectors || []
  defs.forEach((def, i) => {
    const x = d.detectors[def.id] || {}
    const t = isNum(x.presented) ? x.presented : x.hit
    add('det', 0, {
      kind: isNum(t) ? 'mark' : 'note', key: 'det' + def.id,
      label: `${def.label || def.value.slice(0, 18)}`, num: i, color: COLORS.det, t,
      text: x.error ? x.error : '本轮未命中', tip: 'det', data: { def, x, sum: summary.detectors[def.id] }, link: 'det' + def.id, pin: true,
    })
  })

  // ---- DOMContentLoaded 链 与 load 链:决定它们的请求作为子行 ----
  if (n) {
    const ex = explainDclLoad(round)

    // 副标题:类型;同步脚本再带上位置和是否阻塞渲染(实测:head 里的会推迟 FCP / LCP,body 里的只推迟它后面的内容)
    const gateSub = (c) => {
      let t = KIND_LABEL[c.kind] || c.kind
      if (c.kind === 'sync') t += c.inHead === true ? ' · head · 阻塞渲染' : c.inHead === false ? ' · body' : ''
      return t
    }
    // 一条"拖住某个时间点的请求"
    const gate = (chain, depth, c, det, phase, remain) =>
      add(chain, depth, {
        kind: 'bar', key: `gate-${phase}-${c.name}`, label: '', fileUrl: c.name,
        badge: det ? '决定者' : null, badgeCls: det ? 'dbadge' : null,
        sub: gateSub(c), color: GATE_COLOR[c.kind] || COLORS.block,
        start: c.start, end: c.end, tip: 'gate', data: { c, det, phase, remain }, pin: det,
      })
    // 无法识别的时间段:画成一条带斜纹的横线,起止就是这段空白的起止
    const unknownBar = (chain, depth, key, from, to, sub) =>
      add(chain, depth, { kind: 'bar', key, label: '无法识别', sub, unknown: true, color: '#e8a13a', start: from, end: to, tip: 'unknown', data: { from, to }, pin: true })

    // DOMContentLoaded 链:DCL ← (defer / module 脚本) 和 HTML 解析完成 ← 同步脚本
    add('dcl', 0, n.domContentLoaded > 0
      ? { kind: 'mark', key: 'dcl', label: 'DOMContentLoaded', color: COLORS.page, t: n.domContentLoaded, tip: 'dcl', pin: true, strong: true }
      : { kind: 'note', key: 'dcl', label: 'DOMContentLoaded', color: COLORS.page, text: '观察期内没有触发', warn: true, pin: true })
    const hasDom = n.domInteractive > 0
    if (hasDom) add('dcl', 1, { kind: 'mark', key: 'dom', label: 'HTML 解析完成', sub: 'domInteractive', color: COLORS.page, t: n.domInteractive, tip: 'dom', pin: true })
    const pd = hasDom ? 2 : 1 // 同步脚本是"HTML 解析完成"的子项
    if (ex && ex.noResources) {
      add('dcl', 1, { kind: 'note', key: 'noRes', warn: true, pin: true, text: '这条记录是旧版本测量的,没有每个请求的明细,无法归因。重新测量一次即可。' })
    } else if (ex) {
      // 样式表只有在它就是决定者时才列出(它已经在 FCP 链的"渲染阻塞资源"里出现过,不重复)
      const keepGate = (p, c) => c.kind !== 'sheet' || (p.det === c)
      if (ex.parse) ex.parse.list.filter((c) => keepGate(ex.parse, c)).forEach((c) => gate('dcl', pd, c, ex.parse.det === c, 'parse', ex.parse.unknown))
      if (ex.parse && ex.parse.dur > GAP && ex.parse.unknown > GAP)
        unknownBar('dcl', pd, 'unk-parse', ex.parse.to - ex.parse.unknown, ex.parse.to, ex.parse.det ? '决定者下载完之后' : 'HTML 收完之后')
      if (!ex.noResources && ex.deferPhase) {
        ex.deferPhase.list.forEach((c) => gate('dcl', 1, c, ex.deferPhase.det === c, 'defer', ex.deferPhase.unknown))
        if (ex.deferPhase.dur > GAP && ex.deferPhase.unknown > GAP)
          unknownBar('dcl', 1, 'unk-defer', ex.deferPhase.to - ex.deferPhase.unknown, ex.deferPhase.to, ex.deferPhase.det ? '决定者下载完之后' : '解析完成之后')
      }
    }

    // load 链:load ← 拖住它的请求
    const fired = n.loadEvent > 0
    const partial = isNum(d.loadFired) && round.count && d.loadFired < round.count // 汇总时,只有一部分轮次触发了 load
    add('load', 0, fired
      ? { kind: 'mark', key: 'load', label: 'load 事件', color: COLORS.page, t: n.loadEvent, tip: 'load', pin: true, strong: true }
      : { kind: 'note', key: 'load', label: 'load 事件', color: COLORS.page, text: '观察期内没有触发', warn: true, pin: true })
    if (ex && !ex.noResources && ex.load) {
      ex.load.list.forEach((c) => gate('load', 1, c, ex.load.det === c, 'load', ex.load.unknown))
      if (ex.load.dur > GAP && ex.load.unknown > GAP)
        unknownBar('load', 1, 'unk-load', ex.load.to - ex.load.unknown, ex.load.to, ex.load.det ? '决定者下载完之后' : 'DCL 之后')
      if (ex.uncertain.length)
        add('load', 1, { kind: 'note', key: 'uncertain', warn: true, pin: true, text: `另有 ${ex.uncertain.length} 个类型未经验证的请求(video / audio / other)在这段时间内完成,工具无法确认它们是否拖住 load:${ex.uncertain.slice(0, 2).map((r) => baseName(r.name)).join('、')}${ex.uncertain.length > 2 ? ' 等' : ''}` })
    }
    // 汇总时,只有一部分轮次触发了 load:一条说明讲清楚,并在有仍未完成的请求时一并提示
    if (fired && partial) {
      const pn = (d.pendingRequests || []).length
      add('load', 1, { kind: 'note', key: 'loadPartial', warn: true, pin: true, text: `只有 ${d.loadFired} / ${round.count} 轮触发了 load 事件,上面的时间只来自这 ${d.loadFired} 轮;其余 ${round.count - d.loadFired} 轮在观察期内没有触发。${pn ? `没触发的那些轮里,观察结束时仍未完成的请求(${pn} 个)见下:` : ''}` })
    }
    // load 没触发(整轮没触发,或汇总里有轮次没触发):说明原因,并列出观察结束时仍未完成的请求
    if (d.loadTimedOut) {
      const pend = d.pendingRequests || []
      if (!fired)
        add('load', 1, {
          kind: 'note', key: 'noLoad', warn: true, pin: true,
          text: `load 事件在观察期内没有触发。通常是页面一直有会拖住它的请求在途(图片、脚本、iframe 等),或某个请求一直没结束。fetch / XHR 不会拖住 load。${pend.length ? `下面是观察结束时仍未完成的 ${pend.length} 个请求(条的右端是观察结束的时刻)。` : '没有发现仍未完成的请求。'}`,
        })
      pend.slice(0, 8).forEach((r, i) =>
        add('load', 1, {
          kind: 'bar', key: 'pend' + i, label: '', fileUrl: r.name, badge: '未完成', badgeCls: 'dbadge',
          sub: (r.type === 'image' ? '图片' : r.type === 'script' ? '脚本' : r.type === 'stylesheet' ? '样式表' : r.type) + ' · 仍在进行', pending: true,
          color: '#8a93a3', start: r.start, end: r.end, tip: 'pending', data: r, pin: i === 0,
        })
      )
    }
  }
  return rows
}

const timeOf = (r) => (r.kind === 'bar' ? r.end : r.kind === 'mark' ? r.t : null)

/**
 * 把一条链按时间排好。buildTimelineRows 里的行是"父行在前、子行紧随其后"(用 depth 表示层级);
 * 这里改成按时间从早到晚:同一父行下的子项按完成时间排序(最晚完成的,也就是决定者,最靠近父行),
 * 子项在上,父行在它们之后。没有时间的说明行排在同级最前面(它们是在解释下面的内容)。
 */
function orderChain(list) {
  const nodes = list.map((row, i) => ({ row, i, kids: [] }))
  const stack = []
  const roots = []
  for (const nd of nodes) {
    while (stack.length && stack[stack.length - 1].row.depth >= nd.row.depth) stack.pop()
    if (stack.length) stack[stack.length - 1].kids.push(nd)
    else roots.push(nd)
    stack.push(nd)
  }
  const key = (nd) => {
    const t = timeOf(nd.row)
    return isNum(t) ? t : -Infinity
  }
  const out = []
  const walk = (nd) => {
    nd.kids.sort((a, b) => key(a) - key(b) || a.i - b.i) // 两个都是 -Infinity 时结果是 NaN,按原来的先后
    nd.kids.forEach(walk)
    out.push(nd.row)
  }
  roots.forEach(walk)
  return out
}

/**
 * 把行排成"链":决定每条链显示哪些行、树形连线怎么画,以及时间轴用哪些行来定范围。
 *   focus     'all'(总览)或某条链的 id;该链不存在时按总览处理
 *   expanded  总览里已展开的链(Set)
 * 返回 { focus, available, chains, axisRows }:
 *   available 有数据的、可聚焦的链
 *   chains    [{ id, title, flat, items }];item 是 { row, depth, tree } 或 { more, hidden, open, depth, tree }
 *             tree 是这一行前面要画的格子:'v' 竖线,'e' 空白,'f' ┌,'t' ├,'p' 接到自己的子项
 *             (子项在上、父行在下,竖线从第一个子项向下一直连到父行)
 */
export function layoutTimeline(rows, focus, expanded) {
  const present = new Set(rows.map((r) => r.chain))
  const available = CHAINS.filter((c) => c.focus && present.has(c.id))
  const f = available.some((c) => c.id === focus) ? focus : 'all'
  const chains = []
  const axisRows = []

  for (const meta of CHAINS) {
    if (!present.has(meta.id)) continue
    if (f !== 'all' && meta.id !== 'net' && meta.id !== f) continue
    // 总览隐藏"只在聚焦时显示"的行
    const raw = rows.filter((r) => r.chain === meta.id && (f !== 'all' || !r.focusOnly))
    if (!raw.length) continue
    // 平铺的链(你的检测)按时间排,没命中的放最后;树形的链排成"子项在上、父行在下"
    const list = meta.flat
      ? meta.id === 'det'
        ? [...raw].sort((a, b) => (isNum(timeOf(a)) ? timeOf(a) : Infinity) - (isNum(timeOf(b)) ? timeOf(b) : Infinity))
        : raw
      : orderChain(raw)

    // 总览下,超出条数的"可收起"行被收起:保留离父行最近(完成得最晚)的几条,更早的收起
    const limit = f === 'all' ? CHAIN_LIMIT[meta.id] : null
    const hiddenKeys = new Set()
    if (limit != null) {
      let shown = 0
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i]
        if (r.pin || r.kind === 'note') continue
        if (shown < limit) shown++
        else hiddenKeys.add(r.key)
      }
    }
    const open = expanded.has(meta.id)
    const vis = list.filter((r) => open || !hiddenKeys.has(r.key))

    // 时间轴的范围:总览用没被聚焦隐藏的全部行(展开收起时坐标轴不跳);聚焦时只用看得见的行
    axisRows.push(...(f === 'all' ? list : vis))

    const items = vis.map((row) => ({ row, depth: row.depth }))
    // 被收起的是更早的那些,所以"展开"按钮放在最上面
    if (hiddenKeys.size) items.unshift({ more: true, hidden: hiddenKeys.size, open, depth: 1, chain: meta.id })

    // 树形连线
    if (!meta.flat) {
      const D = items.map((it) => it.depth)
      const isFirst = (i) => {
        for (let j = i - 1; j >= 0; j--) {
          if (D[j] === D[i]) return false
          if (D[j] < D[i]) return true
        }
        return true
      }
      items.forEach((it, i) => {
        const tree = []
        for (let k = 1; k < it.depth; k++) {
          let a = i + 1
          while (a < items.length && D[a] > k) a++
          tree.push(a < items.length && !isFirst(a) ? 'v' : 'e')
        }
        if (it.depth >= 1) tree.push(isFirst(i) ? 'f' : 't')
        if (i > 0 && D[i - 1] > D[i]) tree.push('p') // 紧挨在上面的是它的子项
        it.tree = tree
      })
    } else {
      items.forEach((it) => { it.tree = [] })
    }
    chains.push({ id: meta.id, title: meta.title, flat: !!meta.flat, items })
  }
  return { focus: f, available, chains, axisRows }
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

  // FCP 之前有无法识别的时间段
  const gaps = ok.map((r) => unexplainedGap(r)).filter((g) => g && g.significant)
  if (gaps.length && gaps.length * 2 >= ok.length) {
    const med = [...gaps.map((g) => g.gap)].sort((a, b) => a - b)[Math.floor((gaps.length - 1) / 2)]
    out.push({
      id: 'gap', level: 'info', text: `FCP 之前有约 ${fmtMs(med)} 无法识别原因`,
      rows: [['范围', `${gaps.length} / ${ok.length} 轮超过 ${GAP_MS} ms`]],
      note: UNEXPLAINED_TEXT,
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
  return { gap: d.fcp - from, from, basis, blocker: lb || null, fcp: d.fcp, significant: d.fcp - from > GAP_MS }
}

export const UNEXPLAINED_TEXT =
  '工具无法识别这段时间花在哪里。可能是内联脚本或内联样式的执行、样式计算与布局、字体加载、主线程繁忙等,这些都没有被 Chrome 标记,也不是网络请求。'
