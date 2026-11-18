import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export function dataHome() {
  return process.env.PERF_FLOW_HOME || path.join(os.homedir(), '.perf-flow')
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const validId = (id) => typeof id === 'string' && ID_RE.test(id)

const runsDir = () => path.join(dataHome(), 'runs')
export const runDir = (id) => path.join(runsDir(), id)

export function newId() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

export async function saveRun(id, result, frames) {
  const dir = runDir(id)
  await fs.mkdir(path.join(dir, 'frames'), { recursive: true })
  for (const f of frames || []) {
    await fs.writeFile(path.join(dir, 'frames', f.file), Buffer.from(f.data, 'base64'))
  }
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2))
}

export async function loadRun(id) {
  if (!validId(id)) return null
  try {
    return JSON.parse(await fs.readFile(path.join(runDir(id), 'result.json'), 'utf8'))
  } catch {
    return null
  }
}

export async function listRuns() {
  let names = []
  try {
    names = await fs.readdir(runsDir())
  } catch {
    return []
  }
  const out = []
  for (const id of names) {
    const r = await loadRun(id)
    if (!r) continue
    const m = (r.summary && r.summary.metrics) || {}
    out.push({
      id: r.id,
      url: r.config && r.config.url,
      createdAt: r.startedAt || r.createdAt,
      device: r.config && r.config.device,
      rounds: r.summary && r.summary.okRounds,
      ttfb: m.ttfb && m.ttfb.median,
      fcp: m.fcp && m.fcp.median,
      lcp: m.lcp && m.lcp.median,
    })
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export async function deleteRun(id) {
  if (!validId(id)) return false
  await fs.rm(runDir(id), { recursive: true, force: true })
  return true
}

export function framePath(id, file) {
  if (!validId(id) || !/^f\d+\.jpg$/.test(file)) return null
  return path.join(runDir(id), 'frames', file)
}
