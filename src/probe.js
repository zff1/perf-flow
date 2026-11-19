/**
 * 注入到被测页面的探针。
 *
 * 注意:这个函数会被 Playwright 序列化为字符串后注入页面(addInitScript),
 * 所以它必须是自包含的,不能引用外部作用域的任何变量。
 *
 * 记录内容:
 *   - first-paint / first-contentful-paint
 *   - 所有 LCP 候选(含元素描述、位置、面积、图片地址)
 *   - 自定义检测(selector / text / request / js)
 *
 * 所有时间都是相对导航开始的毫秒数(performance.now() 时间线)。
 */
export function installProbe(cfg) {
  if (window.__pf) return
  // 浏览器默认只保留 250 条资源计时,请求多的页面会被截断(阻塞资源、请求类检测都会漏)
  try {
    performance.setResourceTimingBufferSize(2000)
  } catch (e) {}
  const pf = (window.__pf = { fp: null, fcp: null, lcp: [], det: {}, runs: [], loafSupported: false })
  const now = () => performance.now()
  const r1 = (n) => Math.round(n * 10) / 10
  const raf = (fn) => requestAnimationFrame(fn)

  // ---------- 元素描述 ----------
  const cssPath = (el) => {
    const parts = []
    let cur = el
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let part = cur.tagName.toLowerCase()
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts.unshift(part + '#' + cur.id)
        break
      }
      const cls =
        typeof cur.className === 'string'
          ? cur.className
              .trim()
              .split(/\s+/)
              .filter((c) => /^[A-Za-z_][\w-]*$/.test(c))
              .slice(0, 2)
          : []
      if (cls.length) part += '.' + cls.join('.')
      else if (cur.parentElement) {
        const same = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'
      }
      parts.unshift(part)
      if (cur === document.body) break
      cur = cur.parentElement
    }
    return parts.join(' > ')
  }
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return null
    const rc = el.getBoundingClientRect()
    const tag = el.tagName.toLowerCase()
    const isMedia = tag === 'img' || tag === 'video' || tag === 'svg' || tag === 'canvas'
    // 是否被其他元素盖住:在元素可见区域内取几个点,看最上层元素是不是它自己(或其后代 / 祖先)
    let covered = null
    let coveredBy = ''
    try {
      const x0 = Math.max(0, rc.left)
      const y0 = Math.max(0, rc.top)
      const x1 = Math.min(window.innerWidth, rc.right)
      const y1 = Math.min(window.innerHeight, rc.bottom)
      if (x1 - x0 > 2 && y1 - y0 > 2) {
        const pts = [
          [0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8],
        ].map(([fx, fy]) => [x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy])
        let hidden = 0
        for (const [px, py] of pts) {
          const top = document.elementFromPoint(px, py)
          if (!top) continue
          // 点到它自己、它的后代、或包含它的祖先(背景层)都不算被遮挡
          if (top === el || el.contains(top)) continue
          if (!hidden) coveredBy = top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + (typeof top.className === 'string' && top.className.trim() ? '.' + top.className.trim().split(/\s+/)[0] : '')
          hidden++
        }
        covered = hidden >= 3 // 5 个采样点里至少 3 个被盖住才判定为遮挡
        if (!covered) coveredBy = ''
      }
    } catch (e) {}
    return {
      tag,
      id: el.id || '',
      class: typeof el.className === 'string' ? el.className.trim().slice(0, 160) : '',
      selector: cssPath(el),
      text: isMedia ? '' : (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      rect: { x: r1(rc.left), y: r1(rc.top), w: r1(rc.width), h: r1(rc.height) },
      covered,
      coveredBy,
    }
  }

  // ---------- 可见性判断 ----------
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false
    const rc = el.getBoundingClientRect()
    if (rc.width <= 0 || rc.height <= 0) return false
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false
    }
    // 图片需要真正加载完成才算"出现"
    if (el.tagName === 'IMG' && !(el.complete && el.naturalWidth > 0)) return false
    return true
  }

  // 在可见文本节点中查找(跳过 script / style 等),返回包含该文本的元素
  const findText = (needle) => {
    if (!document.body) return null
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement
        if (!p) return NodeFilter.FILTER_REJECT
        const t = p.tagName
        return t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE'
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
      },
    })
    let n
    while ((n = walker.nextNode())) {
      if (n.nodeValue.indexOf(needle) !== -1) return n.parentElement
    }
    return null
  }

  // ---------- paint ----------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-paint') pf.fp = r1(e.startTime)
        if (e.name === 'first-contentful-paint') pf.fcp = r1(e.startTime)
      }
    }).observe({ type: 'paint', buffered: true })
  } catch (e) {}

  // ---------- 脚本执行(长动画帧) ----------
  // Resource Timing 只到下载完成,脚本下载之后的"执行"没有记录。Chrome 123+ 的 Long Animation Frames
  // 会报告长于 50 ms 的帧里、每个执行 ≥5 ms 的脚本(来源、起点、耗时)。更短的帧和脚本看不到。
  try {
    pf.loafSupported = (PerformanceObserver.supportedEntryTypes || []).indexOf('long-animation-frame') >= 0
    if (pf.loafSupported) {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          for (const s of e.scripts || []) {
            if (pf.runs.length >= 300) return
            pf.runs.push({
              src: String(s.sourceURL || '').slice(0, 300),
              type: s.invokerType || '',
              invoker: String(s.invoker || '').slice(0, 80),
              fn: String(s.sourceFunctionName || '').slice(0, 60),
              start: r1(s.executionStart),
              dur: r1(s.duration),
              forced: r1(s.forcedStyleAndLayoutDuration || 0),
            })
          }
        }
      }).observe({ type: 'long-animation-frame', buffered: true })
    }
  } catch (e) {}

  // ---------- LCP 候选 ----------
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        pf.lcp.push({
          t: r1(e.startTime),
          // renderTime 为 0 说明浏览器拿不到真正的渲染时间(跨域资源没有 Timing-Allow-Origin),
          // 此时 startTime 其实是资源加载完成的时间,可能早于真正绘制到屏幕
          src: e.renderTime ? 'render' : 'load',
          size: e.size,
          url: e.url || '',
          el: describe(e.element), // 回调时元素若已被移除则为 null
        })
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch (e) {}

  // ---------- 自定义检测 ----------
  const dets = (cfg.detectors || []).map((d) => ({
    id: d.id,
    label: d.label || '',
    type: d.type,
    value: d.value,
    state: d.state || 'visible',
    when: d.when || 'end',
    hit: null, // 条件被观察到的时间
    presented: null, // 约等于用户看到的时间(下一帧起点)
    el: null,
    error: null,
    seen: false,
    last: 0,
    lastEl: null,
    fn: null,
    re: null,
  }))
  dets.forEach((d) => {
    if (d.type === 'js') {
      try {
        d.fn = new Function('return (' + d.value + ')')
      } catch (e) {
        d.error = '表达式语法错误: ' + e.message
      }
    }
    if (d.type === 'selector') {
      try {
        document.createDocumentFragment().querySelector(d.value)
      } catch (e) {
        d.error = '选择器无效'
      }
    }
    if (d.type === 'request' && d.value.indexOf('re:') === 0) {
      // 以 "re:" 开头才按正则处理,否则按子串匹配(避免把 /api/data 这类路径误判成正则)
      try {
        d.re = new RegExp(d.value.slice(3))
      } catch (e) {
        d.error = '正则无效'
      }
    }
    pf.det[d.id] = d
  })

  const markHit = (d, viaRaf) => {
    d.hit = r1(now())
    if (viaRaf) raf((ts) => (d.presented = r1(ts)))
    else raf(() => raf((ts) => (d.presented = r1(ts))))
  }

  const check = (d, viaRaf) => {
    try {
      if (d.type === 'selector') {
        const el = document.querySelector(d.value)
        const vis = isVisible(el)
        if (d.state === 'gone') {
          if (vis) {
            d.seen = true
            d.lastEl = describe(el)
          } else if (d.seen) {
            d.el = d.lastEl
            markHit(d, viaRaf)
          }
        } else if (vis) {
          d.el = describe(el)
          markHit(d, viaRaf)
        }
      } else if (d.type === 'text') {
        const el = findText(d.value)
        const present = !!el && isVisible(el)
        if (d.state === 'gone') {
          if (present) {
            d.seen = true
            d.lastEl = describe(el)
          } else if (d.seen) {
            d.el = d.lastEl
            markHit(d, viaRaf)
          }
        } else if (present) {
          d.el = describe(el)
          markHit(d, viaRaf)
        }
      } else if (d.type === 'js') {
        if (d.fn && d.fn()) markHit(d, viaRaf)
      }
    } catch (e) {
      d.error = String((e && e.message) || e).slice(0, 120)
    }
  }

  const pending = () => dets.some((d) => d.hit === null && !d.error)
  // 文本检测需要遍历 DOM,成本较高:只在 DOM/属性有变化时才扫描,下一帧立即检查
  let domDirty = true
  let lastForce = 0
  try {
    new MutationObserver(() => (domDirty = true)).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
  } catch (e) {}
  const tick = (viaRaf) => {
    const t = now()
    // CSS 动画/过渡改变可见性时不会触发 DOM 变更,所以每 250ms 强制扫描一次
    if (t - lastForce > 250) {
      domDirty = true
      lastForce = t
    }
    let scanned = false
    for (const d of dets) {
      if (d.hit !== null || d.error || d.type === 'request') continue
      if (d.type === 'text') {
        if (!domDirty && !d.seen) continue
        scanned = true
      }
      d.last = t
      check(d, viaRaf)
    }
    if (scanned) domDirty = false
  }
  if (dets.some((d) => d.type !== 'request')) {
    const loop = () => {
      tick(true)
      if (pending()) raf(loop)
    }
    raf(loop)
    // rAF 被浏览器节流时(窗口被遮挡等)的兜底
    const iv = setInterval(() => {
      tick(false)
      if (!pending()) clearInterval(iv)
    }, 50)
  }

  if (dets.some((d) => d.type === 'request')) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          for (const d of dets) {
            if (d.type !== 'request' || d.hit !== null || d.error) continue
            const ok = d.re ? d.re.test(e.name) : e.name.indexOf(d.value) !== -1
            if (!ok) continue
            d.hit = r1(d.when === 'start' ? e.startTime : e.responseEnd)
            d.presented = d.hit
            d.el = { tag: 'request', id: '', class: '', selector: '', text: e.name.slice(0, 200), rect: null }
          }
        }
      }).observe({ type: 'resource', buffered: true })
    } catch (e) {}
  }

  pf.pending = pending
}

/** 页面加载结束后在页面里执行,收集所有数据(同样必须自包含) */
export function collectPage() {
  const pf = window.__pf
  const nav = performance.getEntriesByType('navigation')[0]
  const res = performance.getEntriesByType('resource')
  const r1 = (n) => Math.round(n * 10) / 10
  const dets = {}
  if (pf) {
    for (const id of Object.keys(pf.det)) {
      const d = pf.det[id]
      dets[id] = { id, label: d.label, type: d.type, value: d.value, state: d.state, when: d.when, hit: d.hit, presented: d.presented, el: d.el, error: d.error }
    }
  }
  return {
    url: location.href,
    title: document.title,
    timeOrigin: performance.timeOrigin,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    probe: !!pf,
    fp: pf ? pf.fp : null,
    fcp: pf ? pf.fcp : null,
    lcp: pf ? pf.lcp : [],
    // 长动画帧里记录到的脚本执行(只含 ≥5 ms、且所在帧 >50 ms 的);不支持时 loafSupported 为 false
    scriptRuns: pf ? pf.runs : [],
    loafSupported: !!(pf && pf.loafSupported),
    detectors: dets,
    nav: nav
      ? {
          redirectCount: nav.redirectCount,
          redirectStart: r1(nav.redirectStart),
          redirectEnd: r1(nav.redirectEnd),
          domainLookupStart: r1(nav.domainLookupStart),
          domainLookupEnd: r1(nav.domainLookupEnd),
          connectStart: r1(nav.connectStart),
          secureConnectionStart: r1(nav.secureConnectionStart),
          connectEnd: r1(nav.connectEnd),
          requestStart: r1(nav.requestStart),
          responseStart: r1(nav.responseStart),
          responseEnd: r1(nav.responseEnd),
          domInteractive: r1(nav.domInteractive),
          // 事件触发的时刻(业界通常说的 DCL / load);dclEnd / loadEnd 是事件处理函数跑完的时刻。
          // 旧版本记录里 domContentLoaded / loadEvent 存的是 End,新记录同时有 dclEnd / loadEnd 可以区分。
          // 事件没有触发时,浏览器给的是 0,这里转成 null,避免被当成"0 ms"进入统计
          domContentLoaded: nav.domContentLoadedEventStart > 0 ? r1(nav.domContentLoadedEventStart) : null,
          dclEnd: nav.domContentLoadedEventEnd > 0 ? r1(nav.domContentLoadedEventEnd) : null,
          domComplete: nav.domComplete > 0 ? r1(nav.domComplete) : null,
          loadEvent: nav.loadEventStart > 0 ? r1(nav.loadEventStart) : null,
          loadEnd: nav.loadEventEnd > 0 ? r1(nav.loadEventEnd) : null,
          protocol: nav.nextHopProtocol,
          encodedBodySize: nav.encodedBodySize,
          decodedBodySize: nav.decodedBodySize,
        }
      : null,
    // 服务端通过 Server-Timing 响应头上报的阶段(只有名称和时长,没有起点)。服务端没输出这个头时为空
    serverTiming: nav && nav.serverTiming
      ? Array.from(nav.serverTiming).slice(0, 30).map((s) => ({ name: String(s.name).slice(0, 60), desc: String(s.description || '').slice(0, 120), dur: r1(s.duration) }))
      : [],
    // 完整的资源列表(用来归因 DCL / load);最多保存 400 条
    resources: res.slice(0, 400).map((r) => ({
      name: r.name.length > 300 ? r.name.slice(0, 300) : r.name,
      type: r.initiatorType,
      start: r1(r.startTime),
      end: r1(r.responseEnd),
      rb: r.renderBlockingStatus === 'blocking',
      size: r.transferSize || 0,
    })),
    resourcesTruncated: res.length > 400,
    // <script src> 的加载方式:区分同步(拖住解析)/ defer / module / async
    scripts: Array.from(document.scripts)
      .filter((sc) => sc.src)
      .slice(0, 100)
      .map((sc) => ({
        src: sc.src.length > 300 ? sc.src.slice(0, 300) : sc.src,
        async: !!sc.async,
        defer: !!sc.defer,
        module: sc.type === 'module',
        inHead: !!sc.closest('head'),
      })),
    blockingSupported: res.length === 0 || 'renderBlockingStatus' in res[0],
    blocking: res
      .filter((r) => r.renderBlockingStatus === 'blocking')
      .map((r) => ({ name: r.name.slice(0, 300), type: r.initiatorType, start: r1(r.startTime), end: r1(r.responseEnd) })),
    resourceCount: res.length + 1,
  }
}
