# Third-party software notices

Popcorn is distributed under the license in [`LICENSE`](LICENSE). Components
incorporated into Popcorn remain subject to their own licenses.

## Tilion Fortress browser engine

The `browser-runtime` image redistributes the `/opt/tilion` binary bundle from
the Tilion Fortress OCI image. The build uses the immutable source image digest
recorded by `FORTRESS_IMAGE` in
[`images/minimal-vnc-desktop/Dockerfile`](images/minimal-vnc-desktop/Dockerfile).

Fortress patches, build tooling, packaging, and documentation are licensed
under BSD-3-Clause. The patched Chromium engine remains under Chromium's
BSD-3-Clause license and the licenses of its third-party components. Fortress's
bundled, renamed open-source fonts remain under their upstream font licenses.

The notices shipped with every Popcorn browser-runtime image are retained here:

- [Fortress BSD-3-Clause license](images/minimal-vnc-desktop/third-party/fortress/LICENSE)
- [Fortress upstream notice](images/minimal-vnc-desktop/third-party/fortress/NOTICE)
- [Chromium BSD-3-Clause license](images/minimal-vnc-desktop/third-party/fortress/CHROMIUM-LICENSE)
- [SIL Open Font License 1.1](images/minimal-vnc-desktop/third-party/fortress/OFL-1.1.txt)

The pinned browser bundle was published for Fortress
[`v149.0.7827.232`](https://github.com/tiliondev/fortress/tree/v149.0.7827.232);
the corresponding patches and build tooling are available at that tag.
Chromium source and third-party license information are available from the
[Chromium 149.0.7827.232 source tree](https://chromium.googlesource.com/chromium/src/+/refs/tags/149.0.7827.232).

Neither Tilion, the Fortress copyright holder, Chromium contributors, nor font
authors endorse Popcorn. Their names are used only for attribution.
