## 变更说明 / Summary

## 检查清单 / Checklist

- [ ] 与 docs/standard.md 冲突时，先改标准并在 CHANGELOG.md 记一笔
- [ ] 改了表结构或 schema：同步检查 `schema/base-schema.json` 与 `docs/base-schema.md`
- [ ] 发版变更同步 bump：`package.json`、`package-lock.json`、`DAEMON_VERSION`
- [ ] 未提交任何凭据、`app.env`、`.a2a-hub/`、`hub.db*`、`approval_key.pem` 等本地状态文件
- [ ] 新增写表路径遵循 `SqliteBus` / `HttpBus` 契约与 `client_token` 幂等规范
