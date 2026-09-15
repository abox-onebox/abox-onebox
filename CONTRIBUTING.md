# 协作入口

本仓库的完整协作规范见 **`docs/ABox一盒协作规范v1.0.md`**，要点速览：

- **分支**：`main`（可发布）/ `develop`（集成）/ `feat-*` · `fix-*` · `hotfix-*`（开发）
- **提交**：Conventional Commits（`feat(scope): 描述`），commitlint 强制校验
- **PR**：至少 1 人 Approve + CI 全绿 + 关联需求编号，禁止直推 `main`（热修除外，需补 PR）
- **密钥**：一律走 `.env`，`.env.example` 同步维护；**严禁**提交真实密钥
- **文档**：改口径必须先改 `docs/`，再改代码；禁止"文档不动、代码自作主张"
- **DoD**：类型检查通过 + 单测覆盖关键分支 + Swagger 已更新 + 关联文档已同步
