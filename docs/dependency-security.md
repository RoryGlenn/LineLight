# Dependency security posture

Last reviewed: 2026-08-08

LineLight treats dependency updates as part of the production build, even when
the affected package is primarily development tooling. CI installs from the
lockfile, audits the complete dependency graph at high severity, type-checks,
builds the Sites Worker, runs the test suite, and validates the packaged
artifact.

## August 2026 hardening

The pre-hardening lockfile reported 20 advisories: 13 high, 6 moderate, and 1
low. The hardening update moves direct dependencies to their compatible patched
releases, including:

- Next.js 16.2.12 and React Server Components 19.2.8;
- Vite 8.2.0;
- Cloudflare's Vite plugin 1.51.1 and Wrangler 4.120.0;
- patched transitive releases of brace-expansion, fast-uri, js-yaml, undici,
  and ws.

The current lockfile reports zero unapproved high or critical findings. Two
high-severity `image-size` 2.0.2 advisories are accepted only through verified
development-only paths: `GHSA-5P2G-FCMC-QVQQ` and
`GHSA-W3RX-R6R6-PGPR`. The exact package, version, advisory IDs, and dev-only
reachability are enforced by `scripts/audit-dependencies.mjs`; any production
path or new finding fails CI. This is a dated audit result, not a permanent
guarantee, so CI repeats the audit on every proposed change.

## Audited overrides

Three transitive packages need explicit overrides because an otherwise-current
parent package constrains them to an advisory-affected release:

- `postcss` 8.5.26 replaces Next.js's older 8.4.31 copy. It stays on PostCSS 8,
  and the production CSS build exercises the integration.
- `esbuild` 0.28.1 replaces the older copy used by Drizzle Kit's deprecated
  `@esbuild-kit` loader. `drizzle-kit check`, type checking, and the production
  build exercise this path.
- `sharp` 0.35.3 replaces the vulnerable 0.34 line required by
  `@huggingface/transformers` 3.8.1. Kokoro 1.2.1 requires Transformers 3.x, so
  moving LineLight to Transformers 4.x is not currently compatible.

Sharp 0.35 drops Node.js 18 and removes several deprecated image options.
LineLight requires Node.js 22.13 or newer, and Transformers 3.8.1 does not call
the removed options. The dependency-hardening regression test exercises the
actual Transformers adapter with Sharp 0.35.3: metadata decoding, raw pixels,
affine and Lanczos resizing, padding, cropping, PNG encoding, and decoding.

## Sharp production exposure

Offline narration runs Transformers and Kokoro in a browser Web Worker. That
path uses browser image primitives and audio inference; it does not invoke the
Node-only Sharp adapter. The production bundle retains an ignored Sharp module
stub because Transformers ships both browser and Node branches in one source
module, but no Sharp native addon, `@img` platform package, or libvips binary is
packaged in `dist`.

The artifact test enforces that boundary after every production build. Sharp is
still installed for Node-side development imports, so the adapter compatibility
test remains necessary until Kokoro accepts a Transformers release whose Sharp
range includes the patched line.

## Maintenance

When Kokoro or Transformers changes its supported dependency range:

1. remove the corresponding override in a dedicated dependency update;
2. regenerate the lockfile from a clean install;
3. rerun the audit, Drizzle check, type check, lint, production build, tests,
   and artifact validation;
4. keep the compatibility and artifact tests unless the Node adapter is no
   longer installed at all.
