<p align="center"><img src="assets/earshot-icon.png" width="112" alt="Earshot icon"></p>

# Earshot

A small macOS app for meeting recordings and voice input. Your recordings stay on your Mac; transcription goes directly to DashScope with your own API key.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Privacy](docs/privacy.md) · [Contributing](CONTRIBUTING.md)

Earshot combines microphone and system audio recording, live and post-recording transcription, speaker naming, playback, and TXT/JSON export. Hold a shortcut to dictate into a text field, or review the result before inserting it. The interface is currently Chinese.

- **Record and revisit.** Read the full live transcript while recording continues. Reopen saved sessions, rename them, and jump from a timestamp to the original audio.
- **Remember speakers.** Cloud diarization separates speakers; naming a speaker can create a local voice embedding for later sessions. Matching is best effort.
- **Speak to type.** Streaming ASR with optional text polishing, safe insertion into supported text controls, and a copy fallback when the target changes.
- **Bring your own key.** No Earshot account or relay. Cloud processing requires a DashScope key and incurs provider charges. This is not an offline transcription app.

## Build and run

The supported development target is Apple Silicon macOS. Use Node.js 22.18 or newer and npm. Install Xcode Command Line Tools if a native dependency needs to compile. Intel Macs are not validated.

```sh
git clone https://github.com/chasey-myagi/earshot.git
cd earshot
npm ci
npm run fetch:voiceprint
npm run dev
```

The optional voiceprint model is downloaded from the sherpa-onnx project into ignored `models/`. Without it, recording, transcription, and manual speaker naming still work; automatic cross-session voice matching is unavailable.

For a local app bundle:

```sh
npm run package
open dist/Earshot.app
```

`npm run install:app` rebuilds and replaces `/Applications/Earshot.app`. Quit Earshot after stopping recordings before running it. Packaging uses a local Apple Development certificate when available, otherwise ad-hoc signing. This is a local build workflow; it does not notarize the app or create a distributable release.

## First use

Open Settings and save a Beijing DashScope API key. Meeting recording requires microphone and screen/system-audio permission. Dictation uses the microphone; inserting text into another app also requires Accessibility permission. macOS may request permissions again after a signing identity or app location changes.

| Default shortcut | Action |
| --- | --- |
| `⌃⌥R` | Start a recording or return to the current one |
| Hold `⌥Space` | Dictate; release to finish |

Shortcuts, insertion mode, ASR model, and optional polishing can be changed in Settings. Meeting recording and dictation cannot run at the same time. Dictation text is saved in the local library; its audio is held temporarily in memory. A failed or unsafe insertion keeps the result available to copy.

## Data and limitations

The API key is a **plaintext local file with mode `0600`**, not encrypted or stored in Keychain. Recordings, transcripts, names, and embeddings live under `~/Library/Application Support/Earshot/`. Audio is sent to DashScope for recognition; enabling dictation polishing also sends recognized text. Local deletion does not promise deletion of provider-side data. Read the [privacy and data-flow details](docs/privacy.md).

Earshot is an early macOS project. Automated tests cover application behavior with substitutes for OS and cloud boundaries. They do not prove permissions, physical shortcut hold/release, system audio capture, or cross-app insertion on your Mac. The [validation record](docs/validation.md) separates verified behavior from remaining manual checks.

## Development checks

```sh
npm run typecheck
npm test
npm run build
```

The [architecture](docs/architecture.md) and [implementation guide](docs/implementation.md) explain the main-process boundary, capture windows, provider calls, storage, and native dependencies. Further documentation is indexed in [docs](docs/README.md).

## License

Earshot source and project assets are provided under [MIT](LICENSE). Dependencies and the optional CAM++ model retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
