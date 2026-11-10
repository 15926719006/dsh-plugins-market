# DSH 插件小市场

个人维护的 DSH 插件集合，通过 GitHub Pages 发布一份 **Plugin Market Index Format 1** 索引，DSH 可以直接把这份索引添加为「索引源」，浏览并安装下面的插件。

索引地址（已经发布，直接复制这条）：

```text
https://15926719006.github.io/dsh-plugins-market/index.json
```

仓库：https://github.com/15926719006/dsh-plugins-market

> 地址必须带上 `/index.json`。GitHub Pages 对目录地址会返回 301 跳转，而 DSH 抓取索引时**不跟随重定向**，目录地址会被判为失败。

当前收录的插件：

| 插件 | 作用 |
| --- | --- |
| 置顶在最上（Pinned on Top） | 把置顶会话收拢到侧边栏最上方的「置顶」分区，并可一键归档某个工作区的全部会话 |
| 任务完成通知（Task Notify） | 任务跑完、出错或被打断，或智能体停下来等你回答/审批时，弹一条 macOS 电脑通知 |
| OpenCode Go 额度（OpenCode Go Quota） | 在侧栏底部显示 OpenCode Go 订阅剩余额度，点开查看滚动 / 每周 / 每月三个窗口 |
| 插件导出（Plugin Export） | 把已安装的插件打包成一个可分享、可直接安装的 `.tgz`，并自动复制安装说明 |
| 任务花费（Task Cost） | 按 **DeepSeek 计费标准**（高峰/空闲、缓存命中/未命中分别计价）估算当前会话的模型调用花费：输入框下方显示会话累计，每条回复底部显示本轮金额 |
| 单轮耗时（Turn Duration） | 在每条助手回复底部显示这一轮从开始到结束用了多久（含模型思考与工具调用），悬停可看起止时间；历史会话同样生效 |
| 总结重命名（Summarize & Rename） | 在会话行悬停时点一下，用模型把整段对话概括成一行标题并直接重命名；可在插件页开启「devops 编号前缀」，让标题带上需求编号与平台标题 |

每个插件的详情页都会展示它自己的 README，开头是真实运行界面截图（`docs/*.png`），点开条目就能先看到效果再决定装不装。

---

## 一、给使用者：添加索引源并安装

DSH **没有内置默认索引源**，所以每个人只需要手动添加一次这个地址。

1. 打开 DSH，进入 **插件** 页面。
2. 切到 **发现** 标签页，点击 **管理索引源…**。
3. 点击 **添加索引源**，粘贴上面的索引地址，例如：

   ```text
   https://15926719006.github.io/dsh-plugins-market/index.json
   ```

4. 保存后回到 **发现**，就能看到上面这些插件；点开插件、选择版本后点击 **安装**。

安装行为说明：

- 索引里的版本都指向 **Git 源 + 固定 commit**（`git+https://github.com/15926719006/dsh-plugins-market.git#<commit>&path:/plugins/<目录>`），DSH 交给 pnpm 安装，因此每个插件安装到的就是索引里写死的那个 commit，不会漂移。
- 作者发布新版本后，索引里的版本号会更新，DSH 会把它标成「有新版本」；但发现页**没有一键升级**，升级要先在「已安装」里卸载，再从发现页安装一次。
- 这些插件包都保持 `"private": true`，**没有发布到 npm**，安装时不经过 npm registry；DSH 只从 GitHub 拉这个 commit。

兼容性：

- 本索引为 **格式 1**，由 DSH 自带的 `@deepseek-ai/dsh-plugin-market-index` 校验器校验后发布。
- 插件面向 **DSH 0.2.2-rc.1** 开发。DSH 版本差异较大时（尤其是客户端插件 API 变化）不保证兼容；升级 DSH 后如果插件异常，先重新安装最新版本，仍不行则暂时停用。

---

## 二、给维护者（作者本人）

### 仓库结构

```text
dsh-plugins-market/
├── .github/workflows/publish-index.yml   # push 到 main 时构建索引并部署 GitHub Pages
├── plugins/
│   ├── dsh-plugin-export/                # 插件源码（package.json 原样保留）
│   ├── dsh-pinned-top/
│   ├── dsh-task-notify/
│   ├── dsh-opencode-quota/
│   ├── dsh-cost-stat/
│   ├── dsh-turn-duration/
│   └── dsh-session-rename/
├── plugins.json                          # 索引的展示元数据：标题/描述/分类/关键词等
├── scripts/
│   ├── build-index.mjs                   # 生成 site/index.json（无第三方依赖）
│   ├── validate-index.mjs                # 用官方校验器校验 site/index.json
│   ├── publish.mjs                       # 一条龙：同步→递增→构建→推送→等待→装回本机
│   └── lib/dsh-api.mjs                   # 调运行中 DSH 的本地 API（签 browser cookie）
├── package.json                          # 私有包，devDependency 只有官方校验器
├── .gitignore
└── README.md
```

`plugins/<目录>/package.json` 及其 `files` 列表保持与源仓库一致：**不要改包名**（包名就是安装身份），也不要遗漏 `files` 里列出的文件。索引只读取 `package.json` 的 `name`、`version`、`description`、可选的 `engines.dsh`，以及 `icon.svg`、`plugins.json` 里的展示信息。

### 首次发布（只做一次）

1. 把 `dsh-plugins-market/` 作为仓库根目录推送到 GitHub，**仓库必须设为 Public**（GitHub Pages 免费版只对公开仓库开放；而且别人从「发现」页安装时 pnpm 在清理过的环境里跑，拿不到你的 token，私有仓库装不了）。仓库名用 `dsh-plugins-market`，默认分支 `main`。
2. 在仓库 **Settings → Pages → Build and deployment** 里把 **Source** 设为 **GitHub Actions**。
3. 推送后 `.github/workflows/publish-index.yml` 会自动运行：构建 `site/index.json` → 上传 Pages artifact → 部署。
4. 部署完成后索引地址就是 `https://15926719006.github.io/dsh-plugins-market/index.json`。
5. 在仓库 **Settings → Topics** 里加上 **`dsh-plugin`**（见下方「第三方目录」）。

### 一条龙发布（推荐）

```sh
node scripts/publish.mjs <插件目录名> --bump patch      # 例：node scripts/publish.mjs dsh-task-notify --bump patch
```

它按顺序做完：同步文件 → 补 `plugins.json` 展示信息（新插件从 `locale/zh.json` 的 meta 生成）→ 递增版本 → 构建并校验索引 → 提交推送 → 等 Actions 和 Pages → **卸载旧版、从新 commit 装回本机运行的 DSH**。

常用变体：

| 命令 | 作用 |
| --- | --- |
| `node scripts/publish.mjs <名> --bump minor` | 递增 minor / major 同理 |
| `node scripts/publish.mjs --from ~/Desktop/work/dsh-new --bump patch` | 把一个还没进仓库的插件目录收进来并发布 |
| `node scripts/publish.mjs <名> --dev` | 不发布，只把 `plugins/<名>` 以本地 link 方式装进 DSH（改代码刷新即生效） |
| `node scripts/publish.mjs <名> --no-push` | 只构建 + 校验，不提交不推送 |
| `node scripts/publish.mjs <名> --dry-run` | 打印计划，不提交、不推送、不安装 |
| `node scripts/publish.mjs <名> --no-install` | 发布但不装到本机 |

安装这一步走的是运行中 DSH 的本地 API（自动从 `lsof` 找端口，或用 `--origin http://127.0.0.1:<端口>` 指定；profile 默认 `desktop`，可用 `--profile` 覆盖），所以脚本跑完本机就是最新版，不用回 UI 点。

发出去之后，别人那边有几段延迟：Actions 构建 + Pages 部署约 1 分钟，DSH 抓索引有 **10 分钟缓存**（发现页点刷新可立即拉），看到的是「有新版本」；DSH 目前没有一键升级，卸载再装才是新 commit。

> 索引每次只带**当前这一个版本**（指向本次提交），所以改版本号后旧版本会从索引里消失；每个版本号只需在同一个索引里唯一，递增只是为了让「已安装 / 有新版本」判断正确。

### 新插件从零开始

1. 复制一个现有插件目录当模板（`plugins/dsh-task-notify` 最简：Host 入口 + client 入口 + `cordis.patch.yml` + `locale/` + `icon.svg` + `docs/preview.png`）。
2. 改 `package.json` 的 `name`、`cordis.patch.yml` 里的行 id、`locale/*.json` 的标题描述、README（`## 效果图` 放真实截图）。
3. 本地调：`node scripts/publish.mjs <目录名> --dev`，刷新页面看效果。
4. 定稿：`node scripts/publish.mjs <目录名> --bump patch`，一条龙发布并装回本机。

> 规格：`package.json` 必须有 `dsh.bundle.patch`；声明 `dsh.client` 时要有 `exports["./client"]` 指向已构建入口；`files` 里要包含 `cordis.patch.yml`、`docs/*.png` 等要发布的文件（脚本会补 `docs/*.png`）。仓库根目录和插件包都不要有 `prepare`/`install` 之类的构建脚本，否则 pnpm 11 会要求逐个批准。

### 本地预览

在仓库里（已经有 `origin` remote 的 git 检出中）：

```bash
npm install
npm run build          # 生成 site/index.json 并校验
npx serve site         # 需要本地起静态服务时：http://localhost:3000/index.json
```

`npm run build` 需要知道仓库 URL 和 commit：CI 里来自 `$GITHUB_REPOSITORY` / `$GITHUB_SHA`，本地来自 `git remote get-url origin` / `git rev-parse HEAD`。

如果目录还没成为 git 仓库，或者想在任意位置做一次干跑，用参数显式覆盖：

```bash
npm install
node scripts/build-index.mjs \
  --repo https://github.com/15926719006/dsh-plugins-market \
  --commit 0123456789abcdef0123456789abcdef01234567
npm run validate
# 校验真实地址：
npm run validate -- https://15926719006.github.io/dsh-plugins-market/index.json
```

### 新增插件

1. 把插件目录整个复制到 `plugins/<目录名>/`（不要带 `.git`、`node_modules`、`.cache`、测试输出）。
2. 确认 `package.json` 的 `name`、`version` 有效，且 `files` 覆盖要发布的文件。
3. 在 `plugins.json` 的 `plugins` 对象里加一条：`title`（含 `en`/`zh`）、`description`（含 `en`/`zh`）、`category`（必须是 `metadata.categories` 里声明过的 id）、`keywords`，可选 `labels`、`sortKeys`。
4. 提交推送，Actions 会自动重建索引。

### 索引格式与硬性限制

索引是 **Plugin Market Index Format 1**，发布前由官方校验器 `@deepseek-ai/dsh-plugin-market-index`（当前 `0.2.2-rc.1`）校验。需要注意的硬性约束：

- **抓取不允许重定向**：索引 URL 必须直接返回 200 和 JSON；301/307 都视为失败。因此请始终使用 `/index.json` 这种显式路径。
- **超时 15 秒**，索引响应体 **不超过 128 MiB**。
- 索引 URL 必须是规范的 HTTPS 地址：主机名小写、不带用户名密码、不带 query 或 fragment。
- Git 源字段 `source.url` 必须是规范化的 HTTPS 仓库地址（不带结尾 `.git`，至少两段路径），`commit` 必须是 **40 位小写十六进制**，`path` 是相对仓库根的目录。DSH 安装时会拼成 `git+<url>.git#<commit>&path:/<path>`。
- 每个插件必须有至少一个版本，`version` 必须是精确 SemVer；同一插件的版本不能重复。
- `publishTimestamp` 是 Unix 秒级整数，取自该插件目录最后一次提交时间；取不到时用当前时间兜底。
- 图标内联为 `data:image/svg+xml;base64,...`，解码后 **不超过 32 KiB**。
- 插件包保持 `"private": true` 没问题：这些插件走 Git 源安装，不需要发布 npm 包。
- **仓库根目录的 `package.json` 不要有 `preinstall` / `install` / `postinstall`，插件包也不要 `prepare` / `prepublish` 等脚本**：pnpm 11 会把它们当成需要批准的构建脚本，于是第一次安装会停在「允许这些脚本并重试」，多一步确认。本仓库目前两者都没有，保持这样即可。
- **构建产物必须提交**：pnpm 从 git 安装时只打包该 commit 里、且被 `files` 覆盖的文件。`lib/`、`client.js`、`cordis.patch.yml`、`locale/` 等已在仓库里，不要 gitignore 它们（只忽略 `site/` 与 `node_modules/`）。
- 每个插件包必须带 `cordis.patch.yml`（被 `dsh.bundle.patch` 引用），并在声明了 `dsh.client` 时提供 `exports["./client"]` 指向已构建的客户端入口，否则装上了也起不来。
- `site/` 和 `node_modules/` 已在 `.gitignore` 中，索引由 CI 构建，不提交产物。

### 第三方目录

GitHub 的第三方 DSH 插件目录（如 dshmk、dsh.so）会抓取带 **`dsh-plugin`** topic 的仓库。给本仓库加上这个 topic，可以让这里的新插件被自动发现；同时 DSH 本身不内置任何默认索引源，别人仍需要像上面「给使用者」那样手动添加一次索引地址。
