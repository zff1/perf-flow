// 在界面端对各轮数据重新汇总。这样用户排除某一轮后,不需要重新测量就能得到新的统计。
// 汇总结果与服务端 src/summarize.js 的 summarize() 保持一致(并额外提供 mean 与逐轮对齐的 values)。
import { isNum } from './format.js'

const KEYS = [
  'ttfb', 'htmlDone', 'fp', 'fcp', 'lcp', 'domInteractive', 'domContentLoaded', 'load',
  'redirect', 'dns', 'connect', 'serverWait', 'htmlDownload', 'htmlDoneToFcp',
]
const r1 = (x) => Math.round(x * 10) / 10

function median(nums) {
  const s = nums.filter(isNum).sort((a, b) => a - b)
  if (!s.length) return null
  const k = s.length
  return k % 2 ? s[(k - 1) / 2] : r1((s[k / 2 - 1] + s[k / 2]) / 2)
}

/**
 * values / excluded 与 rounds 一一对应(第 i 个元素就是第 i+1 轮),
 * 失败的轮次 values 为 null;median / min / max / mean 只用参与统计的轮次计算。
 */
function stat(rounds, used, getter) {
  const values = rounds.map((r) => (r.ok ? getter(r) : null))
  const vs = rounds.filter((r) => used.has(r.index)).map(getter).filter(isNum)
  return {
    values,
    excluded: rounds.map((r) => r.ok && !used.has(r.index)),
    count: vs.length,
    median: median(vs),
    mean: vs.length ? r1(vs.reduce((a, b) => a + b, 0) / vs.length) : null,
    min: vs.length ? Math.min(...vs) : null,
    max: vs.length ? Math.max(...vs) : null,
  }
}

/** @param {Set<number>} excluded 被用户排除的轮次编号 */
export function computeSummary(result, excluded = new Set()) {
  const rounds = result.rounds
  const ok = rounds.filter((r) => r.ok)
  const usedRounds = ok.filter((r) => !excluded.has(r.index))
  const used = new Set(usedRounds.map((r) => r.index))

  const metrics = {}
  for (const k of KEYS) metrics[k] = stat(rounds, used, (r) => r.derived.metrics[k])

  const tally = (pick) => {
    const map = new Map()
    for (const r of usedRounds) {
      const e = pick(r)
      const key = e && e.el ? e.el.selector || e.el.tag : e ? '(元素已被移除)' : '(无)'
      map.set(key, (map.get(key) || 0) + 1)
    }
    return [...map.entries()].map(([selector, count]) => ({ selector, count })).sort((a, b) => b.count - a.count)
  }

  const detectors = {}
  for (const d of result.config.detectors) {
    const time = (r) => {
      const h = r.data.detectors[d.id]
      return h && h.hit != null ? (h.presented != null ? h.presented : h.hit) : null
    }
    const st = stat(rounds, used, time)
    const errRound = usedRounds.find((r) => r.data.detectors[d.id] && r.data.detectors[d.id].error)
    detectors[d.id] = {
      ...st,
      hitCount: usedRounds.filter((r) => isNum(time(r))).length,
      rounds: usedRounds.length,
      error: errRound ? errRound.data.detectors[d.id].error : null,
    }
  }

  return {
    okRounds: ok.length,
    usedRounds: usedRounds.length,
    totalRounds: rounds.length,
    metrics,
    lcpElements: tally((r) => r.derived.lcpFinal),
    fcpElements: tally((r) => r.derived.fcpElement),
    detectors,
    resourceCount: stat(rounds, used, (r) => r.data.resourceCount),
  }
}
