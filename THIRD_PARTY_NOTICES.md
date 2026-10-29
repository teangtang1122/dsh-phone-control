# Components and attribution

This repository packages the custom Android phone-control layer extracted from a local DSH + QQ bridge integration. It is a standalone MCP adaptation, not an official DSH, QQ, WeChat, scrcpy or Android product.

Only the phone-control JavaScript/Python source, tests and documentation are included. Upstream executables, model files and installed dependency directories are not redistributed in the source ZIP.

- Android Debug Bridge (ADB), Android Open Source Project: https://android.googlesource.com/platform/packages/modules/adb/
- Android SDK Platform-Tools downloads: https://developer.android.com/tools/releases/platform-tools
- scrcpy, Genymobile: https://github.com/Genymobile/scrcpy ; the optional clipboard protocol in this release is pinned to scrcpy 4.1: https://github.com/Genymobile/scrcpy/releases/tag/v4.1
- Model Context Protocol TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Zod: https://github.com/colinhacks/zod
- Pillow: https://github.com/python-pillow/Pillow
- RapidOCR: https://github.com/RapidAI/RapidOCR
- DSH / DeepSeek Harness: https://github.com/deepseek-ai/deepseek-harness

## scrcpy 4.1: Apache-2.0, not MIT

Upstream license: https://github.com/Genymobile/scrcpy/blob/v4.1/LICENSE

The unmodified upstream license, including its upstream copyright statements, is included as `LICENSES/scrcpy-4.1-Apache-2.0.txt`.

The JavaScript client in `src/android-phone-text.js` implements the clipboard control wire format described by the following upstream files:

- https://github.com/Genymobile/scrcpy/blob/v4.1/server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java
- https://github.com/Genymobile/scrcpy/blob/v4.1/server/src/main/java/com/genymobile/scrcpy/control/DeviceMessageWriter.java

It starts the user's separately obtained scrcpy server through ADB. This source release includes neither upstream Java source files nor scrcpy executables/server binaries. ADB handles screenshots, taps, swipes and app launching; the optional scrcpy server is used for verified Unicode clipboard input.

The MIT license covers this project's own wrapper contributions, not scrcpy or other third-party materials. Retain upstream licenses and applicable attribution when obtaining or redistributing those materials. If a later release vendors upstream source or binaries, review the applicable redistribution requirements and include the corresponding license/copyright/change notices and any applicable upstream NOTICE content.

Other externally installed components likewise retain their own licenses and notices. Downloaded SDK or executable bundles may contain additional third-party components with their own terms; the wrapper's MIT license does not replace them.
