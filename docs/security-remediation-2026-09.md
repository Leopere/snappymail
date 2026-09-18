# September 2026 source security remediation

The baseline is Jenkins `boompay-daily-security-report/5`, which scanned
`f1a998b18d1979afe57e9388f430de26d163b08b` on `master`. It reported 14 high
dependency vulnerabilities, two secret findings, four high configuration findings,
two tracked key paths, and seven missing ignore patterns.

## S/MIME keys

Certificate creation no longer signs identities with the private key shipped in
the source tree. It creates a self-signed end-entity certificate with the identity's
own key, following [PHP's OpenSSL API](https://www.php.net/manual/en/function.openssl-csr-sign.php).
New certificates have `CA:FALSE` and retain email protection and email address
extensions. Supplying an existing encrypted key preserves it during renewal.

The shared signing key and certificate, sample S/MIME key and certificate, and
embedded demo-account S/MIME credentials have been removed. The demo plugin no
longer replaces identity credentials with a public sample key. Regression tests
generate temporary keys and exercise generation, renewal, signature verification,
and encryption/decryption with real OpenSSL.

Existing account keys and certificates are not deleted or rewritten. Existing
mail still needs its original private key and certificate. Retain both when
replacing an old CA-issued certificate; the new self-signed certificate has a
different issuer and is not a substitute for the old recipient certificate.

The former bundled CA key is public in repository history and must not be trusted as an authority. Removing it from
the current tree does not remove historical copies. Accounts using the published
demo key should replace it for future mail while retaining the key and certificate
needed to read old mail. No account-level rotation is performed by this source change.

## Preventing new secret files

Git ignores `*.age`, `id_ed25519`, `id_rsa`, `*.pem`, `*.key`, `runtime/`, and
`secrets/`. Docker build contexts also exclude local environment files, keys,
runtime state, and crypto examples. Ignore rules do not untrack existing files;
the reported S/MIME key files are explicitly removed.

## Container configuration

The development PHP Dockerfile combines APT update and installation, avoids
recommended packages, clears package lists, and selects `www-data` at runtime.
A base-image probe started `php:7.4-fpm` as `www-data` and connected to its
FastCGI listener on port 9000. Dockerfile static validation also passed.
A fresh local Trivy scan found five high findings before these edits and two
afterward. The historical Jenkins report counted four; these are different scans.

The two remaining `DS002` findings are the production Dockerfile and its asset
overlay. Their startup currently needs root to initialize persistent-volume
ownership and managed configuration before starting services. They remain visible
without suppressions. Moving that startup to an unprivileged user requires a
separate change with fresh-volume, existing-volume, and service startup checks.

## Dependency scope

The reported lockfile findings belong to JavaScript build tooling. They are not
packages served as application code, but still matter on build machines.

The selected fixes keep the existing build tools and update their vulnerable
transitive dependencies: `brace-expansion` 1.1.18, `flatted` 3.4.2, `js-yaml`
3.15.2, `lodash` 4.18.1, and `tmp` 0.2.7. Lodash 4.18.0 is deprecated by its
publisher as a bad release, so it is skipped. The Flatted and tmp
overrides preserve the APIs used by ESLint's cache and editor dependencies.
The compatibility regression checks both ESLint cache generations, Flatted
serialization, editor temporary files, and rejection of non-string traversal
options. Verification now installs from the frozen lockfile on every run.

The supported Gulp build already uses `gulp-terser`. Removing the unused
`rollup-plugin-terser` dependency removes its vulnerable `serialize-javascript`
chain. The optional standalone Rollup recipe now names the maintained
`@rollup/plugin-terser` package and its Node 20+ requirement.

`image-size`, an optional Less dependency, has two high denial-of-service findings
with no patched release listed in the advisory data used here:
[CVE-2025-71329](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) and
[CVE-2025-71330](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr).
These findings remain visible. Limit builds to reviewed source and assets; do not
feed untrusted images to Less's image-sizing functions.

## Scan results

A fresh Trivy 0.68.2 scan with the September 18 vulnerability database reports
two high dependency findings and no critical findings, including development
dependencies. This resolves 12 of the original 14 high dependency findings.
The source secret scan reports no high or critical findings. The configuration
scan reports the two production root-user findings described above.

The original report's suggested tmp 0.2.6 has a separate path-traversal advisory.
The final lockfile uses 0.2.7, which also addresses
[CVE-2026-49982](https://github.com/raszi/node-tmp/security/advisories/GHSA-7c78-jf6q-g5cm).
No findings were suppressed.

## Verification environment

Host package installation failed when the execution environment denied removal
of newly created cache directories (`EPERM`). Dependency installation and the
repository checks therefore ran in an isolated container with Node 22, Yarn
1.22.22, PHP 8.4, and Chromium 152. The host's existing dependency directory was
not used to validate the upgrades.

The broader security suite exposed an existing empty-domain error in the IDN
wrapper: PHP threw for an address ending in `@`. The wrapper now rejects empty
domains before calling ICU, including empty wildcard domains. Regression cases
cover both ASCII and Unicode display conversion. The affected security suite was
rerun after this repair; the asset build and lint checks had already passed.

The S/MIME regression also creates a temporary CA-issued identity and verifies
that its stored certificate and private key still decrypt mail after discarding
the CA signing key. It does not substitute a new self-signed certificate for the
old recipient certificate.

Final checks passed:

- Frozen-lockfile dependency installation.
- Asset build and static browser-bundle continuity.
- JavaScript lint.
- Full `npm run test:security`, including S/MIME, sanitizer, IDN, mailbox,
  OpenPGP browser cryptography and legacy-mail interoperability, contacts, and
  offline Jenkins deployment contracts.
- Development Dockerfile static validation and an unprivileged PHP-FPM
  base-image startup probe.

The tested code, test files, manifest, and lockfile match the workspace byte for
byte. Production rollout and live acceptance are handled by the existing native
shipping and deployment hooks; these local checks do not establish deployment.

## Native deployment follow-up

The native delivery attempt created Jenkins build 21 for revision
`b12494a47ff792ff71bfd42b34513f459beb297c`. Monitoring rejected the build because
Jenkins advertises `https://jenkins.a250.ca` in metadata while the client sends
API requests to loopback. The client now accepts that exact advertised origin
with the expected job and build path. Authenticated requests remain on loopback;
other origins and paths still fail closed.

Regression coverage exercises new submissions, queued and running releases,
explicit monitoring resumption, and rejected metadata origins. A live bounded
resumption accepted build 21 and reached its waiting state. At that observation,
the build was queued behind `deploy-sign-boompay-ca #17` for `local-image-build`,
with no acceptance receipt. That build must release the shared lock before the
SnappyMail build can proceed. No release was resubmitted during diagnosis.

## Production acceptance

[Jenkins build 27](http://127.0.0.1:16155/job/deploy-snappymail-boompay-ca/27/)
succeeded on September 18 at 22:38 UTC. Its
[accepted receipt](http://127.0.0.1:16155/job/deploy-snappymail-boompay-ca/27/artifact/release/accepted.json)
binds both `mail.boompay.ca` and `mail.nixc.us` to source revision
`297fc8782a5090b53c7cf050fb46d2472f5e9720` and image
`ghcr.io/leopere/boompay-snappymail@sha256:5a3f1e0c2183e134cac2c1d088d19e7f5e36c69b8211cf520897376e47e2a099`.
Both runtime verifications and the cross-site OpenPGP acceptance test passed.
The release command returned exit code 0 after validating the archived receipt.

The trusted Jenkins build helpers now require the shared S/MIME key to be absent
from source and image. The previous Trivy exception is removed, and the old
key-containing Build 6 recovery is retired. The production image passed the
HIGH/CRITICAL scan and signature verification. This image result does not remove
the source-only findings documented above.

Deployment exposed two packaging issues. A classifier download failed during
one attempt; a subsequent Docker probe downloaded all six pinned assets and
verified their sizes and hashes. The release recipe now checks that packaging
produced an archive, since PHP previously returned success after Gulp failed.
The broad `data/` Docker exclusion also hid two public release templates. The
source exclusion now admits only `data/.htaccess` and `data/README.md`; the
trusted builder applies the same narrow compatibility rule to the published
revision. Docker context checks confirmed that runtime data and key fixtures
remain excluded. The Jenkins regression suite passed all 56 tests.

Independent HTTPS checks verified both branded roots, their configured manifests
and icons, and both WKD policy endpoints. The public `libs`, `app`, and `openpgp`
bundles on both sites matched the accepted image byte for byte.

The image still emits an OPcache `zend_jit_status` loading warning. The same
warning appears in the earlier successful Build 20; this rollout did not
introduce or resolve it.
