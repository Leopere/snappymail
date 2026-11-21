## 2026-11-21 UTC · security-snappymail-deps-1120

Verified that canonical `Leopere/snappymail` `origin/master` started at `e5999b759b4b8c9ac7d483a300aebf226d41812e`. The dependency checkpoint `338fab17ab5b55673f5f43c8b2ae4353bac6064c` was normal-pushed and verified on the remote. This report is a separate checkpoint. Use the full verified report-checkpoint SHA from the job result for the Jenkins request.

The Yarn resolution advances `brace-expansion` from 1.1.18 to 1.1.21 within the existing `minimatch` range. This covers both assigned high advisories and the medium advisory on the same dependency. The lockfile advances PostCSS's existing `source-map-js@^1.2.1` resolution from 1.2.1 to 1.2.2 with no manifest override. Both lock entries use the published npm tarball and integrity metadata. The source checkpoint changes only `package.json` and `yarn.lock`.

### Dependency scan

Trivy 0.76.2 scanned pristine baseline and final snapshots containing only `package.json` and `yarn.lock`. Both used `trivy fs --skip-db-update --skip-java-db-update --offline-scan --scanners vuln --include-dev-deps --format json` with the same fresh schema 2 database, updated 2026-11-20 at 18:59:53 UTC. It analyzed 464 Yarn packages in each snapshot. The baseline had eight findings and the final had four. Raw reports and logs were kept private outside Git.

| Rule and package in `yarn.lock` | Target fingerprint | Baseline | First fix on this line | Final |
| --- | --- | --- | --- | --- |
| CVE-2026-102276 · brace-expansion | `3b90a843208fbc874b2b2355f2bd8a7be6ff68962bc7fdd8c7dfa9cabbab529f` | 1.1.18 · high | 1.1.19 | Absent at 1.1.21 |
| CVE-2026-102278 · brace-expansion | `e10080fdd09b255b2d01e6ea16b64cbdeabbef5c46d4726d5e4c2b6b85e1cda2` | 1.1.18 · high | 1.1.20 | Absent at 1.1.21 |
| CVE-2026-93749 · source-map-js | `a52db2aca1378d9ad8649735670f9d6ca87b288eee17d09ed4d38451d7855921` | 1.2.1 · high | 1.2.2 | Absent at 1.2.2 |
| CVE-2026-102277 · brace-expansion | Additional scan finding | 1.1.18 · medium | 1.1.21 | Absent at 1.1.21 |

The four remaining rule/package pairs were already present on `fast-uri@3.1.8` in `yarn.lock`. CVE-2026-110180 and CVE-2026-110306 are medium. CVE-2026-110095 and CVE-2026-110725 are low. Trivy lists 3.1.9 as the fix on the installed major line for all four. They are outside this dependency repair. There were zero new findings and zero final high or critical findings.

| Evidence bytes | Baseline SHA-256 | Final SHA-256 |
| --- | --- | --- |
| `package.json` | `503b054e72a74203851e6326a8d8f6a00371610047a948aa1c06aea7e31ab0db` | `60d7b7491d2d3c1951dd96b995d3e1f81427ac22f0cf87edc0eb12bf9b93a368` |
| `yarn.lock` | `8fc472d1d9e34f3479ab19c2b5ff5167ee5f753ec451c2448cc25dacf5b4c785` | `3ecbe9bab61cbd536798f00f10f70e89b89ba0acdb887bd5c4a77215fc1e58df` |
| Trivy vulnerability JSON | `bcaa38178a4297fd233605e8c75cfb46d74602ea531e94deb0574ac445760a5f` | `7623e85c8fcca5a05e3bc548518d943531e32455a213820323a1b6f45b63a7aa` |
| Trivy vulnerability DB | `1c7f2883070385e7540c75c0bb31bbb6840edc05c76785a3075ff49933028d56` | Same bytes |
| Trivy DB metadata | `3f76e3f17a29b64e016eb0fe5d0b8ffea6ba36a3be907bd353a17972c78cb736` | Same bytes |
| Sorted static asset and template hash manifest | `651b5fb729ea4ce5d556ce40fb3e5d7d6b7a9090f116eecdba61843a462de6bc` | Same bytes |

### Local verification and exposure

- `yarn install --frozen-lockfile --non-interactive` passed from clean baseline and final directories using the documented verification toolchain family, Node 22.23.5 and Yarn 1.22.22. The existing flatted and tmp cross-range warnings appeared during installation. A separate clean `yarn install --frozen-lockfile --non-interactive --offline` passed with Node 18.20.1 and the same Yarn on Linux/glibc, matching the Node version available to the Alpine 3.18 Jenkins builder. `npm ls brace-expansion source-map-js --all` confirmed only 1.1.21 and 1.2.2 on both final installs. The checked lock bytes survived installation.
- `./scripts/verify.sh` passed frozen install, `npm run test:static-build` including Gulp asset build and classifier integrity, and `npm run check`. The first security run stopped for missing Chromium libraries. After installing the libraries, the affected `npm run test:security` rerun passed dependency compatibility, supply-chain, S/MIME, and the other preceding contracts, then exited 1 at the IDN forced-ICU-failure fixture. On Ubuntu PHP 8.3.6 with ICU 74.2, the missing `ICU_DATA` path did not disable conversion. The exact IDN check reproduced this exit on the pristine baseline.
- Ran the remaining 20 `test:security` entries individually in manifest order. Nineteen passed, including the offline OpenPGP browser suite, the classifier asset checks, the release Dockerfile's three referenced security checks, and contacts. The static deployment contract passed. The sibling loopback-only deployment-flow mock failed on the baseline checkout before the first commit because it expected a hard-coded synthetic `bbbb…` revision after the existing wrapper derived the real Git revision. The wrapper and mock are identical between baseline and final.
- Ran the source Trivy invocation from `scripts/verify.sh` separately with the same frozen DB and JSON saved privately. Its fixable high/critical vulnerability and secret gate exited 0 with zero findings of either kind. Sanitized counts only. Raw JSON SHA-256 `c5ea90118ba75879742b8da76f1ad39163c0371b05e223830d0e1f257ac65262`.
- The README's broader `npm run test:ui` exited 127 because Docker is absent in the guest. This prevented the local Compose UI flow from starting. `git diff --check` passed.
- Both dependencies are reachable in the build graph even though their parents are listed under `dependencies`. `brace-expansion` is used via minimatch by the lint/build tooling and `source-map-js` via PostCSS by CSS processing. The release recipe installs the Node tree in the builder and copies the extracted webmail archive to the PHP runtime. The archive recipe selects the versioned app tree, and the local versioned app tree contained no package trees or lock inputs. Pristine baseline and final Gulp builds produced byte-identical sets of 130 static assets and templates. A file-name-only search found no affected package or characteristic module identifier in the local JS, CSS, HTML or maps, and no source-map files were emitted. This evidence supports build-time exposure and absence of those versions from the generated runtime assets. Jenkins still needs to verify the actual immutable image and deployed assets.

### Primary Jenkins handoff

Read `Leopere/jenkins-local` at `256aa3688ed6ec5f4d8c92b2ca3de9f6f3ad2133`, including `jobs/deploy-snappymail-boompay-ca.Jenkinsfile` (Git blob `04b34fe77fee4272dbfae807da5a20afb3f7eb5b`). The exact request is `POST /job/deploy-snappymail-boompay-ca/buildWithParameters` with `EXPECTED_REVISION` set to the final full pushed master SHA and `PUBLISHED_BUILD` blank. The latter is a recovery parameter reserved for its old Build #6. The tracked direct job has long stage timeouts. Primary must confirm the installed approved under-five-minute route and follow the exact downstream handles if it uses the Blackwell chain, including `verify-snappymail-blackwell-release` and `publish-snappymail-blackwell`.

Primary owns submission, release checks, signing, publication, activation and receipt verification. Require the exact source revision, signed `ghcr.io/leopere/boompay-snappymail@sha256:…` digest and verified runtime identity in the Jenkins artifacts, under-300-second job receipts, and paired live acceptance for `mail.boompay.ca` and `mail.nixc.us`. Live checks for this change are read-only login page, version, immutable asset and headers. If the installed pipeline cannot provide that contract within the stated scope, resolve it before activation. This checkpoint establishes source repair only.

security-snappymail-deps-1120: DONE 338fab17ab5b55673f5f43c8b2ae4353bac6064c
