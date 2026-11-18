import { html, useState, useMemo } from '../lib/h.js'
import { fmt, isNum, fmtInt, lastSel, fileName } from '../lib/format.js'
import { EXPLAIN } from '../lib/text.js'
import { buildEvents, matchAnnotated, COLORS } from '../lib/model.js'
import { tip, TipCard, TipRows, TipText, toast } from './Tooltip.js'

const KIND_COLOR = { fcp: COLORS.fcp, lcp: COLORS.lcp, det: COLORS.det }

/** 'lcp-final' 这类跳转标识 → 实际事件 */
function resolveEvent(evs, sel) {
  if (!sel) return null
  return evs.find((e) => e.key === sel) || (sel === 'lcp-final' ? evs.find((e) => e.isLast) : null) || null
}

function eventTip(e) {
  const el = e.el
  return html`<${TipCard} title=${e.name} color=${KIND_COLOR[e.kind]} sub=${fmt(e.t)}>
    <${TipRows} rows=${[
      isNum(e.n) && isNum(e.of) ? ['出现在', `${e.n} / ${e.of} 轮`] : null,
      el && el.tag !== 'request' ? ['元素', el.selector || el.tag, true] : null,
      el && el.text ? [el.tag === 'request' ? '地址' : '文字', el.text, el.tag === 'request'] : null,
      isNum(e.size) ? ['面积', fmtInt(e.size) + ' px²'] : null,
      e.url ? ['图片地址', e.url, true] : null,
      el && el.rect && el.rect.w > 0 ? ['位置', `x ${Math.round(el.rect.x)}, y ${Math.round(el.rect.y)}, ${Math.round(el.rect.w)}×${Math.round(el.rect.h)}`] : null,
    ]} />
    ${el && el.covered ? html`<${TipText}><span class="cov">⚠ 这个元素当时被 <b class="mono">${el.coveredBy || '其他元素'}</b> 盖住,用户看不到它。</span><//>` : null}
    ${e.inferred ? html`<${TipText}>${EXPLAIN.fcp}<//>` : null}
    ${el && el.selector ? html`<${TipText}><span class="hint2">路径选择器是尽力生成的;页面结构或类名变化后可能失效。</span><//>` : null}
  <//>`
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制:' + text)
  } catch {
    toast('复制失败,请手动选择文字')
  }
}

/**
 * @param result   汇总视图(用来取配置、参考录屏)
 * @param round    当前查看范围对应的"轮":单轮,或合成的汇总轮
 * @param scope    'all' 或轮次编号;stat 'median' | 'mean'
 */
export function Shot({ result, round, scope, stat, selected, onSelect, onAddDetector }) {
  const a = result.annotated
  const useAnn = !!(a && a.ok)
  const [hoverKey, setHoverKey] = useState(null)

  // 表格:跟随查看范围
  const evs = useMemo(() => (round ? buildEvents(round, null) : []), [round])
  // 画面:来自单独的参考录屏,带帧信息
  const annEvs = useMemo(() => (useAnn ? buildEvents({ data: a.data, derived: a.derived }, a) : []), [a])
  if (!round) return null

  const sel = resolveEvent(evs, selected) || evs.find((e) => e.isLast) || [...evs].reverse().find((e) => e.kind === 'lcp') || evs[0] || null
  const annSel = sel ? matchAnnotated(sel, annEvs) : null

  const scopeText = scope === 'all' ? `汇总(各项分别取${stat === 'mean' ? '平均值' : '中位数'})` : `第 ${scope} 轮`

  // ---------- 画面 ----------
  let stage = html`<div class="empty">${a && !a.ok ? '画面标注失败:' + a.error : '未生成画面标注(在表单里勾选“生成画面标注”后重新运行)。'}</div>`
  if (useAnn && a.frames.length) {
    const vw = a.viewport.w
    const vh = a.viewport.h
    const frameMs = annSel && annSel.frame != null ? annSel.frame : a.frames[a.frames.length - 1].ms
    const frame = a.frames.find((f) => f.ms === frameMs) || a.frames[a.frames.length - 1]
    const url = `/api/runs/${encodeURIComponent(result.id)}/frames/${encodeURIComponent(frame.file)}`
    const hoverAnn = hoverKey ? matchAnnotated(evs.find((e) => e.key === hoverKey), annEvs) : null
    const boxes = annEvs
      .filter((e) => e.frame === frame.ms && e.el && e.el.rect && e.el.rect.w > 0 && e.el.rect.h > 0)
      .sort((x, y) => y.el.rect.w * y.el.rect.h - x.el.rect.w * x.el.rect.h) // 大的在下,小的在上,方便悬停
    stage = html`<div>
      <div class="stage" style=${`aspect-ratio:${vw}/${vh}`}>
        <img src=${url} alt="参考画面" />
        ${boxes.map((e, bi) => {
          const rc = e.el.rect
          const x = Math.max(0, rc.x)
          const y = Math.max(0, rc.y)
          const w = Math.min(vw - x, rc.w - (x - rc.x))
          const hh = Math.min(vh - y, rc.h - (y - rc.y))
          if (w <= 0 || hh <= 0) return null
          const cls = `box ${e.kind} ${y < 22 ? 'inside' : ''} ${annSel && annSel.key === e.key ? 'sel' : ''} ${hoverAnn && hoverAnn.key === e.key ? 'hl' : ''}`
          return html`<div class=${cls} key=${e.key} style=${`left:${(x / vw) * 100}%;top:${(y / vh) * 100}%;width:${(w / vw) * 100}%;height:${(hh / vh) * 100}%`}
            ...${tip(eventTip(e))} onClick=${() => { const back = evs.find((t) => { const m = matchAnnotated(t, annEvs); return m && m.key === e.key }); if (back) onSelect(back.key) }}>
            <span class="cap" style=${`margin-left:${bi * 96}px`}>${e.name}</span>
          </div>`
        })}
      </div>
      <div class="note ref-note">
        <b>参考画面</b>(约 ${fmt(frame.ms)}):来自单独的一轮录屏,<b>不随上方“查看范围”变化</b>。右侧表格会随范围变化,点击一行会在参考录屏里找到同一个元素并画框。
        ${sel && !annSel ? html`<span class="warn"> 参考录屏里没有出现“${sel.name}”这个元素,这里显示的是最后一帧。</span>` : ''}
      </div>
      <div class="note">录屏帧比真实绘制晚约一两帧,录屏也可能影响耗时(参考轮 FCP ${fmt(a.data.fcp)},常规轮中位数 ${fmt(result.summary.metrics.fcp.median)})。画面只用来“看是什么”,耗时以上方常规轮为准。</div>
      ${coveredNote(evs, annEvs)}
    </div>`
  }

  // ---------- 事件表 ----------
  const rows = evs.map((e) => {
    const el = e.el
    const isReq = el && el.tag === 'request'
    const canAdd = (el && el.selector) || isReq
    return html`<tr key=${e.key} class=${'click ' + (sel && sel.key === e.key ? 'on' : '')}
      onClick=${() => onSelect(e.key)} onMouseEnter=${() => setHoverKey(e.key)} onMouseLeave=${() => setHoverKey(null)}>
      <td><span class=${'pill ' + e.kind}>${e.name}</span>${e.inferred ? html`<span class="tag" title=${EXPLAIN.fcp}>推断</span>` : null}${el && el.covered ? html`<span class="tag cov-tag" title=${'被 ' + (el.coveredBy || '其他元素') + ' 盖住'}>被遮挡</span>` : null}
        ${isNum(e.n) && isNum(e.of) && scope === 'all' ? html`<div class="note cnt" title="这个元素在多少轮里出现">${e.n}/${e.of} 轮</div>` : null}</td>
      <td class="num">${fmt(e.t)}</td>
      <td class="elcell" ...${tip(eventTip(e))}>
        ${el
          ? isReq
            ? html`<div>网络请求</div><div class="note mono ell">${el.text}</div>`
            : html`<div class="mono ell" title=${el.selector}>${lastSel(el.selector) || el.tag}</div>
                ${el.text ? html`<div class="note ell">“${el.text}”</div>` : null}
                ${e.url ? html`<div class="note mono ell">${fileName(e.url)}</div>` : null}`
          : html`<span class="muted">${e.req ? '' : '(元素已被移除)'}</span>`}
      </td>
      <td class="num">${isNum(e.size) ? fmtInt(e.size) : ''}</td>
      <td class="acts" onClick=${(ev) => ev.stopPropagation()}>
        ${canAdd
          ? html`<button class="mini" title="把它添加为一项自定义检测" onClick=${() => onAddDetector(toDetector(e))}>+ 检测</button>
              ${!isReq ? html`<button class="mini" title="复制选择器" onClick=${() => copyText(el.selector)}>复制</button>` : null}`
          : null}
      </td>
    </tr>`
  })

  return html`<div class="card" id="shot-anchor">
    <div class="sectionhead">
      <h3>FCP / LCP 元素与画面</h3>
      <span class="tl-which" id="shot-which">表格:${scopeText}</span>
    </div>
    <div class="shot">
      ${stage}
      <div>
        <table>
          <thead><tr><th>事件</th><th>时间</th><th>元素</th><th>面积 px²</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="note">${scope === 'all'
          ? 'LCP 候选按元素汇总:每一行是同一个元素在各轮中的统计值,“x/y 轮”表示它出现在几轮里。FCP 对应的元素是推断值(浏览器不直接提供)。'
          : 'LCP 候选按这一轮出现的顺序列出,最后一个是最终的 LCP。FCP 对应的元素是推断值(浏览器不直接提供)。'}
          “+ 检测”会把该元素加到上方的自定义检测里。</div>
      </div>
    </div>
  </div>`
}

/** 参考录屏里,最终 LCP 元素被遮挡时给出说明 */
function coveredNote(evs, annEvs) {
  const fin = annEvs.find((e) => e.isLast)
  if (fin && fin.el && fin.el.covered) {
    return html`<div class="note cov-note">⚠ 最终的 LCP 元素 <span class="mono">${lastSel(fin.el.selector)}</span> 当时被 <span class="mono">${fin.el.coveredBy || '其他元素'}</span> 盖住,画面里看不到它,但浏览器仍把它计为 LCP。所以这个页面的 LCP 并不代表用户看到内容的时间,建议用上面的“自定义检测”测你真正关心的节点。</div>`
  }
  return html`<div class="note">LCP 元素可能被其他元素遮住(例如不透明的加载遮罩);工具会检测并在这里标出。参考录屏中没有发现遮挡。</div>`
}

/** 把一个事件转换成表单里的一项自定义检测 */
function toDetector(e) {
  const el = e.el
  if (el && el.tag === 'request') {
    let value = el.text
    try {
      value = new URL(el.text).pathname
    } catch {}
    return { type: 'request', value, when: 'end', label: e.name }
  }
  return { type: 'selector', value: el.selector, state: 'visible', label: e.kind === 'det' ? e.name : (el.text ? el.text.slice(0, 12) : e.name) }
}
