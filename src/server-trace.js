// 把"探针在服务端记录的请求"和"浏览器看到的这次导航"对上,并换算到页面时间线上。

const r1 = (n) => Math.round(n * 10) / 10

/**
 * @param data    浏览器这一轮的数据(需要 url、nav、serverTiming)
 * @param probe   { state: 'off' | 'ok' | 'failed', message?, pid?, node? }
 * @param traces  探针取回的入站请求(probe.state 为 'ok' 时)
 * @returns data.server;既没有探针也没有 Server-Timing 时返回 null
 */
export function buildServerData({ data, probe, traces }) {
  const timing = Array.isArray(data.serverTiming) ? data.serverTiming : []
  if (probe.state === 'off' && !timing.length) return null
  const out = { probe, timing, request: null, unmatched: null }
  if (probe.state !== 'ok') return out

  const list = Array.isArray(traces) ? traces : []
  out.inbound = list.length
  const nav = data.nav
  let pathname = ''
  try {
    pathname = new URL(data.url).pathname
  } catch {}
  // 页面这次导航对应的入站请求:路径相同的 GET,并且浏览器标明是文档导航(或 Accept 里要 HTML)。
  // 有重定向时取最后一个(最终页面的那次)
  const cands = list.filter((t) => t.method === 'GET' && t.path === pathname && (t.dest === 'document' || /text\/html/.test(t.accept || '')))
  const t = cands[cands.length - 1]
  if (!t) {
    out.unmatched = `探针已连上,但没有在这个进程里找到页面请求(${pathname || '/'})。请求可能经过了另一个进程(反向代理、集群的其他进程)`
    return out
  }
  if (!nav || !(nav.responseStart > 0) || !(nav.requestStart >= 0)) {
    out.unmatched = '缺少浏览器端的请求时间,无法对齐'
    return out
  }
  const fb = t.firstByteAt != null ? t.firstByteAt : t.total
  if (fb == null) {
    out.unmatched = '这次请求在服务端没有走完,没有记录到响应的第一个字节'
    return out
  }
  // 对齐:浏览器从发出请求到收到第一个字节(wait),减去服务端自己用掉的时间,剩下的是网络往返。
  // 假设去程和回程各占一半,服务端的零点就在发出请求之后 slack / 2 的位置。本机访问时 slack 接近 0
  const wait = nav.responseStart - nav.requestStart
  const slack = r1(wait - fb)
  if (slack < -20) {
    out.unmatched = `服务端记录的处理时间(${Math.round(fb)} ms)比浏览器看到的整个等待(${Math.round(wait)} ms)还长,对不上,没有采用。可能匹配到了别的请求`
    return out
  }
  const offset = r1(nav.requestStart + Math.max(0, slack) / 2)
  const seen = new Map()
  const spans = (t.spans || []).map((s) => {
    const base = `${s.via}|${s.method}|${s.target}`
    const k = (seen.get(base) || 0) + 1
    seen.set(base, k)
    const open = s.end == null
    return {
      key: k > 1 ? `${base}#${k}` : base,
      via: s.via,
      method: s.method,
      target: s.target,
      start: r1(offset + s.start),
      end: r1(offset + (open ? (t.total != null ? t.total : fb) : s.end)),
      open: open || undefined,
      status: s.status,
      error: s.error,
    }
  })
  out.request = { offset, firstByteAt: fb, total: t.total != null ? t.total : null, status: t.status, slack, spans }
  return out
}
