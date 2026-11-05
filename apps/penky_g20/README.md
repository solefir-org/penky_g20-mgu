# Penky G20

Unofficial canvas client for the Penky game server on BMW iDrive 7. The source targets the `idrive7-apps` kit API and is not a standalone or installable package yet.

## Contents

- `app.json`, `main.js`, `game_logic.js`, `signalr.js`: application source.
- `icon.svg` is the original stump mark from Penky's web UI; `icon.png` is its 140x140 iDrive tile asset.
- `tests/`: local logic and SignalR Long Polling tests.
- `LICENSE`: Unlicense, matching the game project this client adapts.

The app is intended to be placed at `apps/penky_g20` in a working copy of `cauliflowermossgrape/idrive7-apps`. It uses that repository's `kit/runtime` and build pipeline; it does not vendor the kit or BMW SDK.

The `internet: true` app field needs the local `idrive7-apps` kit builder to emit `mguInternet: true` in the generated `source/package.json`; the unmodified upstream builder does not read this field. The current [`idrive-apps` linker](https://github.com/robertnisipeanu/idrive-apps/blob/main/tools/oap_link.js) also maps `internet: true` to `mguInternet: true`, but it expects that repository's separate `mgu-app.json` module-and-donor source format, so it is not a drop-in builder for this app. The client also needs an owner-provided server URL in the app's lobby settings.

## Local checks

From a kit checkout with this app under `apps/penky_g20`:

```sh
node kit/tools/test_penky.js
node kit/tools/test_penky_signalr.js
python3 kit/tools/build.py --preview-only penky_g20
```

Preview-only output is not installable. A full package needs the owner-extracted BMW `oap-sdk`; end-to-end server and in-car checks are still outstanding.