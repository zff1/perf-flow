import { html } from '../lib/h.js'

/**
 * 结果区顶部的"查看范围"工具栏。它同时控制下面的指标卡片和时间线。
 *   scope  'all'(汇总)或某一轮的编号
 *   stat   汇总时用中位数还是平均值
 */
export function ScopeBar({ result, scope, onScope, stat, onStat, excluded, onToggleExclude }) {
  const ok = result.rounds.filter((r) => r.ok)
  const usedCount = ok.length - ok.filter((r) => excluded.has(r.index)).length
  const isAll = scope === 'all'

  return html`<div class="scopebar" id="scopebar">
    <div class="sb-row">
      <span class="sb-label">查看</span>
      <div class="seg" role="group" aria-label="选择查看汇总还是某一轮">
        <button class=${isAll ? 'on' : ''} aria-pressed=${isAll} onClick=${() => onScope('all')} title="所有参与统计的轮次合在一起">汇总</button>
        ${ok.map((r) => html`<button key=${r.index} class=${scope === r.index ? 'on' : ''} aria-pressed=${scope === r.index}
          onClick=${() => onScope(r.index)} title="只看这一轮的实际测量值">第 ${r.index} 轮${excluded.has(r.index) ? html`<i class="exmark"> ✕</i>` : null}</button>`)}
      </div>

      ${isAll
        ? html`<span class="sb-sep"></span>
          <span class="sb-label">统计方式</span>
          <div class="seg" role="group" aria-label="汇总时使用的统计方式">
            <button class=${stat === 'median' ? 'on' : ''} aria-pressed=${stat === 'median'} onClick=${() => onStat('median')}
              title="排序后取中间值。不容易被偶发的慢轮次拉偏,推荐。">中位数</button>
            <button class=${stat === 'mean' ? 'on' : ''} aria-pressed=${stat === 'mean'} onClick=${() => onStat('mean')}
              title="所有值相加再除以轮数。会被偶发的慢轮次拉高。">平均值</button>
          </div>`
        : null}

      ${isAll && ok.length > 1
        ? html`<span class="sb-sep"></span>
          <span class="sb-label">参与统计</span>
          <div class="incl-group">
            ${ok.map((r) => html`<label key=${r.index} class=${excluded.has(r.index) ? 'off' : ''}
              title=${'取消勾选后,第 ' + r.index + ' 轮不再计入汇总(数据保留,随时可以恢复)。例如首轮受 DNS / 连接冷启动影响时可以排除。'}>
              <input type="checkbox" checked=${!excluded.has(r.index)}
                disabled=${usedCount <= 1 && !excluded.has(r.index)} onChange=${() => onToggleExclude(r.index)} /> ${r.index}</label>`)}
          </div>`
        : null}
    </div>
    <div class="sb-hint">
      ${isAll
        ? `汇总:${usedCount} 轮的${stat === 'mean' ? '平均值' : '中位数'}。下面的卡片、时间线、元素表都是汇总(各项分别取${stat === 'mean' ? '平均值' : '中位数'},合成的,不是某一次真实加载)。参考画面来自单独录屏,不随范围变化。`
        : `单轮:第 ${scope} 轮的实际测量值,卡片上的小字是与汇总中位数的差距。时间线和元素表显示这一轮。参考画面来自单独录屏,不随范围变化。`}
    </div>
  </div>`
}
