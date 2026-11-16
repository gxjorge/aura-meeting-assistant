# Third-party notices

Aura's own code is released under the [MIT License](LICENSE). This repository also contains the third-party material below, which keeps its original license.

Runtime and build dependencies are installed from npm and are not redistributed here; each keeps its own license (see `package-lock.json`). Some of them, such as the GitHub Copilot CLI packages (`@github/copilot*`), are under their own terms rather than an open-source license, so check them before you use or redistribute Aura.

## Agent skills (`.agents/skills/`)

The `grill-me`, `prd-to-plan`, `tdd`, and `write-a-prd` skills come from [mattpocock/skills](https://github.com/mattpocock/skills) and are used under the MIT License:

```text
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Speech model (`src/renderer/public/vosk-model-small-en-us.tar.gz`)

This is `vosk-model-small-en-us-0.15` from [Alpha Cephei](https://alphacephei.com/vosk/models) (Copyright 2020 Alpha Cephei Inc), which the publisher lists under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
