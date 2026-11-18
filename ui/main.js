import { html, render, useState, useEffect, useRef, useMemo } from './lib/h.js'
import { api } from './lib/api.js'
import { fmt, median, isNum } from './lib/format.js'
import { Form, DEFAULT_CFG, toRequest, fromResultConfig, emptyDetector } from './components/Form.js'
import { Header, CardsPanel, DEFAULT_CARDS } from './components/Summary.js'
import { computeSummary } from './lib/stats.js'
import { buildAggregateRound } from './lib/aggregate.js'
import { Warnings } from './components/Warnings.js'
import { ScopeBar } from './components/ScopeBar.js'
import { Timeline } from './components/Timeline.js'
import { Shot } from './components/Shot.js'
import { TooltipHost, ToastHost, toast } from './components/Tooltip.js'
import { CIRCLED } from './lib/format.js'

const STORE_KEY = 'perf-flow:form'
const CARDS_KEY = 'perf-flow:cards'
const STAT_KEY = 'perf-flow:stat'

function loadStat() {
  try {
    return localStorage.getItem(STAT_KEY) === 'mean' ? 'mean' : 'median'
  } catch {
    return 'median'
  }
}

function loadShownCards() {
  try {
    const c = JSON.parse(localStorage.getItem(CARDS_KEY) || 'null')
    if (c && typeof c === 'object') return { ...DEFAULT_CARDS, ...c }
  } catch {}
  return { ...DEFAULT_CARDS }
}

function loadSavedCfg() {
  try {
    const c = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (c && typeof c === 'object') return fromResultConfig({ ...c, timeoutMs: (c.timeoutSec || 30) * 1000 })
  } catch {}
  return DEFAULT_CFG()
}

function App() {
  const [version, setVersion] = useState('')
  const [cfg, setCfg] = useState(loadSavedCfg)
  const [history, setHistory] = useState([])
  const [historyId, setHistoryId] = useState('')
  const [result, setResult] = useState(null)
  const [scope, setScope] = useState('all') // 'all' = 汇总;数字 = 只看那一轮
  const [stat, setStat] = useState(loadStat) // 汇总时用中位数还是平均值
  const [selected, setSelected] = useState(null)
  const [running, setRunning] = useState(null) // { id }
  const [progress, setProgress] = useState(null) // { text, frac }
  const [error, setError] = useState('')
  const [flashUid, setFlashUid] = useState(null)
  const [formOpen, setFormOpen] = useState(true) // 有结果后默认折叠成摘要栏
  const [excluded, setExcluded] = useState(() => new Set()) // 被用户排除出统计的轮次
  const [shownCards, setShownCards] = useState(loadShownCards)
  const esRef = useRef(null)

  // 表单内容变化即保存,下次打开自动恢复
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...cfg, detectors: cfg.detectors.map(({ uid, ...d }) => d) }))
    } catch {}
  }, [cfg])

  useEffect(() => {
    api('/api/info').then((i) => setVersion(i.version)).catch(() => {})
    refreshHistory()
  }, [])

  async function refreshHistory(selectId) {
    try {
      const list = await api('/api/runs')
      setHistory(list)
      if (selectId) setHistoryId(selectId)
    } catch {}
  }

  async function loadResult(id) {
    const r = await api(`/api/runs/${encodeURIComponent(id)}`)
    setResult(r)
    setExcluded(new Set()) // 每次载入新结果都从"全部计入、看汇总"开始
    setScope('all')
    setSelected(null)
    setHistoryId(id)
    setCfg(fromResultConfig(r.config)) // 打开历史记录时,表单带上当时的配置,方便改一项后重新运行
    setFormOpen(false)
  }

  async function startRun() {
    setError('')
    if (!cfg.url.trim()) return setError('请输入网址')
    let started
    try {
      started = await api('/api/runs', { method: 'POST', body: JSON.stringify(toRequest(cfg)) })
    } catch (e) {
      return setError(e.message)
    }
    const total = started.config.rounds + (started.config.annotate ? 1 : 0)
    let done = 0
    setFormOpen(false)
    setRunning({ id: started.id })
    setResult(null)
    setProgress({ text: '正在启动 Chrome…', frac: 0 })
    const es = new EventSource(`/api/runs/${started.id}/events`)
    esRef.current = es
    const end = () => {
      es.close()
      esRef.current = null
      setRunning(null)
      setProgress(null)
    }
    es.onmessage = async (m) => {
      const ev = JSON.parse(m.data)
      if (ev.type === 'status') setProgress({ text: ev.message, frac: done / total })
      if (ev.type === 'progress') {
        const name = ev.phase === 'annotate' ? '正在录制画面标注轮' : `正在测量第 ${ev.index} / ${ev.total} 轮`
        setProgress({ text: name + '…', frac: done / total })
      }
      if (ev.type === 'round') {
        done++
        if (!ev.ok) setError(`第 ${ev.index} 轮失败:${ev.error}`)
      }
      if (ev.type === 'done') {
        end()
        await refreshHistory(ev.id)
        await loadResult(ev.id)
      }
      if (ev.type === 'error') {
        end()
        setError(ev.message)
      }
    }
    es.onerror = () => {
      // 服务端在结束时会关闭连接;只有在未收到 done / error 且连接确实断开时才视为中断
      if (esRef.current === es && es.readyState === EventSource.CLOSED) end()
    }
  }

  async function cancelRun() {
    if (!running) return
    try {
      await api(`/api/runs/${running.id}/cancel`, { method: 'POST' })
    } catch {}
  }

  async function deleteCurrent() {
    if (!historyId || !confirm('删除这条记录及其截图?')) return
    try {
      await api(`/api/runs/${encodeURIComponent(historyId)}`, { method: 'DELETE' })
      setResult(null)
      setHistoryId('')
      await refreshHistory()
    } catch (e) {
      setError(e.message)
    }
  }

  /** 把结果里的某个元素 / 请求添加为一项自定义检测 */
  function addDetector(partial) {
    const row = emptyDetector(partial)
    // 如果最后一行还是空的,直接用它,避免留下空行
    const last = cfg.detectors[cfg.detectors.length - 1]
    const reuse = last && !last.value.trim() && !last.label.trim()
    const detectors = reuse ? [...cfg.detectors.slice(0, -1), { ...row, uid: last.uid }] : [...cfg.detectors, row]
    const uid = reuse ? last.uid : row.uid
    setCfg({ ...cfg, detectors })
    setFormOpen(true) // 展开表单,让用户看到新加的那一行
    setFlashUid(uid)
    setTimeout(() => setFlashUid(null), 2200)
    window.scrollTo({ top: 0, behavior: 'smooth' })
    toast(`已添加到自定义检测 ${CIRCLED[detectors.findIndex((d) => d.uid === uid)] || ''},点“运行”重新测量`)
  }

  function pick(link) {
    setSelected(link)
    document.getElementById('shot-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /** 警告标签的点击动作 */
  function onWarnAction(a) {
    const go = (id) => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
    if (a.type === 'round') {
      changeScope(a.index)
      go('cards-panel')
    } else if (a.type === 'scroll') {
      go(a.id)
    }
  }

  const okRounds = result ? result.rounds.filter((r) => r.ok) : []

  // 汇总:参与统计的轮次(用户可以排除某几轮)。提醒标签、头部、画面区始终基于汇总。
  const aggView = useMemo(() => (result ? { ...result, summary: computeSummary(result, excluded), excluded } : null), [result, excluded])

  // 汇总轮:把参与统计的各轮合成一条(每一项分别取中位数或平均值),时间线和元素表在汇总模式下用它
  const usedRounds = useMemo(() => {
    const pool = okRounds.filter((r) => !excluded.has(r.index))
    return pool.length ? pool : okRounds
  }, [result, excluded])
  const aggRound = useMemo(() => (result && usedRounds.length ? buildAggregateRound(usedRounds, stat) : null), [result, usedRounds, stat])

  // 当前查看范围:汇总,或者只看某一轮(把其余轮都当作"不参与")
  const scopeView = useMemo(() => {
    if (!result) return null
    if (scope === 'all') return aggView
    const others = new Set(okRounds.filter((r) => r.index !== scope).map((r) => r.index))
    return { ...result, summary: computeSummary(result, others), excluded: others }
  }, [result, excluded, scope])

  // 时间线和元素表显示的"轮":汇总时是合成的汇总轮,单轮时是那一轮本身
  const round = scope === 'all' ? aggRound : result && result.rounds.find((r) => r.index === scope && r.ok)

  function changeScope(s) {
    setScope(s)
    setSelected(null)
  }
  function toggleExclude(index) {
    const next = new Set(excluded)
    next.has(index) ? next.delete(index) : next.add(index)
    setExcluded(next)
  }
  function changeStat(s) {
    setStat(s)
    try {
      localStorage.setItem(STAT_KEY, s)
    } catch {}
  }
  function toggleCard(key) {
    const next = { ...shownCards, [key]: !shownCards[key] }
    setShownCards(next)
    try {
      localStorage.setItem(CARDS_KEY, JSON.stringify(next))
    } catch {}
  }
  return html`<div>
    <header class="topbar">
      <div class="brand">perf-flow <small>${version ? 'v' + version : ''}</small></div>
      <div class="history">
        <label for="history">历史记录</label>
        <select id="history" value=${historyId} onChange=${(e) => e.target.value && loadResult(e.target.value)}>
          <option value="">${history.length ? '— 选择一条历史记录 —' : '(暂无记录)'}</option>
          ${history.map((r) => {
            let host = r.url
            try {
              const u = new URL(r.url)
              host = u.host + u.pathname.slice(0, 24)
            } catch {}
            return html`<option value=${r.id} selected=${historyId === r.id}>${new Date(r.createdAt).toLocaleString()} · ${host} · FCP ${fmt(r.fcp)} / LCP ${fmt(r.lcp)}</option>`
          })}
        </select>
        <button id="btn-del" class="ghost" title="删除当前这条记录" onClick=${deleteCurrent}>删除</button>
      </div>
    </header>

    <main>
      <${Form} cfg=${cfg} setCfg=${setCfg} running=${!!running} onRun=${startRun} onCancel=${cancelRun} error=${error} flashUid=${flashUid}
        open=${formOpen} onEdit=${() => setFormOpen(true)} onCollapse=${result || running ? () => setFormOpen(false) : null} />

      ${progress
        ? html`<section id="progress" class="card">
            <div id="progress-text">${progress.text}</div>
            <div class="bar"><div id="progress-bar" style=${`width:${Math.max(4, Math.round(progress.frac * 100))}%`}></div></div>
          </section>`
        : null}

      ${aggView
        ? html`<section id="result">
            <${Header} result=${aggView} />
            <${Warnings} result=${aggView} onAction=${onWarnAction} />
            <${ScopeBar} result=${aggView} scope=${scope} onScope=${changeScope} stat=${stat} onStat=${changeStat}
              excluded=${excluded} onToggleExclude=${toggleExclude} />
            <${CardsPanel} result=${scopeView} agg=${aggView} scope=${scope} stat=${stat} shown=${shownCards} onToggle=${toggleCard} />
            ${round ? html`<${Timeline} result=${aggView} round=${round} scope=${scope} stat=${stat} onPick=${pick} />` : null}
            <${Shot} result=${aggView} round=${round} scope=${scope} stat=${stat} selected=${selected} onSelect=${setSelected} onAddDetector=${addDetector} />
          </section>`
        : null}
    </main>
    <${TooltipHost} />
    <${ToastHost} />
  </div>`
}

render(html`<${App} />`, document.getElementById('root'))
