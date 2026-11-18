/**
 * 演示页面:用来体验 perf-flow 的所有功能,不依赖任何外部网站。
 *
 *   npm run demo        # 启动在 http://127.0.0.1:9090/
 *
 * 页面时间线(大致):
 *   0ms     HTML 第一段到达(加载遮罩 #mask + 标题 #title)
 *   +400ms  CSS 返回(渲染阻塞,FCP 要等它)
 *   +800ms  HTML 第二段到达(带一张延迟 900ms 的大图 #hero)
 *   +600ms  脚本请求 /api/data
 *   +1800ms 遮罩消失,出现 #app-ready
 */
import http from 'node:http'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = Number(process.env.PORT || 9090)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.write(`<!doctype html><html><head><meta charset="utf-8"><title>perf-flow demo</title>
<link rel="stylesheet" href="/slow.css"></head><body>
<div id="mask"><span>加载中…</span></div>
<h1 id="title">perf-flow 演示页面</h1>`)
    await delay(800)
    res.write(`<img id="hero" class="hero" src="/hero.svg" width="960" height="400" alt="hero">
<p class="note">这段文字在 HTML 第二段里。</p>
<script>
  fetch('/api/data').then(r => r.json()).then(d => {
    setTimeout(() => {
      document.getElementById('mask').style.display = 'none'
      const el = document.createElement('div')
      el.id = 'app-ready'; el.className = 'app-ready'; el.textContent = '应用就绪:' + d.msg
      document.body.appendChild(el)
    }, 1200)
  })
</script></body></html>`)
    res.end()
  } else if (url.pathname === '/slow.css') {
    await delay(400)
    res.writeHead(200, { 'Content-Type': 'text/css' })
    res.end(`body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#222}
#mask{position:fixed;inset:0;background:#181a1c;color:#ccc;display:flex;align-items:center;justify-content:center;z-index:9}
#title{margin:24px}.hero{display:block;margin:0 24px;border-radius:8px}.note{margin:16px 24px}
.app-ready{margin:24px;padding:12px;background:#d9f7e5;border-radius:6px}`)
  } else if (url.pathname === '/hero.svg') {
    await delay(900)
    // 浏览器会忽略"信息量过低"的图片(每像素比特数太小)作为 LCP 候选,
    // 所以这里用确定性的伪随机色块生成一张有足够信息量的图。
    let seed = 42
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    let shapes = ''
    for (let i = 0; i < 700; i++) {
      const c = `hsl(${Math.floor(rnd() * 360)},70%,${40 + Math.floor(rnd() * 30)}%)`
      shapes += `<rect x="${Math.floor(rnd() * 940)}" y="${Math.floor(rnd() * 380)}" width="${10 + Math.floor(rnd() * 60)}" height="${10 + Math.floor(rnd() * 40)}" fill="${c}" opacity="0.${5 + Math.floor(rnd() * 5)}"/>`
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' })
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="960" height="400"><rect width="960" height="400" fill="#335"/>${shapes}<text x="40" y="220" font-size="48" fill="#fff" font-family="sans-serif">hero image</text></svg>`)
  } else if (url.pathname === '/api/data') {
    await delay(600)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ msg: 'ok' }))
  } else {
    res.writeHead(404).end()
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`demo: http://127.0.0.1:${PORT}/`))
