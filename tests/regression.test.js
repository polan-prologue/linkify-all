/*
 * v0.7 自动化测试 = A组（Shadow DOM 回归）+ B组（兜底扫描）+ C组（中文语境）
 *                 + D组（学习规则）+ E组（备份往返）+ F组（v0.7 新功能）
 *
 * F 组：
 *   F1: 菜单只有 4 项（总开关/黑名单/学习新规则/设置）
 *   F2: 打开统一设置面板 → 普通 DOM 面板出现，含场景开关 4 个
 *   F3: 场景开关默认值：代码块=开，编辑器/按钮/链接内部=关
 *   F4: 代码块内链接默认转换（v0.7 新行为；v0.6 应失败）
 *   F5: 关闭代码块开关 → 代码块内不再转换
 *   F6: 学习新规则弹窗（普通 DOM）能打开且含输入框
 */

"use strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function assert(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || "" });
  console.log((cond ? "  ✔ " : "  ✘ ") + name + (cond ? "" : "  -- " + detail));
}

/* ══════════════ 最小 DOM mock（已验证保真） ══════════════ */
const allObservers = [];
class MockNode {
  constructor(nodeType, nodeName, value) {
    this.nodeType = nodeType; this.nodeName = nodeName;
    this.nodeValue = value === undefined ? null : value;
    this.childNodes = []; this.parentNode = null; this.shadowRoot = null;
    this.isShadow = false; this._isDocument = false;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes, i = s.indexOf(this);
    return i > -1 && i + 1 < s.length ? s[i + 1] : null;
  }
  get isConnected() {
    let n = this, guard = 0;
    while (n.parentNode && guard++ < 1000) n = n.parentNode;
    if (n._isDocument) return true;
    if (n.isShadow && n.host) return n.host.isConnected;
    return false;
  }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.childNodes.length = 0;
    if (v) { const t = new MockNode(3, "#text", String(v)); t.parentNode = this; this.childNodes.push(t); }
  }
  _rawAppend(c) {
    // 真实 DOM 语义：先摘除已有父级，避免同节点重复入链形成环
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.push(c);
  }
  appendChild(c) {
    if (c.nodeType === 11 && c.isFragment) {
      const kids = c.childNodes.slice(); c.childNodes.length = 0;
      kids.forEach((k) => this._rawAppend(k)); return c;
    }
    this._rawAppend(c); fireMutation(this, [c]); return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i > -1) { this.childNodes.splice(i, 1); c.parentNode = null; } return c; }
  replaceChild(newNode, oldChild) {
    const i = this.childNodes.indexOf(oldChild);
    if (i === -1) return oldChild;
    if (newNode.nodeType === 11 && newNode.isFragment) {
      const kids = newNode.childNodes.slice(); newNode.childNodes.length = 0;
      this.childNodes.splice(i, 1, ...kids); kids.forEach((k) => { k.parentNode = this; });
    } else {
      oldChild.parentNode = null; newNode.parentNode = this;
      this.childNodes.splice(i, 1, newNode);
    }
    return oldChild;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}
class MockFragment extends MockNode { constructor() { super(11, "#document-fragment"); this.isFragment = true; } }
class MockShadowRoot extends MockNode { constructor() { super(11, "#shadow-root"); this.isShadow = true; } }
class MockElement extends MockNode {
  constructor(tag) {
    super(1, String(tag).toUpperCase());
    this.tagName = String(tag).toUpperCase();
    this.attributes = {}; this.style = {}; this.className = ""; this.id = "";
    this.isContentEditable = false;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.classList = { add() {}, remove() {}, contains() { return false; } };
    this.checked = false; this.value = ""; this.type = "text"; this.disabled = false;
    this._listeners = {};
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === "id") this.id = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  attachShadow() { const sr = new MockShadowRoot(); sr.host = this; this.shadowRoot = sr; fireMutation(this, []); return sr; }
  closest() { return null; } click() { this._fire("click"); }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
  focus() {}
  addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); }
  removeEventListener(ev, fn) { if (!this._listeners[ev]) return; this._listeners[ev] = this._listeners[ev].filter((f) => f !== fn); }
  _fire(ev) { (this._listeners[ev] || []).forEach((f) => f({ key: "Enter", preventDefault() {}, target: this })); }
}
Object.defineProperty(MockElement.prototype, "href", {
  get() { return this.attributes.href !== undefined ? this.attributes.href : ""; },
  set(v) { this.setAttribute("href", v); }
});
function fireMutation(parent, addedNodes) {
  for (const o of allObservers) {
    let n = parent, hit = false;
    while (n) {
      if (o.targets.includes(n)) { hit = true; break; }
      if (n.isShadow) break;
      n = n.parentNode;
    }
    if (hit) o.cb(addedNodes.map((an) => ({ addedNodes: [an], target: parent })));
  }
}
class MockMutationObserver {
  constructor(cb) { this.cb = cb; this.targets = []; allObservers.push(this); }
  observe(t) { this.targets.push(t); } disconnect() { this.targets = []; }
}
function createTreeWalker(root, whatToShow, filter) {
  const found = [];
  (function dfs(n) {
    for (const c of n.childNodes) {
      const mask = 1 << (c.nodeType - 1);
      const show = (mask & whatToShow) !== 0;
      let verdict = 1;
      if (show && filter && typeof filter.acceptNode === "function") verdict = filter.acceptNode(c);
      if (show && verdict !== 2) found.push(c);
      if (c.nodeType === 1) dfs(c);
    }
  })(root);
  let i = 0;
  return { nextNode() { return i < found.length ? found[i++] : null; } };
}

const gmStore = {};
const menuCallbacks = {};
const doc = {
  readyState: "complete", hidden: false, visibilityState: "visible",
  body: new MockElement("body"), head: new MockElement("head"),
  documentElement: new MockElement("html"),
  createElement: (t) => new MockElement(t),
  createTextNode: (t) => new MockNode(3, "#text", t),
  createDocumentFragment: () => new MockFragment(),
  createTreeWalker,
  addEventListener() {}, removeEventListener() {},
};
doc.documentElement._isDocument = true;
doc.documentElement.appendChild(doc.body);
doc.documentElement.appendChild(doc.head);
globalThis.document = doc;
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, getSelection: () => null,
};
globalThis.location = { hostname: "www.example.com", hash: "#lfa-dev" };
globalThis.Element = MockElement;
globalThis.NodeFilter = { SHOW_ALL: -1, SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
globalThis.MutationObserver = MockMutationObserver;
globalThis.GM_getValue = (k, d) => (k in gmStore ? gmStore[k] : d);
globalThis.GM_setValue = (k, v) => { gmStore[k] = v; };
globalThis.GM_registerMenuCommand = (label, fn) => { menuCallbacks[label] = fn; return Object.keys(menuCallbacks).length; };
globalThis.GM_unregisterMenuCommand = () => { };
globalThis.GM_setClipboard = () => { };

// WebDAV 序列 mock（v0.14 版本化）：
//   PUT 每个新时间戳文件名首次 404 → MKCOL 201 → 同名重试 201（模拟坚果云）
//   PROPFIND → 207 + 已备份版本的 href 列表
//   GET 版本文件 → 200 + 存档 JSON
//   其余请求（失效检测 HEAD 等）一律 200
const davLog = [];
const davPutSeen = new Map();
const davFiles = {};   // url -> 存档 JSON（供 GET 读回）
globalThis.GM_xmlhttpRequest = (o) => {
  setTimeout(() => {
    try {
      if (o.method === "PUT" && /backup-\d{8}-\d{6}\.json$/.test(o.url || "")) {
        const seen = davPutSeen.get(o.url) || 0;
        davPutSeen.set(o.url, seen + 1);
        davLog.push({ method: "PUT", url: o.url, seq: seen });
        davFiles[o.url] = o.data || "{}";
        o.onload && o.onload({ status: seen === 0 ? 404 : 201 });
        return;
      }
      if (o.method === "MKCOL") {
        davLog.push({ method: "MKCOL", url: o.url });
        o.onload && o.onload({ status: 201 });
        return;
      }
      if (o.method === "PROPFIND") {
        davLog.push({ method: "PROPFIND", url: o.url });
        const hrefs = Object.keys(davFiles).map((u) => u.replace(/^[^/]*\/\/[^/]+/, ""));
        const xml = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
          '<D:response><D:href>/dav/linkify/</D:href></D:response>' +
          hrefs.map((h) => "<D:response><D:href>" + h + "</D:href></D:response>").join("") +
          "</D:multistatus>";
        o.onload && o.onload({ status: 207, responseText: xml });
        return;
      }
      if (o.method === "GET" && /backup-\d{8}-\d{6}\.json$/.test(o.url || "")) {
        davLog.push({ method: "GET", url: o.url });
        o.onload && o.onload({ status: 200, responseText: davFiles[o.url] || '{"app":"linkify-all","rules":[]}' });
        return;
      }
      davLog.push({ method: o.method, url: o.url || "" });
      o.onload && o.onload({ status: 200 });
    } catch (e) { }
  }, 3);
};

function collectAnchors(node, out) {
  if (!node) return out;
  if (node.nodeType === 1) {
    if (node.tagName === "A" && node.getAttribute("data-lfa") === "1") out.push(node);
    if (node.shadowRoot) collectAnchors(node.shadowRoot, out);
  }
  for (const c of node.childNodes) collectAnchors(c, out);
  return out;
}

console.log("\n[1] 加载脚本并激活…");
const scriptPath = process.argv[2] || "./linkify-all.v0.7.user.js";
console.log("    被测脚本: " + scriptPath);
require(scriptPath);
const lfa = globalThis.window.__LFA__;

(async () => {
  await sleep(300);

  /* ── A 组：三层嵌套 Shadow DOM 动态加载 ── */
  console.log("\n[2-5] Shadow DOM 场景…");
  const biliComments = new MockElement("bili-comments");
  doc.body.appendChild(biliComments);
  await sleep(250);
  biliComments.attachShadow({ mode: "open" });
  await sleep(300);
  const thread = new MockElement("bili-comment-thread-renderer");
  biliComments.shadowRoot.appendChild(thread);
  await sleep(250);
  thread.attachShadow({ mode: "open" });
  await sleep(300);
  const comment = new MockElement("bili-comment-renderer");
  thread.shadowRoot.appendChild(comment);
  await sleep(250);
  comment.attachShadow({ mode: "open" });
  await sleep(300);
  const realText =
    "【资源帖中的官方链接】 📥 1. 示例应用 1（全平台） " +
    "Tracker 自动更新订阅链接：https://pan.quark.cn/s/7e7f51a08273 " +
    "安装包：https://pan.quark.cn/s/6cc5d7a2089c " +
    "官网：https://github.com/example-org/example-app/releases " +
    "📥 2. 示例应用 2 安装包：https://pan.quark.cn/s/ce8055aceebd 官网：https://app1.example.com/ " +
    "📥 3. 示例应用 3 安装包：https://pan.quark.cn/s/dc292ddd8d34 官网：https://app2.example.com/ " +
    "📥 4. 示例应用 4 安装包：https://pan.quark.cn/s/735c54917ef3 官网：https://app3.example.com/ " +
    "Github官网：https://github.com/example-org/example-app";
  const contentDiv = new MockElement("div");
  contentDiv.appendChild(new MockNode(3, "#text", realText));
  comment.shadowRoot.appendChild(contentDiv);
  await sleep(500);
  const anchorsA = collectAnchors(biliComments, []);
  const hrefsA = anchorsA.map((a) => a.getAttribute("href"));
  console.log("\n[断言 A]");
  assert("A1: 三层嵌套 Shadow DOM 生成链接数量 = 10", anchorsA.length === 10, "实际 " + anchorsA.length);
  assert("A2: 第1条夸克链接 href 正确", hrefsA[0] === "https://pan.quark.cn/s/7e7f51a08273", "实际 " + hrefsA[0]);
  assert("A3: 末条 GitHub 链接 href 正确", hrefsA[9] === "https://github.com/example-org/example-app", "实际 " + hrefsA[9]);
  assert("A4: 原文保留", anchorsA.every((a) => a.getAttribute("data-raw") === a.textContent));
  assert("A5: 新标签页打开 + noopener", anchorsA.every((a) => a.target === "_blank" && a.rel === "noopener noreferrer"));

  /* ── C 组：中文语境 ── */
  console.log("\n[6] 中文语境…");
  const cnDiv = new MockElement("div");
  cnDiv.appendChild(new MockNode(3, "#text", "看这个https://www.example.com/question/1960114905232434428/answer/2005287245817607088，这里有激活方法"));
  cnDiv.appendChild(new MockElement("br"));
  cnDiv.appendChild(new MockNode(3, "#text", "参考 https://example.com。全文结束"));
  cnDiv.appendChild(new MockElement("br"));
  cnDiv.appendChild(new MockNode(3, "#text", "资源 https://pan.quark.cn/s/7e7f51a08273，密码：x7k9 速存"));
  cnDiv.appendChild(new MockElement("br"));
  cnDiv.appendChild(new MockNode(3, "#text", "百科 https://example.org/wiki/磁力 介绍"));
  doc.body.appendChild(cnDiv);
  await sleep(600);
  const anchorsC = collectAnchors(cnDiv, []);
  const hrefsC = anchorsC.map((a) => a.getAttribute("href"));
  console.log("\n[断言 C]");
  assert("C1: 长链接不被全角逗号+中文污染", hrefsC.includes("https://www.example.com/question/1960114905232434428/answer/2005287245817607088"), JSON.stringify(hrefsC));
  assert("C2: URL 后句号+中文不吞入", hrefsC.includes("https://example.com"), JSON.stringify(hrefsC));
  assert("C3: 逗号后提取码仍被识别", hrefsC.includes("https://pan.quark.cn/s/7e7f51a08273#lfa-c=x7k9"), JSON.stringify(hrefsC));
  assert("C4: 汉字 IRI 在汉字处截断", hrefsC.includes("https://example.org/wiki/"), JSON.stringify(hrefsC));
  assert("C5: 共 4 条", anchorsC.length === 4, "实际 " + anchorsC.length);

  /* ── D 组：学习规则 ── */
  console.log("\n[7] 学习规则…");
  const teachRes = lfa.addRule("github:lxzy-7/dsh-plugin-guard", "https://github.com/lxzy-7/dsh-plugin-guard");
  const d1Div = new MockElement("div");
  d1Div.appendChild(new MockNode(3, "#text", "安装这个 GitHub 插件：github:lxzy-7/dsh-plugin-guard，备用仓库 github:someone/another-repo 也可以看看"));
  doc.body.appendChild(d1Div);
  await sleep(600);
  const anchorsD1 = collectAnchors(d1Div, []);
  const hrefsD1 = anchorsD1.map((a) => a.getAttribute("href"));
  console.log("\n[断言 D]");
  assert("D0: 教学成功", teachRes.ok === true, JSON.stringify(teachRes));
  assert("D1: 样本自动转换", !!anchorsD1.find((a) => a.getAttribute("href") === "https://github.com/lxzy-7/dsh-plugin-guard"), JSON.stringify(hrefsD1));
  assert("D1b: 带 data-rule 且原文保留", !!anchorsD1.find((a) => a.getAttribute("data-rule") !== null && a.getAttribute("data-raw") === "github:lxzy-7/dsh-plugin-guard"));
  assert("D2: 泛化到新仓库", hrefsD1.includes("https://github.com/someone/another-repo"), JSON.stringify(hrefsD1));
  const d3Div = new MockElement("div");
  d3Div.appendChild(new MockNode(3, "#text", "直接打开 https://github.com/lxzy-7/dsh-plugin-guard 就行"));
  doc.body.appendChild(d3Div);
  await sleep(400);
  const anchorsD3 = collectAnchors(d3Div, []);
  assert("D3: 完整 URL 优先不被规则重复处理", anchorsD3.length === 1 && anchorsD3[0].getAttribute("data-rule") === null, JSON.stringify(anchorsD3.map((a) => a.getAttribute("href"))));
  const d4Div = new MockElement("div");
  d4Div.appendChild(new MockNode(3, "#text", "错词 agithub:foo/bar 不该匹配"));
  doc.body.appendChild(d4Div);
  const d5Div = new MockElement("div");
  d5Div.appendChild(new MockNode(3, "#text", "github:这个不是仓库"));
  doc.body.appendChild(d5Div);
  await sleep(400);
  assert("D4: 词边界保护", collectAnchors(d4Div, []).length === 0);
  assert("D5: 中文不误匹配", collectAnchors(d5Div, []).length === 0);

  /* ── E 组：备份往返 ── */
  console.log("\n[8] 备份往返…");
  const teach2 = lfa.addRule("磁力:08bcd5490a1f341e", "https://bt.example.com/search?h=08bcd5490a1f341e");
  assert("E0: 教学 2 条规则", teachRes.ok && teach2.ok, JSON.stringify([teachRes.err, teach2.err]));
  const data = lfa.exportData();
  assert("E1: 导出结构完整（含 opts 场景开关）", data.app === "linkify-all" && data.rules.length === 2 && data.opts && data.opts.precode === true, JSON.stringify(data).slice(0, 100));
  const snapshot = JSON.parse(JSON.stringify(data));
  for (const k of Object.keys(gmStore)) delete gmStore[k];
  delete require.cache[require.resolve(scriptPath)];
  require(scriptPath);
  const lfa2 = globalThis.window.__LFA__;
  await sleep(200);
  assert("E2a: 重装后规则为空", lfa2.listRules().length === 0, "实际 " + lfa2.listRules().length);
  lfa2.applyImport(snapshot);
  assert("E2b: 导入后恢复 2 条", lfa2.listRules().length === 2, "实际 " + lfa2.listRules().length);
  const divR = new MockElement("div");
  divR.appendChild(new MockNode(3, "#text", "新仓库 github:vuejs/core 已就绪"));
  doc.body.appendChild(divR);
  await sleep(3200);
  const hits = collectAnchors(divR, []).map((a) => a.getAttribute("href"));
  assert("E2c: 恢复的规则可命中新变量", hits.includes("https://github.com/vuejs/core"), JSON.stringify(hits));
  lfa2.applyImport(snapshot);
  assert("E3: 重复导入不翻倍", lfa2.listRules().length === 2, "实际 " + lfa2.listRules().length);
  const before = lfa2.listRules().length;
  lfa2.applyImport({ app: "other", rules: [] });
  assert("E4: 非法数据被拒绝", lfa2.listRules().length === before);

  /* ── F 组：v0.7 新功能 ── */
  console.log("\n[9] v0.7 新功能…");
  const menuKeys = Object.keys(menuCallbacks);
  assert("F1: 菜单精简为 4 项且含 4 个关键动作",
    menuKeys.length === 4 &&
    menuKeys.some((k) => k.includes("总开关")) &&
    menuKeys.some((k) => k.includes("黑名单")) &&
    menuKeys.some((k) => k.includes("学习新规则")) &&
    menuKeys.some((k) => k.includes("设置")),
    "实际 " + JSON.stringify(menuKeys));

  // F2: 打开设置面板（普通 DOM 面板，非 Shadow）
  lfa2.openSettings();
  await sleep(100);
  const panels = doc.body.childNodes.filter((c) => c.className === "lfa-panel");
  const settingsPanel = panels[0];
  // 递归收集面板内所有元素
  function allElements(root, out) {
    if (!root) return out;
    out.push(root);
    for (const c of root.childNodes) allElements(c, out);
    if (root.shadowRoot) allElements(root.shadowRoot, out);
    return out;
  }
  const panelEls = settingsPanel ? allElements(settingsPanel, []) : [];
  const chkAll = panelEls.filter((n) => n.tagName === "INPUT" && n.type === "checkbox");
  const txts = settingsPanel ? settingsPanel.textContent : "";
  assert("F2: 设置面板以普通 DOM 打开，含场景开关",
    !!settingsPanel && settingsPanel.shadowRoot === null && chkAll.length === 4,
    "panel=" + !!settingsPanel + " checkbox=" + chkAll.length + " text包含开关=" + txts.includes("场景开关"));
  assert("F2b: 面板含备份迁移入口（强制转换已按 v0.11 去除）",
    txts.includes("WebDAV") && txts.includes("导出") && !txts.includes("强制转换"),
    "实际 " + txts.slice(0, 120));
  assert("F2c: 学习规则列表为独立内部滚动区", !!settingsPanel && !!panelEls.find((n) => n.className === "lfa-rule-scroll"),
    "无 lfa-rule-scroll 滚动区");

  // F3: 默认值
  assert("F3: 默认值——代码块开 / 编辑器关 / 按钮关 / 链接内关",
    lfa2.getOpt("precode") === true &&
    lfa2.getOpt("editable") === false &&
    lfa2.getOpt("control") === false &&
    lfa2.getOpt("linkinside") === false,
    "实际 " + JSON.stringify({ precode: lfa2.getOpt("precode"), editable: lfa2.getOpt("editable"), control: lfa2.getOpt("control"), linkinside: lfa2.getOpt("linkinside") }));

  // F4: 代码块内默认转换（新行为）
  const preDiv = new MockElement("div");
  const preEl = new MockElement("pre");
  preEl.appendChild(new MockNode(3, "#text", "pip install 比如 https://example.com/pkg "));
  preDiv.appendChild(preEl);
  doc.body.appendChild(preDiv);
  await sleep(1600);
  const preHits = collectAnchors(preEl, []).map((a) => a.getAttribute("href"));
  assert("F4: 代码块内链接默认转换（v0.7 新行为）", preHits.includes("https://example.com/pkg"), JSON.stringify(preHits));

  // F5: 关闭代码块开关 → 代码块内不转换（reapply 还原并停止）
  // 先做环检测，定位 collectAnchors 无限递归的根源
  {
    const seen = new Set();
    let cyc = null;
    (function walk(n, depth) {
      if (cyc || depth > 300) return;
      if (n.isShadow || !n) return;
      if (seen.has(n)) { cyc = "REVISIT node=" + n.nodeName + " type=" + n.nodeType; return; }
      seen.add(n);
      for (const c of n.childNodes) walk(c, depth + 1);
      if (n.shadowRoot) { 
        if (seen.has(n.shadowRoot)) { cyc = "REVISIT shadownode"; return; }
        seen.add(n.shadowRoot);
        for (const c of n.shadowRoot.childNodes) walk(c, depth + 1);
      }
    })(doc.body, 0);
    if (cyc) console.log("  ⚠ 环检测发现: " + cyc);
    else console.log("  环检测: 无环（body 结构正常）");
    // 检查 nextSibling 链
    const nodes = [];
    (function dump(n, d) {
      if (!n || d > 80) return;
      nodes.push(n);
      nodes.push(n.shadowRoot);
      dump(n.firstChild, d + 1);
      if (n.shadowRoot) dump(n.shadowRoot.firstChild, d + 1);
    })(doc.body, 0);
    let bad = 0;
    for (const n of nodes) {
      if (!n) continue;
      let s = n.nextSibling, cnt = 0;
      const chain = new Set();
      while (s && cnt++ < 100) {
        if (chain.has(s)) { bad++; console.log("  ⚠ nextSibling 环: " + n.nodeName + " → " + s.nodeName); break; }
        chain.add(s);
        s = s.nextSibling;
      }
    }
    if (!bad) console.log("  nextSibling 链: 全部正常");
  }
  lfa2.setOpt("precode", false);
  lfa2.reapply();
  await sleep(1600);
  const preHits2 = collectAnchors(preEl, []).map((a) => a.getAttribute("href"));
  assert("F5: 关闭代码块开关后不再转换，之前转换的已还原",
    !preHits2.includes("https://example.com/pkg") && preEl.textContent.includes("https://example.com/pkg"),
    JSON.stringify(preHits2));

  // F6: 学习弹窗以普通 DOM 打开
  doc.body.childNodes.filter((c) => c.className === "lfa-panel").forEach((p) => p.remove());
  lfa2.openLearn();
  await sleep(100);
  const learnPanel = doc.body.childNodes.find((c) => c.className === "lfa-panel");
  const learnEls = learnPanel ? allElements(learnPanel, []) : [];
  const learnInputs = learnEls.filter((n) => n.tagName === "INPUT").length;
  assert("F6: 学习弹窗（普通 DOM）打开且含 2 个输入框",
    !!learnPanel && learnPanel.shadowRoot === null && learnInputs >= 2,
    "panel=" + !!learnPanel + " inputs=" + learnInputs);
  assert("F6b: 弹窗含「抓取选中文字」按钮", learnPanel && learnPanel.textContent.includes("抓取选中文字"), "实际 " + (learnPanel ? learnPanel.textContent.slice(0, 80) : "null"));

  /* ── G 组：WebDAV 备份 404→MKCOL→重试 序列（v0.8 修复目标） ── */
  console.log("\n[11] WebDAV 备份自动建目录重试…");
  // 移除学习弹窗，打开设置面板并模拟用户操作：填服务器 → 点「立即备份到云端」
  doc.body.childNodes.filter((c) => c.className === "lfa-panel").forEach((p) => p.remove());
  const setUI = lfa2.openSettings();
  await sleep(100);
  // 找到设置面板里的按钮和输入框（按钮在 settingsDialog 里由 pv_btn 创建）
  function allEls(root, out) {
    if (!root) return out;
    out.push(root);
    for (const c of root.childNodes) allEls(c, out);
    return out;
  }
  const spin = setUI ? setUI.body : doc.body;
  const els = allEls(spin, []);
  // 找出 WebDAV 表单输入框：按 placeholder 语义定位（服务器地址/账号/密码）
  // v0.10：路径输入框已移除；备份文件展示块也已移除，不再出现在面板里
  const davUrlInput = els.find((n) => n.tagName === "INPUT" && (n.placeholder || "").includes("jianguoyun"));
  const davPwInput = els.find((n) => n.tagName === "INPUT" && n.type === "password");
  const davEyeBtn = els.find((n) => n.tagName === "BUTTON" && n.textContent.includes("👁"));
  const davTargetRow = els.find((n) => n.className === "lfa-target");
  assert("G0a: 路径输入框已移除", !els.find((n) => n.tagName === "INPUT" && (n.placeholder || "").includes("backup.json")),
    "仍存在路径输入框");
  assert("G0b: 密码框配有小眼睛按钮", !!davPwInput && !!davEyeBtn,
    "pw=" + !!davPwInput + " eye=" + !!davEyeBtn);
  assert("G0c: 备份文件展示块已移除（v0.10）", !davTargetRow,
    "仍存在 lfa-target 展示块");
  // 场景开关只有名称，无描述子行（v0.10）
  const optSub = els.filter((n) => n.className === "lfa-opt-sub");
  assert("G0d: 场景开关描述子行已移除（悬浮 title 提示）", optSub.length === 0,
    "lfa-opt-sub 数量=" + optSub.length);
  // 密码标签不含「坚果云用应用密码」
  const pwLabel = els.find((n) => n.tagName === "LABEL" && n.textContent === "密码");
  const pwLabelOld = els.find((n) => n.tagName === "LABEL" && (n.textContent || "").includes("坚果云用应用密码"));
  assert("G0e: 密码标签精简为「密码」", !!pwLabel && !pwLabelOld,
    "pwLabel=" + !!pwLabel + " oldLabel=" + !!pwLabelOld);
  // 「其他」分区已去除
  const otherSec = els.find((n) => n.className === "lfa-sec" && n.textContent === "其他");
  assert("G0f: 「其他」分区已去除", !otherSec, "仍存在其他分区");
  // 模拟用户填表（备份按钮直接读表单，路径用固定默认值）
  if (davUrlInput) davUrlInput.value = "https://dav.jianguoyun.com/dav/";
  // v0.15：按钮文案「备份」「恢复」，横排在密码右侧；按钮列用与密码框同构的
  // lfa-field 结构（占位 label 撑高）→ 与密码输入框天然对齐
  const davActs = els.find((n) => n.className === "lfa-dav-acts");
  const davActField = els.find((n) => n.className === "lfa-field" &&
    n.childNodes && n.childNodes.some && n.childNodes.some((c) => c.className === "lfa-dav-acts"));
  const backupBtn = els.find((n) => n.tagName === "BUTTON" && n.textContent === "备份");
  const restoreBtn = els.find((n) => n.tagName === "BUTTON" && n.textContent === "恢复");
  assert("G0: WebDAV「备份」「恢复」横排一组（dav-acts 内两个按钮）",
    !!davUrlInput && !!davActs && !!backupBtn && !!restoreBtn &&
    davActs.childNodes.indexOf(backupBtn) < davActs.childNodes.indexOf(restoreBtn),
    "url=" + !!davUrlInput + " acts=" + !!davActs + " bak=" + !!backupBtn + " res=" + !!restoreBtn);
  assert("G0h: 按钮列与密码框同构对齐（lfa-field + 占位 label）",
    !!davActField && davActField.childNodes[0] && davActField.childNodes[0].tagName === "LABEL",
    "actField=" + !!davActField);
  const oldBtnGone = els.find((n) => n.tagName === "BUTTON" && (n.textContent.includes("立即备份到云端") || n.textContent.includes("从云端恢复")));
  assert("G0g: 旧长文案按钮已移除", !oldBtnGone, "仍存在旧按钮");
  davLog.length = 0;
  backupBtn && backupBtn.click();
  await sleep(600); // 等待 404→MKCOL→PUT 重试链完成

  const puts = davLog.filter((e) => e.method === "PUT");
  const mkcol = davLog.filter((e) => e.method === "MKCOL");
  assert("G1: 版本化备份——PUT 时间戳文件名，首次 404 后 MKCOL 建目录并重试成功",
    puts.length === 2 && mkcol.length === 1 &&
    /^backup-\d{8}-\d{6}\.json$/.test(puts[0].url.split("/").pop()) &&
    puts[0].url.includes("dav.jianguoyun.com/dav/linkify/") &&
    puts[1].url === puts[0].url,
    JSON.stringify(davLog));
  assert("G2: 重试 PUT 与 MKCOL 同目标目录",
    mkcol[0] && mkcol[0].url.includes("dav.jianguoyun.com/dav/linkify/") && mkcol[0].url.endsWith("/"),
    JSON.stringify(mkcol));
  assert("G3: 保存状态已写入 GM（备份按钮自动保存表单，路径为固定默认值）",
    gmStore["lfa_webdav"] && gmStore["lfa_webdav"].url === "https://dav.jianguoyun.com/dav/" &&
    gmStore["lfa_webdav"].path === "/linkify/backup.json",
    JSON.stringify(gmStore["lfa_webdav"]));

  /* ── G4：恢复列版本可选（v0.14 新功能） ── */
  console.log("\n[11b] 恢复：PROPFIND 列出云端版本并选择恢复…");
  // 再备份一个新版本，制造"两个版本"场景
  davLog.length = 0;
  await sleep(1100); // 确保时间戳（秒级）与上一版本不同
  backupBtn && backupBtn.click();
  await sleep(600);
  const puts2 = davLog.filter((e) => e.method === "PUT");
  assert("G4a: 第二次备份生成不同的新版本文件（不覆盖）",
    puts2.length === 2 && puts2[0].url !== puts[0].url,
    JSON.stringify(puts2.map((e) => e.url)));
  // 点「恢复」→ PROPFIND 列版本 → 版本选择面板出现
  davLog.length = 0;
  restoreBtn && restoreBtn.click();
  await sleep(400);
  const propfinds = davLog.filter((e) => e.method === "PROPFIND");
  const versionPanels = doc.body.childNodes.filter((c) => c.className === "lfa-panel");
  const versionPanel = versionPanels[versionPanels.length - 1];
  const versionRows = versionPanel ? allElements(versionPanel, []).filter((n) => n.className === "lfa-rule") : [];
  const versionScroll = versionPanel ? allElements(versionPanel, []).find((n) => n.className === "lfa-rule-scroll") : null;
  assert("G4b: 恢复触发 PROPFIND 并弹出版本选择面板（2 个版本，内部滚动）",
    propfinds.length === 1 && versionRows.length === 2 && !!versionScroll,
    "propfind=" + propfinds.length + " rows=" + versionRows.length + " scroll=" + !!versionScroll);
  // 点第一行（最新版本）的「恢复」→ GET 该版本 → 导入生效
  davLog.length = 0;
  const rowRestoreBtn = versionRows[0] ? allEls(versionRows[0], []).find((n) => n.tagName === "BUTTON") : null;
  rowRestoreBtn && rowRestoreBtn.click();
  await sleep(400);
  const gets = davLog.filter((e) => e.method === "GET");
  const panelClosed = !doc.body.childNodes.find((c) => c.className === "lfa-panel" && c === versionPanel);
  assert("G4c: 选择版本后 GET 对应版本文件并导入（面板自动关闭）",
    gets.length === 1 && gets[0].url.includes("backup-") && panelClosed,
    "gets=" + JSON.stringify(davLog) + " panelClosed=" + panelClosed);

  /* ── H 组：面板打开时教学规则 → 列表即时刷新（用户报的bug） ── */
  console.log("\n[12] 学习规则保存后面板即时刷新…");
  // 设置面板还开着（G 组），数一下当前规则行
  doc.body.childNodes.filter((c) => c.className === "lfa-panel").forEach((p) => p.remove());
  const settingsH = lfa2.openSettings();
  await sleep(100);
  // v0.12：面板固定高度——教学前后 wrap.style.height 必须不变（外围窗体不被挤占的结构性保证）
  const heightBefore = settingsH.wrap.style.height;
  const flexBefore = settingsH.wrap.style.display;
  assert("H-1: 设置面板为固定高度（height 已设定 + flex 布局）",
    !!heightBefore && heightBefore.includes("vh") && flexBefore === "flex",
    "height=" + heightBefore + " display=" + flexBefore);
  function countRuleRows(root) {
    return allEls(root, []).filter((n) => n.className === "lfa-rule").length;
  }
  const rowsBefore = countRuleRows(settingsH.body);
  // 通过面板内「学习新规则」按钮走真实路径
  // v0.13：学习入口是滚动区顶部的 sticky 添加行（div），不再是外置按钮
  const learnBtnInPanel = allEls(settingsH.body, []).find((n) => n.className === "lfa-rule-add");
  learnBtnInPanel && learnBtnInPanel.click();
  await sleep(100);
  const learnPanelH = doc.body.childNodes.find((c) => c.className === "lfa-panel" && c !== settingsH.wrap);
  const learnInputsH = learnPanelH ? allEls(learnPanelH, []).filter((n) => n.tagName === "INPUT") : [];
  const saveBtnH = learnPanelH ? allEls(learnPanelH, []).find((n) => n.tagName === "BUTTON" && n.textContent.includes("保存规则")) : null;
  if (learnInputsH[0]) learnInputsH[0].value = "论坛:t/123456";
  if (learnInputsH[1]) learnInputsH[1].value = "https://example.com/p/123456";
  assert("H0: 学习窗口已打开且表单可填", learnInputsH.length >= 2 && !!saveBtnH,
    "inputs=" + learnInputsH.length + " save=" + !!saveBtnH);
  saveBtnH && saveBtnH.click();
  await sleep(300);
  const rowsAfter = countRuleRows(settingsH.body);
  assert("H1: 保存后设置面板规则列表即时出现新规则（无需重进面板）",
    rowsAfter === rowsBefore + 1,
    "before=" + rowsBefore + " after=" + rowsAfter);
  // 新规则应能直接列在面板里且命中数存在
  const newRow = allEls(settingsH.body, []).find((n) => n.className === "lfa-rule" && n.textContent.includes("论坛"));
  assert("H2: 新规则行内容正确", !!newRow && newRow.textContent.includes("example.com/p/"), "row=" + (newRow ? newRow.textContent.slice(0, 60) : "null"));

  /* ── I 组：批量累加规则（用户报"加到8条后面就不动"的复现） ── */
  console.log("\n[13] 批量教学 8 条规则（共到 10 条），验证列表全渲染且角标正确…");
  for (let k = 0; k < 8; k++) {
    // 每次教学一条新规则（纯数字对子，覆盖真实反馈场景）
    const rawI = "数字" + (k + 10) + ": " + (100000 + k * 11111);
    const urlI = "https://example.com/p/" + (100000 + k * 11111);
    const resI = lfa2.addRule(rawI, urlI);
    if (!resI.ok) console.log("  ⚠ 第" + (k + 1) + "条教学失败：" + JSON.stringify(resI) + " raw=" + rawI + " url=" + urlI);
    await sleep(20);
  }
  await sleep(300);
  console.log("  ⚠ 诊断: listRules.length=" + lfa2.listRules().length +
    " 渲染行数=" + countRuleRows(settingsH.body) +
    " rules样例=" + JSON.stringify(lfa2.listRules().slice(0, 12).map((r) => r.sampleRaw)));
  const rowsAfter10 = countRuleRows(settingsH.body);
  const countBadge = allEls(settingsH.body, []).find((n) => n.className === "lfa-sec-count");
  assert("I1: 10 条规则全部渲染（超过8条不停摆）", rowsAfter10 >= 10,
    "实际渲染 " + rowsAfter10 + " 行");
  assert("I2: 角标计数与规则数一致",
    countBadge && countBadge.textContent === String(rowsAfter10) + " 条",
    "角标=" + (countBadge ? countBadge.textContent : "null") + " 行数=" + rowsAfter10);
  // 最后一条（第10条）也应出现在列表里
  const lastRow = allEls(settingsH.body, []).find((n) => n.className === "lfa-rule" && n.textContent.includes("177777"));
  assert("I3: 第 10 条规则（177777）出现在列表", !!lastRow, "未找到第10条");
  // 批量累加后面板高度必须恒定（外围窗体不被挤占的最终验证）
  const heightAfter = settingsH.wrap.style.height;
  assert("I5: 批量累加 8 条后面板高度恒定不变",
    heightAfter === heightBefore && settingsH.wrap.style.display === "flex",
    "before=" + heightBefore + " after=" + heightAfter);
  // v0.13：学习入口收进滚动区内部，sticky 顶部（滚动时也可见可点）
  const learnEntryStill = allEls(settingsH.body, []).find((n) => n.className === "lfa-rule-add");
  const scrollZone = allEls(settingsH.body, []).find((n) => n.className === "lfa-rule-scroll");
  const oldLearnBtn = allEls(settingsH.body, []).find((n) => n.tagName === "BUTTON" && n.textContent.includes("学习新规则"));
  assert("I4: 学习入口位于滚动区内部顶部（sticky），外置按钮已去除",
    !!learnEntryStill && !!scrollZone && scrollZone.childNodes.indexOf(learnEntryStill) === 0 && !oldLearnBtn,
    "entry=" + !!learnEntryStill + " scroll=" + !!scrollZone + " oldBtn=" + !!oldLearnBtn);

  /* ── B 组：兜底扫描 ── */
  console.log("\n[10] 静默注入验证兜底扫描…");
  // v0.16：子域名主机（≥3 段）裸域名也转换——用户报的 bug
  const divJ = new MockElement("div");
  const tj = new MockNode(3, "#text", "Mac 系统专用，网站：news.example.com 免费软件");
  divJ.appendChild(tj);
  doc.body.appendChild(divJ);
  await sleep(600);
  const hrefsJ = collectAnchors(divJ, []).map((a) => a.getAttribute("href"));
  assert("J-1: 子域名裸域名 news.example.com 自动补全转换（用户报的bug）",
    hrefsJ.includes("https://news.example.com"), JSON.stringify(hrefsJ));

  const div2 = new MockElement("div");
  const t2 = new MockNode(3, "#text", "备用站 www.example.com 和裸域名 example.com 对比，还有 example.com/page/1 这条和 sub2.example.org 这个子域名");
  div2._rawAppend(t2);
  doc.body._rawAppend(div2);
  await sleep(2800);
  const anchorsB = collectAnchors(doc.body, []).filter((a) =>
    a.getAttribute("href") === "https://www.example.com" || a.getAttribute("href") === "https://example.com/page/1" ||
    a.getAttribute("href") === "https://sub2.example.org");
  const hrefsB = anchorsB.map((a) => a.getAttribute("href"));
  assert("B1: 兜底扫描捕获静默 www 链接", hrefsB.includes("https://www.example.com"), JSON.stringify(hrefsB));
  assert("B3: 带路径裸域名补全转换", hrefsB.includes("https://example.com/page/1"), JSON.stringify(hrefsB));
  assert("J-2: 二段裸域名 example.com 仍不转换（稳健策略未回归）",
    !hrefsB.includes("https://example.com"), JSON.stringify(hrefsB));
  assert("J-3: 子域名 sub2.example.org 在兜底扫描中也被转换",
    hrefsB.includes("https://sub2.example.org"), JSON.stringify(hrefsB));

  /* ── K 组：文件名否决（用户报 GitHub release 附件名误判） ── */
  console.log("\n[14] 文件扩展名否决…");
  // K1/K2: release 附件文件名独立出现 → 不转换（保持 GitHub 原生行为）
  const divK = new MockElement("div");
  const k1 = new MockNode(3, "#text", "example-app-1.0.17-win64.zip");
  const k2 = new MockNode(3, "#text", "example-app-1.0.17.dmg 是 Mac 安装包");
  const k5 = new MockNode(3, "#text", "会议纪要 report.2026.doc 已归档");
  divK.appendChild(k1);
  divK.appendChild(new MockElement("br"));
  divK.appendChild(k2);
  divK.appendChild(new MockElement("br"));
  divK.appendChild(k5);
  doc.body.appendChild(divK);
  await sleep(600);
  const hrefsK = collectAnchors(divK, []).map((a) => a.getAttribute("href"));
  assert("K1: release 附件名 example-app-1.0.17-win64.zip 不再误判为网址",
    !hrefsK.some((h) => (h || "").includes("example-app-1.0.17-win64")), JSON.stringify(hrefsK));
  assert("K2: .dmg / .doc 结尾的文件名同样不转换",
    hrefsK.length === 0, JSON.stringify(hrefsK));
  assert("K3: 原始文本保持纯文本未被改动",
    divK.textContent.includes("example-app-1.0.17-win64.zip") && divK.textContent.includes("report.2026.doc"));

  // K4: 带 https:// 的完整 .zip 直链不受否决影响（tier1 优先）
  const divK4 = new MockElement("div");
  divK4.appendChild(new MockNode(3, "#text",
    "下载：https://github.com/example-org/example-app/releases/download/1.0.17/example-app-1.0.17-win64.zip"));
  doc.body.appendChild(divK4);
  await sleep(600);
  const hrefsK4 = collectAnchors(divK4, []).map((a) => a.getAttribute("href"));
  assert("K4: 带协议头的完整 .zip 直链正常转换（不被误伤）",
    hrefsK4.length === 1 && hrefsK4[0] === "https://github.com/example-org/example-app/releases/download/1.0.17/example-app-1.0.17-win64.zip",
    JSON.stringify(hrefsK4));

  // K5: 子域名修复不回退——news.example.com（.com 不在扩展名表）仍转换
  const divK5 = new MockElement("div");
  divK5.appendChild(new MockNode(3, "#text", "网站：news.example.com 免费软件"));
  doc.body.appendChild(divK5);
  await sleep(400);
  const hrefsK5 = collectAnchors(divK5, []).map((a) => a.getAttribute("href"));
  assert("K5: 子域名修复不回退，news.example.com 仍转换",
    hrefsK5.includes("https://news.example.com"), JSON.stringify(hrefsK5));

  const failed = results.filter((r) => !r.pass);
  console.log("\n════════════════════════════════");
  console.log("总计 " + results.length + " 项，通过 " + (results.length - failed.length) + " 项，失败 " + failed.length + " 项");
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("测试异常:", e); process.exit(2); });
