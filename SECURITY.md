# Security

Earshot is an early project. Only the latest source revision is maintained; there is no security backport or automatic update service.

Report vulnerabilities using [GitHub private vulnerability reporting](https://github.com/chasey-myagi/earshot/security/advisories/new). Include affected revision, reproduction steps, impact, and a synthetic example. Never include live keys, private recordings, or personal transcripts. If private reporting is unavailable, open a public issue asking for a private contact without publishing exploit details or sensitive data.

The application stores the DashScope key as a local plaintext file with mode `0600`, by design. Audio recognition and optional dictation polishing send data directly to the user's provider account. These boundaries and deletion behavior are documented in [privacy.md](docs/privacy.md).

Before a release, inspect dependency advisories, scan the tracked tree and Git history for credentials, verify runtime payloads, and run the checks in [CONTRIBUTING.md](CONTRIBUTING.md). A clean scan is not a guarantee that no vulnerability exists.
