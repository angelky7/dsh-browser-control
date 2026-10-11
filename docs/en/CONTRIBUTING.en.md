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
curl -s "https://api.github.com/repos/caob23/dsh-browser-control/releases?per_page=100" -o /tmp/releases.json
node verify/verify_release_links.mjs /tmp/releases.json
```

## Zipping the extension

Build it with Python `zipfile` or `tar`, and make sure the artifact **starts with `PK\x03\x04`** (no multipart preamble) and uses **forward slashes** in entry names. Windows Explorer only reads the file header, so 162 leading bytes of `------formdata-undici-…` make it refuse, while 7-Zip / `tar` / Python search for `PK` and tolerate it — that is how "one user cannot extract, another finds the zip intact" was simultaneously true (issue #2). After uploading, **download the asset back anonymously** and re-check the first 4 bytes, `unzip -t`, the separators, and ship a `.sha256` sidecar.

## Releasing

1. Sync versions: `package.json`, and `extension/manifest.json` whenever extension behaviour changed
2. Turn the `Unreleased` block of `CHANGELOG.md` into a real version heading
3. Tag, create the Release, keep the asset naming: `DSH-Browser-Control-vX.Y.Z.zip` (extension), `dsh-browser-control-plugin-vX.Y.Z.zip` (plugin)
4. **The offline plugin zip must contain `cordis.patch.yml`** — `package.json`'s `dsh.bundle.patch` points at it, and the v1.0.7 asset omitted it, so installing from that zip mounted nothing. The extension zip must carry every file under `extension/`, `icons/` included
5. Update the download links in README.md and README.en.md, then run the link audit above
6. **Put checksums in the release body, not in `.sha256` sidecar assets**: list file name / byte size / SHA-256 (MD5 too when useful) in the body, then download each asset back anonymously and re-check the first 4 bytes, `unzip -t` and the entry separators
7. `npm publish` (`files` excludes `verify/` and `extension/`; confirm `lib/` is current first). On the maintainer machine `~/.npmrc` defaults to the npmmirror read-only mirror, which cannot publish — `publishConfig.registry` now pins the official registry, do not rely on the CLI default

## Commit conventions

- One PR, one concern; split independent changes
- Commit messages in English: `feat: xxx` / `fix: xxx` / `docs: xxx`
- A `src/` change carries its rebuilt `lib/` in the same commit
- Issue fixes state the **measurement** (what was run, what came back), not just the conclusion

## Host-integration traps worth knowing

- `dsh-settings` changes surface by version: `0.1.2-rc.1` has `register`, while `0.1.7-rc.2` / `0.2.0-rc.2` export only `SettingsForms` (`configure/describe/update/replace/mutate`). No install needed to check: `npm pack @deepseek-ai/dsh-settings@<ver>` and grep.
- A schemastery schema *is* the validator: `Config(data)` returns the value with defaults applied; there is no `.parse()`.
- In cordis, `ctx.effect(execute, label)` treats the **return value of `execute`** as the disposer, so register one as `ctx.effect(() => dispose, 'label')`.
- **Nothing in the `@deepseek-ai/*` family has a stable release** (`latest` sits at `0.0.1-rc.1`; real versions live under `next`/`alpha`), and semver has a hard rule for prereleases: `0.2.0-rc.2` only matches a range that contains a comparator carrying a prerelease on the *same* `[major,minor,patch]` tuple. So loose-looking ranges such as `">=0.1.0-rc.1 <0.3.0-0"` match nothing at all — v1.0.8 shipped exactly that, which pinned the lockfile's host API to 0.1.0-rc.8 and made every typecheck validate against half-a-year-old types. **Three forms are allowed**: an exact pin (`0.2.0-rc.2`), a stable `~4.0.4` / `^3.18.4`, or those joined by `||`; `verify/verify_peers.mjs` rejects anything else.
- Host-injected packages (cordis / dsh-tools / dsh-settings / dsh-invariants) are **peers only**, pinned exactly to a host generation the way the official plugins do it, and retargeting those lines is a manual step when the host moves on (an older host still installs — pnpm only emits a peer warning). `@deepseek-ai/schemastery` is the opposite: it must be a `dependency`. The test is whether a second copy hurts — a second instance of a host package breaks service injection and tool registration, while a second schemastery is just another copy of a pure library.
- The token is the only real boundary; the loopback bind is not. Any change widening the HTTP face must consider `Origin` and `Host` together (WebSocket handshakes are not CORS-guarded).

## Reporting issues

Include: dsh version, Chrome/Edge version, the status page output (`http://127.0.0.1:9777/`), `netstat -ano | findstr :9777`, and the installed package version (`npm ls @caob23/dsh-browser-control`).

More notes and recorded findings: [verify/README.md](verify/README.md).
