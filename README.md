# Biji Tongbu

[English](#english) | [中文](#中文)

---

## English

Biji Tongbu (笔记同步助手) syncs content you collect through the WeChat official account **「笔记同步助手」(Note Sync Helper)** into your Obsidian vault: articles from WeChat Official Accounts, Xiaohongshu, Dedao, Yuanbao, Zhihu and other platforms, plus chat messages, images and file attachments you forward to the account.

Works on desktop and mobile.

### How it works

1. You follow the WeChat official account **「笔记同步助手」** and bind it to get an **API key**.
2. You share links / messages / files to that account. The backing service fetches and cleans the content.
3. This plugin pulls the processed notes from the service into your vault (manually, on startup, or on a timer you configure).

### ⚠️ Disclosures (please read before installing)

**Account & API key required.** The plugin is a client for the Note Sync Helper service. It does nothing until you enter an API key, which you obtain from the WeChat official account 「笔记同步助手」. Your API key is stored locally in the plugin's `data.json` and sent with every API request to authenticate you (image/attachment downloads from the CDN hosts below do **not** carry the key).

**Network use.** This plugin talks to the following servers (all operated by the plugin author / the Note Sync Helper service, unless noted):

| Host | Purpose |
|---|---|
| `obsidian.notebooksyncer.com` | Main sync API (GraphQL): pull your notes, mark them synced, delete on request; membership/quota status; market version-number check (`/plugversion-market`) |
| `relay-1.bijitongbu.site`, `graph.bijitongbu.site` | Fallback endpoints for the same API (network resilience in mainland China) |
| `relay-1/2/3/4.bijitongbu.site`, `pic.clipfx.app`, `media.clipfx.app`, `media30d.clipfx.app`, `sync.bijitongbu.site`, `www.bijitongbu.site` | Image / attachment hosting, including fallback origin servers. When you enable image or attachment localization, files referenced by your synced notes are downloaded from these hosts into your vault |

Localization downloads the remote URLs your synced notes actually reference: the service normally rewrites media links to the hosts above, but if a note still references a file at its original source (e.g. the source platform's CDN), the plugin downloads it from that original host.

Documentation links in the settings page (`www.notebooksyncer.com`, `shoujidiannao.bijitongbu.site`, `bijitongbu.feishu.cn`) open in your browser only when you click them.

Legacy note: the bundle includes the `@omnivore-app/api` client library (this plugin began as an Omnivore fork). The library's built-in default endpoint (`api-prod.omnivore.app`) is never contacted — the plugin always supplies its own endpoint from the table above. The optional `omnivoreUrl` template variable writes legacy `omnivore.app` links into note text as plain text; no request is ever made to omnivore.app.

**What is sent.** Requests carry your API key, sync cursors/timestamps, and — for explicit actions you trigger — article IDs (e.g. "burn after reading" deletion, clearing server-side storage). The plugin does **not** read, upload, or index the existing notes in your vault; content flows from the service *into* your vault.

**Paid tiers.** The backing service offers a free quota and paid VIP tiers. The plugin sends your API key to `obsidian.notebooksyncer.com/user-config` to read back your membership level (trial / member / first-class member) and expiry, and the settings page shows that status together with QR codes for subscribing through WeChat. No payment happens inside the plugin.

**No self-update.** This build contains **no self-update mechanism**. Updates are delivered exclusively through the Obsidian community plugin catalog. After a manual sync the plugin may show a one-line passive reminder under the sync status notice when a newer market version exists (it only fetches a version number from `obsidian.notebooksyncer.com/plugversion-market`); clicking it opens Obsidian's **Settings → Community plugins** page, where you decide whether to update. The plugin never downloads or replaces its own files.

**Static promotion in settings (disclosed).** The settings page shows your membership status and a **statically bundled** QR image (no network load) for purchasing the paid membership. Promotional QR images that the service embeds into note content are **stripped by the plugin** before notes are written to your vault — nothing promotional is written into your notes.

**No cross-plugin scripting.** This edition does not invoke other plugins' commands and does not run Templater interpolation; `<% %>` tags in your templates are kept as-is. As a safety guard, files created by this plugin are marked so the Templater plugin (if installed) will not execute template commands found inside synced web content.

The only interaction with other plugins is read-only: when the diary-link feature is enabled, the bundled `obsidian-daily-notes-interface` library reads the Daily Notes / Periodic Notes / Calendar settings to work out where your daily note lives. Nothing is written to, or executed in, those plugins.

**No telemetry.** The plugin sends no analytics, no usage statistics and no crash reports.

### Install & quick start

1. Install the plugin and enable it.
2. Follow the WeChat official account 「笔记同步助手」, get your API key, and paste it into the plugin settings.
3. Click the ribbon icon (or run the `Sync` command). Synced notes land in the folder configured in settings (default `Synced/`).
4. Optional: customize templates (front matter, file naming, merge modes), image/attachment localization, diary links, and sync schedule in the settings page.

Manual install: download `main.js`, `manifest.json` and `styles.css` from the [Releases](https://github.com/notesynchelper/obsidian-bijitongbu/releases) page into `<vault>/.obsidian/plugins/bijitongbu/`, then reload Obsidian.

### Privacy & data location

- Settings (including your API key) are stored in `.obsidian/plugins/bijitongbu/data.json` inside your vault.
- Downloaded images/attachments are stored in the attachment folder you configure.
- The service stores the content you shared to the official account until you delete it (the settings page provides a "clear server content" action).

### Build & verify

Release assets are built **only** by GitHub Actions from this repository ([`.github/workflows/release.yml`](.github/workflows/release.yml)) — pushing a version tag runs lint, unit tests and the production build, then publishes `main.js`, `manifest.json` and `styles.css`. Each release carries a [build provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds), so anyone can verify the shipped bundle was built from this source:

```bash
gh attestation verify main.js --repo notesynchelper/obsidian-bijitongbu
```

Build locally:

```bash
npm ci
npm run lint     # eslint-plugin-obsidianmd, the same scan the review bot runs
npm test         # unit tests
npm run build    # produces main.js
```

### License

[GNU AGPL v3 or later](LICENSE) — see [NOTICE](NOTICE) for third-party attributions. Releases up to 3.2.2 were published under the MIT License.

### Support

- [GitHub Issues](https://github.com/notesynchelper/obsidian-bijitongbu/issues)
- Email: frank@onenotes.app

---

## 中文

「笔记同步助手」Obsidian 插件：把你通过微信服务号 **「笔记同步助手」** 收集的内容同步进 Obsidian 仓库——支持微信公众号、小红书、得到、元宝、知乎等平台的文章，以及你转发给服务号的聊天记录、图片和文件附件。

桌面端与移动端均可用。

### 工作原理

1. 关注微信服务号 **「笔记同步助手」** 并绑定，获得 **API 密钥**；
2. 把链接 / 消息 / 文件分享给服务号，后台服务抓取并清洗内容；
3. 本插件把处理好的笔记从服务端拉取到你的仓库（手动同步、启动时同步或按你配置的频率定时同步）。

### ⚠️ 使用披露（安装前请阅读）

**需要账号与 API 密钥。** 本插件是「笔记同步助手」服务的客户端，填入 API 密钥前不做任何事。密钥通过微信服务号「笔记同步助手」获取，保存在插件本地 `data.json` 中，每次 API 请求随请求发送用于身份认证（从下表 CDN 域名下载图片/附件时**不**携带密钥）。

**网络访问。** 插件会访问以下服务器（除特别说明外，均由插件作者 / 笔记同步助手服务运营）：

| 域名 | 用途 |
|---|---|
| `obsidian.notebooksyncer.com` | 主同步 API（GraphQL）：拉取笔记、标记已同步、按请求删除；会员/配额状态；市场版本号检查（`/plugversion-market`） |
| `relay-1.bijitongbu.site`、`graph.bijitongbu.site` | 同一 API 的备用端点（大陆网络容灾） |
| `relay-1/2/3/4.bijitongbu.site`、`pic.clipfx.app`、`media.clipfx.app`、`media30d.clipfx.app`、`sync.bijitongbu.site`、`www.bijitongbu.site` | 图片/附件存储（含源站兜底节点）。开启图片或附件本地化后，同步笔记中引用的文件从这些域名下载进仓库 |

本地化下载的是同步笔记中实际引用的远程 URL：服务端通常已把媒体链接改写到上述域名；若某条笔记仍引用原始来源（如源平台 CDN）的文件，插件会从该原始域名下载。

设置页里的文档链接（`www.notebooksyncer.com`、`shoujidiannao.bijitongbu.site`、`bijitongbu.feishu.cn`）仅在你点击时用浏览器打开。

遗留说明：安装包内含 `@omnivore-app/api` 客户端库（本插件源自 Omnivore fork）。该库内置的默认地址（`api-prod.omnivore.app`）永远不会被访问——插件始终传入上表中自己的端点；可选模板变量 `omnivoreUrl` 只会往笔记文本里写历史遗留的 `omnivore.app` 链接（纯文本），不会向 omnivore.app 发起任何请求。

**发送哪些数据。** 请求携带你的 API 密钥、同步游标/时间戳，以及你显式触发的操作对应的文章 ID（如「阅后即焚」删除、清空云端内容）。插件**不会**读取、上传或索引你仓库中已有的笔记；内容只从服务端流向你的仓库。

**付费层级。** 背后服务提供免费额度与付费 VIP 层级。插件会把 API 密钥发送到 `obsidian.notebooksyncer.com/user-config` 读取你的会员等级（体验会员 / 正式会员 / 头等舱会员）与到期时间，设置页展示该状态以及微信订阅二维码。插件内不发生任何支付行为。

**没有自更新。** 本构建**不含任何自更新机制**，更新只通过 Obsidian 官方社区插件目录分发。手动同步后，若市场上有新版本，同步状态提示下方可能出现一行弱提醒（仅从 `obsidian.notebooksyncer.com/plugversion-market` 获取一个版本号）；点击后打开 Obsidian **设置 → 第三方插件** 页面，由你自行决定是否升级。插件永远不会下载或替换自身文件。

**设置页内的静态推广（已披露）。** 设置页会展示会员状态和一张**打包内置**的付费会员购买二维码（不从网络加载）。服务端拼进笔记正文的推广二维码会在写入仓库前被插件**剥除**——不会有任何推广内容写进你的笔记。

**无跨插件脚本行为。** 本版本不调用其它插件的命令，也不执行 Templater 插值；模板里的 `<% %>` 标签会原样保留。作为安全防护，本插件创建的文件会被标记，避免已安装的 Templater 插件执行同步网页内容中出现的模板命令。

与其它插件唯一的交互是只读的：开启日记双链功能时，打包内的 `obsidian-daily-notes-interface` 库会读取「日记 / Periodic Notes / Calendar」插件的设置，用于定位你的日记文件所在位置；不会向这些插件写入任何东西，也不会执行它们的命令。

**无遥测。** 插件不发送任何统计、使用数据或崩溃报告。

### 安装与快速上手

1. 安装并启用插件；
2. 关注微信服务号「笔记同步助手」，获取 API 密钥，填入插件设置；
3. 点击侧边栏图标（或运行 `Sync` 命令），同步的笔记落在设置中配置的文件夹（默认 `Synced/`）；
4. 可选：在设置页自定义模板（前置元数据、文件命名、合并模式）、图片/附件本地化、日记双链与同步频率。

手动安装：从 [Releases](https://github.com/notesynchelper/obsidian-bijitongbu/releases) 下载 `main.js`、`manifest.json`、`styles.css` 放进 `<仓库>/.obsidian/plugins/bijitongbu/`，重启 Obsidian。

### 隐私与数据位置

- 设置（含 API 密钥）保存在仓库内 `.obsidian/plugins/bijitongbu/data.json`；
- 下载的图片/附件保存在你配置的附件文件夹；
- 你分享给服务号的内容保存在服务端，直到你删除（设置页提供「清空云端内容」操作）。

### 模板变量

见 [TEMPLATE-VARIABLES.md](TEMPLATE-VARIABLES.md)。

### 构建与验证

发行包**只由 GitHub Actions** 从本仓库构建（见 [`.github/workflows/release.yml`](.github/workflows/release.yml)）：推送版本 tag 后自动跑 lint、单元测试、生产构建，再发布 `main.js`、`manifest.json`、`styles.css`，并附带 **build provenance 证明**，任何人都可以验证发行包确实由本仓库源码构建：

```bash
gh attestation verify main.js --repo notesynchelper/obsidian-bijitongbu
```

本地构建：

```bash
npm ci
npm run lint     # eslint-plugin-obsidianmd，与官方审核 bot 同一套静态扫描
npm test         # 单元测试
npm run build    # 产出 main.js
```

### 许可证

[GNU AGPL v3 或更新版本](LICENSE)——第三方署名见 [NOTICE](NOTICE)。3.2.2 及更早的发行版按 MIT 许可证发布。

### 支持

- [GitHub Issues](https://github.com/notesynchelper/obsidian-bijitongbu/issues)
- 邮箱：frank@onenotes.app
