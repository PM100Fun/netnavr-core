# Contributing

Use Node.js 24+ and run `npm ci` and `npm run verify` before opening a PR.
Explain the user-visible problem, boundary, tests and remaining limitations.
Follow [the code of conduct](CODE_OF_CONDUCT.md).

Core owns runtime, identity, persistent data and its HTTP contracts. Shell owns
interaction and App packaging. Contract changes need explicit compatibility
review and the consuming Shell integration suite; breaking schema changes need
an upgrade and recovery plan. Pin source commits when validating a component pair.

Keep changes focused. Do not add internal planning documents, credentials,
databases, generated builds, payment code, or upstream reference checkouts.
Never substitute a technical test for human product acceptance. Contributions
use Apache-2.0. Discuss substantial architectural changes in an issue first.
