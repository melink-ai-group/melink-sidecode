# Changelog

All notable changes to sideCode are documented here. The project follows a simple versioned release history; earlier development builds were distributed as VSIX assets from the private repository.

## [0.3.4] - 2026-11-19

### Added

- First public release of the sideCode sidebar for VS Code and Open VSX hosts.
- One model picker across Ollama Cloud, Ollama Local, the OpenAI Codex CLI app-server, and OpenCode Zen.
- Agent, Plan, and Ask modes with a persisted per-thread mode and a plan file under `.melink/plans/`.
- Per-file **Keep** / **Reject**, conflict detection, native diff views, and restore checkpoints stored separately from Git.
- Post-turn typecheck/test checks, advisory diff review, styling consistency, and a no-model diagnostics sweep.
- Bounded project context with languages, tree, manifests, entry points, derived conventions, and an optional repo map.
- Opt-in browser tools, zvec-grep semantic search, and ast-grep structural search.
- Local Whisper dictation with a model cleanup pass.
- An inline settings screen for providers, CLI source, skills, defaults, and orchestration.

### Security

- Application-scoped trust keys so a workspace cannot redirect credentials or choose spawned binaries.
- Secret storage for Ollama Cloud and OpenCode Zen credentials.
- A destructive-command classifier with Ask and Block modes that runs before stored approval rules.
- Limited untrusted-workspace support and explicit confirmation before unrestricted mode.
- No network telemetry; an opt-in local missed-issue log with fixed, redacted fields.

### Documentation

- Public README with a feature overview, provider setup, privacy statement, and a dated comparison.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- GitHub issue and pull-request templates.

[0.3.4]: https://github.com/melink-ai-group/melink-sidecode/releases/tag/v0.3.4
