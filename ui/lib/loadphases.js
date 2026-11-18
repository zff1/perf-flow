// 解释 DOMContentLoaded 和 load 是被什么决定的。
//
// 规则来自对构造页面的实测(见 README),不是凭规范推断:
//   · 同步脚本(没有 async / defer / module)会让解析器停下来 → 推迟 domInteractive,进而推迟 DCL 和 load
//   · defer / module 脚本不推迟 domInteractive,但 DCL 要等它们执行完
//   · async 脚本不推迟 DCL,但推迟 load
//   · 样式表本身不推迟 DCL,但排在它后面的脚本要等它下载完才能执行
//   · 图片、iframe、字体、CSS 背景图、脚本注入的资源:不推迟 DCL,推迟 load
//   · fetch / XHR / beacon:既不推迟 DCL,也不推迟 load
// 资源下载完成之后的"脚本执行、解析"没有任何网络记录,这一段只能说"无法识别"。
import { isNum } from './format.js'

export const TOL = 5 // 毫秒:不同接口给出的时间之间的容差
export const GAP = 150 // 毫秒:超过它的"无法识别"才值得强调

/** 会拖住 load 事件的请求类型(实测验证过:img / css / link / script / iframe)。video、audio 等未验证。 */
const LOAD_TYPES = new Set(['img', 'image', 'css', 'link', 'script', 'iframe', 'frame', 'embed', 'object'])
const UNVERIFIED_LOAD_TYPES = new Set(['video', 'audio', 'track'])
/** 不会拖住 load 的请求类型 */
const NO_LOAD_TYPES = new Set(['fetch', 'xmlhttprequest', 'beacon', 'ping'])

export const KIND_LABEL = {
  sync: '同步脚本',
  defer: 'defer 脚本',
  async: 'async 脚本',
  script: '脚本',
  sheet: '阻塞样式表',
  img: '图片',
  css: 'CSS 引用',
  link: '样式表',
  iframe: 'iframe',
  other: '其他',
}

const keyOf = (name) => {
  try {
    const u = new URL(name)
    return u.origin + u.pathname
  } catch {
    return name
  }
}
export const baseName = (name) => {
  try {
    const u = new URL(name)
    const p = u.pathname.split('/').filter(Boolean)
    return p[p.length - 1] || u.host
  } catch {
    return String(name).slice(-40)
  }
}

/** 取出各个时间点;老版本的记录没有 dclEnd / loadEnd,且 domContentLoaded / loadEvent 存的是事件结束时刻 */
export function navPoints(n) {
  if (!n) return null
  const exact = isNum(n.dclEnd)
  return {
    responseEnd: n.responseEnd,
    domInteractive: n.domInteractive,
    dclStart: isNum(n.domContentLoaded) ? n.domContentLoaded : null,
    dclEnd: exact ? n.dclEnd : null,
    domComplete: isNum(n.domComplete) ? n.domComplete : null,
    loadStart: isNum(n.loadEvent) ? n.loadEvent : null,
    loadEnd: isNum(n.loadEnd) ? n.loadEnd : null,
    exact,
  }
}

function classifyScripts(data) {
  const byUrl = new Map((data.scripts || []).map((s) => [s.src, s]))
  const out = []
  for (const r of data.resources || []) {
    if (r.type !== 'script') continue
    const s = byUrl.get(r.name)
    let kind = 'async' // 找不到对应标签(标签已被移除,或由 import() 等方式加载):按不拖住解析处理
    let known = false
    if (s) {
      known = true
      kind = s.module ? (s.async ? 'async' : 'defer') : s.async ? 'async' : s.defer ? 'defer' : 'sync'
    }
    out.push({ ...r, kind, known, inHead: s ? s.inHead : null })
  }
  return out
}

/** 在 [from, to] 这段等待里,找到"结束得最晚"的候选,算出它能解释多少、剩下多少无法识别 */
function phase(from, to, candidates) {
  if (!isNum(from) || !isNum(to)) return null
  const dur = to - from
  if (dur <= 0) return { from, to, dur: 0, det: null, explained: 0, unknown: 0, list: [] }
  // 只有在这段等待"之内或之后"才结束、且不晚于终点的,才可能是原因
  const gates = candidates.filter((c) => isNum(c.end) && c.end <= to + TOL).sort((a, b) => b.end - a.end)
  const det = gates.length && gates[0].end > from ? gates[0] : null
  const explained = det ? Math.min(dur, Math.max(0, det.end - from)) : 0
  return { from, to, dur, det, explained, unknown: dur - explained, list: gates.slice(0, 6) }
}

/**
 * @param round 一轮(或合成的汇总轮),需要 data.nav / data.resources / data.scripts
 * @returns null 表示没有导航计时
 */
export function explainDclLoad(round) {
  const d = round && round.data
  const pts = d && navPoints(d.nav)
  if (!pts) return null
  const hasRes = Array.isArray(d.resources)
  const scripts = hasRes ? classifyScripts(d) : []
  const sync = scripts.filter((s) => s.kind === 'sync')
  const defer = scripts.filter((s) => s.kind === 'defer')
  // 阻塞渲染的样式表:本身不推迟 DCL,但会让排在它后面的脚本等待。只在没有脚本能解释时,作为"可能"的原因。
  const sheets = hasRes ? d.resources.filter((r) => r.rb && (r.type === 'link' || r.type === 'css')).map((r) => ({ ...r, kind: 'sheet' })) : []

  const parse = phase(pts.responseEnd, pts.domInteractive, [...sync, ...sheets])
  const deferPhase = phase(pts.domInteractive, pts.dclStart, defer)

  // load:DCL 之后,等"会拖住 load 的请求"
  let loadPhase = null
  let uncertain = []
  if (isNum(pts.loadStart)) {
    const from = isNum(pts.dclStart) ? pts.dclStart : pts.domInteractive
    const cands = []
    if (hasRes) {
      for (const r of d.resources) {
        if (NO_LOAD_TYPES.has(r.type)) continue
        if (r.type === 'script') {
          const sc = scripts.find((x) => x.name === r.name)
          cands.push({ ...r, kind: sc ? sc.kind : 'async' })
        } else if (LOAD_TYPES.has(r.type)) {
          cands.push({ ...r, kind: r.type === 'image' ? 'img' : LOAD_TYPES.has(r.type) ? r.type : 'other' })
        } else if (UNVERIFIED_LOAD_TYPES.has(r.type) || r.type === 'other') {
          // favicon 由浏览器自己发起,不属于页面的子资源,不会拖住 load
          if (/\/favicon\.ico(\?|$)/i.test(r.name)) continue
          if (r.end > from && r.end <= pts.loadStart + TOL) uncertain.push(r)
        }
      }
    }
    loadPhase = phase(from, pts.loadStart, cands)
  }

  const gapSum = (p) => (p ? p.unknown : 0)
  return {
    pts,
    hasResources: hasRes,
    noResources: !hasRes,
    truncated: !!d.resourcesTruncated,
    syncScripts: sync,
    deferScripts: defer,
    sheets,
    parse, // HTML 收完 → domInteractive
    deferPhase, // domInteractive → DCL
    load: loadPhase, // DCL → load
    uncertain,
    unknownTotal: gapSum(parse) + gapSum(deferPhase) + gapSum(loadPhase),
  }
}

/** 汇总用:同一个 URL(去掉查询参数)在不同轮次里合成一条 */
export { keyOf }
