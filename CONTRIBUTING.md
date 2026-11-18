# Contributing

## 仓库结构速览

- `bin/` `src/`：守护进程与中台网关（Node >= 24 ESM，零外部运行时依赖 `dependencies: {}`；由 `ah daemon --role node|hub` 承载 node 与 hub 两种逻辑角色，hub 角色代码在 `src/hub/` 与 `src/server/`）。
- `docs/`：规范性文档。**`docs/standard.md` 是标准**，实现与标准冲突时
  先改标准、再改实现，并在 `CHANGELOG.md` 记一笔。
- `schema/`：表结构快照（`schema/base-schema.json` 与 `docs/base-schema.md` 为脚本生成物，不要手改）。

## 改动纪律

- **改了节点或枢纽行为**：`node --check` 过全部源文件；有条件时用
  `ah doctor [--role node|hub]` 对示例配置与真实配置各跑一遍。守护进程是薄壳：
  新能力优先用命令模板（`commands.json`）表达，不要往内核里塞执行器。
- **凭据红线**：任何真实 API Token（`AH_API_TOKEN`）、Webhook 地址、私钥（`approval_key.pem`）都不
  得进仓库；示例一律用占位符，真实值走 `0600` 权限的 `app.env`（已 gitignore）。
- **提交信息**：一行说清动了什么、为什么；版本发布时同步 bump
  `package.json`、`package-lock.json` 与 `src/kernel.mjs` 的
  `DAEMON_VERSION`，并在 `CHANGELOG.md` 顶部加条目。

## 测试

- 怎么跑：在仓库根目录执行 `npm test`。脚本是 `node --test tests/*.test.mjs`，由 shell 展开文件列表，Node >= 24 把具体文件交给内置测试运行器。只用 `node:test` 和 `node:assert`，不要加 Jest、Mocha、Vitest 或任何第三方断言库，也不要加 `devDependencies`。
- 隔离红线：测试不准连接真实外部服务，不准读 `~/.a2a-hub`，不准依赖环境变量里的真实凭据。状态写在 `os.tmpdir()` 的临时目录里，用例结束要删掉。测试不准留下子进程；会拉起的命令用 `node -e`，并等它退出。
- 新功能随带测试：行为变化要带上对应的 `tests/*.test.mjs`。每条测试用注释写明它守的红线。生产代码只为了可注入增加 export，或极小的依赖注入。

## 设计问题去哪讨论

先读 `docs/architecture.md` 的核心决策——多数「为什么不这样做」都在
那里有答案；新提案请开 issue 说明场景与代价。
