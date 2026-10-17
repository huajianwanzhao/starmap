#!/usr/bin/env node
// 从 星图.html 生成 03-live.html（在线体验版）。零依赖。
// 两页共用同一份前端代码，只有 4 处不同：标题、页脚、关于里多一段「你现在打开的是在线版」、配置弹窗的直连文案。
// 改完 星图.html 跑一次 node build-live.js 即可，不要手工改 03-live.html。
const fs = require('fs'), path = require('path');
const ROOT = __dirname;
const SRC = path.join(ROOT, '星图.html'), OUT = path.join(ROOT, '03-live.html');
const PATCH = [
  [
    "<title>星图 · 交互原型（联网版）</title>",
    "<title>星图 · 在线体验版</title>"
  ],
  [
    "<span>所有讲解由 AI 实时生成，可能出错 —— 重要内容请自行核对</span>",
    "<span>在线体验版 · 数据只存在你自己的浏览器里 · 讲解由 AI 实时生成，可能出错，请自行核对</span>"
  ],
  [
    "<div class=\"absec\">\n        <h4><span class=\"abi\">✦</span>内容由 AI 生成</h4>",
    "<div class=\"absec\">\n        <h4><span class=\"abi\">⚑</span>你现在打开的是在线版</h4>\n        <p>这一版没有服务端：页面直接在浏览器里调用模型接口（默认 DeepSeek），你填的 API Key 只写进<b>你这个浏览器的 localStorage</b>，不会上传到任何地方——除了它本来就要发给模型服务商的那次请求。</p>\n        <p>你长出来的星图、看过的讲义，同样只存在这个浏览器里。<b>换台电脑、换个浏览器、或者清一次浏览器数据，就会回到初始状态。</b>想让成果落成一个可以备份的文件，请用仓库里的服务端模式（<code>start-server.bat</code>），数据会写进本机的 <code>star.db</code>；也可以点顶栏的「导出」，把整张星图下载成 .md 文件夹。</p>\n        <p>在线版的定位是「先试试看」；它和完整版共用同一份前端代码，功能一致。</p>\n        <p>唯一换不了的是一样东西：<b>模具</b>。讲义「长什么样」定义在服务端的 <code>templates/*.rules</code> 里，这个版本读不到那些文件，只能用内置的那一副默认模具。</p>\n      </div>\n\n      <div class=\"absec\">\n        <h4><span class=\"abi\">✦</span>内容由 AI 生成</h4>"
  ],
  [
    "s.textContent = '直连模式：这个页面直接调用模型接口，不经过任何服务器。",
    "s.textContent = '在线版（直连模式）：这个页面直接调用模型接口，不经过任何服务器。"
  ]
];

let s = fs.readFileSync(SRC, 'utf8'), ok = 0;
for (const [from, to] of PATCH) {
  const c = s.split(from).length - 1;
  if (c === 1) ok++;
  else console.error('× 匹配 ' + c + ' 次（应为 1）：' + from.slice(0, 50).replace(/\n/g, '⏎'));
  s = s.split(from).join(to);
}
fs.writeFileSync(OUT, s, 'utf8');
console.log((ok === PATCH.length ? '✓ 已生成 ' : '! 仅 ') + path.basename(OUT) + '（' + ok + '/' + PATCH.length + ' 处替换，' + s.split('\n').length + ' 行）');
if (ok !== PATCH.length) process.exit(1);
