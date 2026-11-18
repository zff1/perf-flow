import { html, useState, useRef, useEffect, useLayoutEffect } from '../lib/h.js'

// ---------- 悬浮提示:全局只有一个 <TooltipHost/>,任何元素用 tip(内容) 即可挂上 ----------
const bus = { set: null }

/** 返回一组事件属性:  <div ...${tip(html`<${TipCard} .../>`)}> */
export function tip(content) {
  if (!content) return {}
  return {
    onMouseEnter: (e) => bus.set && bus.set({ content, x: e.clientX, y: e.clientY }),
    onMouseMove: (e) => bus.set && bus.set({ content, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => bus.set && bus.set(null),
  }
}

export function TooltipHost() {
  const [s, set] = useState(null)
  const [pos, setPos] = useState({ left: -9999, top: -9999 })
  const ref = useRef(null)

  useEffect(() => {
    bus.set = set
    const hide = () => set(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      bus.set = null
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // 根据提示框实际尺寸定位,靠近屏幕边缘时翻转到另一侧
  useLayoutEffect(() => {
    if (!s || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    let left = s.x + 14
    let top = s.y + 16
    if (left + r.width > window.innerWidth - 8) left = s.x - r.width - 14
    if (top + r.height > window.innerHeight - 8) top = s.y - r.height - 14
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [s])

  if (!s) return null
  return html`<div class="tip" ref=${ref} style=${`left:${pos.left}px;top:${pos.top}px`}>${s.content}</div>`
}

// ---------- 提示框内容的通用积木 ----------
/** 标题 + 彩色圆点 */
export function TipCard({ title, color, sub, children }) {
  return html`<div class="tc">
    <div class="tc-title">${color ? html`<i style=${`background:${color}`}></i>` : null}${title}${sub ? html`<span>${sub}</span>` : null}</div>
    ${children}
  </div>`
}

/** 键值行 */
export function TipRows({ rows }) {
  return html`<table class="tc-rows"><tbody>
    ${rows.filter((r) => r && r[1] != null && r[1] !== '').map(([k, v, mono]) => html`<tr><td>${k}</td><td class=${mono ? 'mono' : ''}>${v}</td></tr>`)}
  </tbody></table>`
}

/** 说明文字 */
export function TipText({ children }) {
  return html`<div class="tc-text">${children}</div>`
}

/** 各轮数值的小柱状图,偏离中位数过多的轮次会标出来;被用户排除的轮次会变淡;当前查看的那一轮加粗 */
export function RoundBars({ values, median, excluded = [], current = null, unit = 'ms' }) {
  const nums = values.filter((v) => typeof v === 'number')
  const max = Math.max(1, ...nums)
  return html`<div class="tc-bars">
    ${values.map((v, i) => {
      const ok = typeof v === 'number'
      const ex = !!excluded[i]
      const cur = current === i + 1
      const slow = ok && !ex && median > 0 && v > median * 1.5 && v - median > 100
      return html`<div class=${'bar-row' + (ex ? ' ex' : '') + (cur ? ' cur' : '')}>
        <span>第 ${i + 1} 轮${cur ? ' ◀' : ''}</span>
        <div class="bar-track"><div class=${'bar-fill' + (slow ? ' slow' : '')} style=${`width:${ok ? (v / max) * 100 : 0}%`}></div></div>
        <b>${ok ? (v < 1000 ? Math.round(v) + ' ' + unit : (v / 1000).toFixed(2) + ' s') : '未命中'}</b>
        ${ex ? html`<em class="exl">不计入</em>` : slow ? html`<em>偏慢</em>` : null}
      </div>`
    })}
  </div>`
}

// ---------- 轻提示 ----------
const toastBus = { push: null }
export function toast(message) {
  if (toastBus.push) toastBus.push(message)
}

export function ToastHost() {
  const [msg, setMsg] = useState(null)
  const timer = useRef(null)
  useEffect(() => {
    toastBus.push = (m) => {
      setMsg(m)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setMsg(null), 3200)
    }
    return () => (toastBus.push = null)
  }, [])
  return msg ? html`<div class="toast">${msg}</div>` : null
}
