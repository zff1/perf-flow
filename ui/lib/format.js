export const isNum = (x) => typeof x === 'number' && isFinite(x)

/** 毫秒 → "432 ms" / "1.73 s" */
export const fmt = (ms) => (!isNum(ms) ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`)

export const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']

export function median(arr) {
  const s = arr.filter(isNum).sort((a, b) => a - b)
  if (!s.length) return null
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** 选择器过长时只保留最后两段,再按字符数截断 */
export function shortSel(sel, max = 56) {
  if (!sel) return ''
  const parts = String(sel).split(' > ')
  let s = parts.length > 3 ? '… > ' + parts.slice(-2).join(' > ') : String(sel)
  if (s.length > max) s = '…' + s.slice(-(max - 2))
  return s
}

/** 选择器路径的最后一段,如 "div#a > div.b > img.c" → "img.c" */
export function lastSel(sel) {
  if (!sel) return ''
  const parts = String(sel).split(' > ')
  return parts[parts.length - 1]
}

/** 地址 → "host/…/文件名" */
export function shortUrl(u) {
  try {
    const x = new URL(u)
    const p = x.pathname.split('/').filter(Boolean)
    return x.host + (p.length > 1 ? '/…/' : '/') + (p[p.length - 1] || '')
  } catch {
    return String(u).slice(0, 80)
  }
}

/** 地址 → 文件名(去掉 hash 前的长串不处理,只取最后一段) */
export function fileName(u) {
  try {
    const x = new URL(u)
    const p = x.pathname.split('/').filter(Boolean)
    return p[p.length - 1] || x.host
  } catch {
    return String(u).slice(-40)
  }
}

export const fmtInt = (n) => (isNum(n) ? n.toLocaleString() : '')
