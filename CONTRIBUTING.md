# Contributing

Earshot is a small macOS recording and dictation app. Read [the product scope](PRODUCT.md) and [architecture](docs/architecture.md) before proposing a new subsystem. Keep cloud requests in the Electron main process and capture in Chromium. Prefer a focused fix over a new abstraction.

## Local workflow

Use an Apple Silicon Mac, Node.js 22.18 or newer, and `npm ci`. See [README](README.md) for the optional voiceprint model and local app build. Never put a real key in `.env`, source, fixtures, screenshots, or logs; enter it through the app settings only.

1. Create a focused branch and describe the expected behavior.
2. For a bug, provide a reproducible example and an appropriate regression check.
3. Run `npm run typecheck`, `npm test`, and `npm run build`.
4. Describe the change, actual test results, and anything still unverified in the pull request.

Tests use Node's built-in test runner and boundary substitutes. Keep tests about observable behavior. Hardware permissions, system audio, physical shortcut hold/release, window placement, and cross-app insertion require separate manual validation. A mocked green test does not prove them.

Do not commit recordings, credentials, model binaries, app bundles, local profiles, or raw personal transcripts. Use synthetic fixtures and relative paths in new QA evidence. Historical reports are evidence for their stated revisions, not the current product contract.

## Licensing

By submitting a contribution, you agree to license your contribution under the project's [MIT license](LICENSE). Preserve third-party notices and state the source and license of any new dependency, asset, or model. The repository's MIT license does not relicense third-party materials.

## Reporting problems

Use a minimal reproduction, macOS version, CPU architecture, app commit/version, and the exact visible result. Do not upload private meetings. Follow [SECURITY.md](SECURITY.md) for vulnerabilities.
