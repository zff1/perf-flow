// 演示用的后端,用来体验"分析服务端":它在处理页面请求时先串行调用一个上游接口,
// 再并行调用两个(一个走 http 模块,一个走原生 fetch),最后做 80 ms 的同步计算。
//
//   node examples/upstream-demo.cjs
//   然后在 perf-flow 里输入 http://127.0.0.1:9494/page,勾选"分析服务端"。
//
// 预期:时间线的"服务端"组里能看到 /fast 在先,/slow-a 与 /slow-b 并行,
// 最后约 80 ms 的空白被标成"无法识别"(同步计算探针看不到)。
const http = require('http')

// 模拟上游接口
http
  .createServer((req, res) => {
    const delay = req.url.startsWith('/slow') ? 300 : 50
    setTimeout(() => res.end('{"ok":true}'), delay)
  })
  .listen(9495, '127.0.0.1')

http
  .createServer((req, res) => {
    if (!req.url.startsWith('/page')) {
      res.statusCode = 404
      return res.end('not found')
    }
    http.get('http://127.0.0.1:9495/fast', (r1) => {
      r1.resume()
      r1.on('end', () => {
        let left = typeof fetch === 'function' ? 2 : 1
        const done = () => {
          if (--left) return
          const t = Date.now()
          while (Date.now() - t < 80) {} // 模拟服务端自己的同步计算
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end('<!doctype html><title>demo</title><h1>hello</h1>')
        }
        http.get('http://127.0.0.1:9495/slow-a', (r2) => {
          r2.resume()
          r2.on('end', done)
        })
        if (typeof fetch === 'function') fetch('http://127.0.0.1:9495/slow-b').then((r) => r.text()).then(done)
      })
    })
  })
  .listen(9494, '127.0.0.1', () => console.log('演示后端已启动:http://127.0.0.1:9494/page(Node ' + process.version + ')'))
