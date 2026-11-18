// 界面里用到的说明文字。集中放在这里,方便以后改措辞或做多语言。

export const EXPLAIN = {
  redirect: '访问的地址被跳转到另一个地址,浏览器需要重新发起请求。',
  dns: '把域名解析成 IP 地址。',
  connect: '与服务器建立 TCP 连接;https 还包括 TLS 握手。',
  wait: '请求发出后,等待服务器开始返回数据。包含网络往返和服务器处理时间。这一段的终点就是 TTFB(首字节)。',
  html: '从收到第一个字节到整份 HTML 收完。浏览器边收边解析,期间已经可以开始渲染,不必等它收完。',
  block: '渲染阻塞资源:浏览器在它下载完之前不会绘制页面,所以它会推迟 FCP。',
  fp: '页面第一次有任何像素被画出来,包括纯背景色。',
  fcp: '页面第一次画出文字或图片。浏览器不提供它对应的元素,下面显示的元素是推断的:取与 FCP 同一时刻出现的最早 LCP 候选。',
  lcp: '视口内最大的图片或文字块被绘制的时间。加载过程中它可能被更大的元素取代,最后一个候选才是最终的 LCP。',
  dcl: 'HTML 解析完成,同步脚本执行完毕。',
  load: '页面及其依赖的资源(图片、样式等)全部加载完成。',
  ttfb: '从发起请求到收到 HTML 第一个字节的时间,包含重定向、DNS、连接和服务器处理。',
  htmlDone: 'HTML 全部下载完成的时间。',
}

export const TYPE_LABEL = { selector: 'CSS 选择器', text: '页面文字', request: '网络请求', js: 'JS 表达式' }

export const PLACEHOLDER = {
  selector: '.my-class 或 #id',
  text: '页面上出现的一段文字',
  request: '请求地址包含的关键字(以 re: 开头为正则)',
  js: '返回 true 即命中,如 window.appReady === true',
}

/** 一条自定义检测的条件描述 */
export function describeDetector(d) {
  const v = d.value
  if (d.type === 'selector') return d.state === 'gone' ? `元素 ${v} 由可见变为消失` : `元素 ${v} 出现并可见`
  if (d.type === 'text') return d.state === 'gone' ? `文字“${v}”由出现变为消失` : `页面出现文字“${v}”`
  if (d.type === 'request') return `请求 ${v} ${d.when === 'start' ? '开始' : '完成'}`
  return `表达式 ${v} 为真`
}

export const precisionOf = (d) =>
  d.type === 'request' ? '精确(来自浏览器 Resource Timing)' : '约 1 帧(几十毫秒以内)'
