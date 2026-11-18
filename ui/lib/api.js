/** 调用本地服务。写操作必须带 X-Perf-Flow 头(服务端据此拒绝其他网页发来的跨站请求)。 */
export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (opts.method && opts.method !== 'GET') {
    headers['X-Perf-Flow'] = '1'
    if (opts.body) headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(path, { ...opts, headers })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `请求失败 (${res.status})`)
  return body
}
