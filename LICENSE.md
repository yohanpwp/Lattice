# License & Legal Notices

## Lattice License

MIT License

Copyright (c) 2026 Lattice Authors & Contributors

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

---

## Third-Party Software Notices & Acknowledgements

Lattice incorporates and builds upon third-party open source software. Upstream dependencies are managed through package managers (such as Go modules) without checking vendor source trees directly into the Git repository.

In accordance with their respective licensing terms, the upstream copyright notices, license texts, and repository links are documented below.

### 1. PocketBase

Lattice uses PocketBase as an embedded Go framework and backend foundation (imported via Go module `github.com/pocketbase/pocketbase`).

* **Project**: PocketBase
* **Website**: [https://pocketbase.io](https://pocketbase.io)
* **Repository**: [https://github.com/pocketbase/pocketbase](https://github.com/pocketbase/pocketbase)
* **Copyright**: (c) 2022 - present, Gani Georgiev
* **License**: MIT License
* **Upstream License URL**: [https://github.com/pocketbase/pocketbase/blob/master/LICENSE.md](https://github.com/pocketbase/pocketbase/blob/master/LICENSE.md)

#### PocketBase License Text:

```
The MIT License (MIT)
Copyright (c) 2022 - present, Gani Georgiev

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## Compliance and Distribution

1. **Embedded Notices**: Distribution binaries, web application bundles, mobile shells, and desktop packages must retain this notice and the PocketBase copyright attribution.
2. **Third-Party Dependencies**: All additional dependencies used across `packages/`, `apps/`, and `backend/` are tracked and audited via automated CI license scanning (`tools/`) against an approved license allowlist (rejecting incompatible copyleft licenses such as AGPL/GPL/BSL).
3. **Upstream Dependency Management**: PocketBase is imported directly as a Go module dependency. If modifications or patches are required in the future, they will be maintained in a separate repository fork and documented under `docs/patches.md`.
