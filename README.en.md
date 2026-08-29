# Linkify All

[简体中文](README.md) | [繁體中文](README.zh-TW.md) | English

Turns plain-text URLs on any web page into clickable links automatically. A zero-dependency, fully local, instantly effective Tampermonkey userscript.

> **Example**: plain-text URLs such as `https://example.com`, `www.example.com/path`, or the subdomain `news.example.com` are completed into clickable links automatically (opened in a new tab); a bare two-label domain like `example.com` (no `www`, no path) is **not** converted by default — a deliberate anti-false-positive design. See "Conversion rules at a glance" below.

---

## Features

- **Site-wide auto-conversion**: pages are scanned automatically and plain-text URLs become clickable links
  - Full URLs with a scheme (`https://…`)
  - Addresses with `www` but no scheme (`www.example.com` → `https://www.example.com`)
  - Addresses with a path but no scheme (`example.com/page/1` → `https://example.com/page/1`)
  - **Subdomains** (`news.example.com`, `sub2.example.org` — hostnames with 3+ labels convert even without `www` or a path)
- **Robust anti-false-positive design**:
  - Bare two-label domains (e.g. `example.com`) are not converted by default
  - Strings ending in common file extensions (`.zip/.dmg/.exe/.pdf/.torrent…`, e.g. release asset names like `example-app-1.0.17-win64.zip`) are recognized as **file names**, not links
  - Input fields / rich-text editors / code blocks / inside existing links are governed by four scene toggles (code blocks on by default, the others off)
- **Dynamic-content aware**: multi-root MutationObserver (including every Shadow DOM root) + a compatible wrapper around `attachShadow` + a full-page fallback sweep every 2.5 s (auto-paused in background tabs), so content inserted by SPAs is covered too; sweeps are change-gated and adaptively throttled (idle pages ramp 2.5s→30s) and run in browser idle time — steady-state overhead approaches zero
- **Low-overhead design (v1.0.6)**: per-batch ancestor deduplication in the observer, script-generated nodes never re-enter the observer queue, passcode search runs only for cloud-drive links, a fast prefilter gate for plain-text nodes, in-memory snapshots of toggles (zero GM-storage IPC during scans), and time-budgeted sweeps (≤20 ms initial / ≤6 ms fallback rounds, remaining nodes queued in batches) — link-dense and very large pages never stall the main thread
- **Resistant to anti-linkify tricks**: invisible zero-width characters (U+200B etc.) that some content platforms insert into URL text are stripped automatically; when a platform splits a link across adjacent nodes (even interleaving its own partial links), the script **stitches across nodes** to restore the full link and absorb the inserted anchors — covering every structural split point: after the scheme, mid-hostname, at hostname dots, and at path slashes. Plain prose is never absorbed; as a bonus, Alt+click copies cleaner original text
- **Scene toggles** (in the settings panel, effective immediately):
  1. Code blocks (on by default)
  2. Rich-text editors (off)
  3. Control text (off)
  4. Inside existing links (off)
- **Learned rules**: for recurring fixed-format text (like `app:abc-123`, a "prefix:variable" pattern), teach once and every matching text becomes clickable
  - Wildcard rules are inferred automatically (fixed prefix + variable + fixed suffix) and validated round-trip ("sample → link") before saving
  - Variables generalize into digit / letter / mixed classes with word-boundary protection against partial-word matches; variables exclude CJK characters to avoid swallowing text
  - Identical rules dedupe automatically (re-teaching = re-enable + refresh sample); up to 200 rules
  - Rules can be disabled or deleted individually; affected links revert immediately
- **Cloud-drive passcode autofill**: detects passcodes near cloud-drive share links and folds them into the link
  - Matches 4–10 alphanumeric passcodes within 80 characters right / 60 left of the link, keyed on words like "passcode / access code / password / key / pwd"
  - Baidu Netdisk uses the official `?pwd=` parameter; other drives put the code into the link hash — the share page locates the input box, fills it and submits automatically
  - Built-in recognition covers Baidu Netdisk, Quark, Lanzou, Aliyun Drive, Tianyi Cloud, 115, Xunlei, 123 Cloud, China Mobile Cloud, Tencent Weiyun, UC Drive and other mainstream drives
- **Dead-link detection**: converted links are probed anonymously in the background; dead ones get a strikethrough and a "possibly dead" hint
  - HEAD first (auto-downgrades to GET on 405); 404/410, connection failures and timeouts count as dead, 2xx–4xx as alive
  - Anonymous requests carry no cookies; rate-limited to 20 per page, 2 concurrent, 9 s timeout per request; results cached 24 h (max 500 entries per machine)
- **Backup & restore**:
  - Local backup: JSON export / import (file picker + paste into panel), merged and deduplicated by rule content
  - **Versioned WebDAV cloud backup**: every backup is a separate timestamped archive (nothing gets overwritten); restoring lists every historical version on the server for you to pick; missing directories are created automatically (works with services like Jianguoyun that forbid writing to the root)
- **Site blacklist**: one click adds / removes the current site; blacklisted sites are never converted
  (subdomain inheritance since v1.0.8: adding `example.com` also covers `www.example.com`)
- **Instant effect**: master switch, blacklist, rule changes and scene toggles all apply without reloading the page
- **Cross-tab sync**: settings changed in any tab are picked up instantly by all other open tabs (v1.0.8)
- **Zero dependencies, zero telemetry**: no third-party libraries, no analytics, no browsing data collected or uploaded

---

## Installation

Install the **Tampermonkey** browser extension first (Chrome / Edge or any Chromium-based browser; see "Known limitations"), then:

### Option 1: One-click install (recommended)

Pick either link for your network — both serve byte-identical scripts:

- **Mainland China (recommended; CNB connects faster)**
  **👉 [Install Linkify All](https://cnb.cool/xkelin/LinkifyAll/-/git/raw/main/linkify-all.user.js)**
- **International / GitHub**
  **👉 [Install Linkify All](https://raw.githubusercontent.com/polan-prologue/linkify-all/main/linkify-all.user.js)**

Tampermonkey pops up its install confirmation page — click "Install". Revisit the same link to upgrade later.

### Option 2: Manual install

1. Open the Tampermonkey dashboard → "Create a new script"
2. Replace the editor template with the full contents of [`linkify-all.user.js`](./linkify-all.user.js)
3. Save with `Ctrl+S` — the script takes effect immediately

### Upgrading

- Existing users: click the one-click install link again; Tampermonkey treats it as an update and keeps all your local data (rules / blacklist / settings)
- v1.0.0 is the first public release (see [CHANGELOG.md](./CHANGELOG.md))

---

## Quick start

After installation, open any web page — plain-text URLs become clickable automatically. Common actions:

| Action | How |
|---|---|
| Master switch | Tampermonkey toolbar icon → 「总开关」 (master switch) |
| Blacklist current site | Tampermonkey menu → 「把当前站点加入黑名单」 (click again to remove; covers subdomains since v1.0.8) |
| Teach a new rule | Tampermonkey menu → 「🎓 学习新规则…」 (learn a new rule) |
| Open settings panel | Tampermonkey menu → 「⚙️ 设置」 (settings) |
| Copy original text (with passcode) | **Alt + click** a converted link; the passcode is copied too when present |
| Direct jump | **Ctrl + click** (macOS: **Cmd + click**) plain-text URL text — even texts skipped by the anti-false-positive logic (bare two-label domains like `example.com`, file names like `app.zip`) open directly |

---

## Settings panel

The userscript menu has 4 items: **master switch / blacklist / 🎓 learn a new rule / ⚙️ settings**. The settings panel (draggable, closes with Esc, scrolls internally when tall) hosts four modules:

### 1. Scene toggles

Control which regions get converted; all take effect immediately without a reload:

| Scene | Default | Notes |
|---|---|---|
| Code blocks | On | Text inside `<pre>` / `<code>` (allowed for easy copying; can be turned off) |
| Rich-text editors | Off | Editable rich-text areas (avoids disturbing typing) |
| Control text | Off | Text inside buttons / label controls |
| Inside existing links | Off | Text inside existing `<a>` tags (left untouched by default) |

Each toggle shows its description on hover; after toggling, the page is first restored and then re-converted — no reload needed.

### 2. Learned-rule management

- **New rule**: a "＋ Learn a new rule" entry sits pinned at the top of the rule list (always visible while scrolling)
  - Enter a "source text → target link" pair, e.g. `forum:t/123456 → https://example.com/p/123456`
  - The inferred pattern is previewed live (like "prefix⟨digits⟩ → link⟨digits⟩"); impossible inferences explain why
  - The learn dialog never blocks the page: select text on the page first, then press "📌 Grab selection" to fill it in; Enter jumps from the source field to the link field, Enter again saves
- **Rule list**: each rule shows its sample mapping (`source → link`); rules can be disabled or deleted individually (affected links revert immediately); the list scrolls internally, large counts stay smooth
- Rules are stored locally and included in backups

### 3. WebDAV cloud backup

Fill in your own WebDAV server address and credentials (the address field suggests `https://dav.jianguoyun.com/dav/`; Jianguoyun requires an "app password" rather than the login password):

- Every backup creates a separate timestamped file (`backup-<date>-<time>.json`, stored under the server's `/linkify/` folder); historical versions never overwrite each other
- Missing target directories are created automatically (MKCOL) with one retry
- "Restore" lists all historical versions (newest first); current rules are never deleted — identical rules dedupe automatically
- Passwords support non-Latin1 characters such as Chinese (UTF-8 Basic Auth); credentials stay in local Tampermonkey storage and are never exported or sent elsewhere

### 4. Local backup / migration

- **Export to file**: downloads `linkify-all-backup-<date>.json`; falls back to a data URI if the browser blocks the download, then to a manual copy panel
- **Import**: pick a local file, or paste JSON into the panel and click "import from paste"
- Export contents = learned rules + blacklist + master switch + scene toggles; import is **additive** (identical rules dedupe, nothing is deleted); invalid files are rejected with a message

---

## Conversion rules at a glance

| Input | Converted? | Result |
|---|---|---|
| `https://example.com/path/123` | ✅ | Linked as-is |
| `www.example.com/path` | ✅ | `https://` prepended |
| `example.com/page/1` | ✅ | `https://` prepended |
| `news.example.com` (3-label subdomain) | ✅ | `https://` prepended |
| `example.com` (bare two-label domain) | ❌ default | Skipped by design (anti-false-positive) |
| `example-app-1.0.17-win64.zip` | ❌ | Recognized as a file name (extension blacklist; no `/`) |
| `github.com/example-org/app/releases/download/1.0/app.apk` | ✅ | Pathed download links skip the file-name veto (v1.0.8) |
| `https://github.com/.../example-app-1.0.17-win64.zip` | ✅ | Full links with a scheme are never misjudged |
| `Chrome.120.Release` | ❌ | Last label is not a public suffix — not a domain (since v1.0.8) |
| Input fields / rich-text editors / code blocks / inside existing links | per scene toggles | Code blocks on by default, the others off |

> **v1.0.8 principle**: the weaker the signal, the stricter the check. A scheme, a `www` prefix, or a path counts as a strong signal and converts directly; only the weakest form — a three-label host with no scheme, no `www`, and no path — must end in a public-suffix whitelist entry (ccTLDs + mainstream gTLDs + RFC 2606 reserved names).

---

## Permissions & privacy

- **Zero dependencies, zero telemetry**: no analytics; no browsing data collected or uploaded
- **`@connect *`** serves exactly two **user-initiated** features:
  1. Dead-link detection: anonymous HEAD/GET requests to just-converted links (no cookies); intranet addresses (`localhost` / `192.168.*` / `10.*` / `*.local` / IPv6 loopback & ULA etc.) are always skipped since v1.0.8
  2. WebDAV cloud backup: connects to the server address **you** enter
  No other network requests are ever made
- **`GM_addValueChangeListener`** (v1.0.8): listens only to local Tampermonkey storage changes to sync settings across tabs; data never leaves the machine, no network requests involved
- **WebDAV credentials** live only in local Tampermonkey storage and are never included in exported backups
- The script wraps `Element.prototype.attachShadow` compatibly to detect dynamic components (behavior unchanged; open Shadow DOM only)
- All data lives in local Tampermonkey storage: master switch / blacklist / scene toggles / learned rules / dead-link result cache / WebDAV credentials — **uninstalling the script erases everything**

---

## Known limitations

- Bare two-label domains (`example.com`) are not converted by default — anti-false-positive design; subdomains (3+ labels) convert
- Three-label hosts with no scheme, no `www`, and no path must end in a built-in public-suffix whitelist entry; very obscure TLDs will not auto-convert (prepend `https://` or `www.` and they will)
- The file-extension blacklist includes `zip/mov/app` etc., which are also open gTLDs (protecting release asset names takes priority over domain judgment); candidates containing `/` skip this veto, so download links are unaffected
- Does not enter iframes; closed Shadow DOM is inaccessible (open Shadow DOM only)
- Chromium-based browsers supported (Chrome / Edge / recent Opera etc.); **Firefox not supported**
- Learned-rule variables exclude CJK characters (anti text-swallowing); CJK characters following CJK punctuation are never swallowed into links
- Non-HTML namespaces (e.g. inside SVG) are not converted; text nodes over 50,000 characters are skipped (performance guard)

---

## Development & testing

`tests/regression.test.js` is a **zero-dependency** Node regression suite (with a minimal DOM mock faithfully simulating Shadow DOM / MutationObserver / TreeWalker). The file is maintained locally only and is not published with this repository.

```bash
# from the repository root
node tests/regression.test.js ./linkify-all.user.js
# or from the tests directory
cd tests && node regression.test.js ../linkify-all.user.js
```

- The argument is the script path under test — point it at any historical version for behavior comparison
- Coverage: Shadow DOM traversal, cross-node stitching (scheme tail / mid-hostname / hostname dot / path slash boundaries), periodic fallback sweeps, CJK contexts (full-width punctuation / Chinese / passcodes), rule generalization and batch teaching, backup export/import round-trips, file-extension veto, public-suffix whitelist, pseudo-protocol protection, panel immunity, and more
- All test data uses `example.com` placeholder domains (cloud-drive links use test-only drive domains) — no real sites involved
- Current output is fully green: `124 total, 124 passed, 0 failed`

---

## FAQ

**Q: Why doesn't a bare `example.com` (no `www`) become a link?**
A: Bare two-label domains are extremely common in prose (file names, parameters, sentence fragments), so the false-positive risk is highest and they are skipped by default. Subdomains with 3+ labels convert automatically; so do forms with `www` or a path.

**Q: Why isn't `example-app-1.0.17-win64.zip` linked?**
A: `.zip` and friends are on the extension blacklist, and the string contains no `/` (a bare asset name), so it is treated as a file name. Since v1.0.8, pathed download links (e.g. `github.com/xxx/releases/download/1.0/app.apk`) are no longer affected and convert normally.

**Q: How do I migrate settings to a new computer / browser?**
A: Settings panel → export JSON; after installing the script on the new machine, import it. For automatic cross-device migration, use the WebDAV cloud backup and pick any historical version when restoring.

**Q: Will dead-link detection get blocked by websites?**
A: Requests are anonymous, cookie-free and rate-limited (20 per page / 2 concurrent / 24 h result cache) — negligible load. A few sites may still refuse; that is normal.

**Q: How do I uninstall completely?**
A: Tampermonkey dashboard → delete this script. All local data is erased with it.

**Q: Is Firefox supported?**
A: Not yet (the script uses ES2020 features; Firefox would need separate adaptation).

---

## License

[MIT](./LICENSE)

[Changelog → CHANGELOG.md](./CHANGELOG.md)
