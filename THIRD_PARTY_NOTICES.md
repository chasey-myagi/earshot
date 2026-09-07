# Third-party notices

Earshot is MIT licensed. The components below retain their own licenses; the project license does not relicense them. Versions correspond to package-lock.json.

| Component | Version | License |
| --- | --- | --- |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| scheduler | 0.27.0 | MIT |
| sherpa-onnx-node | 1.13.6 | Apache-2.0 |
| sherpa-onnx-darwin-arm64 | 1.13.6 | Apache-2.0 |
| node-mac-permissions | 2.5.0 | MIT |
| koffi | 3.2.1 | MIT |
| bindings | 1.5.0 | MIT |
| node-addon-api | 7.1.1 | MIT |
| @koromix/koffi-darwin-arm64 | 3.2.1 | MIT |
| file-uri-to-path | 1.0.0 | MIT |

Full texts supplied by npm packages are in [licenses/npm.txt](licenses/npm.txt). Native package directories retain their own notices in app bundles.

## Electron and Chromium

Electron is MIT licensed; Chromium and its dependencies use multiple licenses. Packaging copies the installed Electron LICENSE and LICENSES.chromium.html into the app Resources directory. See [Electron licensing](https://github.com/electron/electron/blob/main/LICENSE).

## sherpa-onnx and ONNX Runtime

The sherpa-onnx runtime is Apache-2.0; see [upstream v1.13.6](https://github.com/k2-fsa/sherpa-onnx/tree/v1.13.6) and [license](licenses/sherpa-onnx.txt). Its packaged native runtime includes ONNX Runtime 1.27.1 (MIT); see [license](licenses/onnxruntime.txt) and [additional notices](licenses/onnxruntime-third-party.txt).

## Optional CAM++ model

`3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` is downloaded from the [sherpa-onnx speaker recognition release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models). Its [ModelScope source model](https://www.modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common) declares Apache License 2.0. The [3D-Speaker project](https://github.com/modelscope/3D-Speaker) provides the model implementation. The [Apache license](licenses/campplus.txt) applies independently of Earshot MIT. The download script pins the SHA-256 of the inspected ONNX artifact and rejects mismatches. Model weights are not committed to this repository; optional local packaging includes the downloaded weights and these notices.

## Project artwork

The Earshot icon in assets/ is a generated project asset selected for this application. It is included under the project MIT license. No third-party brand identity or endorsement is claimed.
