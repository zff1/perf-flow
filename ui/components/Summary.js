import { html } from '../lib/h.js'
import { fmt, isNum, CIRCLED, lastSel } from '../lib/format.js'
import { EXPLAIN, TYPE_LABEL, describeDetector, precisionOf } from '../lib/text.js'
import { tip, TipCard, TipRows, TipText, RoundBars } from './Tooltip.js'

const rangeText = (m, total) => {
  const lack = isNum(total) && m.count > 0 && m.count < total ? ` · 仅 ${m.count}/${total} 轮有值` : ''
  if (m.count > 1) return `范围 ${fmt(m.min)} ~ ${fmt(m.max)}${lack}`
  if (m.count === 1) return (isNum(total) && total > 1 ? `仅 ${m.count}/${total} 轮有值` : '仅 1 轮有效')
  return '无数据'
}
const signed = (ms) => (ms >= 0 ? '+' : '−') + fmt(Math.abs(ms))

/** 单行显示的元素名;各轮不一致 / 被遮挡时给出提醒 */
function ElementLine({ tally, inferred, covered }) {
  if (!tally || !tally.length) return html`<div class="el muted">(未捕获到元素)</div>`
  const top = tally[0]
  const mixed = tally.length > 1
  return html`<div class="el-wrap">
    <div class="el mono" title=${top.selector}>${lastSel(top.selector)}${inferred ? html`<span class="tag">推断</span>` : null}</div>
    ${covered ? html`<div class="sub warn" title="最终的 LCP 元素当时被其他元素盖住,用户看不到它">⚠ 被遮挡,用户未必看到</div>` : null}
    ${mixed ? html`<div class="sub warn">⚠ 各轮元素不一致(${tally.length} 种)</div>` : null}
  </div>`
}

/**
 * 一张指标卡片。
 *   m  当前查看范围的统计(汇总时是多轮,单轮时只有一个值)
 *   a  汇总的统计:用来画各轮柱状图、和计算"单轮比汇总中位数快 / 慢多少"
 *   ctx { scope, stat }
 */
/** 没有任何一轮得到这个值时的说明 */
function noValueText(title) {
  if (title.startsWith('load')) return '观察期内 load 事件没有触发'
  if (title.startsWith('DOMContentLoaded')) return '观察期内 DOMContentLoaded 没有触发'
  return '没有得到这个值'
}

function Metric({ cls, title, m, a, ctx, sub, children, tipBody, explain }) {
  const single = ctx.scope !== 'all'
  const value = single ? m.median : ctx.stat === 'mean' ? m.mean : m.median
  const delta = single && isNum(m.median) && isNum(a.median) ? m.median - a.median : null

  let subText = sub
  let subCls = 'sub'
  if (single) {
    if (!isNum(m.median)) subText = noValueText(title).replace('观察期内', '这一轮观察期内')
    else if (delta == null) subText = `第 ${ctx.scope} 轮`
    else {
      subText = `第 ${ctx.scope} 轮 · 比汇总中位数 ${signed(delta)}`
      if (delta > 150 && delta > a.median * 0.3) subCls = 'sub warn'
    }
  } else if (!subText) {
    subText = rangeText(m, a.values.length)
  }
  if (!single && !isNum(value) && a.values.length > 0) {
    // 所有参与的轮次都没有这个值:不要只写"无数据",要说清楚是什么意思
    subText = noValueText(title)
  }

  const label = single ? '本轮' : ctx.stat === 'mean' ? '平均值' : '中位数'
  const content = html`<${TipCard} title=${title} sub=${isNum(value) ? label + ' ' + fmt(value) : ''}>
    ${tipBody}
    ${a.count > 1 ? html`<${TipRows} rows=${[['中位数', fmt(a.median)], ['平均值', fmt(a.mean)], ['参与汇总', `${a.count} 轮`]]} />` : null}
    ${explain ? html`<${TipText}>${explain}<//>` : null}
    ${a.count > 1 ? html`<${TipText}><span class="hint2">汇总默认用中位数:平均值容易被偶发的慢轮次拉高。可在上方“统计方式”切换。</span><//>` : null}
    ${a.values.length > 1 ? html`<${RoundBars} values=${a.values} median=${a.median} excluded=${a.excluded} current=${single ? ctx.scope : null} />` : null}
  <//>`
  return html`<div class=${'metric ' + cls} ...${tip(content)}>
    <h4>${title}</h4>
    <div class="v">${fmt(value)}</div>
    <div class=${subCls}>${subText}</div>
    ${children}
  </div>`
}

export function Header({ result }) {
  const r = result
  const s = r.summary
  const firstOk = r.rounds.find((x) => x.ok)
  const finalUrl = firstOk && firstOk.data.url
  const failed = r.rounds.filter((x) => !x.ok)
  const excl = r.rounds.filter((x) => x.ok && r.excluded && r.excluded.has(x.index)).map((x) => x.index)
  return html`<div class="card">
    <div class="row between">
      <div>
        ${finalUrl && finalUrl !== r.config.url ? html`<div class="note" style="margin-top:0">最终地址(发生了跳转):<span class="mono">${finalUrl}</span></div>` : null}
        <div class="note" style=${finalUrl && finalUrl !== r.config.url ? '' : 'margin-top:0'}>
          ${r.startedAt ? `开始于 ${new Date(r.startedAt).toLocaleString()}` : `记录于 ${new Date(r.createdAt).toLocaleString()}(旧记录,无开始时间)`} · ${r.config.device === 'mobile' ? '手机' : '桌面'} · Chrome ${r.browser.version} · 成功 ${s.okRounds}/${s.totalRounds} 轮${excl.length ? ` · 汇总使用 ${s.usedRounds} 轮(已排除第 ${excl.join('、')} 轮)` : ''} · 每轮全新浏览器上下文(冷缓存)、不限速
        </div>
      </div>
      <a href=${`/api/runs/${encodeURIComponent(r.id)}`} download=${`perf-flow-${r.id}.json`}><button>导出 JSON</button></a>
    </div>
    ${failed.length ? html`<div class="error">${failed.map((f) => `第 ${f.index} 轮失败:${f.error}`).join('\n')}</div>` : null}
  </div>`
}

/** 可选的指标卡片。默认只显示最常看的几个,其余按需打开。 */
export const CARD_OPTIONS = [
  ['ttfb', 'TTFB 首字节'],
  ['htmlDone', 'HTML 收完'],
  ['fcp', 'FCP'],
  ['lcp', 'LCP'],
  ['det', '自定义检测'],
  ['dcl', 'DOMContentLoaded'],
  ['load', 'load 事件'],
]
export const DEFAULT_CARDS = { ttfb: true, htmlDone: false, fcp: true, lcp: true, det: true, dcl: false, load: false }

/**
 * @param result 当前查看范围的结果(带重新计算过的 summary)
 * @param agg    汇总的结果
 */
export function CardsPanel({ result, agg, scope, stat, shown, onToggle }) {
  const hasDet = result.config.detectors.length > 0
  const options = CARD_OPTIONS.filter(([k]) => k !== 'det' || hasDet)
  const anyShown = options.some(([k]) => shown[k])
  const title = scope === 'all' ? `指标(汇总 · ${stat === 'mean' ? '平均值' : '中位数'} · ${agg.summary.usedRounds} 轮)` : `指标(第 ${scope} 轮)`
  return html`<div class="card" id="cards-panel">
    <div class="sectionhead">
      <h3>${title}</h3>
      <div class="toggles" role="group" aria-label="选择要显示的指标">
        <span class="note">显示:</span>
        ${options.map(([k, label]) => html`<button key=${k} class=${'toggle' + (shown[k] ? ' on' : '')} aria-pressed=${!!shown[k]} onClick=${() => onToggle(k)}>${label}</button>`)}
      </div>
    </div>
    ${anyShown ? html`<${Cards} result=${result} agg=${agg} ctx=${{ scope, stat }} shown=${shown} />` : html`<div class="empty">没有选中任何指标。点上面的按钮选择要显示的。</div>`}
  </div>`
}

function Cards({ result, agg, ctx, shown }) {
  const r = result
  const s = r.summary
  const M = s.metrics
  const A = agg.summary.metrics
  // 多数参与统计的轮次里,最终 LCP 元素被遮挡,就在卡片上提醒
  const used = r.rounds.filter((x) => x.ok && !(r.excluded && r.excluded.has(x.index)))
  const coveredCount = used.filter((x) => x.derived.lcpFinal && x.derived.lcpFinal.el && x.derived.lcpFinal.el.covered).length
  const lcpCovered = used.length > 0 && coveredCount * 2 >= used.length
  const one = (k, props) => ({ m: M[k], a: A[k], ctx, ...props })

  return html`<div class="cards">
    ${shown.ttfb ? html`<${Metric} cls="ttfb" title="TTFB 首字节" ...${one('ttfb', {
      sub: ctx.scope === 'all' ? `服务器等待 ${fmt(M.serverWait.median)}` : null,
      explain: EXPLAIN.ttfb,
      tipBody: html`<${TipRows} rows=${[
        ['重定向', fmt(M.redirect.median)],
        ['DNS', fmt(M.dns.median)],
        ['连接(TCP / TLS)', fmt(M.connect.median)],
        ['服务器等待', fmt(M.serverWait.median)],
      ]} />`,
    })} >${ctx.scope !== 'all' ? html`<div class="el">服务器等待 ${fmt(M.serverWait.median)}</div>` : null}<//>` : null}

    ${shown.htmlDone ? html`<${Metric} cls="html" title="HTML 收完" ...${one('htmlDone', {
      sub: ctx.scope === 'all' ? `首字节后 ${fmt(M.htmlDownload.median)} 下载完` : null,
      explain: EXPLAIN.htmlDone,
    })} />` : null}

    ${shown.fcp ? html`<${Metric} cls="fcp" title="FCP 首次内容绘制" ...${one('fcp', { explain: EXPLAIN.fcp })}>
      <${ElementLine} tally=${s.fcpElements} inferred=${true} />
    <//>` : null}

    ${shown.lcp ? html`<${Metric} cls="lcp" title="LCP 最大内容绘制" ...${one('lcp', { explain: EXPLAIN.lcp })}>
      <${ElementLine} tally=${s.lcpElements} covered=${lcpCovered} />
    <//>` : null}

    ${shown.det ? r.config.detectors.map((d, i) => {
      const x = s.detectors[d.id]
      const ax = agg.summary.detectors[d.id]
      const single = ctx.scope !== 'all'
      const miss = x.hitCount < x.rounds
      const value = single ? x.median : ctx.stat === 'mean' ? x.mean : x.median
      const kind = d.type === 'request' ? `请求${d.when === 'start' ? '开始' : '完成'}` : d.type === 'js' ? 'JS 为真' : `${TYPE_LABEL[d.type]}${d.state === 'gone' ? '消失' : '出现'}`
      const delta = single && isNum(x.median) && isNum(ax.median) ? x.median - ax.median : null
      const subText = x.error ? x.error : single ? (isNum(x.median) ? `第 ${ctx.scope} 轮${delta != null ? ' · 比汇总中位数 ' + signed(delta) : ''}` : '这一轮未命中') : `${kind} · 命中 ${x.hitCount}/${x.rounds}`
      return html`<div class="metric det" key=${d.id} ...${tip(html`<${TipCard} title=${d.label || '自定义检测'} sub=${isNum(value) ? (single ? '本轮 ' : ctx.stat === 'mean' ? '平均值 ' : '中位数 ') + fmt(value) : '未命中'}>
          <${TipRows} rows=${[['条件', describeDetector(d)], ['命中(汇总)', `${ax.hitCount} / ${ax.rounds} 轮`], ['精度', precisionOf(d)], ax.count > 1 ? ['中位数', fmt(ax.median)] : null, ax.count > 1 ? ['平均值', fmt(ax.mean)] : null, x.error ? ['错误', x.error] : null]} />
          ${ax.values.length > 1 ? html`<${RoundBars} values=${ax.values} median=${ax.median} excluded=${ax.excluded} current=${single ? ctx.scope : null} />` : null}
        <//>`)}>
        <h4>${CIRCLED[i] || i + 1} ${d.label || d.value.slice(0, 24)}</h4>
        <div class="v">${isNum(value) ? fmt(value) : '未命中'}</div>
        <div class=${miss || (single && !isNum(x.median)) ? 'sub warn' : 'sub'}>${subText}</div>
        <div class="el mono" title=${d.value}>${d.value.slice(0, 48)}</div>
      </div>`
    }) : null}

    ${shown.dcl ? html`<${Metric} cls="" title="DOMContentLoaded" ...${one('domContentLoaded', { explain: EXPLAIN.dcl })} />` : null}
    ${shown.load ? html`<${Metric} cls="" title="load 事件" ...${one('load', { explain: EXPLAIN.load })} />` : null}
  </div>`
}
