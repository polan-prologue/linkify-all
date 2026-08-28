// ==UserScript==
// @name         Linkify All - 明文链接自动转换
// @namespace    local.linkify.all
// @version      1.0.6
// @description  把任意网页中的明文网址自动变成可点击链接：全站生效、子域名识别、场景开关、学习规则、网盘提取码自动填入、失效链接检测、WebDAV 版本化云备份。零依赖纯本地。
// @author       polan-prologue
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      *
// @homepageURL  https://github.com/polan-prologue/linkify-all
// @supportURL   https://github.com/polan-prologue/linkify-all/issues
// @license      MIT
// ==/UserScript==

/*
 * ────────────────────────── 使用说明（v1.0） ──────────────────────────
 * 油猴菜单只有 4 项：
 *   1. 总开关（即时生效）
 *   2. 把当前站点加入/移出黑名单（即时生效）
 *   3. 🎓 学习新规则…（弹窗可拖动、不挡页面、抓取选中文字、回车提交、Esc 关闭）
 *   4. ⚙️ 设置…（统一面板：场景开关 / 学习规则管理 / WebDAV 云备份 / 本地备份迁移）
 *
 * 场景开关（设置面板内）：
 *   - 代码块转换（pre/code）   默认开启
 *   - 富文本编辑器内转换       默认关闭（可能干扰输入，按需开）
 *   - 按钮/控件文本转换       默认关闭
 *   - 已有链接内文本转换       默认关闭（防嵌套）
 *
 * 备份迁移：
 *   - 本地导出 JSON / 本地导入（文件选择 + 粘贴双通道）
 *   - WebDAV 云备份 / 恢复 / 设置（地址/账号/密码，凭据仅存本机）
 *
 * Alt + 点击转换出的链接 = 复制原始明文（链接含提取码时一并复制）
 * Ctrl + 点击明文网址文本 = 直链跳转（含被防误判跳过的裸域名/文件名等）
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ══════════════════ 可调配置 ══════════════════ */

  var MAX_TEXT_LENGTH = 50000;
  var BATCH_DELAY = 150;
  var SWEEP_INTERVAL = 2500;
  var MAX_SHADOW_DEPTH = 20;
  var SCAN_BUDGET_INIT = 20;     // v1.0.6: 初始全页扫描单轮主线程预算（ms），超预算剩余节点入队分批继续
  var SCAN_BUDGET_SWEEP = 6;     // v1.0.6: 兜底扫描单轮预算（ms），大页面不在一次空闲回调里爬完全页

  var CHECK_DEAD = true;
  var CHECK_MAX_PER_PAGE = 20;      // v1.0.3: 50 → 20，降低链接密集页探测压力
  var CHECK_CONCURRENCY = 2;
  var CHECK_TIMEOUT = 9000;
  var CHECK_START_DELAY = 2500;     // v1.0.3: 1200 → 2500，避开页面加载尖峰
  var CACHE_TTL = 24 * 3600 * 1000;
  var CACHE_KEY = "lfa_deadcache";
  var CACHE_SAVE_MAX = 500;

  var CODE_SEARCH_AFTER = 80;
  var CODE_SEARCH_BEFORE = 60;

  var RULES_KEY = "lfa_rules";
  var MAX_RULES = 200;

  // 场景开关默认值（false 存 GM 才视为关闭；未设置/true 均为开启）
  var OPT_DEFAULTS = {
    precode: true,    // 代码块 pre/code 内转换
    editable: false,  // 富文本编辑器/输入控件内转换
    control: false,   // 按钮/下拉等控件文本转换
    linkinside: false // 已有链接内部转换
  };

  /* ══════════════════ 识别正则 ══════════════════ */

  var P = "[^\\s<>\"'{}|\\^\\[\\]`\\x7f-\\uffff]";
  var SCHEME_SRC = "\\bhttps?:\\/\\/" + P + "+";
  var LABEL = "[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?";
  var DOMAIN = "(?:" + LABEL + "\\.)+[a-zA-Z]{2,24}";
  var HOST_WWW = "www\\.(?:" + LABEL + "\\.)*[a-zA-Z]{2,24}";
  // 子域名主机（≥3 段，如 news.example.com）：无 www 无路径也值得转换，
  // 与易误判的二段裸域名（example.com，仍不转）区分
  var HOST_SUB = "(?:" + LABEL + "\\.){2,}[a-zA-Z]{2,24}";
  var HOST_PATH = DOMAIN + "(?:\\/" + P + "*)";
  var HOST_WWW_P = HOST_WWW + "(?:\\/" + P + "*)?";
  var HOST_SUB_P = HOST_SUB + "(?:\\/" + P + "*)?";
  var TIER2_SRC = "(?:" + HOST_WWW_P + "|" + HOST_SUB_P + "|" + HOST_PATH + ")";
  var MAIN_RE = new RegExp(SCHEME_SRC + "|" + TIER2_SRC, "gi");
  var PREFILTER_RE = /:\/\/|www\.|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\//;
  // 预筛补充：≥3 段的主机文本也要进完整匹配（否则新分支被 prefilter 提前挡掉）
  var PREFILTER_SUB_RE = /(?:[a-zA-Z0-9-]+\.){2,}[a-zA-Z]{2,}/;

  var CODE_LABEL = "(提取\\s*码|提取|访问码|访问|密码|密碼|口令|密钥|pwd)";
  var CODE_BODY = "\\s*[:：=》»]?\\s*([a-zA-Z0-9]{4,10})";
  var CODE_RE_NG = new RegExp(CODE_LABEL + CODE_BODY, "i");
  var CODE_RE_G = new RegExp(CODE_LABEL + CODE_BODY, "gi");
  var CODE_STOP = { http: 1, https: 1, www: 1, com: 1, cn: 1, net: 1, org: 1, html: 1, bv: 1, av: 1, html5: 1 };

  // v1.0.1 修复：部分站点/复制链路会在 URL 中段夹带零宽字符（软连字符、
  // 零宽空格等，肉眼不可见），本用于打断自动识别，却使正则在中途截断，
  // 产生 "https://host首段" 这类残缺短链。这些字符不影响显示，统一剥离。
  var INVISIBLE_RE = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

  /* ══════════════════ 场景开关与排除规则 ══════════════════ */

  var HTML_NS = "http://www.w3.org/1999/xhtml";

  function optOn(k) {
    var v;
    try { v = GM_getValue("lfa_opt_" + k, undefined); } catch (e) { }
    if (v === undefined || v === null) return !!OPT_DEFAULTS[k];
    return v !== false;
  }

  var skipCache = new WeakMap();   // v1.0.3: 父元素 → 祖先链 skippable 判定缓存
  var ownNodes = new WeakSet();    // v1.0.6: 本脚本创建的节点，MutationObserver 不再回处理
  var optCache = null;             // v1.0.6: 场景开关内存快照，setOpt 时失效重建
  function setOpt(k, on) {
    try { GM_setValue("lfa_opt_" + k, !!on); } catch (e) { }
    optCache = null;
    skipCache = new WeakMap();     // 场景开关变化后判定失效，整表重建
  }

  function allOpts() {
    var out = {}, k;
    for (k in OPT_DEFAULTS) if (OPT_DEFAULTS.hasOwnProperty(k)) out[k] = optOn(k);
    return out;
  }

  // v1.0.6: 热路径共用快照。isSkippable 对每个文本节点都会调用，逐节点同步读
  // GM 存储（IPC 往返开销大），改为一次读取、setOpt 时重建
  function optSnapshot() {
    if (!optCache) optCache = allOpts();
    return optCache;
  }

  function isSkippable(node) {
    var o = optSnapshot();
    var precode = o.precode, editable = o.editable, control = o.control, linkinside = o.linkinside;
    for (var n = node; n; n = n.parentNode) {
      if (n === document.body || n.nodeType === 11) break;
      if (n.nodeType !== 1) continue;
      var tag = n.tagName;
      if (tag === "A") {
        // v1.0.6: 自身产出的链接恒定跳过——即使「已有链接内部」开启，也不对自己重复转换嵌套
        if (n.getAttribute && n.getAttribute("data-lfa") === "1") return true;
        if (!linkinside) return true;
      }
      if ((tag === "PRE" || tag === "CODE") && !precode) return true;
      if ((tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || tag === "OPTION") && !editable) return true;
      if (tag === "BUTTON" && !control) return true;
      if (n.isContentEditable && !editable) return true;
      var ns = n.namespaceURI;
      if (ns && ns !== HTML_NS) return true;
    }
    return false;
  }

  // v1.0.3：按直接父元素缓存祖先链判定——同一父元素下的文本节点不重复爬链，
  // 重复扫描/兄弟节点密集时大幅削减开销；场景开关变化（setOpt/reapply）时重建
  function isSkippableCached(node) {
    var p = node && node.parentNode;
    if (!p || p.nodeType !== 1) return isSkippable(node);
    var v = skipCache.get(p);
    if (v === undefined) {
      v = isSkippable(node) ? 1 : 0;
      try { skipCache.set(p, v); } catch (e) { }
    }
    return v === 1;
  }

  // 场景开关变化后的整页重处理（先还原再转换，保证前后一致）
  function reapply() {
    if (!isEnabled() || isBlacklisted(location.hostname)) return;
    skipCache = new WeakMap();
    deactivate();
    unwrapAll();
    activate();
  }

  /* ══════════════════ URL 清洗 ══════════════════ */

  var TRAILING_PUNCT = ".,;:!?、。，；：！？：；、·";
  var PAIRS = {
    ")": "(", "]": "[", "}": "{",
    "\"": "\"", "'": "'",
    "）": "（", "」": "「", "』": "『", "》": "《"
  };

  function trimTrailing(url) {
    var end = url.length;
    while (end > 0) {
      var ch = url.charAt(end - 1);
      if (TRAILING_PUNCT.indexOf(ch) !== -1) { end--; continue; }
      if (PAIRS[ch] !== undefined) {
        var open = PAIRS[ch], closes = 0, opens = 0;
        for (var i = 0; i < end; i++) {
          if (url.charAt(i) === ch) closes++;
          else if (url.charAt(i) === open) opens++;
        }
        if (closes > opens) { end--; continue; }
      }
      break;
    }
    return url.slice(0, end);
  }

  function trimLoose(s) {
    s = s.trim();
    var MIRROR = {
      "\"": "\"", "'": "'", "“": "”", "‘": "’",
      "「": "」", "『": "』", "《": "》", "（": "）",
      "(": ")", "[": "]", "【": "】", "{": "}"
    };
    while (s.length > 1 && MIRROR[s.charAt(0)] && s.charAt(s.length - 1) === MIRROR[s.charAt(0)]) {
      s = s.slice(1, -1).trim();
    }
    return s;
  }

  function toHref(raw) {
    var s = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
    try {
      var u = new URL(s);
      if (!u.hostname) return null;
      return s;
    } catch (e) { return null; }
  }

  function hostOf(href) {
    try { return new URL(href).hostname || ""; } catch (e) { return ""; }
  }

  /* ══════════════════ 网盘识别与提取码 ══════════════════ */

  var PAN_HOST_RE = /(^|\.)(pan\.baidu\.com|pan\.quark\.cn|[a-z0-9.-]*lanzou[a-z]*(\.com|\.cc|\.xyz|\.lan|\.vip|\.org)|alipan\.com|aliyundrive\.com|cloud\.189\.cn|115\.com|115cdn\.com|pan\.xunlei\.com|123pan\.com|123684\.com|123865\.com|caiyun\.139\.com|share\.weiyun\.com|pan\.uc\.cn)$/i;

  function isPanUrl(href) { return PAN_HOST_RE.test(hostOf(href)); }
  function isBaiduPan(href) { return /(^|\.)pan\.baidu\.com$/i.test(hostOf(href)); }

  function applyCodeToHref(href, code) {
    if (!code) return href;
    if (isBaiduPan(href)) {
      if (/[?&]pwd=/i.test(href)) return href;
      var base = href.split("#")[0];
      return base + (base.indexOf("?") === -1 ? "?" : "&") + "pwd=" + encodeURIComponent(code);
    }
    var b2 = href.split("#")[0];
    return b2 + "#lfa-c=" + encodeURIComponent(code);
  }

  function validCode(tok, srcText, endIdx) {
    if (!tok) return null;
    var t = tok.trim();
    if (t.length < 4 || t.length > 10) return null;
    if (CODE_STOP[t.toLowerCase()]) return null;
    if (srcText.charAt(endIdx) === ":") return null;
    return t;
  }

  /* ══════════════════ 学习规则引擎 ══════════════════ */

  var rules = [];
  var rulesDirty = false;

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function longestCommonSubstr(a, b) {
    var best = "", bestLen = 0;
    for (var i = 0; i < a.length; i++) {
      for (var j = i + 1; j <= a.length; j++) {
        if (j - i <= bestLen) continue;
        var s = a.slice(i, j);
        // 可变片段须以字母数字开头和结尾（URL 变量语义），
        // 否则会匹配到 "/123456" 这类带符号片段导致推导验证失败
        if (!/[A-Za-z0-9]/.test(s.charAt(0)) || !/[A-Za-z0-9]/.test(s.charAt(s.length - 1))) continue;
        if (b.indexOf(s) !== -1) { best = s; bestLen = j - i; }
      }
    }
    return best;
  }

  function generalizeVar(s) {
    if (/^\d+$/.test(s)) return "\\d+";
    if (/^[A-Za-z]+$/.test(s)) return "[A-Za-z][A-Za-z0-9]*";
    return "[A-Za-z0-9][A-Za-z0-9._\\-/]*";
  }

  function ruleRegex(pat, flags) {
    return new RegExp("(?<![A-Za-z0-9])" + pat + "(?![A-Za-z0-9])", flags || "gi");
  }

  function inferRule(rawText, urlText) {
    var raw = String(rawText || "").trim();
    var url = String(urlText || "").trim();
    if (!raw && !url) return { ok: false, err: "请填写原文本和跳转链接" };
    if (!raw) return { ok: false, err: "原文本为空" };
    if (!url) return { ok: false, err: "跳转链接为空" };
    if (raw.length > 200 || url.length > 800) return { ok: false, err: "内容过长" };
    if (/^https?:\/\//i.test(raw)) return { ok: false, err: "原文本本身已是完整网址，无需学习" };
    if (!/^https?:\/\//i.test(url)) {
      var h = toHref(url);
      if (!h) return { ok: false, err: "跳转链接需以 http:// 或 https:// 开头" };
      url = h;
    }
    var lcs = longestCommonSubstr(raw, url);
    if (!lcs || lcs.length < 2) return { ok: false, err: "未找到对应片段：原文本与链接中需含有相同的部分" };
    var ri = raw.indexOf(lcs), ui = url.indexOf(lcs);
    var rawPre = raw.slice(0, ri), rawSuf = raw.slice(ri + lcs.length);
    var urlPre = url.slice(0, ui), urlSuf = url.slice(ui + lcs.length);
    if (!rawPre && !rawSuf) return { ok: false, err: "规则过于宽泛：请让原文本包含一些固定文字（前缀或后缀）" };
    var varPat = generalizeVar(lcs);
    var pat = escapeRe(rawPre) + "(" + varPat + ")" + escapeRe(rawSuf);
    var m = ruleRegex(pat, "i").exec(raw);
    if (!m || m[0] !== raw || urlPre + m[1] + urlSuf !== url) {
      return { ok: false, err: "对应关系不成立：请检查两段内容是否一一对应" };
    }
    var varLabel = (varPat === "\\d+") ? "数字" : ((varPat === "[A-Za-z][A-Za-z0-9]*") ? "字母数字" : "字符");
    return {
      ok: true,
      human: "「" + rawPre + "⟨" + varLabel + "⟩" + rawSuf + "」 → 「" + urlPre + "⟨" + varLabel + "⟩" + urlSuf + "」",
      pat: pat, urlPre: urlPre, urlSuf: urlSuf,
      probe: (rawPre || rawSuf).toLowerCase().slice(0, 24),
      sampleRaw: raw, sampleUrl: url
    };
  }

  function ruleRecord(r) {
    return {
      id: r.id, pat: r.pat, urlPre: r.urlPre, urlSuf: r.urlSuf, probe: r.probe,
      sampleRaw: r.sampleRaw, sampleUrl: r.sampleUrl,
      enabled: r.enabled, hits: r.hits, ts: r.ts
    };
  }

  function loadRules() {
    rules = [];
    var raw = [];
    try { raw = GM_getValue(RULES_KEY, []); } catch (e) { }
    if (!Array.isArray(raw)) return;
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];
      if (!r || !r.pat || !r.urlPre) continue;
      var c = {
        id: r.id, pat: r.pat, urlPre: r.urlPre, urlSuf: r.urlSuf || "",
        probe: r.probe || "", sampleRaw: r.sampleRaw || "", sampleUrl: r.sampleUrl || "",
        enabled: r.enabled !== false, hits: r.hits || 0, ts: r.ts || Date.now()
      };
      try { c.re = ruleRegex(c.pat, "gi"); } catch (e) { continue; }
      rules.push(c);
    }
    markProbeDirty();   // v1.0.4: 规则重新加载后需重建 probe 正则
  }

  function saveRules() {
    var out = [];
    for (var i = 0; i < rules.length; i++) out.push(ruleRecord(rules[i]));
    try { GM_setValue(RULES_KEY, out); } catch (e) { }
    markProbeDirty();   // v1.0.4: 规则变化后 probe 正则需重建
    // 规则持久化后通知设置面板刷新列表（教学/导入/开关变更等所有入口统一生效）
    try { if (refreshSettingsRules) refreshSettingsRules(); } catch (e) { }
  }

  function addRuleByPair(rawText, urlText) {
    var inf = inferRule(rawText, urlText);
    if (!inf.ok) return inf;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].pat === inf.pat) {
        rules[i].enabled = true;
        rules[i].sampleRaw = inf.sampleRaw;
        rules[i].sampleUrl = inf.sampleUrl;
        saveRules();
        return { ok: true, dup: true, rule: rules[i] };
      }
    }
    if (rules.length >= MAX_RULES) return { ok: false, err: "规则数量已达上限（" + MAX_RULES + " 条）" };
    var rule = {
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      pat: inf.pat, urlPre: inf.urlPre, urlSuf: inf.urlSuf,
      probe: inf.probe, sampleRaw: inf.sampleRaw, sampleUrl: inf.sampleUrl,
      enabled: true, hits: 0, ts: Date.now()
    };
    try { rule.re = ruleRegex(rule.pat, "gi"); } catch (e) { return { ok: false, err: "规则编译失败" }; }
    rules.push(rule);
    saveRules();
    return { ok: true, rule: rule };
  }

  var probeRe = null;        // v1.0.4: 合并全部启用规则的 probe 为单一正则
  var probeDirty = true;     // 规则增删/启停时置脏，下次匹配前重建

  function rebuildProbeRe() {
    var parts = [], seen = {};
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r.enabled || !r.probe) continue;
      var p = r.probe;
      if (seen[p]) continue;
      seen[p] = 1;
      parts.push(escapeRe(p));
    }
    probeRe = parts.length ? new RegExp(parts.join("|"), "i") : null;
    probeDirty = false;
  }

  function markProbeDirty() {
    probeDirty = true;
    probeRe = null;
  }

  function ruleProbeHit(text) {
    if (probeDirty) rebuildProbeRe();
    if (!probeRe) return false;
    return probeRe.test(text);
  }

  // v1.0.4: 合并两个预筛正则减少正则调用次数
  var PREFILTER_COMBINED = /:\/\/|www\.|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/|(?:[a-zA-Z0-9-]+\.){2,}[a-zA-Z]{2,}/;

  function textPrefilter(text) {
    // v1.0.6: 不含 "." 也不含 ":" 的文本不可能命中任何 URL 分支（协议/域名/www 均含其一），
    // 只需查学习规则探测，纯中文/纯文本节点不再跑完整预筛正则
    if (text.indexOf(".") === -1 && text.indexOf(":") === -1) return ruleProbeHit(text);
    return PREFILTER_COMBINED.test(text) || ruleProbeHit(text);
  }

  /* ══════════════════ 核心：文本节点转换 ══════════════════ */

  // 疑似文件扩展名黑名单：无协议候选以此结尾 → 视为文件名而非网址，不转换。
  // v1.0 修复：GitHub release 附件名 example-app-1.0.17-win64.zip 被子域名分支
  // 误判成 https://example-app-1.0.17-win64.zip/（.zip/.mov/.app 均已开放为 gTLD，
  // 但作为文件名远比真站常见，故否决优先）。
  var FILE_EXT_BLACKLIST = {
    zip: 1, rar: 1, "7z": 1, exe: 1, msi: 1, msix: 1,
    dmg: 1, pkg: 1, deb: 1, rpm: 1, tar: 1, gz: 1, bz2: 1, xz: 1, zst: 1,
    iso: 1, img: 1, ipa: 1, apk: 1, app: 1, appimage: 1, bin: 1, dat: 1,
    doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, pdf: 1,
    txt: 1, md: 1, csv: 1, xml: 1, torrent: 1,
    mp4: 1, mkv: 1, avi: 1, mov: 1, wmv: 1, flv: 1, webm: 1,
    mp3: 1, wav: 1, flac: 1, ape: 1, m4a: 1, m4v: 1,
    jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, bmp: 1, psd: 1,
    dll: 1, jar: 1, class: 1, swf: 1,
    ttf: 1, otf: 1, woff: 1, woff2: 1, db: 1, bak: 1
  };

  function looksLikeFileName(raw) {
    if (/^https?:\/\//i.test(raw)) return false; // 带协议头的完整 URL 不否决（.zip 直链是真链接）
    var segs = raw.split(".");
    if (segs.length < 2) return false;
    return FILE_EXT_BLACKLIST[segs[segs.length - 1].toLowerCase()] === 1;
  }

  function findUrls(text) {
    var out = [];
    MAIN_RE.lastIndex = 0;
    var m;
    while ((m = MAIN_RE.exec(text)) !== null) {
      if (m.index === MAIN_RE.lastIndex) MAIN_RE.lastIndex++;
      var raw = trimTrailing(m[0]);
      if (!raw || raw.length < 6) continue;
      // 文件名否决（在 toHref 之前，裸 host/子域名误判在此拦截）
      if (looksLikeFileName(raw)) continue;
      var href = toHref(raw);
      if (!href) continue;
      out.push({ start: m.index, end: m.index + raw.length, mend: m.index + m[0].length, raw: raw, href: href });
    }
    return out;
  }

  function findCodeNear(text, hits, idx) {
    var h = hits[idx];
    var rightEnd = (idx + 1 < hits.length) ? hits[idx + 1].start : Math.min(text.length, h.end + CODE_SEARCH_AFTER);
    var segR = text.slice(h.end, rightEnd);
    var mR = CODE_RE_NG.exec(segR);
    if (mR) {
      var c1 = validCode(mR[2], text, h.end + mR.index + mR[0].length);
      if (c1) return c1;
    }
    var leftStart = (idx > 0) ? hits[idx - 1].end : Math.max(0, h.start - CODE_SEARCH_BEFORE);
    var segL = text.slice(leftStart, h.start);
    CODE_RE_G.lastIndex = 0;
    var mL, last = null, lastEnd = 0;
    while ((mL = CODE_RE_G.exec(segL)) !== null) {
      last = mL; lastEnd = leftStart + mL.index + mL[0].length;
    }
    if (last) {
      var c2 = validCode(last[2], text, lastEnd);
      if (c2) return c2;
    }
    return null;
  }

  function findRuleHits(text) {
    var out = [];
    for (var r = 0; r < rules.length; r++) {
      var ru = rules[r];
      if (!ru.enabled || !ru.re) continue;
      ru.re.lastIndex = 0;
      var mm;
      while ((mm = ru.re.exec(text)) !== null) {
        if (mm[0].length === 0) { ru.re.lastIndex++; continue; }
        out.push({ start: mm.index, end: mm.index + mm[0].length, raw: mm[0], href: ru.urlPre + mm[1] + ru.urlSuf, ruleId: ru.id });
        ru.hits++;
        rulesDirty = true;
      }
    }
    return out;
  }

  // v1.0.6: 本脚本创建的文本节点登记进 ownNodes，观察器不再回处理
  function lfaTextNode(s) {
    var t = document.createTextNode(s);
    ownNodes.add(t);
    return t;
  }

  function buildAnchor(hit) {
    var a = document.createElement("a");
    var href = hit.href;
    if (hit.code && isPanUrl(href)) {
      href = applyCodeToHref(href, hit.code);
      a.setAttribute("data-code", hit.code);
    }
    a.href = href;
    a.textContent = hit.raw;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("data-lfa", "1");
    a.setAttribute("data-raw", hit.raw);
    if (hit.ruleId) a.setAttribute("data-rule", hit.ruleId);
    a.style.cursor = "pointer";
    a.style.textDecoration = "underline";
    ownNodes.add(a);   // v1.0.6: 自身产物（锚点及其文本）不再触发观察器回处理
    enqueueDeadCheck(a);
    return a;
  }

  /* ── v1.0.2：跨节点续接 ──
   * 内容平台会把链接文本拆进多个相邻内联节点（甚至中间插入平台自带的局部
   * 链接），单节点匹配只能看到 "https://host首段" 这类残缺片段。策略：
   * ① 命中延伸到节点末尾且主机名不完整 → 向后收集兄弟节点中的 URL 字符
   *    前缀，续接成完整链接，整块替换并吞并被消费的兄弟节点；
   * ② 续接不成 → 抑制该命中，宁可不转也不出残缺短链；
   * ③ 完整链接即使恰好结尾于节点末尾也不续接，避免误吞无关后续文本。
   * v1.0.4 ④ 节点恰好以裸协议头（协议后零字符）收尾时常规匹配必然落空、
   *    续接器没有启动种子 → 合成种子命中，交由同一套续接管线组装验证。 */

  var CONT_URL_RE = /^[A-Za-z0-9._~:/?#@!$&'()*+,;=\-[\]%]+/;
  var INLINE_TAGS = { SPAN: 1, A: 1, B: 1, I: 1, EM: 1, STRONG: 1, U: 1, S: 1, CODE: 1, SMALL: 1, LABEL: 1, FONT: 1, WBR: 1, MARK: 1 };

  function hostIncomplete(raw) {
    var mh = /^https?:\/\/([^/?#]+)/i.exec(raw);
    if (!mh) return false;
    var labels = mh[1].split(".");
    if (labels.length < 2) return true;   // 主机无点 → 明显残缺
    return labels[labels.length - 1].length < 2;
  }

  // 内联包裹穿透：文本节点若被 <span> 等内联元素包住且是该元素末尾，
  // 从最外层内联祖先开始找续接（不跨块级元素/根容器）
  function inlineEndNode(node) {
    var n = node;
    while (n && n.parentNode) {
      var p = n.parentNode;
      if (p.nodeType !== 1) break;
      var kids = p.childNodes, last = false;
      for (var i = kids.length - 1; i >= 0; i--) { if (kids[i] === n) { last = i === kids.length - 1; break; } }
      if (!last) break;
      var tag = p.tagName || "";
      if (!INLINE_TAGS[tag] && tag.indexOf("-") === -1) break;
      n = p;
    }
    return n;
  }

  // 收集 node 之后兄弟内容中可续接的 URL 字符前缀。文本节点可部分消费
  // （改写 nodeValue）；元素节点同样支持部分消费——保留包裹元素与其残余
  // 文本，仅剔除已被并走的 URL 前缀（平台常把「链接尾巴+正文」包进同一
  // 个 <span>）。最多串联 12 个兄弟节点（v1.0.4: 6→12），覆盖更深拆分链
  function collectContinuation(node) {
    var str = "", parts = [], sib = node.nextSibling, guard = 0;
    while (sib && guard++ < 12 && str.length < 500) {
      if (sib.nodeType === 1 && sib.getAttribute && sib.getAttribute("data-lfa")) break;
      var t = sib.nodeType === 3 ? (sib.nodeValue || "") : (sib.textContent || "");
      if (!t) { sib = sib.nextSibling; continue; }
      var mc = CONT_URL_RE.exec(t);
      var take = mc ? mc[0] : "";
      if (!take) break;
      var partial = take.length < t.length;
      parts.push({ node: sib, len: take.length, partial: partial, orig: t });
      str += take;
      if (partial) break;
      sib = sib.nextSibling;
    }
    return { str: str, parts: parts };
  }

  // 续接核心（v1.0.4 自 v1.0.2 内联逻辑抽出公用）：以 hit 为种子，
  // 收集节点末尾之后的兄弟 URL 前缀整体组装。组装文本先剥离缝合处粘连的
  // 前导符号（拆分往往把 "." 这类分隔符留在了下一个节点里），再经「主机
  // 完整性」与 toHref 双重闸门——单标签主机、半截主机一律视为组装不完整，
  // 宁可不转也不出残缺短链；通过后改写 hit 并返回待消费的兄弟列表。
  function stitchFromHit(hit, node, text) {
    var cont = collectContinuation(inlineEndNode(node));
    var joined = text.slice(hit.start) + cont.str;
    joined = joined.replace(/^(https?:\/\/)\.+/i, "$1");
    var stitched = trimTrailing(joined);
    if (!stitched || hostIncomplete(stitched)) {
      hit.suppressed = true;
      return null;
    }
    var shref = toHref(stitched);
    if (!cont.str || !shref || stitched.length <= hit.raw.length + 1) {
      hit.suppressed = true;
      return null;
    }
    hit.raw = stitched;
    hit.href = shref;
    hit.end = text.length;
    return cont.parts;
  }

  function processTextNode(node) {
    var text = node.nodeValue;
    if (INVISIBLE_RE.test(text)) {
      text = text.replace(INVISIBLE_RE, "");   // v1.0.1: 剥离零宽字符后再匹配
      // v1.0.4: 标记内部写入，避免 nodeValue 变更触发 MO 产生额外处理
      internalWrite = true;
      try { node.nodeValue = text; } catch (e) { }
      internalWrite = false;
    }
    if (!text || text.length < 6 || text.length > MAX_TEXT_LENGTH) return false;
    if (!node.parentNode) return false;
    if (isSkippableCached(node)) return false;
    if (!textPrefilter(text)) return false;

    var urlHits = findUrls(text);
    // v1.0.6: 提取码只对网盘链接有意义；非网盘命中不再做链接周边文本的补充正则搜索。
    // 边界参数仍用原始命中数组，与旧行为完全一致
    for (var k = 0; k < urlHits.length; k++) {
      if (isPanUrl(urlHits[k].href)) urlHits[k].code = findCodeNear(text, urlHits, k);
    }
    var removeParts = null;
    if (urlHits.length) {
      var lastHit = urlHits[urlHits.length - 1];
      if (lastHit.mend >= text.length && hostIncomplete(lastHit.raw)) {
        removeParts = stitchFromHit(lastHit, node, text);
      }
    }
    // v1.0.4：裸协议尾种子——节点以孤立 "https://"（协议后零字符）收尾时，
    // SCHEME_SRC 要求协议后至少 1 字符，常规匹配在此必然落空，跨节点续接器
    // 因没有种子而整链失联。此处合成种子命中进入同一套续接管线；协议头前
    // 紧贴字母数字（非自然边界）、或任一命中已触及节点末尾时不补种。
    if (!removeParts) {
      var mSeed = /https?:\/\/$/i.exec(text);
      var seedOk = !!mSeed;
      var ss = seedOk ? mSeed.index : -1;
      if (seedOk && ss > 0 && /[A-Za-z0-9]/.test(text.charAt(ss - 1))) seedOk = false;
      for (var si2 = 0; seedOk && si2 < urlHits.length; si2++) {
        if (urlHits[si2].end > ss || urlHits[si2].mend >= text.length) seedOk = false;
      }
      if (seedOk) {
        var seed = { start: ss, end: text.length, mend: text.length, raw: mSeed[0], href: null };
        urlHits.push(seed);
        removeParts = stitchFromHit(seed, node, text);
      }
    }
    var ruleHits = findRuleHits(text);

    var merged = [];
    for (var k2 = 0; k2 < urlHits.length; k2++) if (!urlHits[k2].suppressed) merged.push(urlHits[k2]);
    for (var q = 0; q < ruleHits.length; q++) {
      var rh = ruleHits[q];
      var overlap = false;
      for (var w = 0; w < merged.length; w++) {
        if (rh.start < merged[w].end && merged[w].start < rh.end) { overlap = true; break; }
      }
      if (!overlap) merged.push(rh);
    }
    if (!merged.length) return false;
    merged.sort(function (a, b) { return a.start - b.start; });

    var frag = document.createDocumentFragment();
    var pos = 0;
    for (var i = 0; i < merged.length; i++) {
      var h = merged[i];
      if (h.start > pos) frag.appendChild(lfaTextNode(text.slice(pos, h.start)));
      frag.appendChild(buildAnchor(h));
      pos = h.end;
    }
    if (pos < text.length) frag.appendChild(lfaTextNode(text.slice(pos)));

    // v1.0.6: 转换写入自身 DOM 时挂 internalWrite，本脚本产物不再回流观察器队列
    internalWrite = true;
    try {
      node.parentNode.replaceChild(frag, node);
      if (removeParts) {
        for (var rp = 0; rp < removeParts.length; rp++) {
          var part = removeParts[rp], pn = part.node;
          if (!pn.parentNode) continue;
          if (part.partial && pn.nodeType === 3) {
            try { pn.nodeValue = (pn.nodeValue || "").slice(part.len); } catch (e) { }
          } else if (part.partial && pn.nodeType === 1) {
            // 元素部分消费：保留包裹与残余正文，仅剔除已被并走的 URL 前缀
            var remain = (part.orig || "").slice(part.len);
            try {
              while (pn.firstChild) pn.removeChild(pn.firstChild);
              if (remain) pn.appendChild(lfaTextNode(remain));
            } catch (e) { }
          } else {
            pn.parentNode.removeChild(pn);
          }
        }
      }
    } finally {
      internalWrite = false;
    }
    sweepConverted++;
    return true;
  }

  /* ══════════════════ 遍历（含 Shadow DOM 内容穿透） ══════════════════ */

  function makeTextFilter() {
    return {
      acceptNode: function (n) {
        var v = n.nodeValue;
        if (!v || v.length < 6 || v.length > MAX_TEXT_LENGTH) return NodeFilter.FILTER_REJECT;
        if (isSkippableCached(n)) return NodeFilter.FILTER_REJECT;
        if (!textPrefilter(v)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    };
  }

  function processRoot(root) {
    if (!root) return;
    if (root.nodeType === 3) { processTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, makeTextFilter());
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (var i = 0; i < nodes.length; i++) processTextNode(nodes[i]);
  }

  // budgetMs 给定时为单轮主线程预算：超时即停，剩余文本节点转入队列分块处理，
  // 调用方据此知道本轮是否被迫中断（返回 true）。不传 budgetMs 则整树一次扫完。
  function processRootDeep(root, depth, budgetMs) {
    depth = depth || 0;
    if (!root || depth > MAX_SHADOW_DEPTH) return false;
    if (root.nodeType === 3) { processTextNode(root); return false; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return false;
    // v1.0.4: 跳过已脱离文档的节点，避免处理无效 DOM 子树
    if (root.nodeType === 1 && root !== document.documentElement && root !== document.body && !root.isConnected) return false;
    if (root.nodeType === 1 && root.shadowRoot) {
      observeRoot(root.shadowRoot);
      processRootDeep(root.shadowRoot, depth + 1, budgetMs);
    }
    // v1.0.4: 单次遍历同时收集文本节点和 Shadow DOM 宿主，避免双树遍历
    var textNodes = [], hosts = [];
    try {
      var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: function (n) {
          if (n.nodeType === 3) {
            // v1.0.6: 本脚本链接内的文本直接拒绝——免去祖先链判定与预筛（兜底扫描高频路径）
            var p0 = n.parentNode;
            if (p0 && p0.nodeType === 1 && p0.getAttribute && p0.getAttribute("data-lfa") === "1") return NodeFilter.FILTER_REJECT;
            var v = n.nodeValue;
            if (!v || v.length < 6 || v.length > MAX_TEXT_LENGTH) return NodeFilter.FILTER_REJECT;
            if (isSkippableCached(n)) return NodeFilter.FILTER_REJECT;
            if (!textPrefilter(v)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
          // v1.0.4: 元素节点用 FILTER_SKIP 而非 FILTER_REJECT，
          // 确保 Shadow 宿主的光 DOM 子节点仍可被遍历到
          if (n.nodeType === 1 && n.shadowRoot) { hosts.push(n); }
          return NodeFilter.FILTER_SKIP;
        }
      });
      var node;
      while ((node = w.nextNode())) {
        if (node.nodeType === 3) textNodes.push(node);
      }
    } catch (err) { }
    var deadline = budgetMs ? Date.now() + budgetMs : 0;
    var i = 0;
    for (; i < textNodes.length; i++) {
      if (deadline && (i & 63) === 0 && Date.now() > deadline) break;
      processTextNode(textNodes[i]);
    }
    var bailed = deadline !== 0 && i < textNodes.length;
    if (bailed) {
      // v1.0.6: 剩余节点入队分批处理（每批 8 个 + 宏任务让出），不阻塞渲染也不丢节点
      for (var r = i; r < textNodes.length; r++) schedule(textNodes[r]);
    } else {
      // 预算沿宿主递归传递：Shadow 子树同样受限，扫不玩的剩余部分入队续扫
      for (var j = 0; j < hosts.length; j++) processRootDeep(hosts[j], depth + 1, budgetMs);
    }
    return bailed;
  }

  /* ══════════════════ 动态监听（多根） ══════════════════ */

  var mo = null;
  var observedRoots = new WeakSet();
  var queue = new Set();
  var pending = new Set();   // v1.0.6: 队列+余量的全部待处理节点，供观察器批内祖先去重
  var timer = 0;
  var internalWrite = false;

  function observeRoot(root) {
    if (!mo || !root) return;
    if (observedRoots.has(root)) return;
    try {
      mo.observe(root, { childList: true, subtree: true });
      observedRoots.add(root);
    } catch (e) { }
  }

  function schedule(node) {
    if (internalWrite) return;
    if (ownNodes.has(node)) return;   // v1.0.6: 自身产物不入队
    mutCount++;   // v1.0.3: 变更计数供兜底扫描门控使用
    queue.add(node);
    pending.add(node);
    if (!timer) timer = setTimeout(flushQueue, BATCH_DELAY);
  }

  var QUEUE_CHUNK = 8;   // v1.0.4: 每批处理节点数，避免一次性阻塞主线程
  var queueRest = null;    // 分块处理时的剩余节点

  function flushQueue() {
    timer = 0;
    // 合并上一轮剩余与新增队列，保证不丢节点
    var arr = queueRest ? queueRest.concat(Array.from(queue)) : Array.from(queue);
    queueRest = null;
    queue.clear();
    pending.clear();
    var batchEnd = Math.min(QUEUE_CHUNK, arr.length);
    for (var i = 0; i < batchEnd; i++) {
      var n = arr[i];
      if (!n) continue;
      if (n.nodeType === 3 && !n.parentNode) continue;
      if (n.nodeType === 1 && !n.isConnected) continue;
      try { processRootDeep(n); } catch (e) { }
    }
    if (batchEnd < arr.length) {
      // v1.0.4: 还有剩余 → 暂存并在下一个宏任务继续，让出主线程
      queueRest = arr.slice(batchEnd);
      for (var r2 = 0; r2 < queueRest.length; r2++) pending.add(queueRest[r2]);
      timer = setTimeout(flushQueue, 0);
    }
  }

  function startObserve() {
    if (mo) { observeRoot(document.body); return; }
    mo = new MutationObserver(function (muts) {
      if (internalWrite) return;   // v1.0.6: 自身写入窗口内的回调整批跳过
      // v1.0.6: 先整批收集再统一去重：同批同时新增「父容器+子节点」时只处理父容器，
      // 且已待处理的祖先覆盖其子孙节点——框架/页面批量插大树不再对重叠子树重复爬取
      var into = [];
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType === 1 || n.nodeType === 3) into.push(n);
        }
      }
      for (var k = 0; k < into.length; k++) {
        var nd = into[k];
        if (pending.has(nd) || ownNodes.has(nd)) continue;
        var covered = false;
        for (var p = nd.parentNode; p && p.nodeType !== 9 && p !== document.body; p = p.parentNode) {
          if (pending.has(p)) { covered = true; break; }
        }
        if (!covered) schedule(nd);
      }
    });
    observedRoots = new WeakSet();
    observeRoot(document.body);
  }

  function stopObserve() {
    if (mo) { mo.disconnect(); mo = null; }
    observedRoots = new WeakSet();
    queue.clear();
    pending.clear();
    queueRest = null;   // v1.0.4: 清空分块处理中的剩余节点
    if (timer) { clearTimeout(timer); timer = 0; }
  }

  function patchAttachShadow() {
    try {
      var orig = Element.prototype.attachShadow;
      if (!orig) return;
      Element.prototype.attachShadow = function (init) {
        var sr = orig.call(this, init);
        try { schedule(this); } catch (e) { }
        return sr;
      };
    } catch (e) { }
  }

  /* ══════════════════ 周期性兜底扫描（v1.0.3：门控+降频+空闲调度） ══════════════════
   * 观察器正常工作时页面变更持续计数；自上轮扫描后毫无变更的轮次直接跳过
   * （连续跳过 4 轮强制保底一次，防观察器失效），零新转换的轮次逐级降频
   * 2.5s→30s，一旦扫出新转换立即恢复密集保险。扫描本体放到浏览器空闲时段
   * 执行（requestIdleCallback，2 秒兜底），不挤占渲染帧。 */

  var sweepTimer = 0;
  var sweepDelay = SWEEP_INTERVAL;
  var sweepIdleRounds = 0;
  var sweepSkipStreak = 0;
  var mutCount = 0;
  var sweptMutCount = -1;
  var sweepConverted = 0;
  var SWEEP_LEVELS = [2500, 5000, 10000, 30000];

  function sweepOnce() {
    if (!isEnabled() || document.hidden || !document.body) return;
    if (mutCount === sweptMutCount) {
      if (++sweepSkipStreak < 4) return;
    }
    sweepSkipStreak = 0;
    sweptMutCount = mutCount;
    sweepConverted = 0;
    var bailed = false;
    try { bailed = processRootDeep(document.body, 0, SCAN_BUDGET_SWEEP); } catch (e) { }
    // v1.0.6: 超预算被迫中断说明还有存量待扫，保持当前档位继续，不计为「空闲轮次」
    if (sweepConverted > 0 || bailed) sweepIdleRounds = 0;
    else if (sweepIdleRounds < SWEEP_LEVELS.length - 1) sweepIdleRounds++;
  }

  function startSweep() {
    if (sweepTimer) return;
    var step = function () {
      sweepTimer = 0;
      var run = function () {
        sweepOnce();
        sweepDelay = SWEEP_LEVELS[sweepIdleRounds];
        startSweep();
      };
      if (typeof requestIdleCallback === "function") {
        sweepTimer = requestIdleCallback(function () { run(); }, { timeout: 2000 });
      } else {
        run();
      }
    };
    sweepTimer = setTimeout(step, sweepDelay);
  }

  function stopSweep() {
    if (sweepTimer) {
      clearTimeout(sweepTimer);
      if (typeof cancelIdleCallback === "function") { try { cancelIdleCallback(sweepTimer); } catch (e) { } }
      sweepTimer = 0;
    }
  }

  /* ══════════════════ 样式 & 提示气泡 ══════════════════ */

  var styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    styleInjected = true;
    var st = document.createElement("style");
    st.textContent =
      "a[data-lfa]{cursor:pointer;text-decoration:underline;}" +
      "a[data-lfa].lfa-dead{text-decoration:line-through !important;color:#9a9a9a !important;}";
    (document.head || document.documentElement).appendChild(st);
  }

  function toast(msg) {
    var d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText =
      "position:fixed;left:50%;bottom:44px;transform:translateX(-50%);" +
      "z-index:2147483647;background:rgba(20,20,20,.86);color:#fff;" +
      "padding:8px 14px;border-radius:6px;font-size:13px;line-height:1.5;" +
      "font-family:system-ui,sans-serif;pointer-events:none;" +
      "transition:opacity .35s ease;";
    (document.body || document.documentElement).appendChild(d);
    setTimeout(function () { d.style.opacity = "0"; }, 1300);
    setTimeout(function () { if (d.parentNode) d.remove(); }, 1800);
  }

  /* ══════════════════ 状态存储 ══════════════════ */

  function gval(k, d) { try { var v = GM_getValue(k, d); return v === undefined ? d : v; } catch (e) { return d; } }

  var enabledCache = null;   // v1.0.6: 启用状态内存缓存，写入时失效（避免每链接/每轮扫描同步读 GM）
  function isEnabled() {
    if (enabledCache === null) enabledCache = gval("lfa_enabled", true) !== false;
    return enabledCache;
  }
  function writeEnabled(v) {
    enabledCache = !!v;
    try { GM_setValue("lfa_enabled", enabledCache); } catch (e) { }
  }

  function getBlacklist() { var b = gval("lfa_blacklist", []); return Array.isArray(b) ? b : []; }
  function isBlacklisted(host) { return getBlacklist().indexOf(host) !== -1; }

  /* ══════════════════ 还原 ══════════════════ */

  function collectAnchors(root, out) {
    if (!root) return out;
    if (root.nodeType === 1) {
      if (root.tagName === "A" && root.getAttribute && root.getAttribute("data-lfa") === "1") out.push(root);
      if (root.shadowRoot) collectAnchors(root.shadowRoot, out);
    }
    for (var c = root.firstChild; c; c = c.nextSibling) collectAnchors(c, out);
    return out;
  }

  function unwrapAll() {
    internalWrite = true;
    try {
      var arr = [];
      collectAnchors(document.body, arr);
      for (var i = 0; i < arr.length; i++) {
        var a = arr[i];
        if (!a.parentNode) continue;
        var txt = lfaTextNode(a.getAttribute("data-raw") || a.textContent);
        a.parentNode.replaceChild(txt, a);
      }
    } finally {
      internalWrite = false;
    }
  }

  function unwrapRuleAnchors(ruleId) {
    internalWrite = true;
    try {
      var arr = [];
      collectAnchors(document.body, arr);
      for (var i = 0; i < arr.length; i++) {
        var a = arr[i];
        if (a.getAttribute("data-rule") !== ruleId) continue;
        if (!a.parentNode) continue;
        var txt = lfaTextNode(a.getAttribute("data-raw") || a.textContent);
        a.parentNode.replaceChild(txt, a);
      }
    } finally {
      internalWrite = false;
    }
  }

  /* ══════════════════ 失效检测 ══════════════════ */

  var deadCache = (function () {
    var c = gval(CACHE_KEY, {});
    return (c && typeof c === "object") ? c : {};
  })();
  var cacheDirty = false;
  var checkQueue = [];
  var checking = 0;
  var checkCount = 0;
  var pumpTimer = 0;

  function cacheSave() {
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      var now = Date.now(), keys = [], k;
      for (k in deadCache) {
        if (!deadCache.hasOwnProperty(k)) continue;
        if (!deadCache[k] || now - deadCache[k].ts > CACHE_TTL) delete deadCache[k];
        else keys.push(k);
      }
      while (keys.length > CACHE_SAVE_MAX) {
        keys.sort(function (a, b) { return deadCache[a].ts - deadCache[b].ts; });
        delete deadCache[keys.shift()];
      }
      GM_setValue(CACHE_KEY, deadCache);
    } catch (e) { }
  }

  function cachedVerdict(url) {
    var e = deadCache[url];
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL) return null;
    return e.dead ? true : false;
  }

  function isLocalUrl(u) {
    var h = hostOf(u);
    return /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(h);
  }

  function applyDead(anchor) {
    if (!anchor || !anchor.isConnected) return;
    try {
      anchor.classList.add("lfa-dead");
      anchor.style.textDecoration = "line-through";
      anchor.style.color = "#9a9a9a";
      anchor.title = "可能失效（Linkify 检测）";
    } catch (e) { }
  }

  function enqueueDeadCheck(a) {
    if (!CHECK_DEAD || !isEnabled()) return;
    if (checkCount >= CHECK_MAX_PER_PAGE) return;
    var url = a.href;
    if (!url || !/^https?:/i.test(url) || isLocalUrl(url)) return;
    var v = cachedVerdict(url);
    if (v === true) { applyDead(a); return; }
    if (v === false) return;
    checkCount++;
    checkQueue.push({ url: url, a: a });
    // v1.0.4: 有新任务时重置 pump 计时器并立即唤醒（即使当前处于降频长间隔）
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = 0; }
    pumpDelay = PUMP_LEVELS[0];
    schedulePump();
  }

  function judgeStatus(st) {
    if (st === 404 || st === 410) return true;
    if (st >= 200 && st < 500) return false;
    return true;
  }

  function requestOnce(item, method, onDone) {
    try {
      GM_xmlhttpRequest({
        method: method,
        url: item.url,
        timeout: CHECK_TIMEOUT,
        headers: { "Accept": "*/*" },
        anonymous: true,
        onload: function (r) {
          if (method === "HEAD" && r.status === 405) { requestOnce(item, "GET", onDone); return; }
          onDone(judgeStatus(r.status));
        },
        onerror: function () { onDone(true); },
        ontimeout: function () { onDone(true); }
      });
    } catch (e) { onDone(false); }
  }

  function pump() {
    if (!CHECK_DEAD || !isEnabled() || document.hidden) return;
    while (checking < CHECK_CONCURRENCY && checkQueue.length > 0) {
      var item = checkQueue.shift();
      if (!item.a.isConnected) continue;
      checking++;
      (function (it) {
        requestOnce(it, "HEAD", function (dead) {
          checking--;
          if (dead) applyDead(it.a);
          deadCache[it.url] = { dead: dead, ts: Date.now() };
          cacheDirty = true;
        });
      })(item);
    }
  }

  var pumpDelay = 600;   // v1.0.4: 自适应间隔，空队列时降频
  var PUMP_LEVELS = [600, 1200, 2500, 5000];

  function pumpLoop() {
    pumpTimer = 0;
    if (!CHECK_DEAD || !isEnabled() || document.hidden) { pumpDelay = 5000; schedulePump(); return; }
    pump();
    // 队列耗尽 → 逐步降频；有新任务入队 → 下次恢复密集轮询
    var hasWork = checkQueue.length > 0;
    if (hasWork) pumpDelay = PUMP_LEVELS[0];
    else {
      var idx = PUMP_LEVELS.indexOf(pumpDelay);
      if (idx >= 0 && idx < PUMP_LEVELS.length - 1) pumpDelay = PUMP_LEVELS[idx + 1];
    }
    schedulePump();
  }

  function schedulePump() {
    if (pumpTimer) return;
    pumpTimer = setTimeout(pumpLoop, pumpDelay);
  }

  function startChecker() {
    if (!CHECK_DEAD) return;
    if (pumpTimer) return;
    setTimeout(function () { if (isEnabled()) schedulePump(); }, CHECK_START_DELAY);
  }

  function stopChecker() {
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = 0; }
    checkQueue = [];
    checking = 0;
    cacheSave();
  }

  setInterval(cacheSave, 25000);
  setInterval(function () { if (rulesDirty) { rulesDirty = false; saveRules(); } }, 30000);
  window.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      cacheSave();
      if (rulesDirty) { rulesDirty = false; saveRules(); }
    } else {
      // v1.0.4: 页面恢复可见时立即唤醒失效检测与兜底扫描
      if (isEnabled()) {
        if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = 0; }
        pumpDelay = PUMP_LEVELS[0];
        schedulePump();
      }
    }
  });

  /* ══════════════════ 网盘页自动填提取码 ══════════════════ */

  function setInputValue(inp, val) {
    try {
      var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (desc && desc.set) desc.set.call(inp, val); else inp.value = val;
    } catch (e) { inp.value = val; }
    try {
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { }
  }

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findPwdInput() {
    var inputs = document.querySelectorAll("input");
    var hintRe = /提取|访问|密码|口令|密钥|pwd|pass|code/i;
    var fallback = null;
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var t = (inp.type || "text").toLowerCase();
      if (t === "hidden" || t === "checkbox" || t === "radio" || t === "submit" || t === "button") continue;
      if (!visible(inp)) continue;
      var sig = (inp.placeholder || "") + " " + (inp.name || "") + " " + (inp.id || "") + " " + (inp.className || "");
      if (hintRe.test(sig)) return inp;
      if (!fallback && (t === "" || t === "text" || t === "number")) fallback = inp;
    }
    return fallback;
  }

  function findSubmitBtn() {
    var cand = document.querySelectorAll("button, input[type=submit], input[type=button], a, div, span");
    var textRe = /(提取|访问|确定|确认|提交|解析|打开|下一步)/;
    for (var i = 0; i < cand.length; i++) {
      var el = cand[i];
      if (!visible(el)) continue;
      var cls = el.className || "";
      var looksBtn = /btn|button/i.test(typeof cls === "string" ? cls : "");
      var txt = (el.tagName === "INPUT" || el.tagName === "BUTTON")
        ? (el.value || el.textContent || "")
        : (el.textContent || "");
      txt = txt.trim();
      if (txt && txt.length <= 12 && textRe.test(txt)) {
        if (el.tagName === "INPUT" || el.tagName === "BUTTON" || el.tagName === "A" || looksBtn) return el;
      }
    }
    return null;
  }

  function autoFillPanCode(code) {
    var tries = 0;
    (function attempt() {
      tries++;
      if (tries > 25) return;
      var inp = findPwdInput();
      if (!inp) { setTimeout(attempt, 600); return; }
      if (inp.value && inp.value === code) { }
      else {
        setInputValue(inp, code);
        var btn = findSubmitBtn();
        if (btn) { try { btn.click(); } catch (e) { } }
        else {
          var form = inp.closest && inp.closest("form");
          if (form) { try { form.submit(); } catch (e) { } }
        }
        toast("已自动填写提取码：" + code);
      }
    })();
  }

  function autofillHook() {
    var mh = /^#lfa-c=([A-Za-z0-9%._-]+)$/.exec(location.hash || "");
    if (mh) {
      var code = "";
      try { code = decodeURIComponent(mh[1]); } catch (e) { code = mh[1]; }
      if (code) autoFillPanCode(code);
    }
  }

  /* ══════════════════ 备份：本地 + WebDAV ══════════════════ */

  var WEBDAV_KEY = "lfa_webdav";

  function buildExportData() {
    return {
      app: "linkify-all",
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      rules: rules.map(ruleRecord),
      blacklist: getBlacklist(),
      enabled: isEnabled(),
      opts: allOpts()
    };
  }

  function exportLocal() {
    var data = buildExportData();
    var json = JSON.stringify(data, null, 2);
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    var name = "linkify-all-backup-" + stamp + ".json";
    var a = document.createElement("a");
    a.download = name;
    try {
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      a.href = url;
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.remove(); }, 1000);
      toast("已导出：" + name + "（" + data.rules.length + " 条规则）");
    } catch (e) {
      // 兜底：data URI（TM 沙箱中 Blob/URL 可能不可用）
      try {
        a.href = "data:application/json;charset=utf-8," + encodeURIComponent(json);
        (document.body || document.documentElement).appendChild(a);
        a.click();
        if (a.parentNode) a.remove();
        toast("已导出（data URI 方式）：" + name);
      } catch (e2) {
        toast("导出失败：浏览器不允许自动下载，请从设置面板「导出 JSON」文本框复制");
        copyFallback(json);
      }
    }
  }

  // 导出主链路失败时的最终兜底：显示文本域让用户手动复制
  function copyFallback(json) {
    try {
      var ui = openPanel("导出失败 · 手动复制 JSON", false);
      var ta = document.createElement("textarea");
      ta.value = json;
      ta.style.cssText = "width:100%;height:220px;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:12px;font-family:monospace;";
      var btn = document.createElement("button");
      btn.textContent = "复制全部内容";
      btn.onclick = function () { GM_setClipboard(json); toast("已复制到剪贴板"); };
      ui.body.appendChild(ta);
      ui.body.appendChild(btn);
    } catch (e) { }
  }

  function importLocal() {
    var inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.style.display = "none";
    (document.body || document.documentElement).appendChild(inp);
    inp.addEventListener("change", function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try { applyImportData(JSON.parse(reader.result)); }
        catch (e) { toast("导入失败：文件不是有效 JSON"); }
      };
      reader.onerror = function () { toast("导入失败：文件读取错误"); };
      reader.readAsText(f);
      setTimeout(function () { if (inp.parentNode) inp.remove(); }, 5000);
    });
    inp.click();
  }

  function applyImportData(data) {
    if (!data || data.app !== "linkify-all" || !Array.isArray(data.rules)) {
      toast("导入失败：不是 Linkify All 的配置文件");
      return;
    }
    var added = 0, skipped = 0, i, j;
    for (i = 0; i < data.rules.length; i++) {
      var r = data.rules[i];
      if (!r || !r.pat || !r.urlPre) { skipped++; continue; }
      var dup = false;
      for (j = 0; j < rules.length; j++) { if (rules[j].pat === r.pat) { dup = true; break; } }
      if (dup) { skipped++; continue; }
      var rule = {
        id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        pat: r.pat, urlPre: r.urlPre, urlSuf: r.urlSuf || "",
        probe: r.probe || "", sampleRaw: r.sampleRaw || "", sampleUrl: r.sampleUrl || "",
        enabled: r.enabled !== false, hits: r.hits || 0, ts: r.ts || Date.now()
      };
      try { rule.re = ruleRegex(rule.pat, "gi"); } catch (e) { skipped++; continue; }
      rules.push(rule);
      added++;
    }
    if (Array.isArray(data.blacklist)) {
      var bl = getBlacklist();
      for (i = 0; i < data.blacklist.length; i++) {
        var h = data.blacklist[i];
        if (typeof h === "string" && bl.indexOf(h) === -1) bl.push(h);
      }
      GM_setValue("lfa_blacklist", bl);
    }
    if (data.opts && typeof data.opts === "object") {
      for (var k in OPT_DEFAULTS) {
        if (data.opts.hasOwnProperty(k)) setOpt(k, data.opts[k]);
      }
    }
    if (typeof data.enabled === "boolean") writeEnabled(data.enabled);
    saveRules();
    refreshMenu();
    reapply();
    toast("导入完成：新增 " + added + " 条规则，跳过重复/无效 " + skipped + " 条");
  }

  function getWebdavCfg() {
    var c = gval(WEBDAV_KEY, null);
    return (c && typeof c === "object") ? c : null;
  }

  // UTF-8 安全的 Basic Auth 编码（btoa 对非 Latin1 字符会抛异常，如中文密码）
  function btoaUtf8(str) {
    var bytes = new TextEncoder().encode(str), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function webdavRequest(cfg, method, body, onDone, urlOverride) {
    var url = urlOverride || (cfg.url.replace(/\/+$/, "") + "/" + (cfg.path || "linkify/backup.json").replace(/^\/+/, ""));
    var headers = { "Accept": "application/json,text/plain,*/*" };
    if (body !== null && body !== undefined) headers["Content-Type"] = "application/json;charset=utf-8";
    if (method === "PROPFIND") headers["Depth"] = "1";
    if (cfg.user) headers["Authorization"] = "Basic " + btoaUtf8(cfg.user + ":" + (cfg.pass || ""));
    GM_xmlhttpRequest({
      method: method, url: url, headers: headers,
      data: (body === null || body === undefined) ? undefined : JSON.stringify(body),
      timeout: 15000,
      onload: function (r) { onDone(url, r); },
      onerror: function () { onDone(url, { status: 0, error: "network" }); },
      ontimeout: function () { onDone(url, { status: 0, error: "timeout" }); }
    });
  }

  function webdavBase(cfg) { return cfg.url.replace(/\/+$/, ""); }
  function webdavDirUrl(cfg) { return webdavBase(cfg) + "/linkify/"; }

  // 版本化备份文件名：backup-YYYYMMDD-HHMMSS.json（每次备份独立版本，不覆盖）
  function backupFileName() {
    var d = new Date();
    var p2 = function (n) { return (n < 10 ? "0" : "") + n; };
    return "backup-" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) +
      "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + ".json";
  }

  // 自动创建缺失目录（MKCOL 父目录），幂等：已存在返回 405/409/201 都可继续
  function webdavMkcol(cfg, dirUrl, onDone) {
    var headers = { "Accept": "*/*" };
    if (cfg.user) headers["Authorization"] = "Basic " + btoaUtf8(cfg.user + ":" + (cfg.pass || ""));
    GM_xmlhttpRequest({
      method: "MKCOL", url: dirUrl, headers: headers, timeout: 15000,
      onload: function (r) { onDone(r.status); },
      onerror: function () { onDone(0); },
      ontimeout: function () { onDone(0); }
    });
  }

  function parentDirUrl(fileUrl) {
    var i = fileUrl.lastIndexOf("/");
    if (i < "https://".length) return fileUrl; // 已经是根
    // MKCOL 目录要以 / 结尾才规范
    return fileUrl.slice(0, i + 1);
  }

    // 备份：每次生成独立时间戳版本（不覆盖云端旧版本）
    // PUT 404 时先 MKCOL 建目录再重试一次；再失败则提示排查建议
    function webdavBackup(cfg) {
      var payload = buildExportData();
      var fileName = backupFileName();
      var attempts = 0;
      function tryPut(url, r) {
        if (r.status >= 200 && r.status < 300) {
          toast("已备份版本 " + fileName + "（" + rules.length + " 条规则）");
          return;
        }
        if (r.error === "timeout") { toast("备份失败：连接超时，检查服务器地址"); return; }
        if (r.status === 401 || r.status === 403) { toast("备份失败：账号或密码错误（坚果云请用应用密码，而非登录密码）"); return; }
        // 404：目标父目录不存在 → 自动 MKCOL 建目录后重试一次
        if (r.status === 404 && attempts === 0) {
          attempts = 1;
          webdavMkcol(cfg, parentDirUrl(url), function (st) {
            // MKCOL 返回 405/409=目录已存在或服务器不支持建目录，均不影响重试 PUT；
            // 仅认证错误才终止
            if (st === 401 || st === 403) {
              toast("备份失败：建目录被拒绝（认证错误），请检查应用密码");
              return;
            }
            // 重新真实发起 PUT（目录要么已存在要么刚建好）
            webdavRequest(cfg, "PUT", payload, function (url2, r2) { tryPut(url2, r2); }, url);
          });
          return;
        }
        if (r.status === 404) {
          toast("备份失败：云端仍找不到目标路径。若用坚果云：请先登录网页端在「我的文件」下创建一个文件夹（如 linkify），然后重试。");
          return;
        }
        toast("备份失败：HTTP " + r.status + "（已尝试自动建目录重试）");
      }
      var fileUrl = webdavDirUrl(cfg) + fileName;
      webdavRequest(cfg, "PUT", payload, function (url, r) { tryPut(url, r); }, fileUrl);
    }

  // 从 PROPFIND 的 207 XML 里解析出全部备份版本（新→旧排序）
  function parseBackupVersions(xml, cfg) {
    var out = [];
    var re = /<(?:[A-Za-z0-9]+:)?href>\s*([^<]+?)\s*<\/(?:[A-Za-z0-9]+:)?href>/gi;
    var m;
    while ((m = re.exec(xml)) !== null) {
      var href = m[1];
      try { href = decodeURIComponent(href); } catch (e) { }
      var name = href.slice(href.lastIndexOf("/") + 1);
      var fm = /^backup-(\d{8})-(\d{6})\.json$/i.exec(name);
      if (!fm) continue;
      out.push({
        name: name,
        url: webdavDirUrl(cfg) + name,
        label: fm[1].replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") + " " + fm[2].replace(/(\d{2})(\d{2})(\d{2})/, "$1:$2:$3")
      });
    }
    out.sort(function (a, b) { return b.name.localeCompare(a.name); }); // 新版本在前
    return out;
  }

  // 恢复：先 PROPFIND 列出云端全部版本，弹面板供用户选择恢复某一时刻
  function webdavRestore(cfg) {
    webdavRequest(cfg, "PROPFIND", null, function (url, r) {
      if (r.status === 404) { toast("云端还没有任何备份版本（先点一次备份）"); return; }
      if (r.error === "timeout") { toast("恢复失败：连接超时，检查服务器地址"); return; }
      if (r.status === 401 || r.status === 403) { toast("恢复失败：账号或密码错误（坚果云请用应用密码）"); return; }
      if (r.status !== 207) { toast("无法获取版本列表：HTTP " + r.status); return; }
      var versions = parseBackupVersions(r.responseText || "", cfg);
      if (!versions.length) { toast("云端还没有备份文件"); return; }
      openRestorePanel(cfg, versions);
    }, webdavDirUrl(cfg));
  }

  function openRestorePanel(cfg, versions) {
    var ui = openPanel("☁️ 选择要恢复的备份版本");
    pv_tip(ui.body, "共 " + versions.length + " 个版本（新→旧）。点「恢复」即导入该时刻的全部配置，当前规则不会被删除（同名规则自动去重）。");
    // 版本列表独立内部滚动（与学习规则区同款），版本再多面板高度也不变
    var list = document.createElement("div");
    list.className = "lfa-rule-scroll";
    ui.body.appendChild(list);
    versions.forEach(function (v) {
      var row = document.createElement("div");
      row.className = "lfa-rule";
      var info = document.createElement("div");
      info.className = "lfa-rule-info";
      info.textContent = v.label;
      var bR = pv_btn(row, "恢复", "secondary", function () {
        webdavRequest(cfg, "GET", null, function (u, r) {
          if (r.status === 200) {
            try {
              applyImportData(JSON.parse(r.responseText));
              ui.close();
              toast("已恢复版本 " + v.label);
            } catch (e) { toast("恢复失败：该版本文件不是有效 JSON"); }
          } else if (r.status === 401 || r.status === 403) toast("恢复失败：账号或密码错误");
          else toast("恢复失败：HTTP " + r.status);
        }, v.url);
      });
      bR.className += " lfa-btn-sm";
      row.appendChild(info);
      row.appendChild(bR);
      list.appendChild(row);
    });
  }

  /* ══════════════════ 通用面板（普通 DOM + 前缀类样式表） ══════════════════ */

  // 全部类名带 lfa- 前缀，避免污染页面；样式集中一处便于统一调整
  var PANEL_STYLE =
    ".lfa-panel{position:fixed;top:6%;left:50%;transform:translateX(-50%);" +
    "width:min(420px,92vw);max-height:82vh;overflow:auto;background:#fff;color:#1f2328;" +
    "border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.08);" +
    "z-index:2147483646;font-size:12.5px;line-height:1.55;box-sizing:border-box;" +
    "font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;}" +
    ".lfa-head{display:flex;align-items:center;gap:8px;padding:11px 14px;cursor:move;" +
    "user-select:none;border-bottom:1px solid #eaecef;position:sticky;top:0;background:#fff;" +
    "border-radius:14px 14px 0 0;z-index:2;}" +
    ".lfa-head-title{font-weight:700;font-size:13.5px;letter-spacing:.2px;flex:1;}" +
    ".lfa-head-ver{font-size:10.5px;color:#8b949e;background:#f0f2f5;border-radius:8px;padding:1px 7px;font-weight:500;}" +
    ".lfa-close{cursor:pointer;padding:2px 8px;color:#8b949e;font-size:14px;border-radius:7px;flex:none;}" +
    ".lfa-close:hover{background:#f0f2f5;color:#1f2328;}" +
    ".lfa-body{padding:4px 14px 14px;}" +
    ".lfa-sec{margin:14px 0 8px;display:flex;align-items:center;gap:7px;font-size:11.5px;" +
    "color:#57606a;font-weight:700;letter-spacing:.4px;}" +
    ".lfa-sec::before{content:'';width:3px;height:12px;border-radius:2px;background:#2563eb;}" +
    ".lfa-sec-count{font-weight:500;color:#8b949e;background:#f0f2f5;border-radius:9px;padding:0 7px;font-size:10.5px;}" +
    ".lfa-opt{display:flex;align-items:flex-start;gap:8px;padding:8px 9px;border:1px solid #eaecef;" +
    "border-radius:9px;margin:0;background:#fff;transition:border-color .15s,background .15s;box-sizing:border-box;}" +
    ".lfa-opt-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:0 0 2px;}" +
    ".lfa-opt:hover{border-color:#d0d7de;background:#fafbfc;}" +
    ".lfa-opt input[type=checkbox]{width:14px;height:14px;margin-top:2px;accent-color:#2563eb;cursor:pointer;flex:none;}" +
    ".lfa-opt label{cursor:pointer;flex:1;font-size:12px;color:#1f2328;}" +
    ".lfa-btn{display:inline-flex;align-items:center;gap:5px;margin:0 6px 6px 0;padding:6px 11px;" +
    "border-radius:7px;cursor:pointer;font-size:12px;font-weight:600;line-height:1.4;transition:all .15s;}" +
    ".lfa-btn-primary{background:#2563eb;color:#fff;border:1px solid #2563eb;}" +
    ".lfa-btn-primary:hover{background:#1d4ed8;border-color:#1d4ed8;}" +
    ".lfa-btn-secondary{background:#fff;color:#24292f;border:1px solid #d0d7de;}" +
    ".lfa-btn-secondary:hover{background:#f6f8fa;border-color:#afb8c1;}" +
    ".lfa-btn-danger{background:#fff;color:#cf222e;border:1px solid #d0d7de;}" +
    ".lfa-btn-danger:hover{background:#ffebe9;border-color:#cf222e;}" +
    ".lfa-btn-sm{margin:0;padding:3px 8px;font-size:11px;font-weight:500;white-space:nowrap;}" +
    ".lfa-field{margin:0 0 8px;}" +
    ".lfa-field label{display:block;font-size:11px;color:#57606a;font-weight:600;margin:0 0 4px;}" +
    ".lfa-input{box-sizing:border-box;width:100%;padding:7px 10px;border:1px solid #d0d7de;" +
    "border-radius:7px;font-size:12.5px;color:#1f2328;background:#fff;transition:border-color .15s,box-shadow .15s;}" +
    ".lfa-input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.15);}" +
    ".lfa-input::placeholder{color:#8b949e;}" +
    ".lfa-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 10px;}" +
    ".lfa-dav-acts{display:flex;flex-direction:row;gap:6px;height:33px;}" +
    ".lfa-dav-acts .lfa-btn{margin:0;flex:1;justify-content:center;height:100%;padding:0 11px;}" +
    ".lfa-pwd{position:relative;}" +
    ".lfa-pwd .lfa-input{padding-right:36px;}" +
    ".lfa-eye{position:absolute;right:3px;top:50%;transform:translateY(-50%);border:none;background:none;" +
    "cursor:pointer;font-size:12px;padding:4px 6px;border-radius:6px;opacity:.55;line-height:1;}" +
    ".lfa-eye:hover{opacity:1;background:#f0f2f5;}" +
    ".lfa-rule-scroll{max-height:236px;overflow-y:auto;overflow-x:hidden;padding:0 2px 4px;}" +
    ".lfa-rule-add{position:sticky;top:0;z-index:1;background:#fff;border:1px dashed #b6c2cf;" +
    "border-radius:9px;padding:7px 10px;margin:0 0 6px;text-align:center;font-size:12px;" +
    "font-weight:600;color:#57606a;cursor:pointer;transition:all .15s;}" +
    ".lfa-rule-add:hover{border-color:#2563eb;color:#2563eb;background:#f6faff;}" +
    ".lfa-rule-scroll::-webkit-scrollbar{width:6px;}" +
    ".lfa-rule-scroll::-webkit-scrollbar-thumb{background:#d0d7de;border-radius:3px;}" +
    ".lfa-rule-scroll::-webkit-scrollbar-thumb:hover{background:#afb8c1;}" +
    ".lfa-rule{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid #eaecef;" +
    "border-radius:10px;margin:0 0 8px;background:#fff;}" +
    ".lfa-rule-info{flex:1;min-width:0;font-size:12px;color:#24292f;word-break:break-all;line-height:1.5;}" +
    ".lfa-rule-info code{font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:11.5px;}" +
    ".lfa-rule-info .muted{color:#8b949e;font-size:11px;}" +
    ".lfa-preview{margin:10px 0 0;font-size:12px;background:#f6f8fa;border:1px solid #eaecef;" +
    "border-radius:10px;padding:9px 12px;color:#57606a;line-height:1.7;word-break:break-all;}" +
    ".lfa-preview .ok{color:#1a7f37;}" +
    ".lfa-preview .err{color:#cf222e;}" +
    ".lfa-empty{font-size:12px;color:#8b949e;padding:12px 2px;}" +
    ".lfa-bar{display:flex;align-items:center;justify-content:space-between;margin:14px 0 8px;}" +
    ".lfa-tip{font-size:11.5px;color:#8b949e;line-height:1.6;margin:2px 0 10px;}" +
    "@media (max-width:540px){.lfa-opt-grid{grid-template-columns:1fr;}.lfa-grid2{grid-template-columns:1fr;}}";
  var panelStyleInjected = false;

  function injectPanelStyle() {
    if (panelStyleInjected) return;
    panelStyleInjected = true;
    var st = document.createElement("style");
    st.textContent = PANEL_STYLE;
    (document.head || document.documentElement).appendChild(st);
  }

  // 返回 { wrap, body, close }；Esc 关闭；标题栏可拖动
  // fixed=true 时面板高度恒定（不随内容增长），body 内部滚动 —— 结构性保证
  // 「累加规则最外围窗体不被挤占」
  function openPanel(title, drag, fixed) {
    injectPanelStyle();
    var wrap = document.createElement("div");
    wrap.className = "lfa-panel";
    if (fixed) {
      wrap.style.height = "min(600px, 88vh)";
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
    }
    var head = document.createElement("div");
    head.className = "lfa-head";
    head.style.cursor = (drag === false ? "default" : "move");
    head.style.flex = "none";
    var h = document.createElement("span");
    h.className = "lfa-head-title";
    h.textContent = title;
    var ver = document.createElement("span");
    ver.className = "lfa-head-ver";
    ver.textContent = "v1.0.6";
    var closeBtn = document.createElement("span");
    closeBtn.className = "lfa-close";
    closeBtn.textContent = "✕";
    closeBtn.title = "关闭（Esc）";
    head.appendChild(h);
    head.appendChild(ver);
    head.appendChild(closeBtn);
    var body = document.createElement("div");
    body.className = "lfa-body";
    if (fixed) {
      body.style.flex = "1";
      body.style.minHeight = "0";
      body.style.overflowY = "auto";
    }
    wrap.appendChild(head);
    wrap.appendChild(body);
    (document.body || document.documentElement).appendChild(wrap);

    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    }
    var dragMove = null, dragUp = null;
    function close() {
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      // v1.0.6: 面板关闭时移除全局拖拽监听（此前每次打开面板都会遗留两个全局监听）
      if (dragMove) document.removeEventListener("mousemove", dragMove);
      if (dragUp) document.removeEventListener("mouseup", dragUp);
    }
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);

    if (drag !== false) {
      var dragging = false, sx = 0, sy = 0, bx = 0, by = 0;
      head.addEventListener("mousedown", function (e) {
        if (e.target === closeBtn) return;
        dragging = true;
        var r = wrap.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; bx = r.left; by = r.top;
        e.preventDefault();
      });
      dragMove = function (e) {
        if (!dragging) return;
        wrap.style.left = (bx + e.clientX - sx) + "px";
        wrap.style.top = (by + e.clientY - sy) + "px";
        wrap.style.transform = "none";
      };
      dragUp = function () { dragging = false; };
      document.addEventListener("mousemove", dragMove);
      document.addEventListener("mouseup", dragUp);
    }
    return { wrap: wrap, body: body, close: close };
  }

  // ── 构建辅助函数（全部基于 .lfa-* 类） ──

  function pv_section(body, text, count) {
    var s = document.createElement("div");
    s.className = "lfa-sec";
    var t = document.createElement("span");
    t.textContent = text;
    s.appendChild(t);
    if (count !== undefined && count !== null) {
      var c = document.createElement("span");
      c.className = "lfa-sec-count";
      c.textContent = count;
      s.appendChild(c);
    }
    body.appendChild(s);
    return s;
  }

  function pv_btn(parent, text, kind, cb) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.className = "lfa-btn " + (kind === "primary" ? "lfa-btn-primary" : (kind === "danger" ? "lfa-btn-danger" : "lfa-btn-secondary"));
    if (cb) b.addEventListener("click", cb);
    parent.appendChild(b);
    return b;
  }

  function pv_field(parent, labelText, placeholder, value, type) {
    var f = document.createElement("div");
    f.className = "lfa-field";
    var l = document.createElement("label");
    l.textContent = labelText;
    var i = document.createElement("input");
    i.className = "lfa-input";
    i.type = type || "text";
    i.placeholder = placeholder || "";
    i.value = value || "";
    f.appendChild(l);
    f.appendChild(i);
    parent.appendChild(f);
    return i;
  }

  // 密码字段：带小眼睛（明文/密文切换）
  function pv_pwfield(parent, labelText, value) {
    var f = document.createElement("div");
    f.className = "lfa-field";
    var l = document.createElement("label");
    l.textContent = labelText;
    var wrap = document.createElement("div");
    wrap.className = "lfa-pwd";
    var i = document.createElement("input");
    i.className = "lfa-input";
    i.type = "password";
    i.value = value || "";
    var eye = document.createElement("button");
    eye.type = "button";
    eye.className = "lfa-eye";
    eye.textContent = "👁";
    eye.title = "显示 / 隐藏密码";
    eye.addEventListener("click", function () {
      var show = i.type === "password";
      i.type = show ? "text" : "password";
      eye.textContent = show ? "🙈" : "👁";
      i.focus();
    });
    wrap.appendChild(i);
    wrap.appendChild(eye);
    f.appendChild(l);
    f.appendChild(wrap);
    parent.appendChild(f);
    return i;
  }

  function pv_tip(parent, text) {
    var t = document.createElement("div");
    t.className = "lfa-tip";
    t.textContent = text;
    parent.appendChild(t);
    return t;
  }

  /* ══════════════════ 设置面板（统一） ══════════════════ */

  // learnDialog 保存规则后回调它，让已打开的面板即时刷新规则列表
  var refreshSettingsRules = null;

  function settingsDialog() {    var ui = openPanel("⚙️ Linkify All 设置", true, true);

    /* ── 场景开关 ── */
    pv_section(ui.body, "场景开关（对应区域是否转换链接）");
    var optDefs = [
      ["precode", "代码块（pre / code）", "代码里出现的网址也可点击，默认开启"],
      ["editable", "富文本编辑器 / 输入框", "可能干扰输入，谨慎开启"],
      ["control", "按钮 / 下拉框等控件", "控件文本里的网址，默认关闭"],
      ["linkinside", "已有链接内部", "防嵌套错误，建议保持关闭"]
    ];
    var optGrid = document.createElement("div");
    optGrid.className = "lfa-opt-grid";
    ui.body.appendChild(optGrid);
    for (var oi = 0; oi < optDefs.length; oi++) {
      (function (key, name, sub) {
        var row = document.createElement("div");
        row.className = "lfa-opt";
        row.title = sub;                 // 仅名称可见，悬浮显示说明
        var ck = document.createElement("input");
        ck.type = "checkbox";
        ck.checked = optOn(key);
        var lb = document.createElement("label");
        lb.textContent = name;
        ck.addEventListener("change", function () {
          setOpt(key, ck.checked);
          reapply();
          toast((ck.checked ? "已开启：" : "已关闭：") + name);
        });
        row.appendChild(ck);
        row.appendChild(lb);
        optGrid.appendChild(row);
      })(optDefs[oi][0], optDefs[oi][1], optDefs[oi][2]);
    }

    /* ── 学习规则 ── */
    var secTitle = pv_section(ui.body, "学习规则", String(rules.length) + " 条");
    // 规则列表固定在内部滚动区：规则再多也只在这一块内滚动，不撑大外层面板
    // 「＋ 学习新规则」入口收进滚动区顶部（sticky 恒可见），不再外置独立按钮
    var list = document.createElement("div");
    list.className = "lfa-rule-scroll";
    ui.body.appendChild(list);
    var addEntry = document.createElement("div");
    addEntry.className = "lfa-rule-add";
    addEntry.title = "教学一对「原文本→链接」示例，自动推导规则";
    addEntry.textContent = "＋ 学习新规则";
    addEntry.addEventListener("click", function () { learnDialog(); });
    list.appendChild(addEntry);
    // 更新分区角标计数（pv_section 结构：第0个=标题文字span，第1个=计数span）
    function updateCount() {
      var cc = secTitle.childNodes[1];
      if (cc) cc.textContent = String(rules.length) + " 条";
    }
    function renderRules() {
      // DocumentFragment 批量渲染：几十条规则也一次性挂载，无逐行重排
      var frag = document.createDocumentFragment();
      updateCount();
      if (!rules.length) {
        var em = document.createElement("div");
        em.className = "lfa-empty";
        em.textContent = "还没有学习规则。点上方「＋ 学习新规则」输入一对示例即可教会它。";
        frag.appendChild(em);
      } else {
      for (var i = 0; i < rules.length; i++) {
        (function (r) {
          var row = document.createElement("div");
          row.className = "lfa-rule";
          var info = document.createElement("div");
          info.className = "lfa-rule-info";
          var code1 = document.createElement("code");
          code1.textContent = r.sampleRaw || r.pat;
          var arrow = document.createTextNode(" → ");
          var code2 = document.createElement("code");
          code2.textContent = r.sampleUrl || "";
          var muted = document.createElement("div");
          muted.className = "muted";
          muted.textContent = r.enabled ? "" : "已停用 · ";
          info.appendChild(code1);
          info.appendChild(arrow);
          info.appendChild(code2);
          info.appendChild(muted);
          var bT = pv_btn(row, r.enabled ? "停用" : "启用", r.enabled ? "secondary" : "primary", function () {
            r.enabled = !r.enabled;
            saveRules();
            reapply();
            toast("规则已" + (r.enabled ? "启用，本页即刻生效" : "停用，相关链接已还原"));
          });
          bT.className += " lfa-btn-sm";
          var bD = pv_btn(row, "删除", "danger", function () {
            for (var j = 0; j < rules.length; j++) { if (rules[j].id === r.id) { rules.splice(j, 1); break; } }
            saveRules();
            unwrapRuleAnchors(r.id);
            reapply();
            toast("规则已删除");
          });
          bD.className += " lfa-btn-sm";
          row.appendChild(info);
          row.appendChild(bT);
          row.appendChild(bD);
          frag.appendChild(row);
        })(rules[i]);
      }
      }
      while (list.firstChild) list.removeChild(list.firstChild);
      list.appendChild(addEntry);   // 入口行重挂到列表顶部
      list.appendChild(frag);
    }
    renderRules();
    refreshSettingsRules = renderRules;
    var origClose0 = ui.close;
    ui.close = function () {
      if (refreshSettingsRules === renderRules) refreshSettingsRules = null;
      origClose0();
    };
    pv_section(ui.body, "WebDAV 云备份（凭据仅存本机）");
    var cfg = getWebdavCfg() || { url: "", user: "", pass: "" };
    var grid = document.createElement("div");
    grid.className = "lfa-grid2";
    ui.body.appendChild(grid);
    var urlIn = pv_field(grid, "服务器地址", "https://dav.jianguoyun.com/dav/", cfg.url);
    var userIn = pv_field(grid, "账号", "账号", cfg.user);
    var passIn = pv_pwfield(grid, "密码", cfg.pass);
    // 备份 / 恢复：横排一组（备份在左、恢复在右），位于账号下方、密码右侧。
    // 用与密码框完全同构的 field 结构（占位 label 撑起同高）→ 两列天然对齐
    var actField = document.createElement("div");
    actField.className = "lfa-field";
    var actLabel = document.createElement("label");
    actLabel.textContent = "\u00A0";   // 占位：与「密码」标签同高
    var actCell = document.createElement("div");
    actCell.className = "lfa-dav-acts";
    actField.appendChild(actLabel);
    actField.appendChild(actCell);
    pv_btn(actCell, "备份", "primary", function () {
      var c = readCfg();
      if (c) webdavBackup(c);
    });
    pv_btn(actCell, "恢复", "secondary", function () {
      var c = readCfg();
      if (c) webdavRestore(c);
    });
    grid.appendChild(actField);

    // 读取当前表单（自动补默认），保存并返回；URL 不合法返回 null
    function readCfg() {
      var url = urlIn.value.trim();
      if (!/^https?:\/\//i.test(url)) { toast("服务器地址需以 http:// 或 https:// 开头"); return null; }
      var c = {
        url: url,
        user: userIn.value.trim(),
        pass: passIn.value,
        path: "/linkify/backup.json"   // 固定：坚果云根目录不允许 PUT，必须放子目录（已实测验证）
      };
      GM_setValue(WEBDAV_KEY, c);
      return c;
    }

    /* ── 本地备份 ── */
    pv_section(ui.body, "本地备份 / 迁移");
    var bar2 = document.createElement("div");
    bar2.className = "lfa-bar";
    ui.body.appendChild(bar2);
    pv_btn(bar2, "📦 导出到本地文件", "primary", function () { exportLocal(); });
    pv_btn(bar2, "📥 从本地文件导入", "secondary", function () { importLocal(); });
    var pasteTa = document.createElement("textarea");
    pasteTa.className = "lfa-input";
    pasteTa.placeholder = "或把备份 JSON 粘贴到这里，点右侧导入…";
    pasteTa.style.cssText = "height:44px;font-family:'SFMono-Regular',Consolas,monospace;font-size:11px;resize:none;";
    var pasteRow = document.createElement("div");
    pasteRow.style.cssText = "display:flex;gap:8px;align-items:stretch;";
    var pasteWrap = document.createElement("div");
    pasteWrap.style.cssText = "flex:1;";
    pasteWrap.appendChild(pasteTa);
    var pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.className = "lfa-btn lfa-btn-secondary";
    pasteBtn.textContent = "从粘贴导入";
    pasteBtn.addEventListener("click", function () {
      try { applyImportData(JSON.parse(pasteTa.value)); }
      catch (e) { toast("导入失败：不是有效 JSON"); }
    });
    pasteRow.appendChild(pasteWrap);
    pasteRow.appendChild(pasteBtn);
    ui.body.appendChild(pasteRow);

    return ui;
  }

  /* ══════════════════ 学习新规则对话框（普通 DOM） ══════════════════ */

  function learnDialog() {
    var ui = openPanel("🎓 学习新链接规则");
    pv_tip(ui.body, "窗口不挡页面：先选中页面文字再点「抓取选中文字」；原文本回车跳链接框，链接框回车提交；Esc 关闭。");

    var rawIn = pv_field(ui.body, "原文本（页面上的明文，如 app:abc-123）", "app:abc-123", "");
    var grab1 = document.createElement("div");
    grab1.style.cssText = "margin:-4px 0 4px;";
    ui.body.appendChild(grab1);
    pv_btn(grab1, "📌 抓取选中文字", "secondary", function () { grab(rawIn); });

    var urlIn = pv_field(ui.body, "跳转链接（如 https://example.com/item/abc-123）", "https://example.com/item/abc-123", "");
    var grab2 = document.createElement("div");
    grab2.style.cssText = "margin:-4px 0 4px;";
    ui.body.appendChild(grab2);
    pv_btn(grab2, "📌 抓取选中文字", "secondary", function () { grab(urlIn); });

    var pv = document.createElement("div");
    pv.className = "lfa-preview";
    pv.textContent = "填写后自动分析对应关系；两段内容需含相同的可变部分。";
    ui.body.appendChild(pv);

    var btns = document.createElement("div");
    btns.style.cssText = "margin-top:14px;text-align:right;";
    pv_btn(btns, "取消", "secondary", ui.close);
    pv_btn(btns, "保存规则", "primary", doSave);
    ui.body.appendChild(btns);

    // 页面选区快照：避免点击瞬间选区被清除
    var lastSel = "";
    function onSelChange() {
      try { var s = window.getSelection().toString(); if (s) lastSel = s; } catch (e) { }
    }
    onSelChange();
    document.addEventListener("selectionchange", onSelChange);
    var origClose = ui.close;
    ui.close = function () {
      document.removeEventListener("selectionchange", onSelChange);
      origClose();
    };

    function setPreview(inf) {
      pv.textContent = inf.ok ? ("规则：" + inf.human + "　——同类文本将自动转换") : ("⚠ " + inf.err);
      pv.className = "lfa-preview " + (inf.ok ? "ok" : "err");
    }
    function preview() {
      if (!rawIn.value && !urlIn.value) {
        pv.textContent = "填写后自动分析对应关系；两段内容需含相同的可变部分。";
        pv.className = "lfa-preview";
        return;
      }
      setPreview(inferRule(rawIn.value, urlIn.value));
    }
    function grab(target) {
      if (lastSel) { target.value = lastSel.slice(0, 200); preview(); }
      else toast("请先在页面上选中要填入的文字");
    }
    function doSave() {
      var res = addRuleByPair(rawIn.value, urlIn.value);
      if (!res.ok) { setPreview(res); return; }
      ui.close();
      toast(res.dup ? "该规则已存在，已重新启用" : "已学会新规则，本页即刻生效");
      // 若设置面板仍开着，即时刷新规则列表（否则要退出重进才看到新规则）
      try { if (refreshSettingsRules) refreshSettingsRules(); } catch (e) { }
      try { processRootDeep(document.body); } catch (e) { }
    }
    rawIn.addEventListener("input", preview);
    urlIn.addEventListener("input", preview);
    rawIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); urlIn.focus(); }
    });
    urlIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doSave(); }
    });
    rawIn.focus();
  }

  /* ══════════════════ 菜单命令（精简为 4 项） ══════════════════ */

  var menuIds = [];
  var dynamicMenu = typeof GM_unregisterMenuCommand === "function";

  function clearMenu() {
    if (!dynamicMenu) return;
    for (var i = 0; i < menuIds.length; i++) {
      try { GM_unregisterMenuCommand(menuIds[i]); } catch (e) { }
    }
    menuIds = [];
  }

  function addMenu(label, fn) {
    try {
      var id = GM_registerMenuCommand(label, fn);
      if (dynamicMenu) menuIds.push(id);
    } catch (e) { }
  }

  function refreshMenu() {
    clearMenu();
    addMenu(
      isEnabled() ? "✅ 总开关：已启用（点击关闭）" : "⛔ 总开关：已停用（点击开启）",
      function () {
        var next = !isEnabled();
        writeEnabled(next);
        refreshMenu();
        if (next) { activate(); toast("Linkify 已启用，本页即刻生效"); }
        else { deactivate(); unwrapAll(); toast("Linkify 已停用，本页已还原"); }
      }
    );
    var host = location.hostname;
    var blocked = isBlacklisted(host);
    addMenu(
      blocked ? "🚫 黑名单：" + host + "（点击移出）" : "🚫 把当前站点加入黑名单",
      function () {
        var b = getBlacklist();
        var i = b.indexOf(host);
        if (i === -1) {
          b.push(host);
          GM_setValue("lfa_blacklist", b);
          refreshMenu();
          deactivate();
          unwrapAll();
          toast("已加入黑名单并还原本页：" + host);
        } else {
          b.splice(i, 1);
          GM_setValue("lfa_blacklist", b);
          refreshMenu();
          if (isEnabled()) activate();
          toast("已移出黑名单，本页即刻生效：" + host);
        }
      }
    );
    addMenu("🎓 学习新规则…", learnDialog);
    addMenu("⚙️ 设置…", settingsDialog);
  }

  /* ══════════════════ 手动兜底：强制转换选区 ══════════════════ */

  function convertSelection() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      toast("请先用鼠标选中要转换的文本");
      return;
    }
    var range = sel.getRangeAt(0);
    var ca = range.commonAncestorContainer;
    var hostEl = ca.nodeType === 1 ? ca : ca.parentNode;
    for (var n = hostEl; n; n = n.parentNode) {
      if (n === document.body || n.nodeType === 11) break;
      if (n.nodeType !== 1) continue;
      var tag = n.tagName;
      if (tag === "A" || tag === "BUTTON") { toast("选中内容已在链接/按钮内，跳过"); return; }
      if (n.isContentEditable) { toast("选中内容在编辑器内，跳过"); return; }
      var ns = n.namespaceURI;
      if (ns && ns !== HTML_NS) { toast("该区域不支持转换"); return; }
    }
    var raw = trimLoose(sel.toString());
    if (!raw) { toast("选中的内容为空"); return; }
    if (!/^https?:\/\//i.test(raw) && raw.indexOf(".") === -1) {
      toast("选中的内容看起来不像网址");
      return;
    }
    var href = toHref(raw);
    if (!href) { toast("无法解析为有效网址"); return; }
    var frag = range.extractContents();
    var a = document.createElement("a");
    var hit = { raw: raw, href: href, start: 0, end: 0 };
    var ctxText = "";
    try { ctxText = hostEl.textContent || ""; } catch (e) { }
    var codeFound = null;
    if (ctxText) codeFound = findCodeNear(ctxText, [{ start: 0, end: 0 }], 0);
    if (codeFound && isPanUrl(href)) hit.code = codeFound;
    var built = buildAnchor(hit);
    built.appendChild(frag);
    range.insertNode(built);
    toast(codeFound ? "已转换为链接（含提取码：" + codeFound + "）" : "已转换为链接：" + built.href);
  }

  /* ══════════════════ Alt+点击 复制原文 / Ctrl+点击 直链跳转 ══════════════════ */

  // Ctrl+点击直链跳转：从点击位置的文本中提取 URL 并直接跳转
  // 与 Alt+点击（复制原文）互不冲突；专门用于那些被防误判逻辑
  // 跳过的明文文本（如二段裸域名 example.com、文件名 app.zip 等）
  function extractDirectUrl(text) {
    if (!text || text.length < 6) return null;
    // 第一步：复用主识别正则提取 URL
    // 注意：这里不做文件名否决，直链跳转更宽松
    MAIN_RE.lastIndex = 0;
    var m;
    while ((m = MAIN_RE.exec(text)) !== null) {
      if (m.index === MAIN_RE.lastIndex) MAIN_RE.lastIndex++;
      var raw = trimLoose(m[0]);
      if (!raw || raw.length < 6) continue;
      var href = toHref(raw);
      if (href) return { raw: raw, href: href };
    }
    // 第二步：兜底处理主正则未覆盖的情况
    //  - 二段裸域名（example.com）——脚本默认不自动转换
    //  - 带文件扩展名的地址（app.zip）——被文件名否决跳过
    // 这些场景恰好是直链跳转要补的
    var cand = [];
    // 从文本中找可能是裸域名/文件的片段
    var tokenRe = /(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,24}(?:\/[\w\-.\/%?#@!$&'()*+,;=~]*)?/g;
    tokenRe.lastIndex = 0;
    var tm;
    while ((tm = tokenRe.exec(text)) !== null) {
      var tok = trimLoose(tm[0]);
      if (tok && tok.length >= 6) cand.push(tok);
    }
    // 优先尝试完整片段，再逐个尝试
    var full = trimLoose(text);
    if (full.length >= 6 && full.length <= 300) cand.unshift(full);
    for (var i = 0; i < cand.length; i++) {
      var h = toHref(cand[i]);
      if (h) return { raw: cand[i], href: h };
    }
    return null;
  }

  // 从点击事件定位具体文本位置，提取该位置附近的 URL
  function textAtPoint(e) {
    // caretPositionFromPoint（Firefox）
    try {
      var pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos && pos.offsetNode) return pos.offsetNode;
    } catch (err) { }
    // caretRangeFromPoint（Chrome / Edge / Safari）
    try {
      if (document.caretRangeFromPoint) {
        var rng = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (rng && rng.startContainer) return rng.startContainer;
      }
    } catch (err) { }
    // 兜底：直接返回点击目标
    return e.target;
  }

  function directJump(e) {
    var node = textAtPoint(e);
    if (!node) return;
    // 跳过链接元素内部（已有 href 的 <a>），避免干扰正常链接行为
    // 文本节点需要向上找最近的元素节点再做 closest 判断
    var el = node.nodeType === 1 ? node : (node.parentElement || null);
    if (el && el.closest && el.closest("a[href]")) return;
    // 文本节点或元素节点：从其文本中提取 URL
    var txt = (node.nodeType === 3 ? (node.nodeValue || '') : (node.textContent || '')).trim();
    if (txt.length > 300) txt = txt.slice(0, 300);
    if (!txt) return;
    var hit = extractDirectUrl(txt);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(hit.href, '_blank', 'noopener,noreferrer');
    toast('直链跳转：' + hit.href);
  }

  var eventsBound = false;
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    document.addEventListener("click", function (e) {
      if (e.altKey) {
        var t = e.target;
        if (!(t && t.closest)) return;
        var a = t.closest("a[data-lfa]");
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        var raw = a.getAttribute("data-raw") || a.textContent;
        var code = a.getAttribute("data-code");
        GM_setClipboard(code ? raw + " 提取码:" + code : raw);
        toast(code ? "已复制原文及提取码：" + raw + "（" + code + "）" : "已复制原始文本：" + raw);
        return;
      }
      // Ctrl+点击 直链跳转
      if (e.ctrlKey && !e.metaKey) {
        directJump(e);
      }
    }, true);
  }

  /* ══════════════════ 启停控制 ══════════════════ */

  function activate() {
    injectStyle();
    bindEvents();
    // v1.0.6: 初始全页扫描带预算，剩余节点入队分批转换——巨型页面首扫也不占长任务
    if (document.body) processRootDeep(document.body, 0, SCAN_BUDGET_INIT);
    startObserve();
    startSweep();
    startChecker();
  }

  function deactivate() {
    stopObserve();
    stopSweep();
    stopChecker();
  }

  function boot() {
    patchAttachShadow();
    loadRules();
    refreshMenu();
    if (isEnabled() && !isBlacklisted(location.hostname)) activate();
    autofillHook();
  }

  /* ══════════════════ 测试/调试钩子（默认关闭） ══════════════════
   * 安全说明：该对象可操作规则库与配置，仅用于自动化回归测试。
   * 仅当页面 URL hash 含 #lfa-dev 时才注入，普通浏览下不暴露给页面脚本。
   */
  try {
    if (/[#&]lfa-dev\b/.test(location.hash || "")) {
      (typeof unsafeWindow !== "undefined" ? unsafeWindow : window).__LFA__ = {
        addRule: addRuleByPair,
        listRules: function () {
          return rules.map(function (r) {
            return { id: r.id, pat: r.pat, enabled: r.enabled, hits: r.hits, sampleRaw: r.sampleRaw, sampleUrl: r.sampleUrl };
          });
        },
        exportData: buildExportData,
        applyImport: applyImportData,
        getOpt: optOn,
        setOpt: setOpt,
        reapply: reapply,
        openSettings: settingsDialog,
        openLearn: learnDialog,
        sweepState: function () { return { delay: sweepDelay, idle: sweepIdleRounds, mut: mutCount }; }
      };
    }
  } catch (e) { }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
