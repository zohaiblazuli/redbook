# Redbook

Mod layer for College Board's [Bluebook](https://bluebook.collegeboard.org/) — the lockdown browser used for the digital SAT.

Redbook wraps the stock `app.asar` in a custom Electron launcher that disables security telemetry, neutralizes anti-tamper protections, restores clipboard access, and injects a developer console with an embedded AI assistant. The original binary is never modified; integrity checks pass because the signed asar remains byte-identical.

---

## What it does

**Security patch** — Intercepts and drops Bluebook's security dispatches (lockdown enforcement, process scanning, focus-loss reporting) and telemetry beacons. Suppresses DOM-level proctoring overlays. Blocks the sub-second clipboard wipe timer and restores Ctrl+C/V/X.

**AI overlay** — Opens Claude, Gemini, or ChatGPT in a stealth `WebContentsView` pinned inside the main window. The overlay is grayscaled, edge-faded, and background-matched to blend with the Bluebook UI. All provider branding, greetings, and sidebars are stripped. Panic-hide on backtick.

**Dev console** — Shadow DOM panel (Insert to toggle) with a full command set:

| Command | What it does |
|---|---|
| `/patch on\|off` | Arm or disarm the security patch |
| `/ai claude\|gemini\|chatgpt` | Load an AI provider (hidden by default) |
| `/kiosk on\|off` | Enter or exit kiosk mode |
| `/exam start\|stop\|save\|list` | Record and replay exam flows |
| `/exam spoof on\|off\|target N` | Rewrite exam dispatch event type codes |
| `/session save\|load\|list\|delete` | Snapshot and restore full browser state |
| `/theme redbook\|bluebook` | Switch visual theme |
| `/devtools` | Open Chromium DevTools |
| `/log` | Tail the runtime log |
| `/hide` | Panic-hide everything |

**Startup flow** — On launch, the console presents provider selection cards (with logos) and a Start button. Start auto-patches and loads the selected AI in the background. The AI panel stays hidden until toggled.

---

## Anti-tamper bypass

Bluebook ships with several self-protection layers. The launcher neutralizes each before the app's own code runs:

- **Self-healing callback** — The obfuscator's `selfHealingCallbackFunction` is frozen as a no-op via `Object.defineProperty` before `require()`. The obfuscator's assignment silently fails against the non-writable descriptor.
- **Signature verification** — `win-verify-signature` is stubbed to return `signed: true`. The real module expects a College Board-signed executable; we're running bare Electron.
- **Argv check** — Bluebook calls `app.exit(0)` if command-line args don't match its expected launch context. Both `app.exit` and `app.quit` are blocked during startup.
- **Window visibility** — Bluebook starts hidden and shows conditionally. The launcher forces `win.show()` on every `browser-window-created` event.

The `app.asar` is loaded from `resources/` unmodified. No patching, no repacking.

---

## File structure

```
_run.js                 Main Electron launcher (security bypass, AI overlay, IPC)
_run_safe.js            Bare-bones launcher (no mods, for debugging login)
mods/
  devpanel.js           Dev console (Shadow DOM, command system, startup flow)
  switcher.js           Theme application layer
  redbook.css           Dark theme stylesheet
  custom.css            User overrides
  sessions/             Saved browser state snapshots
  recordings/           Exam flow recordings
resources/
  app.asar              Stock Bluebook binary (not tracked in git)
media/                  Provider logos
analysis/               Extracted Bluebook source (reverse engineering reference)
Launch Bluebook.bat     Standard launch
Launch Bluebook (Safe Mode).bat
Launch Bluebook (No DevTools).bat
```

---

## Requirements

- **Windows** — Bluebook is Windows/Mac only; Redbook targets Windows.
- **Electron** — Matching the version Bluebook ships with (currently Electron 39, ia32). Install via `cd analysis && npm install`.
- **Bluebook** — A copy of `app.asar` from an installed Bluebook, placed in `resources/`.

---

## Setup

1. Install Bluebook normally, then copy `app.asar` from its install directory to `resources/`.
2. Install Electron: `cd analysis && npm install`
3. Launch: double-click `Launch Bluebook.bat`, or run `electron _run.js` from the repo root.
4. Press **Insert** to open the dev console. Press **backtick** to panic-hide.

---

## Hotkeys

| Key | Action |
|---|---|
| `Insert` or `Ctrl+Shift+D` | Toggle dev console |
| `` ` `` (backtick) | Panic hide (console + AI + toasts) |
| `Ctrl+Shift+G` | Toggle AI overlay visibility |

---

## Disclaimer

This project exists for educational and research purposes — specifically, to study how Electron-based lockdown browsers enforce their security model. It is not intended for use during actual College Board examinations. Violating College Board's terms of service can result in score cancellation and other consequences. Use at your own risk.
