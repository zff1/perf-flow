import { html, useMemo } from '../lib/h.js'
import { buildWarnings } from '../lib/model.js'
import { tip, TipCard, TipRows, TipText } from './Tooltip.js'

/** 结果顶部的警告标签。悬停看明细,有动作的可以点击跳转。 */
export function Warnings({ result, onAction }) {
  const list = useMemo(() => buildWarnings(result), [result])
  if (!list.length) return null
  return html`<div class="chips" id="warnings">
    ${list.map((w) => {
      const content = html`<${TipCard} title=${w.text}>
        ${w.rows && w.rows.length ? html`<${TipRows} rows=${w.rows.map(([k, v]) => [k, v, true])} />` : null}
        ${w.note ? html`<${TipText}>${w.note}<//>` : null}
        ${w.action ? html`<${TipText}><span class="hint2">点击查看</span><//>` : null}
      <//>`
      return html`<span key=${w.id} class=${'chip ' + w.level + (w.action ? ' click' : '')} ...${tip(content)}
        onClick=${w.action ? () => onAction(w.action) : undefined}>${w.level === 'warn' ? '⚠' : 'ℹ'} ${w.text}</span>`
    })}
  </div>`
}
