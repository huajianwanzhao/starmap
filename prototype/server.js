/* 星图 · 本地服务器
   1) 提供静态页面
   2) 代理大模型 API —— API Key 只在服务端，绝不进前端
   3) 按「生成契约」约束输出（行协议），并对结果做自动质检
   -----------------------------------------------------------
   启动：  node server.js
   配置：  编辑同目录下的 config.json
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let CFG = { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', port: 5173,
            embedModel: '', embedBaseUrl: '', embedApiKey: '' };
try {
  const p = path.join(ROOT, 'config.json');
  if (fs.existsSync(p)) Object.assign(CFG, JSON.parse(fs.readFileSync(p, 'utf8')));
} catch (e) { console.warn('[config] 读取失败：' + e.message); }
if (process.env.LLM_API_KEY)  CFG.apiKey  = process.env.LLM_API_KEY;
if (process.env.LLM_BASE_URL) CFG.baseUrl = process.env.LLM_BASE_URL;
if (process.env.LLM_MODEL)    CFG.model   = process.env.LLM_MODEL;
/* config.json 里若还留着中文占位符，就当没配置 —— 否则会用非 ASCII 字符发请求而报 ByteString 错 */
function keyLooksValid(k) {
  if (!k || k.length < 10) return false;
  for (let i = 0; i < k.length; i++) { const c = k.charCodeAt(i); if (c < 33 || c > 126) return false; }
  return true;
}
if (!keyLooksValid(CFG.apiKey)) CFG.apiKey = '';
const PORT = Number(process.env.PORT || CFG.port || 5173);

/* ---------- 数据库（Node 内置 sqlite，零依赖） ---------- */
let DB = null;
function openDb() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(path.join(ROOT, 'star.db'));
    d.exec([
      'CREATE TABLE IF NOT EXISTS clusters (id TEXT PRIMARY KEY, name TEXT, cx REAL, cy REAL, hue INTEGER, aliases TEXT, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, cluster_id TEXT, parent_id TEXT, kind TEXT, label TEXT, rel TEXT, why TEXT, question TEXT, x REAL, y REAL, visited INTEGER, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS edges (a TEXT, b TEXT, cluster_id TEXT, cross INTEGER, manual INTEGER, rel TEXT, rt TEXT, PRIMARY KEY (a, b))',
      'CREATE TABLE IF NOT EXISTS lectures (cache_key TEXT PRIMARY KEY, body TEXT, problems TEXT, created_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS generations (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, concept TEXT, topic TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER, ok INTEGER, problems TEXT, created_at INTEGER)'
    ].join(';'));
    /* 老库补列：edges.rel（双链上那句「它俩是什么关系」）。CREATE TABLE IF NOT EXISTS 不会改已有表，
       所以必须单独 ALTER 一次；已经有了就报错，吞掉即可。 */
    try { d.exec('ALTER TABLE edges ADD COLUMN rel TEXT'); } catch (e) { /* 列已存在 */ }
    try { d.exec('ALTER TABLE edges ADD COLUMN rt TEXT'); } catch (e) { /* 列已存在 */ }
    console.log('[db] 已连接');
    return d;
  } catch (e) {
    console.warn('[db] 不可用，本次运行不持久化：' + e.message);
    return null;
  }
}
function loadState() {
  if (!DB) return { clusters: [], nodes: [], edges: [] };
  return {
    clusters: DB.prepare('SELECT * FROM clusters ORDER BY created_at').all(),
    nodes: DB.prepare('SELECT * FROM nodes ORDER BY created_at').all(),
    edges: DB.prepare('SELECT * FROM edges').all()
  };
}
function saveState(s) {
  if (!DB) return false;
  DB.exec('BEGIN');
  try {
    DB.exec('DELETE FROM clusters; DELETE FROM nodes; DELETE FROM edges;');
    const ci = DB.prepare('INSERT INTO clusters (id,name,cx,cy,hue,aliases,created_at) VALUES (?,?,?,?,?,?,?)');
    for (const c of (s.clusters || [])) ci.run(String(c.id), String(c.name || ''), Number(c.cx) || 0, Number(c.cy) || 0, Number(c.hue) || 0, JSON.stringify(c.aliases || []), Date.now());
    const ni = DB.prepare('INSERT INTO nodes (id,cluster_id,parent_id,kind,label,rel,why,question,x,y,visited,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const n of (s.nodes || [])) ni.run(String(n.id), String(n.clusterId || n.cluster_id || ''), (n.parentId || n.parent_id) ? String(n.parentId || n.parent_id) : null, String(n.kind || 'concept'), String(n.label || ''), n.rel == null ? null : String(n.rel), n.why == null ? null : String(n.why), n.question == null ? null : String(n.question), Number(n.x) || 0, Number(n.y) || 0, n.visited ? 1 : 0, Date.now());
    const ei = DB.prepare('INSERT OR REPLACE INTO edges (a,b,cluster_id,cross,manual,rel,rt) VALUES (?,?,?,?,?,?,?)');
    for (const e of (s.edges || [])) ei.run(String(e.a), String(e.b), String(e.clusterId || e.cluster_id || ''), e.cross ? 1 : 0, e.manual ? 1 : 0, e.rel == null ? null : String(e.rel), e.rt == null ? null : String(e.rt));
    DB.exec('COMMIT');
    return true;
  } catch (e) {
    try { DB.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }
}
function rememberLecture(key, text, problems) {
  if (!DB) return;
  try {
    DB.prepare('INSERT OR REPLACE INTO lectures (cache_key,body,problems,created_at) VALUES (?,?,?,?)')
      .run(key, text, problems && problems.length ? problems.join('；') : '', Date.now());
  } catch (e) { console.warn('[db] 讲义写入失败：' + e.message); }
}
function recallLecture(key) {
  if (!DB) return null;
  try {
    const row = DB.prepare('SELECT body, problems FROM lectures WHERE cache_key = ?').get(key);
    if (!row) return null;
    return { text: row.body, check: row.problems ? String(row.problems).split('；') : [] };
  } catch (e) { return null; }
}
function recordGeneration(g) {
  if (!DB) return;
  try {
    DB.prepare('INSERT INTO generations (node_id,concept,topic,model,prompt_tokens,completion_tokens,cached_tokens,ok,problems,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(g.nodeId, g.concept, g.topic, g.model, g.promptTokens, g.completionTokens, g.cachedTokens, g.ok, g.problems, Date.now());
  } catch (e) { console.warn('[db] 用量写入失败：' + e.message); }
}

/* ---------- 生成契约 ----------
   下面的 PROTOCOL 是**冻结**的协议骨架：13 个标签、行协议、自检会拦的那几条。
   用户改不到它。能改的只有 templates/*.rules 里那几副「模具」（说人话的方式），
   模具是追加在协议**后面**的 —— 所以改坏一个模具，最多是讲义难看，解析不会碎。 */
const PROTOCOL = [
  '你是一个教科书级的解释者，但不预设学科：数学、物理、人文、艺术、工程一样对待。用户在探索一张知识星图，刚点开一个概念，你要写一份极短的讲义。',
  '',
  '【输出格式：行协议，必须严格遵守】',
  '每行以 ## 开头，标签 + 空格 + 内容。不要输出任何其他文字，不要用 markdown 代码块，不要用列表符号。',
  '',
  '##COMMON 大多数人以为：<一句流行的错误理解>',
  '##INSIGHT 其实<一句反直觉的真相>',
  '##LIST <条目> | <一句为什么它值得一提>   ← 只在清单型问题下使用，最多 10 行；其它情况不要输出这一行',
  '##SCENE <一个具体画面：不出现任何专业名词，不超过两句，必须含一个具体数字或量词，以及一个身体动作或感官>',
  '##MECH <它是怎么工作的，一段；可以有多行 ##MECH>',
  '##FORMULA <公式。用 Unicode 直接写：θ η λ ∇ ≤ 等，不要写 LaTeX 反斜杠>',
  '##READ <把公式念成中文。不要自己加「读作：」前缀，前端会统一加>',
  '##SYM <符号> | <它是什么>',
  '##BOUNDS <它在什么时候失效或不成立>',
  '##MIS <一个常见误解>',
  '##CHILD <子概念名> | <它回答的下一个问题> | <关系词> | <一句话为什么值得点进去>',
  '',
  '【硬性规则】',
  '1. 洞察必须反直觉：##INSIGHT 里必须出现「其实/并不是/并非/反而/恰恰/只有」其中之一。禁止写成定义句；也不许在 ##INSIGHT 里出现这个概念的名字本身（用「它」代替），否则就是在下定义。',
  '2. 画面必须自足：##SCENE 里不许出现任何专业名词，不许出现其他概念的名字。',
  '3. 公式若写，必须同时给出 ##READ 和至少两个 ##SYM；若这个概念没有合适的公式，就整体省略这三行。',
  '4. 必须写 ##BOUNDS。',
  '5. ##CHILD 最多 4 行，第二个字段必须是「下一个困惑」，不是「相关概念」。每个子概念都必须能从「本次要讲的概念」本身自然引出；如果这个概念你了解得太少、想不出真正相关的子概念，就少写几个（允许只写 1 个甚至完全不写），绝对不许拿别的领域的术语来凑数。',
  '6. 禁止用别的概念来定义当前概念。顺序永远是：画面 → 现象 → 最后才给它名字。',
  '7. 正文总长不超过 400 字（公式与符号表不算）。宁可短。',
  '8. 清单型问题（问「有哪些 / 哪几个 / 分几类 / 都包括 / 包含哪些」）必须先用 ##LIST 逐条列出来，一条一行，最多 10 行，每条都跟一句"为什么它值得一提"；此时禁止纠错式开场，#COMMON 不要写成"你以为……其实不是"，改成「这题常常被当成一个背诵清单，但清单是怎么被选出来的，本身就是答案」。',
  '9. 一个词可能在好几个学科里有完全不同的含义（正则化、熵、梯度、收敛…）。必须先看「当前正在探索的问题」的语境：语境落在数学/物理/人文，就绝不要默认取机器学习或计算机里的那一支。若另一种含义极其常见，可以在 ##MIS 里补一句「另一个学科里它指的不是这个」，但正文主体必须落在当前语境这一支上。',
  '',
  '关系词只能从这些里选：前置 / 参数 / 上游 / 陷阱 / 变体 / 技巧 / 应用 / 对比 / 延伸'
].join('\n');

/* ---------- 模具：讲义长什么样，是一段文本，不是一个功能 ----------
   文件格式（templates/*.rules）：
     开头连续的 # 行 = 说明，会显示在页面的模具列表里
     第一个不是 # 开头的行之后 = 正文，原样追加到协议后面
   文件名就是名字（去掉前面的序号），所以「复制一个文件、改掉内容」就是一个新模具。
   每次请求都重新读盘：改完文件刷新页面就生效，不用重启服务。 */
const TPL_DIR = path.join(ROOT, 'templates');
const TPL_DEFAULT = '00-默认';
function tplParse(raw) {
  const lines = String(raw || '').split('\n');
  const desc = [], ui = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.charAt(0) === '@') {   /* @小节名 = 这副本子里这一节叫什么；只改页面上的小标题，不改行协议 */
      const eq = t.indexOf('=');
      if (eq > 1) ui[t.slice(1, eq).trim()] = t.slice(eq + 1).trim();
      continue;
    }
    if (t.charAt(0) !== '#' || t.slice(0, 2) === '##') break;   /* ## 是行协议的标签，不是注释 */
    desc.push(t.replace(/^#+\s*/, ''));
  }
  while (i < lines.length && !lines[i].trim()) i++;
  return { desc: desc.join(' · '), text: lines.slice(i).join('\n').trim(), ui: ui };
}
function tplName(id) { return String(id).replace(/^\d+[-_.\s]*/, ''); }
function listTemplates() {
  let names = [];
  try { names = fs.readdirSync(TPL_DIR).filter(function (f) { return /\.rules$/i.test(f); }); } catch (e) { return []; }
  names.sort();
  const out = [];
  for (const f of names) {
    const id = f.replace(/\.rules$/i, '');
    let raw = '';
    try { raw = fs.readFileSync(path.join(TPL_DIR, f), 'utf8'); } catch (e) { continue; }
    const p = tplParse(raw);
    out.push({ id: id, name: tplName(id), desc: p.desc, text: p.text, ui: p.ui });
  }
  return out;
}
function publicTemplates() {
  return listTemplates().map(function (t) {
    return { id: t.id, name: t.name, desc: t.desc, chars: t.text.length,
             ui: t.ui || {},
             excerpt: t.text.replace(/\s+/g, ' ').slice(0, 120), empty: !t.text };
  });
}
/* 当前该用哪一副：请求里带的 > config.json 里存的 > 默认 */
function templateBlock(id) {
  const list = listTemplates();
  const want = String(id || CFG.template || TPL_DEFAULT);
  let t = null;
  for (const x of list) if (x.id === want) t = x;
  if (!t) for (const x of list) if (x.id === TPL_DEFAULT) t = x;
  if (!t) return { id: '', name: '', text: '', ui: {} };   /* 模板目录被删光了：退回纯协议，照常能生成 */
  return { id: t.id, name: t.name, ui: t.ui || {},
           text: '\n\n【这一次用的模具：' + t.name + '】\n' + t.text };
}

/* 事实模式的追加规则：不塞进 PROTOCOL，因为 PROTOCOL 描述的是「原理」那副模具。
   两个模式各自追加，互不污染；客户端直连模式里那份内置 RULES 也因此不用改。 */
const FACT_ADD = '\n\n【本次追加 · 事实模式】\n用户要的只是一个事实，不是理解。所以：\n' +
  '1. 第一行必须是 ##FACT <直接答案，一句话，不超过 40 字>。不许用 ##COMMON / ##INSIGHT 开场，不许先讲背景再给答案，不许制造悬念。\n' +
  '2. 给完答案之后，最多再写 ##MECH <它为什么会是这样，一到两段>。\n' +
  '3. 禁止输出 ##COMMON / ##INSIGHT / ##SCENE / ##BOUNDS / ##LIST / ##CHILD —— 事实问题不需要反直觉开场，也不需要「它在什么时候失效」；事实是一个终点，不是新探索的起点，继续深入交给前端那个「为什么会这样」按钮。\n' +
  '4. 即使答案很平淡、很无聊、一句话就说完，也要照直说。不要为了显得深刻而制造悬念。\n' +
  '5. 若答案有争议或你不确定，##FACT 里写清楚「通常认为……」，宁可承认不确定，也绝不编造具体数字、年份或人名。';

const SEED_SYS = [
  '你是一个知识地图的编辑。用户刚问了一个问题，你要把它拆成 4 个可以往下钻的概念。',
  '只输出 4 行，每行格式如下，不要有任何其他文字、不要有代码块：',
  '##CHILD <子概念名> | <它回答的下一个问题> | <关系词> | <一句话为什么值得点进去>',
  '第二个字段必须是「下一个困惑」—— 即用户读完当前回答后自然会产生的问题，不是「相关概念」。',
  '关系词只能从这些里选：前置 / 参数 / 上游 / 陷阱 / 变体 / 技巧 / 应用 / 对比 / 延伸'
].join('\n');

/* ---------- 与模型通信 ---------- */
function apiUrl() {
  let b = CFG.baseUrl;
  while (b.length && b.charAt(b.length - 1) === '/') b = b.slice(0, -1);
  return b + '/chat/completions';
}
async function llmStream(messages, onDelta, sink) {
  const res = await fetch(apiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CFG.apiKey },
    body: JSON.stringify({ model: CFG.model, messages: messages, stream: true, temperature: 0.7 })
  });
  if (!res.ok) throw new Error('模型接口返回 ' + res.status + '：' + (await res.text()).slice(0, 300));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.slice(0, 5) !== 'data:') continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        if (j.usage && sink) sink.usage = j.usage;
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) { full += t; if (onDelta) onDelta(t); }
      } catch (e) { /* 忽略不完整的分片 */ }
    }
  }
  return full;
}
async function llmOnce(messages) { return llmStream(messages, null); }

/* ---------- 行协议解析 ---------- */
function parseTag(line) {
  if (line.slice(0, 2) !== '##') return null;
  const i = line.indexOf(' ');
  if (i < 0) return null;
  return { tag: line.slice(2, i), rest: line.slice(i + 1).trim() };
}
function parseLineProtocol(text) {
  const out = { common: '', insight: '', fact: '', scene: [], mech: [], formula: null, bounds: [], mis: [], list: [], children: [], title: '', rel: '', raw: text };
  for (const raw of text.split('\n')) {
    const p = parseTag(raw.split('\r').join(''));
    if (!p) continue;
    if (p.tag === 'COMMON') out.common = p.rest;
    else if (p.tag === 'INSIGHT') out.insight = p.rest;
    else if (p.tag === 'TITLE') out.title = p.rest;   /* 只有「关系/双链」这两条分支会输出它 */
    else if (p.tag === 'REL') out.rel = p.rest;
    else if (p.tag === 'FACT') out.fact = p.rest;
    else if (p.tag === 'SCENE') out.scene.push(p.rest);
    else if (p.tag === 'MECH') out.mech.push(p.rest);
    else if (p.tag === 'FORMULA') out.formula = { tex: p.rest, read: '', symbols: [] };
    else if (p.tag === 'READ') { if (out.formula) out.formula.read = p.rest; }
    else if (p.tag === 'SYM') {
      const q = p.rest.split('|');
      if (out.formula && q.length >= 2) out.formula.symbols.push([q[0].trim(), q[1].trim()]);
    }
    else if (p.tag === 'BOUNDS') out.bounds.push(p.rest);
    else if (p.tag === 'MIS') out.mis.push(p.rest);
    else if (p.tag === 'LIST') {
      const q = p.rest.split('|').map(function (s) { return s.trim(); });
      if (q[0] && out.list.length < 10) out.list.push({ item: q[0], why: q[1] || '' });
    }
    else if (p.tag === 'CHILD') {
      const q = p.rest.split('|').map(function (s) { return s.trim(); });
      if (q.length >= 4) out.children.push({ concept: q[0], question: q[1], relation: q[2], why: q[3] });
    }
  }
  return out;
}

/* ---------- 四条自动质检 ---------- */
const DIGITS = '0123456789０１２３４５６７８９一二三四五六七八九十百千万两';
const TURNS = ['其实', '并不是', '并非', '反而', '恰恰', '只有'];
function hasDigit(s) {
  for (let i = 0; i < s.length; i++) if (DIGITS.indexOf(s.charAt(i)) >= 0) return true;
  return false;
}
function hasTurn(s) {
  for (let i = 0; i < TURNS.length; i++) if (s.indexOf(TURNS[i]) >= 0) return true;
  return false;
}
const ENUM_Q = /有哪些|哪几个|哪几种|分几类|分为几类|都包括|包含哪些|有哪几/;
function isEnumQuestion(s) { return !!s && ENUM_Q.test(s); }
function selfCheck(p, concept, seen, parent, isRel, isFact) {
  const problems = [];
  /* 关系讲义天然要同时点名 A 和 B，所以「洞察里出现本节点名 / 子概念名」这几条对它不适用 */
  const childNames = p.children.map(function (c) { return c.concept; });
  const sceneAll = p.scene.join(' ');
  // 1. 洞察里出现本节点名 → 它在下定义
  if (!isRel && !isFact) {
  if (p.insight && p.insight.indexOf(concept) >= 0) problems.push('洞察里出现了本节点名（在下定义）');
  // 2. 洞察/画面里出现别的概念名 → 耦合
  for (let i = 0; i < childNames.length; i++) {
    const n = childNames[i];
    if (n && n.length >= 2 && p.insight.indexOf(n) >= 0) problems.push('洞察里出现了子概念「' + n + '」（耦合）');
  }
  if (sceneAll && concept && sceneAll.indexOf(concept) >= 0) problems.push('画面里出现了本节点名（不自足）');
  for (let i = 0; i < childNames.length; i++) {
    const n = childNames[i];
    if (n && n.length >= 2 && sceneAll.indexOf(n) >= 0) problems.push('画面里出现了子概念「' + n + '」（不自足）');
  }
  }
  /* 事实模式（用户明确说「我只想知道一个事实」）：模具整个不一样，下面这些检查全部不适用。
     事实只需要一件事 —— 答案在第一行，而且是一句话。 */
  if (isFact) {
    if (!p.fact) problems.push('事实模式没有写 ##FACT 直答');
    else if (p.fact.length > 60) problems.push('##FACT 太长（' + p.fact.length + ' 字）—— 事实要一句话说完');
    if (p.insight) problems.push('事实模式不该写 ##INSIGHT（那是原理模式的反直觉开场）');
    if (p.common) problems.push('事实模式不该写 ##COMMON（别把用户的问题当他的误解）');
    return problems;
  }
  // 3. 画面必须具体
  if (p.scene.length && !hasDigit(sceneAll)) problems.push('画面里没有具体数字或量词');
  // 4. 洞察必须反直觉
  if (!p.insight) problems.push('没有写洞察');
  else if (!hasTurn(p.insight)) problems.push('洞察里没有转折词（其实/并不是/反而/恰恰/只有）');
  // 结构完整性
  if (!p.bounds.length) problems.push('没有写失效条件');
  if (!p.children.length) problems.push('没有给出子概念');
  if (p.children.length > 4) problems.push('子概念超过 4 个');
  // 5. 清单型问题必须真的给出清单
  if (!isRel && isEnumQuestion(concept) && !p.list.length) problems.push('这是清单型问题，却没有给 ##LIST 清单');
  // 6. 子概念不许反过来指回本节点或它的来路（否则图上出现 A→B→A 绕圈）
  for (let i = 0; isRel ? false : i < childNames.length; i++) {
    const n = childNames[i];
    if (n && n === concept) problems.push('子概念「' + n + '」就是本节点（循环）');
    if (n && parent && n === parent) problems.push('子概念「' + n + '」指回了来路「' + parent + '」（循环）');
  }
  return problems;
}

/* ---------- 语义去重：向量召回 + 模型裁决 ---------- */
const CONCEPTS = new Map();      /* 规范名 -> { name, summary, vec, aliases: [] } */
let embedBroken = false;

function stripSlash(u) { let b = u; while (b.length && b.charAt(b.length - 1) === '/') b = b.slice(0, -1); return b; }

async function embed(text) {
  if (embedBroken) return null;
  const url = stripSlash(CFG.embedBaseUrl || CFG.baseUrl) + '/embeddings';
  const model = CFG.embedModel || 'text-embedding-3-small';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (CFG.embedApiKey || CFG.apiKey) },
      body: JSON.stringify({ model: model, input: text })
    });
    if (!res.ok) { embedBroken = true; console.warn('[embed] 接口不可用（' + res.status + '），已退化为按名字去重：' + (await res.text()).slice(0, 120)); return null; }
    const j = await res.json();
    return (j.data && j.data[0] && j.data[0].embedding) || null;
  } catch (e) {
    embedBroken = true;
    console.warn('[embed] 调用失败，已退化为按名字去重：' + e.message);
    return null;
  }
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? s / d : 0;
}

/* 第一段：宽召回。阈值故意放低，宁可多召回，交给第二段去筛 */
const RECALL_MIN = 0.72, RECALL_K = 5;
function recall(vec) {
  const out = [];
  for (const c of CONCEPTS.values()) {
    if (!c.vec) continue;
    const s = cosine(vec, c.vec);
    if (s >= RECALL_MIN) out.push({ c: c, s: s });
  }
  out.sort(function (x, y) { return y.s - x.s; });
  return out.slice(0, RECALL_K);
}

/* 第二段：模型裁决 —— 把"同义"和"相关"分开 */
const ADJ_SYS = [
  '你在做知识图谱的实体消歧。判断两个概念是不是同一个东西。',
  '只输出一行，两种格式之一：',
  'SAME <候选编号> | <不超过 20 字的理由>',
  'DIFF | <不超过 20 字的理由>',
  '判 SAME：同义词、别名、不同译法（例如「维数灾难」与「维数诅咒」）。',
  '判 DIFF：只是相关、上下位关系、或不同领域的同名（例如「核」在物理与生物里）。'
].join('\n');

async function adjudicate(name, summary, cands) {
  const lines = ['新概念：' + name + ' —— ' + (summary || '（无说明）'), ''];
  for (let i = 0; i < cands.length; i++) {
    lines.push('候选' + (i + 1) + '：' + cands[i].c.name + ' —— ' + (cands[i].c.summary || '（无说明）') + '　相似度 ' + cands[i].s.toFixed(3));
  }
  lines.push('');
  lines.push('新概念和某个候选是同一个东西吗？');
  try {
    const t = String(await llmOnce([{ role: 'system', content: ADJ_SYS }, { role: 'user', content: lines.join('\n') }])).trim();
    if (t.slice(0, 4) === 'SAME') {
      const rest = t.slice(4).trim();
      let num = '';
      for (let i = 0; i < rest.length; i++) {
        const ch = rest.charAt(i);
        if (ch >= '0' && ch <= '9') num += ch; else break;
      }
      const idx = num ? (parseInt(num, 10) - 1) : 0;
      const parts = rest.split('|');
      return { same: true, idx: idx, reason: parts.length > 1 ? parts.slice(1).join('|').trim() : '' };
    }
    const p2 = t.split('|');
    return { same: false, reason: p2.length > 1 ? p2.slice(1).join('|').trim() : '' };
  } catch (e) {
    return null;
  }
}

/* 持久化：这个规模不需要向量数据库，内存暴力算余弦就够 */
const CONCEPTS_FILE = path.join(ROOT, 'concepts.json');
function loadConcepts() {
  try {
    if (!fs.existsSync(CONCEPTS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(CONCEPTS_FILE, 'utf8'));
    for (const c of arr) CONCEPTS.set(c.name, { name: c.name, summary: c.summary || '', vec: c.vec || null, aliases: c.aliases || [] });
  } catch (e) { console.warn('[concepts] 读取失败：' + e.message); }
}
function saveConcepts() {
  try {
    fs.writeFileSync(CONCEPTS_FILE, JSON.stringify(Array.from(CONCEPTS.values()), null, 0), 'utf8');
  } catch (e) { console.warn('[concepts] 保存失败：' + e.message); }
}
function knownNames() { return Array.from(CONCEPTS.keys()); }

/* ---------- 配置读写 ---------- */
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}
function publicConfig() {
  const cur = templateBlock(CFG.template || TPL_DEFAULT);
  return { baseUrl: CFG.baseUrl, model: CFG.model, hasKey: !!CFG.apiKey, mask: maskKey(CFG.apiKey),
           template: cur.id || CFG.template || TPL_DEFAULT, templateName: tplName(cur.id || CFG.template || TPL_DEFAULT),
           templateUi: cur.ui || {} };
}
function saveConfig(patch) {
  const next = { baseUrl: CFG.baseUrl, apiKey: CFG.apiKey, model: CFG.model, port: CFG.port,
                 embedModel: CFG.embedModel, embedBaseUrl: CFG.embedBaseUrl, embedApiKey: CFG.embedApiKey,
                 template: CFG.template || TPL_DEFAULT };
  if (typeof patch.template === 'string' && patch.template) next.template = patch.template;
  if (patch.embedModel !== undefined) next.embedModel = String(patch.embedModel || '').trim();
  if (patch.embedBaseUrl !== undefined) next.embedBaseUrl = String(patch.embedBaseUrl || '').trim();
  if (typeof patch.embedApiKey === 'string' && patch.embedApiKey.trim() && patch.embedApiKey.indexOf('*') < 0) next.embedApiKey = patch.embedApiKey.trim();
  if (patch.baseUrl) next.baseUrl = String(patch.baseUrl).trim();
  if (patch.model) next.model = String(patch.model).trim();
  if (patch.port) next.port = Number(patch.port) || next.port;
  /* Key 留空、或传回来的是掩码，就表示"不改" */
  const k = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (k && k.indexOf('*') < 0) next.apiKey = k;
  CFG = Object.assign(CFG, next);
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/* ---------- HTTP ---------- */
function json(res, obj, code) {
  const s = JSON.stringify(obj);
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}
function readBody(req) {
  return new Promise(function (resolve) {
    const chunks = [];                       /* 必须按 Buffer 收集：字符串拼接会把跨分片的中文字符切坏 */
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve({}); }
    });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname === '/' ? '/星图.html' : pathname);
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    /* 页面永远向服务器要新的：否则改完前端刷新还是旧脚本，功能会「莫名失灵」 */
    'Cache-Control': ext === '.html' ? 'no-store, must-revalidate' : 'no-cache',
    'Last-Modified': fs.statSync(file).mtime.toUTCString()
  });
  res.end(fs.readFileSync(file));
}

const cache = new Map();

async function handleConcept(req, res) {
  const b = await readBody(req);
  const name = String(b.name || '').trim().slice(0, 80);
  const summary = String(b.summary || '').trim().slice(0, 400);
  if (!name) return json(res, { error: 'name 必填' }, 400);

  const exact = CONCEPTS.get(name);
  if (exact) return json(res, { canonical: exact.name, aliases: exact.aliases, action: 'exact', score: 1 });

  const vec = await embed(name + '：' + summary);
  if (!vec) {   /* embedding 不可用 → 退化为按名字去重，功能不中断 */
    CONCEPTS.set(name, { name: name, summary: summary, vec: null, aliases: [] });
    saveConcepts();
    return json(res, { canonical: name, aliases: [], action: 'new', score: 0, degraded: true });
  }
  const cands = recall(vec);
  if (cands.length) {
    const v = await adjudicate(name, summary, cands);
    if (v && v.same && cands[v.idx]) {
      const hit = cands[v.idx];
      if (hit.c.aliases.indexOf(name) < 0) hit.c.aliases.push(name);
      saveConcepts();
      return json(res, { canonical: hit.c.name, aliases: hit.c.aliases, action: 'merged',
                         score: Number(hit.s.toFixed(3)), reason: v.reason || '' });
    }
  }
  CONCEPTS.set(name, { name: name, summary: summary, vec: vec, aliases: [] });
  saveConcepts();
  return json(res, { canonical: name, aliases: [], action: 'new', score: 0 });
}

async function handleSeed(u, res) {
  const q = u.searchParams.get('q') || '';
  const exist = (u.searchParams.get('exist') || '').slice(0, 800);
  if (!CFG.apiKey) return json(res, { topic: q, children: [], error: '未配置 apiKey' });
  const seedUser = [
    '用户的问题：' + q,
    exist ? ('星图里已经存在的概念：' + exist) : '',
    '如果上面已经有一个概念和你想到的是同一个东西 —— 哪怕是同义词、别名、不同译法（例如「维数灾难」和「维数诅咒」是同一个东西）—— 必须原样复用已有的那个名字，绝对不要另造新词。'
  ].filter(Boolean).join('\n');
  const text = await llmOnce([{ role: 'system', content: SEED_SYS }, { role: 'user', content: seedUser }]);
  const p = parseLineProtocol(text);
  json(res, { topic: q, children: p.children.slice(0, 4) });
}

async function handleLecture(req, res, isAnswer) {
  const body = await readBody(req);
  const isAns = isAnswer || !!body.answer;   /* 追问也走 /api/lecture，所以必须读 body 里的标记 */
  const isRel = !!body.relation;             /* 合并出来的「桥」节点：讲的是 A 和 B 的关系，不是某个概念 */
  const isFact = !isRel && body.mode === 'fact';   /* 用户点的是「我只想知道一个事实」：换一副模具，答案放第一行 */
  const concept = String(body.concept || '').slice(0, 100);
  const topic = String(body.topic || '').slice(0, 100);
  const parent = String(body.parent || '').slice(0, 100);
  const seen = Array.isArray(body.seen) ? body.seen.slice(0, 24) : [];   /* 本星团的名字：必须复用，防团内分裂 */
  const known = Array.isArray(body.known) ? body.known.slice(0, 24) : [];   /* 别团的名字：只当同义词表，不是候选菜单 */
  /* 不再把服务端全局知道的概念名并进来（原来是 knownNames()）：客户端只送同一星团内的名字。
     以前这里把整张图的概念混成一张「候选菜单」，模型遇到不熟的题目就从菜单里挑词，
     于是输入「奶龙」会硬扯上「期权」「损失函数」这类完全无关的概念。 */
  /* 模具进了缓存键：换模具 = 换一份讲义，不能把旧模具的结果端上来。
     默认模具不加后缀，这样以前存在 star.db 里的讲义（都是默认模具生成的）还能命中。 */
  const tpl = isFact ? { id: '', name: '', text: '' } : templateBlock(body.template);
  const key = (isFact ? 'F|' : isRel ? 'R|' : (isAns ? 'A|' : 'L|')) + concept + '|' + topic + '|' + parent +
              (tpl.id && tpl.id !== TPL_DEFAULT ? '|M:' + tpl.id : '');

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });

  if (!body.bust) {
    let hit = cache.get(key);
    if (!hit) { const fromDb = recallLecture(key); if (fromDb) { hit = fromDb; cache.set(key, fromDb); } }
    if (hit) {
      res.write(hit.text);
      res.write('\n##CHECK ' + (hit.check.length ? 'fail ' + hit.check.join('；') : 'ok') + '\n');
      return res.end();
    }
  }
  if (!CFG.apiKey) {
    res.write('##SCENE 服务端还没有配置 API Key：请编辑 prototype/config.json 填入 apiKey，然后重启 node server.js。\n');
    res.write('##INSIGHT 并不是模型不会用，只是还没给它钥匙。\n');
    res.write('##CHECK fail 未配置 apiKey\n');
    return res.end();
  }

  const user = isFact
    ? ['用户要的只是一个事实，不是理解。他问的是：' + concept,
       '当前正在探索的问题：' + topic,
       known.length ? ('星图里别的星团已经有这些名字（同义词表，不是候选菜单）：' + known.join('、')) : '',
       '第一行必须直接给出答案，不要铺垫、不要「大多数人以为」式开场、不要悬念。',
       '如果你不确定、或者答案本身有争议，就在 ##FACT 里直说「通常认为是……，但有分歧」并指出分歧在哪 —— 绝对不许编一个数字或一个年份。'].filter(Boolean).join('\n')
    : isRel
    ? ['用户把星图里两个问题连到了一起：',
       '问题 A：' + concept,
       '问题 B：' + topic,
       '这一节要讲的不是 A、也不是 B，而是「A 和 B 之间到底是什么关系」。',
       '按这个顺序讲：① 它们其实是同一件事的两个侧面（共同点）；② 关键差别在哪；③ 谁更基础、该先弄清谁；④ 给一个能同时串起两者的具体例子。',
       '开头必须原样各点一次 A 和 B 的名字（让读者知道在讲哪两件事），但之后不要再分别复述它们各自的内容 —— 通篇只讲它们之间的关系。',
       '仍然严格遵守行协议：##COMMON 写它们共同的那个直觉，##BOUNDS 写这个类比什么时候不成立，##MIS 写把它们混为一谈的常见误解。',
       '并且第一行必须是 ##TITLE <不超过 12 个字，概括这两个问题的关系，例如「同一个硬币的两面」>。'].join('\n')
    : isAns
    ? ['用户在「' + parent + '」这一节提出了一个追问：' + concept,
       '当前正在探索的问题：' + topic,
       '请直接回答这个追问，仍然严格遵守上面的行协议。'].join('\n')
    : ['当前正在探索的问题：' + topic,
       '本次要讲的概念：' + concept,
       parent ? ('来路：从「' + parent + '」过来，关系=' + (body.rel || '') + '，为什么=' + (body.why || '')) : '这是这个星团的原点。',
       '这个星团里已经有的概念：' + (seen.length ? seen.join('、') : '无'),
       '如果你的子概念和它们重复，必须原样复用这个星团里的名字，不要另造新词。',
       known.length ? ('星图里别的星团已经有这些名字（把它当同义词表看，不是候选菜单）：' + known.join('、') +
         '。只有当你的子概念确实就是同一个东西时才复用；就算字面一模一样，只要语境不同（例如数学里的正则化和机器学习里的正则化）也绝对不要复用。不要为了让名字出现在图上，就把别的学科的概念塞进来。') : '',
       '也不要在正文里重复解释上面这些概念。'].filter(Boolean).join('\n');

  const enumQ = !isRel && !isFact && (isEnumQuestion(concept) || isEnumQuestion(topic));
  /* 拼装顺序：协议骨架 → 这一次的场合（关系 / 清单）→ 用户选的模具。
     模具放在最后，是故意的：后说的写法定得更大声，用户改模具才真的改得动讲法。 */
  const base = isRel
    ? PROTOCOL + '\n\n【本次追加】\n这一节讲的是两个问题之间的关系，不是某一个概念。第一行必须输出 ##TITLE <不超过 12 字的短标题>，概括这两个问题之间是什么关系；然后照常给 ##COMMON / ##SCENE / ##INSIGHT / ##BOUNDS / ##MIS / ##CHILD（子概念给的是「想弄懂这层关系，下一步该点哪个概念」）。'
    : enumQ
    ? PROTOCOL + '\n\n【本次追加】\n这个问题是清单型问题：请务必用 ##LIST 逐条列出来，一条一行「##LIST <条目> | <一句为什么它值得一提>」，最多 10 行，并且排在 ##SCENE 之前。不要用纠错式开场。'
    : PROTOCOL;
  /* 「我只想知道一个事实」有自己的模具（FACT_ADD），不受这里影响 */
  const sys = isFact ? PROTOCOL + FACT_ADD : base + tpl.text;

  let full = '';
  const sink = {};
  try {
    full = await llmStream([{ role: 'system', content: sys }, { role: 'user', content: user }],
      function (d) { res.write(d); }, sink);
  } catch (e) {
    res.write('\n##SCENE 生成失败：' + e.message + '\n');
    res.write('##CHECK fail ' + e.message + '\n');
    return res.end();
  }
  const parsed = parseLineProtocol(full);
  const problems = selfCheck(parsed, concept, seen, parent, isRel, isFact);
  cache.set(key, { text: full, check: problems });
  rememberLecture(key, full, problems);
  const u = sink.usage || {};
  recordGeneration({
    nodeId: String(body.nodeId || ''), concept: concept, topic: topic, model: CFG.model,
    promptTokens: u.prompt_tokens || 0, completionTokens: u.completion_tokens || 0,
    cachedTokens: u.prompt_cache_hit_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    ok: problems.length ? 0 : 1, problems: problems.join('；')
  });
  res.write('\n##CHECK ' + (problems.length ? 'fail ' + problems.join('；') : 'ok') + '\n');
  res.end();
}

/* ---------- 双链：让 AI 指出两个节点之间是什么关系 ----------
   只回两行，成本极低（几十个 token）。不复用 handleLecture 的 R| 分支，
   因为那条分支产出的是一整份讲义，而这里用户只想知道「它俩算什么关系」——
   一句话，能当连线上的标签用。 */
const LINK_RULES = [
  '你在帮用户把一个知识星图上的两个节点连起来。用户认为它们有关系，你要用一句话说清是什么关系，并给它一个短名字。',
  '',
  '【输出格式：只有两行，不要任何其他文字，不要 markdown，不要代码块】',
  '##TITLE <不超过 12 个字，能当这条连线标签用的短名，例如「同一个硬币的两面」>',
  '##REL <一句话，不超过 40 字，说清 A 和 B 是什么关系>',
  '',
  '【硬性规则】',
  '1. 关系必须是具体的：谁是谁的前提、谁是谁的特例、同一件事的两个层面、一个用来解释另一个……',
  '2. 不许写「它们有关联」「互相影响」这类放在任何两个东西上都成立的空话。',
  '3. 如果这两者其实没有真正的关系，就在 ##REL 里直说「严格说这两者没有直接关系」，不要硬编。',
  '4. 不要分别复述 A 是什么、B 是什么 —— 只讲它们之间。'
].join('\n');

async function handleLink(req, res) {
  const body = await readBody(req);
  const a = String(body.a || '').slice(0, 80);
  const b = String(body.b || '').slice(0, 80);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  if (!a || !b) { res.write('##CHECK fail 缺少节点名\n'); return res.end(); }
  const key = 'X|' + a + '|' + b;
  if (!body.bust) {
    let hit = cache.get(key);
    if (!hit) { const fromDb = recallLecture(key); if (fromDb) { hit = fromDb; cache.set(key, fromDb); } }
    if (hit) {
      res.write(hit.text);
      res.write('\n##CHECK ' + (hit.check.length ? 'fail ' + hit.check.join('；') : 'ok') + '\n');
      return res.end();
    }
  }
  if (!CFG.apiKey) {
    res.write('##REL 服务端还没有配置 API Key，暂时没法让模型说它们的关系。\n');
    res.write('##CHECK fail 未配置 apiKey\n');
    return res.end();
  }
  const user = '节点 A：' + a + '\n节点 B：' + b + '\n\n这两者之间是什么关系？';
  let full = '';
  const sink = {};
  try {
    full = await llmStream([{ role: 'system', content: LINK_RULES }, { role: 'user', content: user }],
      function (d) { res.write(d); }, sink);
  } catch (e) {
    res.write('\n##REL 生成失败：' + e.message + '\n##CHECK fail ' + e.message + '\n');
    return res.end();
  }
  const p = parseLineProtocol(full);
  const title = p.title || '';
  const rel = p.rel || (p.insight || '');
  if (!rel) {
    res.write('\n##CHECK fail 模型没有给出 ##REL\n');
    return res.end();
  }
  const problems = [];
  if (title.length > 14) problems.push('关系短名超过 12 字');
  if (rel.length > 60) problems.push('关系说明超过 40 字');
  cache.set(key, { text: full, check: problems });
  rememberLecture(key, full, problems);
  const u = sink.usage || {};
  recordGeneration({
    nodeId: String(body.nodeId || ''), concept: a + ' ⇄ ' + b, topic: String(body.topic || '').slice(0, 100), model: CFG.model,
    promptTokens: u.prompt_tokens || 0, completionTokens: u.completion_tokens || 0,
    cachedTokens: u.prompt_cache_hit_tokens || (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    ok: problems.length ? 0 : 1, problems: problems.join('；')
  });
  res.write('\n##CHECK ' + (problems.length ? 'fail ' + problems.join('；') : 'ok') + '\n');
  res.end();
}

const server = http.createServer(async function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/health') return json(res, Object.assign({ live: true }, publicConfig()));
    if (u.pathname === '/api/state' && req.method === 'GET') return json(res, loadState());
    if (u.pathname === '/api/state' && req.method === 'POST') {
      const b = await readBody(req);
      const wrote = saveState(b);
      return json(res, { ok: !!wrote, saved: !!wrote, clusters: (b.clusters || []).length, nodes: (b.nodes || []).length });
    }
    if (u.pathname === '/api/stats' && req.method === 'GET') {
      if (!DB) return json(res, { db: false });
      const t = DB.prepare('SELECT COUNT(*) AS n, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct, SUM(cached_tokens) AS cc, SUM(ok) AS okn FROM generations').get();
      return json(res, { db: true, generations: t.n || 0, promptTokens: t.pt || 0, completionTokens: t.ct || 0, cachedTokens: t.cc || 0, passed: t.okn || 0,
                         byModel: DB.prepare('SELECT model, COUNT(*) AS n FROM generations GROUP BY model').all(),
                         lectures: DB.prepare('SELECT COUNT(*) AS n FROM lectures').get().n });
    }
    if (u.pathname === '/api/concepts' && req.method === 'GET') {
      return json(res, Array.from(CONCEPTS.values()).map(function (c) { return { name: c.name, aliases: c.aliases, hasVec: !!c.vec }; }));
    }
    if (u.pathname === '/api/concept' && req.method === 'POST') return await handleConcept(req, res);
    if (u.pathname === '/api/config' && req.method === 'GET') return json(res, publicConfig());
    if (u.pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      saveConfig(b);
      return json(res, Object.assign({ ok: true }, publicConfig()));
    }
    /* ---------- 模具：讲义长什么样，用户可以改 ---------- */
    if (u.pathname === '/api/templates' && req.method === 'GET') {
      return json(res, { dir: TPL_DIR, defaultId: TPL_DEFAULT,
                         current: CFG.template || TPL_DEFAULT, items: publicTemplates() });
    }
    if (u.pathname === '/api/templates' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '');
      const hit = listTemplates().filter(function (t) { return t.id === id; })[0];
      if (!hit) return json(res, { ok: false, error: '没有这个模具：' + (id || '(空)') }, 400);
      saveConfig({ template: hit.id });
      return json(res, Object.assign({ ok: true }, publicConfig()));
    }
    /* 一个按钮把模板文件夹打开 —— 「用户能改」的前提是找得到那个文件 */
    if (u.pathname === '/api/templates/open' && req.method === 'POST') {
      try {
        if (!fs.existsSync(TPL_DIR)) fs.mkdirSync(TPL_DIR, { recursive: true });
        require('child_process').execFile('explorer.exe', [TPL_DIR], function () {});
        return json(res, { ok: true, dir: TPL_DIR });
      } catch (e) {
        return json(res, { ok: false, dir: TPL_DIR, error: String(e.message || e) });
      }
    }
    if (u.pathname === '/api/test' && req.method === 'POST') {
      if (!CFG.apiKey) return json(res, { ok: false, error: '还没有配置 API Key' });
      try {
        const t = await llmStream([{ role: 'user', content: '只回复两个字：可以' }], null);
        return json(res, { ok: true, sample: String(t).trim().slice(0, 40) });
      } catch (e) {
        return json(res, { ok: false, error: String(e && e.message || e).slice(0, 300) });
      }
    }
    if (u.pathname === '/api/link' && req.method === 'POST') return await handleLink(req, res);
    /* 「最近弄懂的」：把一直只用来记 token 的 generations 表变成用户能看见的东西。
       按 node_id 反查节点（节点可能已经被删掉），查不到就退回用 concept 名兜底。 */
    if (u.pathname === '/api/recent' && req.method === 'GET') {
      if (!DB) return json(res, { db: false, items: [] });
      const limit = Math.max(1, Math.min(60, Number(u.searchParams.get('limit') || 30)));
      let rows = [];
      try {
        rows = DB.prepare('SELECT id, node_id, concept, topic, model, ok, created_at FROM generations ORDER BY id DESC LIMIT ?').all(limit);
      } catch (e) { return json(res, { db: true, items: [] }); }
      const byId = DB.prepare('SELECT id, label, cluster_id FROM nodes WHERE id = ?');
      const byName = DB.prepare('SELECT id, label, cluster_id FROM nodes WHERE label = ? LIMIT 1');
      const items = [];
      for (const r of rows) {
        let n = null;
        try { n = r.node_id ? byId.get(String(r.node_id)) : null; } catch (e) {}
        if (!n) { try { n = byName.get(String(r.concept)); } catch (e) {} }
        items.push({
          id: r.id, concept: String(r.concept || ''), topic: String(r.topic || ''), model: String(r.model || ''),
          ok: r.ok ? 1 : 0, at: r.created_at || 0,
          nodeId: n ? n.id : '', label: n ? n.label : String(r.concept || ''), clusterId: n ? n.cluster_id : ''
        });
      }
      return json(res, { db: true, items: items });
    }
    if (u.pathname === '/api/seed') return await handleSeed(u, res);
    if (u.pathname === '/api/lecture' && req.method === 'POST') return await handleLecture(req, res, false);
    if (u.pathname === '/api/answer' && req.method === 'POST') return await handleLecture(req, res, true);
    return serveStatic(u.pathname, res);
  } catch (e) {
    json(res, { error: String(e && e.message || e) }, 500);
  }
});
DB = openDb();
server.listen(PORT, '127.0.0.1', function () {
  console.log('星图服务已启动：http://localhost:' + PORT + '（仅本机可访问）');
  console.log('模型：' + CFG.model + ' @ ' + CFG.baseUrl);
  console.log(CFG.apiKey ? 'API Key：已配置' : 'API Key：未配置 —— 请编辑 config.json');
  console.log('语义去重：' + ((CFG.embedModel || CFG.embedBaseUrl) ? ('已配置 embedding，概念表 ' + CONCEPTS.size + ' 条') : '未配置 embedding，将按名字去重'));
  console.log('持久化：' + (DB ? ('已开启（star.db，' + loadState().nodes.length + ' 个节点）') : '未开启'));
});
