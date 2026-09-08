<p align="center"><img src="assets/earshot-icon.png" width="112" alt="Earshot icon"></p>

# Earshot

A small macOS app for meeting recordings and voice input. Your recordings stay on your Mac; transcription goes directly to DashScope with your own API key.

[中文说明](README.zh-CN.md) · [Documentation](docs/README.md) · [Privacy](docs/privacy.md) · [Contributing](CONTRIBUTING.md)

Earshot combines microphone and system audio recording, live and post-recording transcription, speaker naming, playback, and TXT/JSON export. Hold a shortcut to dictate into a text field, or turn off automatic insertion and copy the result manually. The interface is currently Chinese.

- **Record and revisit.** Read the full live transcript while recording continues. Reopen saved sessions, rename them, and jump from a timestamp to the original audio.
- **Find and correct.** Search session titles, transcript text or speaker names locally. Correct one turn with undo and original text preserved; add timestamp bookmarks and listen at 0.75–2× speed. Import WAV, MP3 or M4A recordings up to 64 MiB and 30 minutes.
- **Remember speakers.** Cloud diarization separates speakers; naming a speaker can create a local voice embedding for later sessions. Matching is best effort.
- **Speak to type.** Streaming ASR with optional text polishing, one clipboard paste into the original input location, and a copy fallback when the target changes or the edit cannot be confirmed.
- **Reuse your vocabulary.** Save personal hotwords and inspect local model usage and estimated costs in Settings. Estimates are separate from provider billing; the inference API key cannot query your account balance.
- **Bring your own key.** No Earshot account or relay. Cloud processing requires a DashScope key and incurs provider charges. This is not an offline transcription app.

## Download and install

Download the [0.1.0 Apple Silicon preview](https://github.com/chasey-myagi/earshot/releases/tag/v0.1.0) for **macOS 26.4 or later**. This preview is development-signed and **not notarized**; Gatekeeper may require an explicit exception. Read the [installation guide](docs/install.md) before opening it. Download an Earshot binary asset, not GitHub’s automatically generated source archive. Only macOS 26.7 has been tested locally; other supported OS versions and a fresh Mac installation remain unverified.

## Build and run

The current packaged target is Apple Silicon, macOS 26.4 or later. Use Node.js 22.18 or newer and npm. Install Xcode Command Line Tools if a native dependency needs to compile. Intel Macs are not validated.

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

Closing the main window leaves Earshot available from the menu bar and global shortcuts. Use Quit to exit. Shortcuts, automatic insertion, ASR model, and optional polishing can be changed in Settings. Meeting recording and dictation cannot run at the same time. Dictation text is saved in the local library; its audio is held temporarily in memory. A failed or unsafe insertion keeps the result available to copy. Automatic insertion uses one temporary clipboard paste and never presses Enter. Earshot restores the previous clipboard only while it still owns that temporary content; a newer user copy is preserved. When the target cannot confirm the edit, the result stays visible for you to check. Turn off automatic insertion to copy results manually.

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
