# Changelog

## [2.4.0](https://github.com/mytab0r/Rotor-Cuda/compare/v2.3.1...v2.4.0) (2026-11-25)


### Features

* **admin:** sign in with a login and password ([#539](https://github.com/mytab0r/Rotor-Cuda/issues/539)) ([ea01a32](https://github.com/mytab0r/Rotor-Cuda/commit/ea01a327448a14910a9fd38a71f3f097bb3e1ee8))
* **wallet:** move long explanations behind disclosures (ROT-528) ([#540](https://github.com/mytab0r/Rotor-Cuda/issues/540)) ([4115357](https://github.com/mytab0r/Rotor-Cuda/commit/41153576eec991e14e3ca895090ff378425f84a4))
* **wallet:** TRON mainnet TRX and TRC-20 send ([#525](https://github.com/mytab0r/Rotor-Cuda/issues/525)) ([5809751](https://github.com/mytab0r/Rotor-Cuda/commit/5809751a996603fbc67de711b5c655cc535ef9b6))


### Bug Fixes

* **site:** render the landing directories as compact rows ([#542](https://github.com/mytab0r/Rotor-Cuda/issues/542)) ([b1d1062](https://github.com/mytab0r/Rotor-Cuda/commit/b1d10625522b4a2842eeddb496fcff73ec4f94b8))
* **site:** stop reserving dead space in the puzzle card ([#534](https://github.com/mytab0r/Rotor-Cuda/issues/534)) ([b39bd41](https://github.com/mytab0r/Rotor-Cuda/commit/b39bd4187f54dddf6d5a2ec15daf6f9399723736))
* **site:** trim the duplicated /key stats note ([#543](https://github.com/mytab0r/Rotor-Cuda/issues/543)) ([3eeba27](https://github.com/mytab0r/Rotor-Cuda/commit/3eeba271705123a7d54b8a3faeb6a8f17fed9fe7))


### Documentation

* add the human-readable changelog ([#535](https://github.com/mytab0r/Rotor-Cuda/issues/535)) ([a6ac537](https://github.com/mytab0r/Rotor-Cuda/commit/a6ac5371b9432adc1f18d107738d7455bfc22a53))

## [2.3.1](https://github.com/mytab0r/Rotor-Cuda/compare/v2.3.0...v2.3.1) (2026-11-24)


### Documentation

* **design-system:** rule for progressive disclosure on functional pages ([#531](https://github.com/mytab0r/Rotor-Cuda/issues/531)) ([eedf75d](https://github.com/mytab0r/Rotor-Cuda/commit/eedf75deb7f635f85e3832d0b695b6b7ed830c29))

## [2.3.0](https://github.com/mytab0r/Rotor-Cuda/compare/v2.2.1...v2.3.0) (2026-11-24)


### Features

* **process:** claim a task before editing it across sessions ([#524](https://github.com/mytab0r/Rotor-Cuda/issues/524)) ([425d08a](https://github.com/mytab0r/Rotor-Cuda/commit/425d08ab6b02aed32dc99522743c2f69e454aa37))


### Bug Fixes

* **board:** skip unchanged project fields in the sync and its dry run ([#529](https://github.com/mytab0r/Rotor-Cuda/issues/529)) ([31ff5a3](https://github.com/mytab0r/Rotor-Cuda/commit/31ff5a3d543c9b06860a0566ca796f06816d47f5))
* **ci:** never revert documentation in the mutation gate ([#530](https://github.com/mytab0r/Rotor-Cuda/issues/530)) ([fad08da](https://github.com/mytab0r/Rotor-Cuda/commit/fad08da532b7ecbcc7600521d2f0ec6f21189c53))

## [2.2.1](https://github.com/mytab0r/Rotor-Cuda/compare/v2.2.0...v2.2.1) (2026-11-24)


### Bug Fixes

* **board:** labels must not duplicate native or project fields ([#515](https://github.com/mytab0r/Rotor-Cuda/issues/515)) ([334ceb9](https://github.com/mytab0r/Rotor-Cuda/commit/334ceb9a84efe220b9361d48bc072795f0c44786))
* **board:** map wallet-swap to the wallet milestone ([#522](https://github.com/mytab0r/Rotor-Cuda/issues/522)) ([91d118f](https://github.com/mytab0r/Rotor-Cuda/commit/91d118f24a7f650ce08b6c4aa12c86b56879bfbf))


### Documentation

* **spec:** propose the wallet swap slice ([#517](https://github.com/mytab0r/Rotor-Cuda/issues/517)) ([48a8358](https://github.com/mytab0r/Rotor-Cuda/commit/48a8358d13b9440ea5f1b2f818466f07b8058ecb))

## [2.2.0](https://github.com/mytab0r/Rotor-Cuda/compare/v2.1.0...v2.2.0) (2026-11-24)


### Features

* **ops:** capture the product-split P0 baseline (ROT-487) ([#506](https://github.com/mytab0r/Rotor-Cuda/issues/506)) ([2686e59](https://github.com/mytab0r/Rotor-Cuda/commit/2686e59652c2413a87a78a02c64d2e60ec7f90f6))
* **web:** migrate /key to Astro with curated pages and a Pages worker ([#451](https://github.com/mytab0r/Rotor-Cuda/issues/451)) ([65eea06](https://github.com/mytab0r/Rotor-Cuda/commit/65eea061a4eb18127e0327fc81c32bad0edcfae7))


### Bug Fixes

* **audit:** settle fonts before measuring cell boxes ([#483](https://github.com/mytab0r/Rotor-Cuda/issues/483)) ([7360124](https://github.com/mytab0r/Rotor-Cuda/commit/73601242058176f5467459078ac31383b6523b45))
* **site:** preload the webfont on every site.css document (ROT-501) ([#502](https://github.com/mytab0r/Rotor-Cuda/issues/502)) ([f5941ae](https://github.com/mytab0r/Rotor-Cuda/commit/f5941ae2ecb112827f1e1a41d703de1907b33637))
* **site:** recover legacy link contrast and underlines (ROT-478) ([#500](https://github.com/mytab0r/Rotor-Cuda/issues/500)) ([3a8ca0b](https://github.com/mytab0r/Rotor-Cuda/commit/3a8ca0bc945574cc7fbe1ad7dc580bbea2f2a368))
* **web:** keep a11y overrides in the Astro shell only ([#484](https://github.com/mytab0r/Rotor-Cuda/issues/484)) ([c919dd9](https://github.com/mytab0r/Rotor-Cuda/commit/c919dd911f0baf8d0ba5ab98f1274c2132fc4b32))


### Code Refactoring

* **core:** extract rotor-core and make the wasm adapter depend on it ([#507](https://github.com/mytab0r/Rotor-Cuda/issues/507)) ([2e30339](https://github.com/mytab0r/Rotor-Cuda/commit/2e30339ecbe7ded71fbbc20d421c8fde6ffa0f4b))
* **core:** extract rotor-search shared planning crate (ROT-488) ([#508](https://github.com/mytab0r/Rotor-Cuda/issues/508)) ([082d006](https://github.com/mytab0r/Rotor-Cuda/commit/082d006ae944b3cb6c7aa4c05be2e91c4c017551))


### Documentation

* **spec:** product split architecture and migration order ([#480](https://github.com/mytab0r/Rotor-Cuda/issues/480)) ([1e41833](https://github.com/mytab0r/Rotor-Cuda/commit/1e41833994753de5fbcfe007cb6064cf37622ab5))


### Tests

* **audit:** pin mobile key-summary stacking (ROT-445) ([#499](https://github.com/mytab0r/Rotor-Cuda/issues/499)) ([0a4a75c](https://github.com/mytab0r/Rotor-Cuda/commit/0a4a75ce6a4c13e3c1929cbce2f55b44dceefbf3))
* **parity:** P0 baseline vectors for desktop and WASM cores ([#497](https://github.com/mytab0r/Rotor-Cuda/issues/497)) ([f3d3670](https://github.com/mytab0r/Rotor-Cuda/commit/f3d3670384deb016bc44ffd35335f76237e9b2f9))
* **web:** browser E2E, axe and visual regression gate ([#462](https://github.com/mytab0r/Rotor-Cuda/issues/462)) ([30072bf](https://github.com/mytab0r/Rotor-Cuda/commit/30072bf56867164758982ac8a6fa4eca07da3136))
* **web:** pin /key address-format scope in the browser (ROT-468) ([#477](https://github.com/mytab0r/Rotor-Cuda/issues/477)) ([fc0400a](https://github.com/mytab0r/Rotor-Cuda/commit/fc0400a718c8923326aa57297d89e0d56d01ab79))


### Miscellaneous Chores

* **ui:** persist the narrow cramped-padding exceptions for shared table pages ([#509](https://github.com/mytab0r/Rotor-Cuda/issues/509)) ([df37d3b](https://github.com/mytab0r/Rotor-Cuda/commit/df37d3b3c38ac4e2ec292aea951901cdbf2c9a32))

## [2.1.0](https://github.com/mytab0r/Rotor-Cuda/compare/v2.0.0...v2.1.0) (2026-11-24)


### Features

* **ci:** baseline gates - revert-fix, commitlint, gitleaks, links, budgets, SBOM ([#475](https://github.com/mytab0r/Rotor-Cuda/issues/475)) ([ef27a5d](https://github.com/mytab0r/Rotor-Cuda/commit/ef27a5d09f516b0aeb42c0cb22290f7669c2d084))
* **ops:** route security alerts into issues with lifecycle and escalation ([#464](https://github.com/mytab0r/Rotor-Cuda/issues/464)) ([819a101](https://github.com/mytab0r/Rotor-Cuda/commit/819a101e8e85f9b510900c5907ced8a5a9ce1816))
* **process:** mechanical verification contract and mutation gates ([#458](https://github.com/mytab0r/Rotor-Cuda/issues/458)) ([0b02e90](https://github.com/mytab0r/Rotor-Cuda/commit/0b02e90a88bed38251954477e4cfb1368c07576e))
* **process:** release, dependency and security automation ([#457](https://github.com/mytab0r/Rotor-Cuda/issues/457)) ([c820e74](https://github.com/mytab0r/Rotor-Cuda/commit/c820e745495e2b8d98bf76e6f9f79435a3ee955e))


### Bug Fixes

* **ops:** open the release PR with a PAT so checks start ([#474](https://github.com/mytab0r/Rotor-Cuda/issues/474)) ([10d8357](https://github.com/mytab0r/Rotor-Cuda/commit/10d83573d6a156284d5940f828e163116e893e60))
* **site:** scope the address-format selector to the selected chain ([#456](https://github.com/mytab0r/Rotor-Cuda/issues/456)) ([ecaa079](https://github.com/mytab0r/Rotor-Cuda/commit/ecaa07956cb4b6c8971608bedde9593dba92b36e))


### Tests

* **audit:** pin the /key address-format selector scope ([#471](https://github.com/mytab0r/Rotor-Cuda/issues/471)) ([2f1d498](https://github.com/mytab0r/Rotor-Cuda/commit/2f1d498796e66c02f1983778f8a5b487eb9f5a50))


### Miscellaneous Chores

* **process:** remove donor identities from the public tree ([#467](https://github.com/mytab0r/Rotor-Cuda/issues/467)) ([bb54491](https://github.com/mytab0r/Rotor-Cuda/commit/bb54491c34d0bb57505111caece8e2c590bb41bc))

## Changelog

All notable changes to this project are documented in this file.

The file is maintained by [release-please](https://github.com/googleapis/release-please)
from conventional commits on `main`; do not edit it by hand. See
[docs/process/releases.md](docs/process/releases.md) for the release flow.
