# Design

## Decisions
1. Use upstream `Mehdi256/Rotor-Cuda` as base because it has native MSBuild/CUDA project and MIT license.
2. Treat Etayson/Collider as algorithmic reference only; do not translate PureBasic source mechanically.
3. Add `BSGS` as an explicit search mode, not implicit dual scheduling. This limits shared-state races and lets users run CPU and GPU jobs independently.
4. CPU and GPU BSGS share a versioned table manifest but can use different execution backends.
5. Sequential recovery is first-class: checkpoint contains mode, range, table identity, current giant-step position, and checksum. Random mode remains disabled or marked non-resumable until proven.
6. Filter selection is explicit (`bloom`, `binary-fuse`, `xor`) and table manifests record filter kind/version.
7. Hosted CI builds and CPU-tests. GPU smoke tests run only when `self-hosted`, `windows`, and `gpu` labels are present.

## Data layout
`filters/<coin>/<bits>/<range-id>/<filter-kind>/manifest.json` plus table/filter files. Existing paths are never overwritten; generation fails on collision unless an explicit new range-id is used.

## Build
The workflow uses Windows 2022, CUDA 12.x, MSVC v143, and a pinned GMP source/package. Project settings are patched or migrated explicitly because upstream references CUDA 10.2/v142.
