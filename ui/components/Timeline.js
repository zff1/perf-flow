import { html, useState, useRef, useMemo } from '../lib/h.js'
import { fmt, isNum, CIRCLED, lastSel, fileName, fmtInt } from '../lib/format.js'
import { EXPLAIN, describeDetector, precisionOf } from '../lib/text.js'
import { buildTimelineRows, layoutTimeline, timelineMax, niceStep, COLORS, UNEXPLAINED_TEXT, unexplainedNote, RUN_TYPE, legendFor, FOCUS_HINT, SRV_GAP } from '../lib/model.js'
import { tip, TipCard, TipRows, TipText, RoundBars } from './Tooltip.js'
import { explainDclLoad, KIND_LABEL, baseName } from '../lib/loadphases.js'

const INIT_LABEL = { link: '样式表', script: '脚本', css: '样式', img: '图片', fetch: 'fetch', xmlhttprequest: 'XHR' }
const METRIC_OF = { redirect: 'redirect', dns: 'dns', connect: 'connect', wait: 'serverWait', html: 'htmlDownload' }

/**
 * "等待服务器响应"悬浮卡片里追加的服务端信息,并把这段时间拆开对账:
 *   等待 = 调用实际占用的时间(并行的只算一次) + 服务端自己 / 无法识别 + 网络往返
 */
function srvRows({ q, probe }, aggregate) {
  const winStart = q.offset
  const winEnd = q.offset + q.firstByteAt
  const iv = q.spans.filter((sp) => isNum(sp.start) && isNum(sp.end)).map((sp) => [Math.max(sp.start, winStart), Math.min(sp.end, winEnd)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
  let covered = 0
  let cur = null
  for (const [a, b] of iv) {
    if (!cur || a > cur[1]) {
      if (cur) covered += cur[1] - cur[0]
      cur = [a, b]
    } else cur[1] = Math.max(cur[1], b)
  }
  if (cur) covered += cur[1] - cur[0]
  const sum = q.spans.reduce((m, sp) => (isNum(sp.start) && isNum(sp.end) ? m + (sp.end - sp.start) : m), 0)
  const rest = Math.max(0, q.firstByteAt - covered)
  return [
    ['上游调用实际占用', fmt(covered) + (sum - covered > 5 ? `(各调用时长直接相加是 ${fmt(sum)},并行的部分重叠了)` : '')],
    ['服务端自己 / 无法识别', fmt(rest)],
    isNum(q.slack) ? ['网络往返(估算)', fmt(Math.max(0, q.slack))] : null,
    isNum(q.total) && q.total - q.firstByteAt > 5 ? ['响应写完', `${fmt(q.total)}(第一个字节之后还在继续写出)`] : null,
    q.status ? ['HTTP 状态', String(q.status)] : null,
    isNum(q.n) && isNum(q.of) ? ['匹配到页面请求', `${q.n} / ${q.of} 轮`] : null,
    probe && probe.pid ? ['被测进程', `pid ${probe.pid} · ${probe.node || ''}`] : null,
  ]
}

/** 同一个资源在好几个时间点的路径里都有角色时,悬浮卡片里把另外几个角色列出来 */
const alsoNode = (row) =>
  row.also && row.also.length
    ? html`<${TipText}><b>它同时是:</b>${row.also.map((a) => html`<div>· ${a}</div>`)}<//>`
    : null

/** 生成某一行的悬浮提示内容 */
function rowTip(row, ctx) {
  const { round, summary } = ctx
  const d = round.data
  const link = row.link ? html`<${TipText}><span class="hint2">点击跳转到下方对应的画面和元素</span><//>` : null

  if (row.kind === 'bar' && METRIC_OF[row.tip]) {
    const dur = row.end - row.start
    const m = summary.metrics[METRIC_OF[row.tip]]
    return html`<${TipCard} title=${row.label} color=${row.color} sub=${fmt(dur)}>
      <${TipRows} rows=${[
        ['起止', `${fmt(row.start)} → ${fmt(row.end)}`],
        row.tip === 'wait' ? ['TTFB(首字节)', fmt(row.end)] : null,
        ...(row.tip === 'wait' && row.data && row.data.q ? srvRows(row.data, !!round.aggregate) : []),
      ]} />
      <${TipText}>${EXPLAIN[row.tip]}<//>
      ${row.tip === 'wait' && row.data && row.data.q
        ? html`<${TipText}>${round.aggregate
            ? html`<span class="cov">⚠ 这是汇总:每一项都是各轮分别取的${ctx.stat === 'mean' ? '平均值' : '中位数'},中位数不能相加,所以这几项加起来可能和等待时间有出入。要核对“加起来是否等于”,请选某一轮(单轮里:上游调用实际占用 + 服务端自己 / 无法识别 + 网络往返 = 等待时间)。</span>`
            : html`<span class="hint2">这一轮里:上游调用实际占用 + 服务端自己 / 无法识别 + 网络往返 = 等待时间。</span>`}<//>
          <${TipText}><span class="hint2">服务端记录来自注入在服务进程里的探针。对齐是估算:服务端和浏览器的时钟不是同一个,假设网络的去程和回程各占一半,本机访问时误差通常在几毫秒内。</span><//>`
        : null}
      ${m && m.values.length > 1 ? html`<${RoundBars} values=${m.values} median=${m.median} />` : null}
    <//>`
  }
  if (row.tip === 'block') {
    const b = row.data
    const late = isNum(d.fcp) ? d.fcp - b.end : null
    return html`<${TipCard} title=${fileName(b.name)} color=${row.color} sub="阻塞渲染">
      <${TipRows} rows=${[
        ['地址', b.name, true],
        ['类型', INIT_LABEL[b.type] || b.type],
        ['起止', `${fmt(b.start)} → ${fmt(b.end)}`],
        ['耗时', fmt(b.end - b.start)],
        isNum(late) && late >= 0 ? ['FCP 比它晚', fmt(late)] : null,
      ]} />
      <${TipText}>${EXPLAIN.block}<//>
      ${alsoNode(row)}
      <${TipText}><span class="hint2">来源:Chrome 在 Resource Timing 里给这个请求打的“渲染阻塞”标记。</span><//>
    <//>`
  }
  if (row.tip === 'fp') {
    return html`<${TipCard} title="FP 首次绘制" color=${row.color} sub=${fmt(row.t)}><${TipText}>${EXPLAIN.fp}<//><//>`
  }
  if (row.tip === 'fcp') {
    const fe = row.data
    const m = summary.metrics.fcp
    return html`<${TipCard} title="FCP 首次内容绘制" color=${row.color} sub=${fmt(row.t)}>
      ${fe && fe.el ? html`<${TipRows} rows=${[['元素(推断)', fe.el.selector, true], ['文字', fe.el.text], ['面积', isNum(fe.size) ? fmtInt(fe.size) + ' px²' : '']]} />` : null}
      <${TipText}>${EXPLAIN.fcp}<//>
      ${m.values.length > 1 ? html`<${RoundBars} values=${m.values} median=${m.median} />` : null}
      ${link}
    <//>`
  }
  if (row.tip === 'lcp') {
    const { c, isLast, prev } = row.data
    const m = summary.metrics.lcp
    return html`<${TipCard} title=${row.label} color=${row.color} sub=${fmt(row.t)}>
      <${TipRows} rows=${[
        isNum(c.n) && isNum(c.of) ? ['出现在', `${c.n} / ${c.of} 轮`] : null,
        ['元素', c.el ? c.el.selector : '(出现时元素已被移除)', true],
        ['文字', c.el && c.el.text],
        ['面积', fmtInt(c.size) + ' px²'],
        prev > 0 ? ['相比上一候选', `大 ${(c.size / prev).toFixed(1)} 倍`] : null,
        ['图片地址', c.url, true],
        c.src === 'load' ? ['时间来源', '图片加载完成的时间(不是渲染时间)'] : c.src === 'render' ? ['时间来源', '渲染时间'] : null,
      ]} />
      ${c.src === 'load' ? html`<${TipText}><span class="cov">⚠ 浏览器拿不到这张图片的渲染时间(跨域资源没有 Timing-Allow-Origin),这里的时间是它加载完成的时间,可能早于真正绘制到屏幕。</span><//>` : null}
      ${c.el && c.el.covered ? html`<${TipText}><span class="cov">⚠ 这个元素当时被 <b class="mono">${c.el.coveredBy || '其他元素'}</b> 盖住,用户看不到它,但浏览器仍把它计为 LCP。</span><//>` : null}
      <${TipText}>${isLast ? '这是最终的 LCP:此后没有更大的元素出现。' : '这只是候选:之后出现了更大的元素,它会取代这一个。'}<//>
      ${isLast && m.values.length > 1 ? html`<${RoundBars} values=${m.values} median=${m.median} />` : null}
      ${link}
    <//>`
  }
  if (row.tip === 'det') {
    const { def, x, sum } = row.data
    return html`<${TipCard} title=${(def.label || '自定义检测')} color=${row.color} sub=${isNum(row.t) ? fmt(row.t) : '未命中'}>
      <${TipRows} rows=${[
        ['条件', describeDetector(def)],
        ['命中', sum ? `${sum.hitCount} / ${sum.rounds} 轮` : ''],
        ['精度', precisionOf(def)],
        x && x.el && x.el.selector ? ['元素', x.el.selector, true] : null,
        x && x.error ? ['错误', x.error] : null,
      ]} />
      ${sum && sum.values.length > 1 ? html`<${RoundBars} values=${sum.values} median=${sum.median} />` : null}
      ${link}
    <//>`
  }
  if (row.tip === 'gate') {
    const { c, det, phase, remain } = row.data
    const what = phase === 'parse' ? 'HTML 解析完成(domInteractive)' : phase === 'defer' ? 'DOMContentLoaded' : 'load'
    const why =
      c.kind === 'sync'
        ? (c.inHead === true
            ? '同步脚本,位于 <head>:解析器要等它下载并执行完才继续,而且浏览器在它完成之前不会绘制页面,所以它既推迟 HTML 解析完成 / DOMContentLoaded / load,也推迟 FCP 和 LCP(实测)。'
            : '同步脚本,位于 <body>:解析器要等它下载并执行完才继续,所以它推迟 HTML 解析完成 / DOMContentLoaded / load。它前面已经解析出来的内容可以先画出来(FCP 不受影响),但它后面的内容要等它结束才会出现,可能推迟 LCP(实测)。如果它在执行时占住主线程,连它前面的内容也画不出来。')
      : c.kind === 'defer' ? 'defer / module 脚本:在 HTML 解析完成之后执行,DOMContentLoaded 要等它执行完。'
      : c.kind === 'sheet' ? '阻塞样式表:样式表本身不推迟 DOMContentLoaded,但排在它后面的脚本要等它下载完才能执行。这里是“可能”的原因,从数据里看不出脚本是否真的排在它后面。'
      : c.kind === 'async' || c.kind === 'script' ? 'async 脚本:不推迟 DOMContentLoaded,但会拖住 load。'
      : '这类请求不推迟 DOMContentLoaded,但会拖住 load 事件。'
    return html`<${TipCard} title=${baseName(c.name)} color=${row.color} sub=${KIND_LABEL[c.kind] || c.kind}>
      <${TipRows} rows=${[
        ['地址', c.name, true],
        ['下载', `${fmt(c.start)} → ${fmt(c.end)}(耗时 ${fmt(c.end - c.start)})`],
        isNum(c.n) ? ['出现在', `${c.n} 轮`] : null,
        c.size ? ['传输大小', `${(c.size / 1024).toFixed(1)} KB`] : null,
        det ? ['作用', `这是影响 ${what} 的请求里结束得最晚的一个(决定者)`] : null,
      ]} />
      ${det && remain > 150 ? html`<${TipText}><span class="cov">⚠ 它下载完之后还有 ${fmt(remain)} 无法识别原因(脚本执行、解析等,没有记录)。</span><//>` : null}
      <${TipText}>${why}<//>
      ${alsoNode(row)}
    <//>`
  }
  if (row.tip === 'unknown') {
    const { from, to, loaf } = row.data
    return html`<${TipCard} title="无法识别" color=${row.color} sub=${fmt(to - from)}>
      <${TipRows} rows=${[['起止', `${fmt(from)} → ${fmt(to)}`]]} />
      <${TipText}>${UNEXPLAINED_TEXT}<//>
      <${TipText}><span class="hint2">${unexplainedNote(loaf)}</span><//>
    <//>`
  }
  if (row.tip === 'scriptrun') {
    const { run, clipped } = row.data
    const name = run.src ? fileName(run.src) : run.invoker || '脚本'
    const pg = round.data.url
    const inline = run.src && pg && run.src.split(/[?#]/)[0] === pg.split(/[?#]/)[0]
    const fcp = round.data.fcp
    return html`<${TipCard} title=${inline ? '页面内联脚本' : name} color=${row.color} sub=${fmt(run.dur)}>
      <${TipRows} rows=${[
        run.src ? ['来源', run.src, true] : null,
        ['类型', RUN_TYPE[run.type] || run.type],
        run.invoker ? ['触发者', run.invoker, true] : null,
        run.fn ? ['函数', run.fn, true] : null,
        ['执行', `${fmt(run.start)} → ${fmt(run.start + run.dur)}(耗时 ${fmt(run.dur)})`],
        run.forced > 1 ? ['其中强制样式 / 布局', fmt(run.forced)] : null,
        isNum(run.n) ? ['出现在', `${run.n} 轮`] : null,
        isNum(fcp) && run.start < fcp ? ['FCP 比它执行完晚', fmt(fcp - (run.start + run.dur))] : null,
      ]} />
      ${clipped ? html`<${TipText}><span class="hint2">图上只画出了落在这段空白里的部分。</span><//>` : null}
      <${TipText}>脚本执行时占着主线程,这期间浏览器画不出页面;同步脚本还会让后面的 HTML 解析也停下。它在 Resource Timing 里没有记录,下载完成之后的这一段以前只能标成“无法识别”。<//>
      <${TipText}><span class="hint2">来源:Chrome 的长动画帧(Long Animation Frames)接口,只记录所在帧长于 50 ms、自身执行不少于 5 ms 的脚本,更短的看不到。脚本在页面第一次绘制之前执行时,Chrome 不一定会报告(实测有时整个漏掉),所以没有这条记录并不代表没有执行。</span><//>
    <//>`
  }
  if (row.tip === 'lcpimg') {
    const { res, c } = row.data
    return html`<${TipCard} title=${fileName(res.name)} color=${row.color} sub=${fmt(res.end - res.start)}>
      <${TipRows} rows=${[
        ['地址', res.name, true],
        ['下载', `${fmt(res.start)} → ${fmt(res.end)}`],
        res.size ? ['传输大小', `${(res.size / 1024).toFixed(1)} KB`] : null,
        ['LCP 时间', fmt(c.t)],
        isNum(c.t) ? ['下载完成之后又过了', fmt(c.t - res.end)] : null,
      ]} />
      <${TipText}>最终的 LCP 元素就是这张图片,它下载完成之前不可能被绘制出来,所以这个请求直接决定了 LCP。<//>
      <${TipText}><span class="hint2">下载完成到真正绘制之间(解码、布局,以及它之前被什么挡住),没有任何记录,界面里会单独标成“无法识别”。</span><//>
      ${alsoNode(row)}
    <//>`
  }
  if (row.tip === 'srvcall') {
    const { sp, det, chain, winEnd } = row.data
    const after = winEnd - sp.end
    return html`<${TipCard} title=${`${sp.method} ${sp.target.slice(sp.target.indexOf('/'))}`} color=${row.color} sub=${fmt(sp.end - sp.start)}>
      <${TipRows} rows=${[
        ['目标', sp.target, true],
        ['方式', sp.via === 'fetch' ? '原生 fetch' : 'http / https 模块'],
        ['起止', `${fmt(sp.start)} → ${fmt(sp.end)}`],
        sp.status ? ['状态', String(sp.status)] : null,
        sp.error ? ['错误', sp.error] : null,
        sp.open ? ['说明', '服务端写出响应时这个调用还没结束'] : null,
        isNum(sp.n) ? ['出现在', `${sp.n} 轮`] : null,
        det ? ['作用', '这是响应写出之前最后完成的上游调用(决定者)'] : chain ? ['作用', '它先完成,下一个调用才发出(串行),所以也在关键路径上'] : null,
      ]} />
      ${det && after > SRV_GAP ? html`<${TipText}><span class="cov">⚠ 它结束之后又过了 ${fmt(after)} 才写出第一个字节,这段时间探针无法识别(服务端自己的处理、数据库等)。</span><//>` : null}
      <${TipText}>服务端在处理这次页面请求时发出的出站调用。几个调用的时间重叠,说明是并行;首尾相接,说明是串行。<//>
    <//>`
  }
  if (row.tip === 'srvunk') {
    const { from, to, where } = row.data
    return html`<${TipCard} title="无法识别" color=${row.color} sub=${fmt(to - from)}>
      <${TipRows} rows=${[['位置', where], ['起止', `${fmt(from)} → ${fmt(to)}`]]} />
      <${TipText}>这段时间里服务端没有发出任何 http / https / fetch 调用,探针看不到它在做什么。可能是服务端自己的同步计算(渲染、序列化)、数据库或 Redis 等探针不覆盖的调用,也可能是事件循环被其他请求占着。<//>
      <${TipText}><span class="hint2">要进一步确定,需要对服务进程做 CPU 采样,目前没有。</span><//>
    <//>`
  }
  if (row.tip === 'srvtiming') {
    const t = row.data
    return html`<${TipCard} title=${t.name} color=${row.color} sub=${fmt(t.dur)}>
      <${TipRows} rows=${[['说明', t.desc], isNum(t.n) ? ['出现在', `${t.n} 轮`] : null]} />
      <${TipText}>服务端通过 Server-Timing 响应头自己上报的阶段耗时。这个头只有名称和时长,没有起止时刻,所以不能画在时间轴上。<//>
    <//>`
  }
  if (row.tip === 'pending') {
    const r = row.data
    return html`<${TipCard} title=${fileName(r.name)} color=${row.color} sub="观察结束时仍未完成">
      <${TipRows} rows=${[['地址', r.name, true], ['类型', r.type], ['发出于', fmt(r.start)], ['已等待', fmt(r.end - r.start)]]} />
      <${TipText}>观察结束时这个请求还没有完成。如果它是图片、脚本或 iframe,它会让 load 事件一直无法触发。fetch / XHR 不会拖住 load。<//>
    <//>`
  }
  const ex = ctx.ex
  const detLine = (p) => (p && p.det ? [`${KIND_LABEL[p.det.kind] || p.det.kind} ${baseName(p.det.name)}(完成于 ${fmt(p.det.end)})`] : null)
  const unk = (p) => (p && p.unknown > 150 ? html`<${TipText}><span class="cov">⚠ ${p.det ? '它之后' : '这段时间里'}还有 ${fmt(p.unknown)} 无法识别原因(脚本执行、解析等,没有记录)。</span><//>` : null)
  if (row.tip === 'dom') {
    return html`<${TipCard} title="HTML 解析完成(domInteractive)" color=${row.color} sub=${fmt(row.t)}>
      <${TipRows} rows=${[['HTML 收完', fmt(ex && ex.pts.responseEnd)], ex && ex.parse && ex.parse.dur > 20 ? ['之后又等了', fmt(ex.parse.dur)] : null, ex && ex.parse && ex.parse.det ? ['最晚完成的是', detLine(ex.parse)[0]] : null]} />
      ${unk(ex && ex.parse)}
      <${TipText}>解析器读完了整份 HTML。同步脚本会让解析器停下来等它下载并执行,所以它们会推迟这个时刻。<//>
      <${TipText}><span class="hint2">详见下方“DOMContentLoaded 与 load 由什么决定”。</span><//>
    <//>`
  }
  if (row.tip === 'dcl') {
    return html`<${TipCard} title="DOMContentLoaded" color=${row.color} sub=${fmt(row.t)}>
      <${TipRows} rows=${[
        ['HTML 解析完成', fmt(ex && ex.pts.domInteractive)],
        ex && ex.deferPhase && ex.deferPhase.dur > 20 ? ['解析完成后又等了', fmt(ex.deferPhase.dur)] : null,
        ex && ex.deferPhase && ex.deferPhase.det ? ['最晚完成的是', detLine(ex.deferPhase)[0]] : null,
        ex && ex.pts.exact ? ['事件处理函数', fmt(ex.pts.dclEnd - ex.pts.dclStart)] : null,
      ]} />
      ${unk(ex && ex.deferPhase)}
      <${TipText}>${EXPLAIN.dcl}<//>
      <${TipText}><span class="hint2">详见下方“DOMContentLoaded 与 load 由什么决定”。</span><//>
    <//>`
  }
  if (row.tip === 'load') {
    const ld = ex && ex.load
    return html`<${TipCard} title="load 事件" color=${row.color} sub=${fmt(row.t)}>
      <${TipRows} rows=${[
        ['DCL', fmt(ex && ex.pts.dclStart)],
        ld && ld.dur > 20 ? ['DCL 之后又等了', fmt(ld.dur)] : null,
        ld && ld.det ? ['最晚完成的是', detLine(ld)[0]] : null,
      ]} />
      ${unk(ld)}
      <${TipText}>${EXPLAIN.load}<//>
      <${TipText}><span class="hint2">详见下方“DOMContentLoaded 与 load 由什么决定”。</span><//>
    <//>`
  }
  return null
}

export function Timeline({ result, round, onPick, scope, stat }) {
  const [focusSel, setFocus] = useState('all') // 聚焦到哪个时间点
  const overlayRef = useRef(null)
  const crossRef = useRef(null) // 十字线
  const bubbleRef = useRef(null) // 轴上的时间气泡

  const rows = useMemo(() => (round ? buildTimelineRows(round, result.summary, result.config) : []), [round, result])
  if (!round) return null
  const d = round.data
  const n = d.nav
  const layout = layoutTimeline(rows, focusSel)
  const focus = layout.focus
  const T = timelineMax(layout.axisRows)
  const pct = (t) => `${Math.min(100, Math.max(0, (t / T) * 100))}%`
  const step = niceStep(T)
  const ticks = []
  for (let t = 0; t <= T; t += step) ticks.push(t)

  // 鼠标在图上移动:只更新十字线和时间气泡(直接改 DOM,不重渲染整张时间线,也不去高亮任何行)
  const showCross = (frac) => {
    const c = crossRef.current
    const b = bubbleRef.current
    if (!c || !b) return
    if (frac == null) {
      c.classList.remove('on')
      b.classList.remove('on')
      return
    }
    c.style.left = b.style.left = `${frac * 100}%`
    b.textContent = fmt(frac * T)
    c.classList.add('on')
    b.classList.add('on')
  }
  const onMove = (e) => {
    const el = overlayRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left
    showCross(x >= 0 && x <= r.width ? x / r.width : null)
  }

  // 首字节 → FCP 区域
  const band = n && isNum(d.fcp) && d.fcp > n.responseStart ? { a: n.responseStart, b: d.fcp } : null
  const bandWide = band && ((band.b - band.a) / T) * 100 > 14

  // 解读文字(用这一轮自己的数据,与图一致)
  const gap = n && isNum(d.fcp) ? d.fcp - n.responseEnd : null
  const lb = round.derived.lastBlocker
  const hasBlockers = (d.blocking || []).length > 0
  const blockerLine = lb
    ? html`<div>FCP 之前最后完成的、被 Chrome 标记为渲染阻塞的请求:<span class="mono">${fileName(lb.name)}</span>(${fmt(lb.start)} → ${fmt(lb.end)},耗时 ${fmt(lb.end - lb.start)}),FCP 比它晚 ${fmt(d.fcp - lb.end)}。</div>`
    : hasBlockers
      ? html`<div>有被 Chrome 标记为渲染阻塞的请求,但它们都在 FCP 之后才完成,不是 FCP 被推迟的原因。</div>`
      : d.blockingSupported === false
        ? html`<div>无法识别渲染阻塞资源:当前 Chrome 不提供这项信息。</div>`
        : null
  const ctx = { round, summary: result.summary, ex: explainDclLoad(round), stat }

  // 缩进:只有服务端发出的上游调用缩进一级(它们是“等待服务器响应”里面的事)
  const IND = 16
  const indent = (depth, base) => `padding-left:${base + (depth || 0) * IND}px`

  // 不分组:所有行按时间顺序排成一列
  const body = layout.items.map((it) => renderRow(it.row, it.depth))

  function renderRow(row, depth) {
    // 说明行(没有名字的 note):整行通栏显示,不画色点和空的标签列
    if (row.kind === 'note' && !row.label) {
      return html`<div class=${'wf-row k-note wf-full' + (row.warn ? ' wf-warnrow' : '')} key=${row.key} style=${indent(depth, 15)}>
        <div class="wf-fulltext">${row.warn ? '⚠ ' : ''}${row.text}</div>
      </div>`
    }
    const content = rowTip(row, ctx)
    const clickable = !!row.link
    const cls = `wf-row k-${row.kind} ${clickable ? 'click' : ''}`
    const tipProps = tip(content)

    // 左侧名称
    const label = html`<div class=${'wf-label' + (depth ? ' sub' : '')} style=${indent(depth, 4)}>
      <div class="wf-name">
        <i class="dot" style=${`background:${row.color || '#ccc'}`}></i>
        ${row.fileUrl && row.tip === 'scriptrun' ? html`<em class=${'badge ' + (row.badgeCls || '')}>${row.badge}</em><span class="mono">${fileName(row.fileUrl)}</span>` : row.fileUrl ? html`<span class="mono">${fileName(row.fileUrl)}</span>${row.badge ? html`<em class=${'badge ' + (row.badgeCls || '')}>${row.badge}</em>` : null}` : html`<span class=${row.strong ? 'strong' : ''}>${isNum(row.num) ? CIRCLED[row.num] + ' ' : ''}${row.label}</span>${row.badge ? html`<em class=${'badge ' + (row.badgeCls || '')}>${row.badge}</em>` : null}`}
        ${row.covered ? html`<em class="badge warnb" title="被其他元素盖住">被遮挡</em>` : null}
      </div>
      ${row.sub ? html`<div class="wf-sub mono" title=${row.sub}>${row.sub.startsWith('TTFB') ? row.sub : lastSel(row.sub)}</div>` : null}
    </div>`

    // 右侧图形
    let chart = null
    if (row.kind === 'bar') {
      const w = Math.max(((row.end - row.start) / T) * 100, 0.35)
      const nearRight = (row.end / T) * 100 > 86
      chart = html`<div class="wf-chart">
        <div class=${'wf-bar' + (row.unknown ? ' unk-bar' : '') + (row.pending ? ' pend-bar' : '')} style=${`left:${pct(row.start)};width:${w}%;${row.unknown || row.pending ? '' : 'background:' + row.color}`}></div>
        <span class="wf-val" style=${nearRight ? `right:calc(100% - ${pct(row.start)} + 6px)` : `left:calc(${pct(row.end)} + 6px)`}>${fmt(row.end - row.start)}</span>
      </div>`
    } else if (row.kind === 'mark') {
      const nearRight = (row.t / T) * 100 > 88
      chart = html`<div class="wf-chart">
        <div class=${'wf-mark' + (row.faded ? ' faded' : '')} style=${`left:${pct(row.t)};color:${row.color}`}></div>
        <span class="wf-val" style=${nearRight ? `right:calc(100% - ${pct(row.t)} + 10px)` : `left:calc(${pct(row.t)} + 10px)`}>${fmt(row.t)}</span>
      </div>`
    } else {
      chart = html`<div class=${'wf-chart' + (row.warn ? ' wf-warn' : '')}><span class="wf-none">${row.warn ? '⚠ ' : ''}${row.text}</span></div>`
    }

    return html`<div class=${cls} key=${row.key} ...${tipProps} onClick=${clickable ? () => onPick(row.link) : undefined}>${label}${chart}</div>`
  }

  return html`<div class="card" id="timeline-anchor">
    <div class="sectionhead">
      <h3>加载时间线</h3>
      <span class="tl-which" id="tl-which">
        ${scope === 'all'
          ? html`汇总时间线<em>(各项分别取${stat === 'mean' ? '平均值' : '中位数'},由 ${round.count} 轮合成,不是某一次真实加载;想看真实的一次请在上方“查看”里选某一轮)</em>`
          : html`第 ${round.index} 轮<em>(这一轮的实际时间线)</em>`}
      </span>
      <span class="seg tl-focus" id="tl-focus" title="聚焦:只看某一个时间点是由什么决定的">
        <button class=${focus === 'all' ? 'on' : ''} onClick=${() => setFocus('all')}>总览</button>
        ${layout.available.map((c) => html`<button key=${c.id} class=${focus === c.id ? 'on' : ''} onClick=${() => setFocus(c.id)}>${c.label}</button>`)}
      </span>
    </div>
    <div class="tl-legend" id="tl-legend">${focus === 'all' ? legendFor(layout.hiddenUnknown) : FOCUS_HINT[focus]}</div>

    <div class="wf" onMouseMove=${onMove} onMouseLeave=${() => showCross(null)}>
      <div class="wf-overlay" ref=${overlayRef}>
        ${ticks.map((t) => html`<i class="wf-grid" style=${`left:${pct(t)}`}></i>`)}
        ${band ? html`<div class="wf-band" style=${`left:${pct(band.a)};width:${((band.b - band.a) / T) * 100}%`}></div>` : null}
        <div class="wf-cross" ref=${crossRef}></div>
      </div>

      <div class="wf-axis">
        <div></div>
        <div class="wf-axis-chart">
          ${ticks.map((t) => html`<span style=${`left:${pct(t)}`}>${t === 0 ? '0' : t >= 1000 ? t / 1000 + ' s' : t + ' ms'}</span>`)}
          ${band ? html`<div class=${'wf-bandlabel' + (bandWide ? '' : ' out')} style=${`left:${pct(band.a)};width:${((band.b - band.a) / T) * 100}%`} title="首字节到首次绘制之间"><b>首字节 → FCP ${fmt(band.b - band.a)}</b></div>` : null}
          <div class="wf-bubble" ref=${bubbleRef}></div>
        </div>
      </div>

      ${body}
    </div>

    <div class="wf-notes">
      ${n && gap != null
        ? html`<div>首字节 <b>${fmt(n.responseStart)}</b> → HTML 收完 <b>${fmt(n.responseEnd)}</b> → FCP <b>${fmt(d.fcp)}</b>。${gap < 0
            ? html`FCP 比 HTML 收完早 ${fmt(-gap)}:浏览器边下载边渲染,不需要等 HTML 收完。`
            : html`HTML 收完后又过了 ${fmt(gap)} 才出现 FCP。`}</div>`
        : null}
      ${blockerLine}
      <div class="hint2">把鼠标移到任意一行可查看说明;移到图上会出现时间参考线。点击 FCP / LCP / 自定义检测的行,可跳到下方对应的画面。</div>
    </div>
  </div>`
}
