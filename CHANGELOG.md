# Changelog

## [0.3.0](https://github.com/ryanmazzolini/diffect/compare/v0.2.1...v0.3.0) (2026-08-31)


### Features

* add canonical local daemon ([9ad9115](https://github.com/ryanmazzolini/diffect/commit/9ad91157253ec8d9364cfa2f4ad92356e1ea1a7a))
* attach Pi to canonical daemon ([f85fa5f](https://github.com/ryanmazzolini/diffect/commit/f85fa5fb86b7bdc56cb176ffa43fd75b8b956655))
* **core:** add Herdr and cmux workspace providers ([4d94b2c](https://github.com/ryanmazzolini/diffect/commit/4d94b2c736c541eaa8ca24db3cc11c9ab12a9397))
* **core:** add workspace provider settings ([233b753](https://github.com/ryanmazzolini/diffect/commit/233b753ed4df04956cf78bb8c4734cf85e2e2c4b))
* **core:** canonicalize review scope identity ([96ac88a](https://github.com/ryanmazzolini/diffect/commit/96ac88aa69fd89ce15bfa99e51859024b3db3abd))
* **core:** discover open reviews ([f44f8c2](https://github.com/ryanmazzolini/diffect/commit/f44f8c23ca64d333ed885e014c3fd84cae291211))
* **core:** resolve workspaces from configured providers ([cb74a37](https://github.com/ryanmazzolini/diffect/commit/cb74a37f749e9409cf0d2918c5a745a971867c7d))
* **pi:** use daemon workspace resolution ([18072ba](https://github.com/ryanmazzolini/diffect/commit/18072ba53944050463e260bab9495ee3a6559b15))
* **web:** browse review comparisons ([d2e54e5](https://github.com/ryanmazzolini/diffect/commit/d2e54e5f77b966196b485f5ab43e7f69c434757f))
* **web:** load open reviews ([381a01d](https://github.com/ryanmazzolini/diffect/commit/381a01dde909a9b8659d24f4fdc8c100f29bd6ad))
* **web:** paginate comparison refs ([9d808ab](https://github.com/ryanmazzolini/diffect/commit/9d808abf507f629ab68724a5793ccff5b224f831))


### Bug Fixes

* **core:** honor native provider fallback and authentication ([00819f4](https://github.com/ryanmazzolini/diffect/commit/00819f44c107b9ecf98d77e25fff113cbe9d426c))
* **core:** keep test-named Pi session projects ([4a4141f](https://github.com/ryanmazzolini/diffect/commit/4a4141f16aea09aef6e091939ccf8c6001fbe9d1))
* **core:** match cmux sessions by transcript path ([e70a01b](https://github.com/ryanmazzolini/diffect/commit/e70a01b11f3cb41643d1e32a88c82662386a3b61))
* **pi:** allow replacing workspace bindings ([871ecc8](https://github.com/ryanmazzolini/diffect/commit/871ecc8a9c9cd9ca1f444eed02131dad4a17a6ac))
* **pi:** harden feedback watch integration ([7828c98](https://github.com/ryanmazzolini/diffect/commit/7828c98a86d38db4c459721896f4f1c3717ccbf0))
* recognize exited Linux daemon zombies ([957a2f2](https://github.com/ryanmazzolini/diffect/commit/957a2f2a1036734f345767120f8ff0e1afe17c4e))
* restrict Pi launcher discovery ([d7d1d9b](https://github.com/ryanmazzolini/diffect/commit/d7d1d9b27d5ca004813257cdef7fe4df537339f3))
* **web:** cancel deferred review selections ([edf9885](https://github.com/ryanmazzolini/diffect/commit/edf9885c1653b8746d4b1503719e132051ef90c4))
* **web:** keep review picker entry inert ([bb43069](https://github.com/ryanmazzolini/diffect/commit/bb430698c796d38288ecaeaa3571bd07bd4302e8))
* **web:** preserve native scrollbar intent during refresh ([8b57cec](https://github.com/ryanmazzolini/diffect/commit/8b57cec94b1e9df2f1c8033f71f107e18c3ddca1))
* **web:** stabilize split-view refresh anchoring ([27c783f](https://github.com/ryanmazzolini/diffect/commit/27c783fa15bd02b52632a622d6f0f34c5fe6813f))
* **web:** stabilize split-view refresh anchoring ([9250ea8](https://github.com/ryanmazzolini/diffect/commit/9250ea84b7dfb0c48b455426b0b65f117d7df470))


### Performance Improvements

* **ci:** cache Rust release dependencies ([1ae6e8f](https://github.com/ryanmazzolini/diffect/commit/1ae6e8fab1a2687e24b8adba95b720911c8ffb0e))


### Reverts

* separate split-refresh stabilization ([943da16](https://github.com/ryanmazzolini/diffect/commit/943da1612247ad05e11724c72e653c81410d2b51))

## [0.2.1](https://github.com/ryanmazzolini/diffect/compare/v0.2.0...v0.2.1) (2026-07-16)


### Bug Fixes

* set repository for release publishing ([6bfb24d](https://github.com/ryanmazzolini/diffect/commit/6bfb24df9732f2ef73f0d769dc6875647dea6f31))
* **web:** disable native diff scroll anchoring ([e38dec5](https://github.com/ryanmazzolini/diffect/commit/e38dec508002b21fa4ba2c03fbe0b5ae9df7f2bd))

## [0.2.0](https://github.com/ryanmazzolini/diffect/compare/v0.1.0...v0.2.0) (2026-07-15)


### Features

* publish desktop builds from GitHub releases ([0556960](https://github.com/ryanmazzolini/diffect/commit/0556960df98a3c35b3aee0f319244759d1a2b7e2))


### Bug Fixes

* **web:** anchor shared viewport during refresh ([8aaaeea](https://github.com/ryanmazzolini/diffect/commit/8aaaeeacd7404112bd4db08c4d8101eb239b1261))
* **web:** preserve reading position during live refresh ([d754f9d](https://github.com/ryanmazzolini/diffect/commit/d754f9d8588d288e68cc6a35d26e261907287324))
