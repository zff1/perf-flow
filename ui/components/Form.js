import { html } from '../lib/h.js'
import { CIRCLED } from '../lib/format.js'
import { TYPE_LABEL, PLACEHOLDER } from '../lib/text.js'

let uidSeq = 1
export const newUid = () => 'u' + uidSeq++

export const DEFAULT_CFG = () => ({
  url: '',
  rounds: 3,
  device: 'desktop',
  settleMs: 3000,
  timeoutSec: 30,
  headless: false,
  annotate: true,
  serverProbe: false,
  detectors: [emptyDetector()],
})

export function emptyDetector(d = {}) {
  return { uid: newUid(), label: '', type: 'selector', value: '', state: 'visible', when: 'end', ...d }
}

/** 表单状态 → 提交给服务端的配置 */
export function toRequest(cfg) {
  return {
    url: cfg.url.trim(),
    rounds: Number(cfg.rounds) || 3,
    device: cfg.device,
    settleMs: Number(cfg.settleMs),
    timeoutMs: Number(cfg.timeoutSec) * 1000,
    headless: !!cfg.headless,
    annotate: !!cfg.annotate,
    serverProbe: !!cfg.serverProbe,
    detectors: cfg.detectors.map((d) => ({ label: d.label.trim(), type: d.type, value: d.value.trim(), state: d.state, when: d.when })),
  }
}

/** 服务端返回的配置 → 表单状态(打开历史记录时使用) */
export function fromResultConfig(c) {
  const dets = (c.detectors || []).map((d) => emptyDetector({ label: d.label || '', type: d.type, value: d.value, state: d.state || 'visible', when: d.when || 'end' }))
  return {
    url: c.url || '',
    rounds: c.rounds || 3,
    device: c.device || 'desktop',
    settleMs: c.settleMs ?? 3000,
    timeoutSec: Math.round((c.timeoutMs || 30000) / 1000),
    headless: !!c.headless,
    annotate: c.annotate !== false,
    serverProbe: !!c.serverProbe,
    detectors: dets.length ? dets : [emptyDetector()],
  }
}

function DetectorRow({ d, index, onChange, onRemove, flash }) {
  const set = (patch) => onChange({ ...d, ...patch })
  return html`<div class=${'drow' + (flash ? ' flash' : '')} key=${d.uid}>
    <span class="no">${CIRCLED[index] || index + 1}</span>
    <input type="text" class="label" placeholder="名称(可选)" value=${d.label} onInput=${(e) => set({ label: e.target.value })} />
    <select value=${d.type} onChange=${(e) => set({ type: e.target.value })}>
      ${Object.entries(TYPE_LABEL).map(([k, v]) => html`<option value=${k} selected=${d.type === k}>${v}</option>`)}
    </select>
    <input type="text" class="value" spellcheck="false" placeholder=${PLACEHOLDER[d.type]} value=${d.value} onInput=${(e) => set({ value: e.target.value })} />
    ${d.type === 'selector' || d.type === 'text'
      ? html`<select value=${d.state} onChange=${(e) => set({ state: e.target.value })}>
          <option value="visible" selected=${d.state === 'visible'}>出现 / 可见</option>
          <option value="gone" selected=${d.state === 'gone'}>消失</option>
        </select>`
      : null}
    ${d.type === 'request'
      ? html`<select value=${d.when} onChange=${(e) => set({ when: e.target.value })}>
          <option value="end" selected=${d.when === 'end'}>响应完成</option>
          <option value="start" selected=${d.when === 'start'}>开始请求</option>
        </select>`
      : null}
    <button class="ghost" title="删除这一项" onClick=${onRemove}>×</button>
  </div>`
}

/** 折叠后的摘要栏:一行看清这次测的是什么,保留"编辑"和"运行" */
function FormBar({ cfg, running, onEdit, onRun, onCancel, error }) {
  const n = cfg.detectors.filter((d) => d.value.trim()).length
  return html`<section class="card formbar" id="form">
    <div class="fb-main">
      <div class="fb-url mono" title=${cfg.url}>${cfg.url || '(未填写网址)'}</div>
      <div class="fb-chips">
        <span>${cfg.rounds} 轮</span>
        <span>${cfg.device === 'mobile' ? '手机' : '桌面'}</span>
        <span>${cfg.headless ? '无头' : '有窗口'}</span>
        <span>${n} 项检测</span>
        ${cfg.annotate ? html`<span>画面标注</span>` : null}
        ${cfg.serverProbe ? html`<span>服务端分析</span>` : null}
      </div>
    </div>
    <div class="fb-actions">
      <button id="btn-edit" onClick=${onEdit} disabled=${running}>编辑</button>
      ${running
        ? html`<button id="btn-cancel" class="danger" onClick=${onCancel}>■ 取消</button>`
        : html`<button id="btn-run" class="primary" onClick=${onRun}>▶ 运行</button>`}
    </div>
    ${error ? html`<div id="form-error" class="error fb-error">${error}</div>` : null}
  </section>`
}

export function Form({ cfg, setCfg, running, onRun, onCancel, error, flashUid, open, onEdit, onCollapse }) {
  const set = (patch) => setCfg({ ...cfg, ...patch })
  const setDet = (uid, next) => set({ detectors: cfg.detectors.map((d) => (d.uid === uid ? next : d)) })
  const delDet = (uid) => set({ detectors: cfg.detectors.filter((d) => d.uid !== uid) })

  if (!open) return html`<${FormBar} cfg=${cfg} running=${running} onEdit=${onEdit} onRun=${onRun} onCancel=${onCancel} error=${error} />`

  return html`<section class="card" id="form">
    <div class="row">
      <input id="url" type="text" spellcheck="false" placeholder="输入要测量的网址,例如 https://example.com" value=${cfg.url}
        onInput=${(e) => set({ url: e.target.value })} onKeyDown=${(e) => e.key === 'Enter' && !running && onRun()} />
      ${onCollapse ? html`<button id="btn-collapse" class="ghost" title="收起表单,只保留摘要" onClick=${onCollapse}>收起</button>` : null}
      ${running
        ? html`<button id="btn-cancel" class="danger" onClick=${onCancel}>■ 取消</button>`
        : html`<button id="btn-run" class="primary" onClick=${onRun}>▶ 运行</button>`}
    </div>

    <div class="row options">
      <label>轮数 <input id="rounds" type="number" min="1" max="20" value=${cfg.rounds} onInput=${(e) => set({ rounds: e.target.value })} />
        ${Number(cfg.rounds) < 3 ? html`<span class="warn small" title="轮数太少时,一次偶发的慢请求就会拉偏中位数">少于 3 轮时中位数不可靠</span>` : null}</label>
      <label>设备
        <select id="device" value=${cfg.device} onChange=${(e) => set({ device: e.target.value })}>
          <option value="desktop" selected=${cfg.device === 'desktop'}>桌面 1280×720</option>
          <option value="mobile" selected=${cfg.device === 'mobile'}>手机 (Pixel 7)</option>
        </select>
      </label>
      <label>加载后等待 <input id="settle" type="number" min="0" max="30000" step="500" value=${cfg.settleMs} onInput=${(e) => set({ settleMs: e.target.value })} /> ms</label>
      <label>超时 <input id="timeout" type="number" min="5" max="120" value=${cfg.timeoutSec} onInput=${(e) => set({ timeoutSec: e.target.value })} /> s</label>
      <label class="check"><input id="headless" type="checkbox" checked=${cfg.headless} onChange=${(e) => set({ headless: e.target.checked })} /> 无头模式(不弹窗口)</label>
      <label class="check"><input id="annotate" type="checkbox" checked=${cfg.annotate} onChange=${(e) => set({ annotate: e.target.checked })} /> 生成画面标注(多跑 1 轮)</label>
      <label class="check" title="只支持本机上运行的 Node 服务"><input id="serverProbe" type="checkbox" checked=${cfg.serverProbe} onChange=${(e) => set({ serverProbe: e.target.checked })} /> 分析服务端(本机 Node 服务)</label>
    </div>
    ${cfg.serverProbe
      ? html`<div class="sp-hint" id="sp-hint">
          测量时会向监听该端口的 Node 进程发送 <span class="mono">SIGUSR1</span>,让它临时打开调试端口(127.0.0.1:9229),并注入一段只读探针,记录页面请求在服务端的耗时和它发出的上游调用(<span class="mono">http</span> / <span class="mono">https</span> / <span class="mono">fetch</span>)。
          测完立即卸载探针并关闭调试端口。<b>不改你的代码,不需要重启服务。</b>只对本机、同一用户的 Node 进程生效;数据库、Redis 等看不到。
        </div>`
      : null}

    <div class="detectors">
      <div class="dhead">
        <strong>自定义检测</strong>
        <span class="hint">测量你关心的页面节点出现 / 消失的时间,因为 FCP、LCP 未必对应真正重要的内容</span>
        <button id="btn-add" class="ghost" onClick=${() => set({ detectors: [...cfg.detectors, emptyDetector()] })}>+ 添加</button>
      </div>
      <div id="det-list">
        ${cfg.detectors.map((d, i) => html`<${DetectorRow} key=${d.uid} d=${d} index=${i} flash=${flashUid === d.uid} onChange=${(n) => setDet(d.uid, n)} onRemove=${() => delDet(d.uid)} />`)}
      </div>
    </div>
    ${error ? html`<div id="form-error" class="error">${error}</div>` : null}
  </section>`
}
