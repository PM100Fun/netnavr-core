# NetNavr Core

Local identity and durable runtime foundations for NetNavr. This repository is
pre-alpha source, not a completed MVP or an end-user installer.

## What works today

- Persistent SQLite Node identity, schema migration checks and a single-runtime lock.
- Loopback-only `GET /v1/health` and `GET /v1/node`, bounded HTTP requests and errors.
- A versioned HTTP contract consumed by [NetNavr Shell](https://github.com/PM100Fun/netnavr-shell).

Tasks, durable conversations, multiple real providers, permission orchestration
and backup/restore workflows remain product work. Current tests do not establish
those capabilities.

## Quick start

Use Node.js 24 or newer and npm.

```sh
git clone https://github.com/PM100Fun/netnavr-core.git
cd netnavr-core
npm ci
npm run verify
npm start
```

The default address is `http://127.0.0.1:8786`. Configure `NETNAVR_CORE_PORT`
and `NETNAVR_CORE_DATA_DIR` when needed; normal execution stores local identity in
the user's `.netnavr/core` directory. Tests use isolated temporary storage.

## Boundaries and compatibility

`src/` owns the runtime and storage, `test/` owns its tests, and `contracts/`
owns the Core wire contract. `npm run build` produces JavaScript in `dist/`
using Node's type stripping. It is not a static type check.

| Identity | Value |
| --- | --- |
| Core component | 0.2.2 |
| HTTP API | v1 |
| SQLite schema | 1 |
| Import baseline | NetNavr v0.2.33, `ca6002d580cef51cab869a3a65cbcddc2dfed3c1` |
| Previous Core component | 0.2.1 |

The split adds a package build and contract export without changing the API or
database schema. Shell pins an exact Core Git commit through its npm lockfile.
Core owns `@netnavr/core/contract`; Shell must not maintain a second definition.
Core changes run local tests and then the consuming Shell integration tests
before a product candidate binds the pair. Publishing a new Core commit does
not automatically update a released Shell.

The product roadmap starts separately at product 0.1 and targets a macOS-first,
Tasks-first MVP through 1.0. Component versions and the legacy repository's tags
are separate identities. New features and accepted product releases are not
implied by this repository initialization. App packaging belongs to Shell.

## 中文说明

Core 当前提供本地 Node 身份、SQLite 持久化、运行锁和只读 HTTP 接口。
本仓从旧总仓 v0.2.33 导出，组件由 0.2.1 调整为 0.2.2，保留现行修复。
产品 0.1—1.0 是独立的规划编号，不能将本次拆仓视为 MVP 已完成。
共享接口以本仓 `contracts/` 为唯一维护位置；Shell 固定引用具体提交。
Pay、私有项目文档、本机数据、上游参考检出和旧仓 Git 历史未导入。
macOS 实际安装、升级、恢复与人工验收必须单独完成。

## Community and license

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md),
[Governance](GOVERNANCE.md) and [Code of Conduct](CODE_OF_CONDUCT.md).
Apache-2.0; copyright and source provenance are retained in [NOTICE](NOTICE).
