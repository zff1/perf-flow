import { spawn } from 'node:child_process'
import { listen } from './server.js'
import { VERSION } from './runner.js'
import { dataHome } from './store.js'

function parseArgs(argv) {
  const o = { port: 7777, open: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' || a === '-p') o.port = Number(argv[++i])
    else if (a === '--no-open') o.open = false
    else if (a === '--home') process.env.PERF_FLOW_HOME = argv[++i]
    else if (a === '--help' || a === '-h') o.help = true
    else if (a === '--version' || a === '-v') o.version = true
  }
  return o
}

const HELP = `perf-flow ${VERSION}

用法: perf-flow [选项]

启动本地服务并在浏览器中打开操作界面。

选项:
  -p, --port <n>   起始端口(默认 7777,被占用时自动顺延)
      --no-open    不自动打开浏览器
      --home <dir> 结果保存目录(默认 ~/.perf-flow)
  -v, --version    显示版本
  -h, --help       显示帮助

环境变量:
  PERF_FLOW_CHROME  指定 Chrome 可执行文件路径(默认自动查找已安装的 Google Chrome)
  PERF_FLOW_HOME    同 --home
`

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {}
}

export async function main(argv) {
  const o = parseArgs(argv)
  if (o.help) return console.log(HELP)
  if (o.version) return console.log(VERSION)
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65500) {
    console.error('端口不合法')
    process.exit(1)
  }
  const { port } = await listen(o.port)
  const url = `http://127.0.0.1:${port}/`
  console.log(`perf-flow ${VERSION}`)
  console.log(`界面地址:${url}`)
  console.log(`结果目录:${dataHome()}`)
  console.log('按 Ctrl+C 退出')
  if (o.open) openBrowser(url)
}
