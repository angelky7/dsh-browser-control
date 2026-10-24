# Contributing

[简体中文](../../CONTRIBUTING.md)

## Repository shape

- `src/` is the plugin source, `extension/` is the MV3 extension. They do not depend on each other: the extension only dials the WebSocket.
- `lib/` is build output, but by convention it is **committed** so installing from GitHub needs no compiler. After touching `src/` you must rebuild and commit `lib/`, or the published package drifts from the source — v1.0.7 did exactly that: `src/` had 16 tools, the npm `lib/index.js` registered 11.

## Development workflow

```bash
npm install
npm run check     # tsc --noEmit + tsdown build + publint
npm run verify    # the harnesses under verify/, binds 127.0.0.1:9777
```

`npm run verify` covers: config resolution (which wins, the in-package patch or the schema default), `apply()` against three host shapes, HTTP authentication plus WebSocket upgrade origin, and the same behaviour of the **published artifact `lib/index.js`**. Every issue conclusion should be reproducible there; do not ship an inference as a measurement.

Extension-only changes do not touch `lib/`. Doc-only changes may skip both, but if you change a download link, audit it:

```bash
curl -s "https://api.github.com/repos/angelky7/dsh-browser-control/releases?per_page=100" -o /tmp/releases.json
node verify/verify_release_links.mjs /tmp/releases.json
```

## Zipping the extension

Build it with Python `zipfile` or `tar`, and make sure the artifact **starts with `PK\x03\x04`** (no multipart preamble) and uses **forward slashes** in entry names. Windows Explorer only reads the file header, so 162 leading bytes of `------formdata-undici-…` make it refuse, while 7-Zip / `tar` / Python search for `PK` and tolerate it — that is how "one user cannot extract, another finds the zip intact" was simultaneously true (issue #2). After uploading, **download the asset back anonymously** and re-check the first 4 bytes, `unzip -t`, the separators, and ship a `.sha256` sidecar.

## Releasing

1. Sync versions: `package.json`, and `extension/manifest.json` whenever extension behaviour changed
2. Turn the `Unreleased` block of `CHANGELOG.md` into a real version heading, and retarget the download links and `#vX.Y.Z` references in README.md / README.en.md
3. **`npm publish` first, tag and Release afterwards.** For 1.0.10 the Release went out before anyone checked the registry mirror, and users simply could not install it. On the maintainer machine `~/.npmrc` defaults to the npmmirror read-only mirror, which cannot publish — `publishConfig.registry` pins the official registry, so do not rely on the CLI default. `files` excludes `verify/` and `extension/`; confirm `lib/` is current first
4. **Wait for the mirror to catch up before announcing anything**: `dsh plugin add` pins the dependency to an **exact version**, and pnpm resolves it from the *user's* registry (for most Chinese users that is `registry.npmmirror.com`). If the mirror has not synced, the install dies with `ERR_PNPM_NO_MATCHING_VERSION`. Check both documents — `curl https://registry.npmjs.org/@angelky7%2F<pkg>` and `curl https://registry.npmmirror.com/@angelky7%2F<pkg>` — and only say "install X" once the version is there *and* `dist-tags.latest` moved
4b. **A second gate causes the same "cannot install" report for a different reason.** dsh profiles carry a 24-hour package-age supply-chain gate (measured: `minimumReleaseAge: 1440` in `node_modules/.pnpm-workspace-state-v1.json`). A version younger than that is rejected with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, and the message quotes `was published at …, within the minimumReleaseAge cutoff (…)`. **Discriminator**: `NO_MATCHING_VERSION` = the registry you are installing from does not have that version (mirror lag); `NO_MATURE_MATCHING_VERSION` = it does, but the release is too new — the only fix is waiting past the cutoff. Rule both out before announcing "install X", or a fresh publish will generate install-failure issues on day one.
5. Tag, create the Release, keep the asset naming: `DSH-Browser-Control-vX.Y.Z.zip` (extension), `dsh-browser-control-plugin-vX.Y.Z.zip` (plugin)
6. **The offline plugin zip must contain `cordis.patch.yml`** — `package.json`'s `dsh.bundle.patch` points at it, and the v1.0.7 asset omitted it, so installing from that zip mounted nothing. The extension zip must carry every file under `extension/`, `icons/` included
7. **Put checksums in the release body, not in `.sha256` sidecar assets**: list file name / byte size / SHA-256 (MD5 too when useful), then download each asset back anonymously and re-check the first 4 bytes, `unzip -t` and the entry separators; finish with `verify_release_links.mjs` so no document points at a missing asset
8. **Re-run the failed CI job after creating the Release** (`gh run rerun <id> --failed`): the link audit checks that every release download link in the docs exists, and there is always a few-minute gap between the push and the Release, so that step is guaranteed red until the assets are up — it happened for both 1.0.9 and 1.0.11 and is not an artifact problem

## Commit conventions

- One PR, one concern; split independent changes
- Commit messages in English: `feat: xxx` / `fix: xxx` / `docs: xxx`
- A `src/` change carries its rebuilt `lib/` in the same commit
- Issue fixes state the **measurement** (what was run, what came back), not just the conclusion

## Host-integration traps worth knowing

- `dsh-settings` changes surface by version: `0.1.2-rc.1` has `register`, while `0.1.7-rc.2` / `0.2.0-rc.2` export only `SettingsForms` (`configure/describe/update/replace/mutate`). No install needed to check: `npm pack @deepseek-ai/dsh-settings@<ver>` and grep.
- A schemastery schema *is* the validator: `Config(data)` returns the value with defaults applied; there is no `.parse()`.
- In cordis, `ctx.effect(execute, label)` treats the **return value of `execute`** as the disposer, so register one as `ctx.effect(() => dispose, 'label')`.
- **One peer range is read two different ways by two different consumers, and it has to satisfy both.** The host gate (`@deepseek-ai/dsh-app-boot`, measured at `lib/index.js:294-300`) only inspects peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`, and runs `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` against the **host version** — failing it throws (`:931`) and the whole plugin bundle is skipped unless the user grants `dsh plugin allow-version`. cordis and schemastery sit outside that name filter. The package manager (pnpm / npm, default semantics, **no** includePrerelease) matches against the **package's own version list**, and semver only admits a prerelease when the range carries a prerelease comparator on the *same* `[major,minor,patch]` tuple — while nothing in the `@deepseek-ai/dsh-*` family has a stable release (`latest` sits at `0.0.1-rc.1`; real versions live under `next`/`alpha`).
- The two traps point in opposite directions. A wide range such as `">=0.1.0-rc.1 <0.3.0-0"` passes every gate but the resolver maxes out at **0.1.0-rc.8** — v1.0.8 shipped that, which is why our own lockfile pinned months-old host types and every typecheck validated against them. An exact-only pin `"0.2.0-rc.2"` resolves correctly but makes the gate declare dsh 0.1.7 and 0.2.1 hosts incompatible. **The form that survives both is a union**: `0.2.0-rc.2 || >=0.1.0-rc.1 <0.3.0-0` — the exact branch anchors the resolver, the wide branch satisfies the gate. Measure both sides (`npm view "<pkg>@<range>" version`, and `satisfies(host, range, {includePrerelease:true})`); never eyeball a range.
- **Do not add `engines.node`.** No official dsh plugin declares it, the host owns the Node decision, and the gate never reads engines — keeping the field only hands `engine-strict` users one more way for our own package to refuse an install.
- Host-injected packages (cordis / dsh-tools / dsh-settings / dsh-invariants) are **peers only**, never simultaneously `dependencies`: a second copy of a host package breaks service injection and tool registration. `@deepseek-ai/schemastery` is the opposite — it must be a `dependency` (`~3.18.4`), which is what the official plugins do. When the host generation moves, retarget the exact anchor; `verify_peers.mjs` runs both consumers with the host's own semver and rejects a wrong move.
- The token is the only real boundary; the loopback bind is not. Any change widening the HTTP face must consider `Origin` and `Host` together (WebSocket handshakes are not CORS-guarded).
- **This machine's `npm config get registry` points at `registry.npmmirror.com`, which lags.** Any claim about whether a version exists on npm must come from the official registry: `npm view <pkg> versions --registry=https://registry.npmjs.org/`, or `curl https://registry.npmjs.org/<escaped-name>`. It burned once already: "1.0.9 was never published" was declared from mirror data while the official document had carried it since `2026-10-10T13:42:43Z`.

## Reporting issues

Include: dsh version, Chrome/Edge version, the status page output (`http://127.0.0.1:9777/`), `netstat -ano | findstr :9777`, and the installed package version (`npm ls @caob23/dsh-browser-control`).

More notes and recorded findings: [verify/README.md](verify/README.md).
