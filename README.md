# Linkify All

把任意网页中的明文网址自动变成可点击的链接。一个零依赖、纯本地的油猴（Tampermonkey）用户脚本。

> 例：页面里的 `https://example.com`、`www.example.com/path`、子域名 `dshell.ft07.com`
> 会自动补全并转成可点击的新标签页链接。

## 功能

- **全站自动转换**：带协议完整网址；无协议但含 `www`/路径/**子域名**的地址自动补全 `https://`
- **稳健防误判**：二段裸域名（如 `example.com`）默认不转；常见文件扩展名结尾的字符串
  （`.zip/.dmg/.exe/.pdf...`，如 GitHub Release 附件名）识别为文件名不转换
- **场景开关**：代码块（默认开）/ 富文本编辑器 / 控件文本 / 已有链接内部，按需启用
- **学习规则**：输入一对「原文本 → 跳转链接」，自动推导通配规则（如
  `github:owner/repo → https://github.com/owner/repo`），此后同类文本全部转换；
  支持启停/删除/批量列表内部滚动
- **网盘提取码**：识别网盘链接附近的提取码并入链接；百度网盘走官方 `?pwd=`，
  其他网盘打开后自动填入提取码框
- **失效检测**：后台匿名探测转换出的链接，404/410 标记中划线并提示「可能失效」
- **配置备份**：本地 JSON 导出/导入 + **WebDAV 版本化云备份**
  （每次备份按时间戳独立存档，恢复时可自由选择任一历史版本）
- **即时生效**：总开关 / 站点黑名单 / 规则增删改，全部无需刷新页面

## 安装

需先安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展，然后：

**👉 [点此安装 Linkify All](https://raw.githubusercontent.com/polan-prologue/linkify-all/main/linkify-all.user.js)**

（点击后油猴会自动弹出安装确认页，点「安装」即可。以后升级也是点同一链接。）

也可以手动安装：打开 Tampermonkey 管理面板 → 新建脚本 → 粘贴 [`linkify-all.user.js`](./linkify-all.user.js) 全部内容 → 保存。

要求：Chrome / Edge 等 Chromium 内核浏览器（使用 ES2020 特性，Firefox 未适配）。

## 使用

安装后油猴菜单共 4 项：

| 菜单项 | 说明 |
|---|---|
| ✅ 总开关 | 全局启停，改动即刻还原/重转换当前页 |
| 🚫 黑名单 | 一键把当前站点加入/移出黑名单 |
| 🎓 学习新规则… | 教一对示例即可让同类文本可点击 |
| ⚙️ 设置 | 场景开关 / 规则管理 / WebDAV 与本地备份 |

快捷键：**Alt + 点击** 转换出的链接 = 复制原始文本。

## 权限与隐私

- **零依赖、零遥测**：无任何统计上报；不收集、不上传任何浏览数据
- **`@connect *`**：仅服务于两个用户主动功能——① 失效检测（对链接目标发匿名
  HEAD/GET，不带 Cookie）；② 连接你**自己填写**的 WebDAV 服务器做云备份。
  除此之外脚本不发起任何网络请求
- **WebDAV 凭据**仅保存在本机 Tampermonkey 存储中，不会随备份文件导出或外发
- 脚本会以兼容方式包装 `Element.prototype.attachShadow` 以感知动态组件（不改其行为）
- 所有数据（规则/黑名单/缓存/凭据）存于本机，卸载脚本即清除

## 已知边界

- 二段裸域名（`example.com`）默认不转换——防误判设计；可在「设置」里按需开启其他区域
- 文件扩展名黑名单包含 `zip/mov/app` 等同时是 gTLD 的后缀（防 Release 附件误判优先）
- 不进入 iframe；仅穿透开放 Shadow DOM（封闭 Shadow DOM 无法访问）
- 未适配 Firefox

## 开发与测试

仓库内的 [`tests/regression.test.js`](./tests/regression.test.js) 是零依赖的 Node 回归测试
（内置最小 DOM mock），覆盖 Shadow DOM 穿透、中文标点、学习规则泛化、备份往返等：

```bash
node tests/regression.test.js ../linkify-all.user.js   # 或指向任意历史版本对比
```

## License

[MIT](./LICENSE)
