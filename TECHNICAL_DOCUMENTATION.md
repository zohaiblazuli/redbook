# Redbook — Technical Documentation

> Internal reference for the Redbook mod layer sitting on top of College Board's Bluebook (Electron 39, ia32).
> Last updated: 2026-06-12

---

## Table of Contents

1. [Anti-Tamper Bypass](#1-anti-tamper-bypass)
2. [Mod Injection Pipeline](#2-mod-injection-pipeline)
3. [Exam Flow — What Happens During a Real Test](#3-exam-flow--what-happens-during-a-real-test)
4. [Security Detection Surface](#4-security-detection-surface)
5. [Exam Recorder](#5-exam-recorder)
6. [Dispatch & Fetch Spoofer](#6-dispatch--fetch-spoofer)
7. [IPC System](#7-ipc-system)
8. [Bridge API Catalog](#8-bridge-api-catalog)

---

## 1. Anti-Tamper Bypass

Bluebook ships with multiple layers of self-protection. The launcher (`_run.js`) neutralizes each one before the app's own `main/index.js` runs. The app's `app.asar` is never modified — the binary on disk still matches the publisher's signed bytes, so Bluebook's own integrity check passes naturally.

### 1.1 Self-Healing Callback Lock

**What it is:** Bluebook's bundled JavaScript is processed by an obfuscator (javascript-obfuscator / similar) that embeds a "self-defending" function. This function is assigned to `global.selfHealingCallbackFunction` and, when invoked, detects if the code has been tampered with (reformatted, hooked, or modified at runtime). If tampering is detected, it loops indefinitely or crashes the process.

**How we bypass it:**

```javascript
Object.defineProperty(global, 'selfHealingCallbackFunction', {
  value: function selfHealingCallbackFunction() {},
  writable: false,
  configurable: false,
  enumerable: false,
});
```

Before Bluebook's code loads, we lock `selfHealingCallbackFunction` as a frozen no-op on the global object. The property is non-writable and non-configurable, so when the obfuscator tries to assign its real self-defending function, the assignment silently fails (strict mode would throw, but the obfuscated code runs in sloppy mode). The self-defending check runs the no-op instead of the real detector, and nothing triggers.

**Why this works:** `Object.defineProperty` with `writable: false` wins over simple assignment. The obfuscator assigns via `global.selfHealingCallbackFunction = function() { ... }` which is a plain assignment — it cannot override a non-writable property descriptor.

### 1.2 Signature Verification Stub

**What it is:** Bluebook uses the `win-verify-signature` native module to verify that the executable is signed by "The College Board". Since we're launching via a bare `node.exe` / `electron.exe` that isn't signed by CB, this check would fail and block startup.

**How we bypass it:**

```javascript
const origLoad = Module._load;
Module._load = function(req, parent, isMain) {
  if (req === 'win-verify-signature') {
    return {
      verifySignatureByPublishName(filePath, publisherName) {
        const name = (publisherName && publisherName[0]) || 'The College Board';
        return { signed: true, subject: 'CN=' + name };
      }
    };
  }
  return origLoad.apply(this, arguments);
};
```

We intercept Node's `Module._load` (the function that backs `require()`). When any code in the process tries to `require('win-verify-signature')`, we return a fake module whose `verifySignatureByPublishName()` always returns `{ signed: true }`. The real native module is never loaded.

**Why this works:** `Module._load` is the single chokepoint for all `require()` calls. By intercepting it before Bluebook's code runs, every signature check in the entire app hits our stub.

### 1.3 Exit/Quit Blocking

**What it is:** Bluebook's startup code checks `process.argv` and various environment conditions. If it doesn't like what it sees (wrong binary name, missing flags, unexpected environment), it calls `process.exit()`, `app.exit()`, or `app.quit()` to kill itself.

**How we bypass it:**

```javascript
let _allowExit = false;
process.exit = (code) => {
  if (_allowExit) return require('process').reallyExit(code);
  log('[blocked] process.exit(' + code + ')');
};
app.exit  = (code) => { if (_allowExit) return; log('[blocked] app.exit(' + code + ')'); };
app.quit  = ()     => { if (_allowExit) return; log('[blocked] app.quit()'); };
dialog.showErrorBox = (title, content) => { log('SUPPRESSED dialog:', title, '|', content); };
```

All exit paths are replaced with logging stubs. The `_allowExit` flag is only set to `true` when *we* deliberately relaunch the app (via the `/relaunch` command). Error dialogs are also suppressed so they don't interrupt the flow.

An uncaught exception handler catches anything Bluebook throws during startup and logs it instead of crashing:

```javascript
process.on('uncaughtException', (e) => log('UNCAUGHT', e && e.stack || e));
```

### 1.4 Window Visibility Force

**What it is:** Bluebook creates its BrowserWindow in a hidden state and only shows it after its own initialization sequence completes. Since our launcher modifies the startup flow, the window sometimes never gets its show signal.

**How we bypass it:**

```javascript
app.on('browser-window-created', (e, win) => {
  setTimeout(() => { win.show(); win.focus(); }, 50);
});
```

Every time Electron creates a BrowserWindow, we force it visible after a 50ms delay. The `ready-to-show` event also triggers a `win.show()` as a fallback.

---

## 2. Mod Injection Pipeline

### How Mods Get Into the Renderer

The launcher reads three files from disk on every page load:

| File | Purpose |
|------|---------|
| `mods/redbook.css` | Theme overrides (Redbook visual skin) |
| `mods/switcher.js` | Theme application layer (text replacement, wordmark overlay, MutationObserver) |
| `mods/devpanel.js` | Console window, recorder, spoofer, security watcher, IPC client |

These are bundled into a single IIFE (Immediately Invoked Function Expression):

```javascript
(()=>{
  const __RB_CSS   = "...";   // redbook.css as a string
  const __RB_FLAGS = {...};   // { sentryDebug, noCheckin }
  // switcher.js code
  // devpanel.js code
})();
```

The bundle is injected via `win.webContents.executeJavaScript(bundle, true)` on three Electron events:

| Event | When It Fires |
|-------|---------------|
| `did-finish-load` | After initial page load completes |
| `did-navigate` | After full-page navigation |
| `did-navigate-in-page` | After SPA-style in-page navigation (history pushState) |

This triple-hook ensures mods survive Bluebook's React router navigations and full page reloads. Both `switcher.js` and `devpanel.js` are idempotent — they check `window.__redbookSwitcherInstalled` and `window.__rbDevPanelInstalled` flags to avoid double-initialization.

### Shadow DOM Isolation

The console window and toast notifications each mount their own shadow host directly under `<html>`:

- `redbook-console-host` — the floating TUI console
- `redbook-toasts-host` — bottom-left detection toast stack

Shadow DOM prevents Bluebook's React app, its CSS, and its MutationObservers from interfering with our UI. Conversely, our styles don't bleed into the test interface.

---

## 3. Exam Flow — What Happens During a Real Test

This section is based on data captured by the exam recorder across multiple recording sessions (practice tests with and without dispatch spoofing).

### 3.1 Exam Types (asmtEventTypeCd)

The server assigns each exam an `asmtEventTypeCd` integer that controls the entire security stack:

| Code | Type | Security Level |
|------|------|----------------|
| 1 | OPERATIONAL | Full lockdown — kiosk, all detections active |
| 2 | PILOT_IN_SCHOOL | Full lockdown |
| 3 | PILOT_WEEKEND | Reduced lockdown |
| 4 | ABBREVIATED_PRACTICE | No lockdown — practice tests |

This field arrives inside the `registrations/ADD_REGISTRATION` Redux action payload at `payload.registration.event.asmtEventTypeCd`.

### 3.2 Redux Action Flow During an Exam

The Redux store processes a specific sequence of saga actions during exam startup and execution. These were captured via dispatch interception:

**Startup phase:**

| Action Type | Purpose |
|-------------|---------|
| `registrations/ADD_REGISTRATION` | Loads exam registration data (contains `asmtEventTypeCd`, credentials, `regNumber`) |
| `checkin-setup-info/LOAD_CHECKIN_SETUP_INFO` | Loads check-in configuration |
| `exam-player/LOAD_MANIFEST_SUCCESS` | Loads the exam content manifest (carries `waiting-room-start` step) |
| `test-status/SET_TEST_STATUS` | Sets the current test phase |

**During the exam:**

| Action Type | Purpose |
|-------------|---------|
| `exam-player/RECORD_EXAM_UNIT_PULSE` | Heartbeat — fires every 5 seconds during active test-taking |
| `exam-player/SET_CURRENT_STEP` | Tracks which question/section the student is on |
| `exam-player/SAVE_ANSWER` | Records answer submission |
| `test-status/UPDATE_TEST_STATUS` | Phase transitions (waiting room → section 1 → break → section 2 → complete) |

### 3.3 Kiosk Mode — What Triggers It and What Doesn't

**Full kiosk mode requires ALL of these conditions (server-gated):**

1. `asmtEventTypeCd` is 1 (OPERATIONAL) or 2 (PILOT_IN_SCHOOL)
2. `examCheckinInfo.credentials.sessionToken` is a valid server-issued STS token (non-empty string)
3. `regNumber` is non-null
4. The `id` field has the correct prefix format

**What we confirmed through spoofing experiments:**

We successfully rewrote `asmtEventTypeCd` from 4 (practice) to 1 (operational) at the Redux dispatch level. The recording confirmed the rewrite happened (`dispatchRewriteCount: 1, before: 4, after: 1`). However, **kiosk mode still did not engage** because the saga also checks `examCheckinInfo.credentials.sessionToken`, which is an empty string for practice tests. The token is server-issued and cannot be faked client-side without a valid exam session from College Board's servers.

**Manual kiosk** can still be triggered via `enterKioskMode()` on the bridge object (accessible through `/security kiosk on` in the console). This engages the visual lockdown (fullscreen, non-minimizable, empty menu bar) but without the security polling stack that a real operational exam would run.

### 3.4 What the Server-Side Flow Looks Like

From our fetch recordings during practice tests:

1. **GraphQL queries** to `api.cb.org` fetch registration data, exam manifests, and check-in info
2. **Heartbeat pulses** POST to the server every 5 seconds during active exam sections
3. **Answer submissions** are batched and synced via GraphQL mutations
4. **The waiting room** is a server-controlled step — `LOAD_MANIFEST_SUCCESS` carries a `waiting-room-start` step that gates the student until the proctor releases the exam

### 3.5 Recording Session Summary

| Recording | Type | Events | Dispatch | Bridge | Key Finding |
|-----------|------|--------|----------|--------|-------------|
| `baseline_practice` | Practice (code 4) | 393 | 0 | 0 | No security events fire for practice |
| `baseline_homepage_to_practice` | Navigation capture | — | — | — | SPA routing captured |
| `spoofed_to_operational` | Spoofed (4→1) | — | Yes | — | Rewrite confirmed, kiosk blocked by empty token |
| `recording_new` | Spoofed (4→1) | 295 | 56 | 2 | 1 dispatch rewrite confirmed, 22/22 bridge methods tapped |

---

## 4. Security Detection Surface

Bluebook's bridge exposes 10 security event channels. During an **operational exam** (asmtEventTypeCd 1), the native layer actively polls for these conditions and fires callbacks into the renderer. During **practice tests** (asmtEventTypeCd 4), these channels exist on the bridge but the native layer never fires them.

### 4.1 All Detection Channels

| Channel | Severity | What It Detects |
|---------|----------|-----------------|
| `onGrammarlyDetected` | warn | Grammarly browser extension or desktop app is running. Detected via process enumeration and browser extension scanning. |
| `onRestrictedAppsReceived` | warn | List of restricted applications currently running on the system. Includes screen recorders, remote access tools, virtual machines, and other prohibited software. The payload is an array of app names. Fires after `requestRestrictedApps()` is called. |
| `onSecurityViolationDetected` | err | Generic security violation — catch-all for policy breaches that don't fit a specific channel. |
| `onDebuggerDetected` | err | A debugger is attached to the process. Detected via native-level anti-debug techniques (timing checks, `IsDebuggerPresent`, debug registers). **Important:** Bluebook has cumulative debugger detection — repeated DevTools opens during a session will eventually disable the login flow. |
| `onVirtualMachineDetected` | err | The app is running inside a confirmed virtual machine (VMware, VirtualBox, Hyper-V, QEMU, etc.). Detected via CPUID leaf checks, registry keys, MAC address prefixes, and known VM artifact files. |
| `onVirtualMachineSuspected` | warn | VM indicators are present but not conclusive. Weaker signals like certain BIOS strings or driver names that correlate with but don't confirm VM usage. |
| `onRemoteDesktopConnectionDetected` | err | An active remote desktop session (RDP, TeamViewer, AnyDesk, etc.) is detected. Would allow a remote operator to view or control the exam. |
| `onLockdownNewProcess` | warn | A new process was spawned after kiosk mode engaged. During lockdown, process creation is monitored — any new process is flagged as a potential unauthorized tool. |
| `onLockdownWindowResized` | warn | The exam window was resized during kiosk lockdown. In kiosk mode the window should be fullscreen and immovable. A resize event indicates something forced the window size to change. |
| `onWindowFocusChanged` | — | The exam window lost or gained focus. Fires on alt-tab, clicking outside the window, or another application stealing focus. During operational exams, focus loss is logged and may trigger a security incident. |
| `onHModStatus` | warn | Hardware modification status — relates to system integrity checks at the hardware/firmware level. |
| `onLowBattery` | ok | Device battery is critically low. Not a security threat per se, but logged because a sudden shutdown during an exam could corrupt the test session. |
| `onKeyboardLayoutChanged` | — | The keyboard layout/language was switched during the exam. Monitored because layout switching could be used to input characters not available on the expected keyboard. |
| `onSegmentUpdateSuccess` | — | Segment (analytics/telemetry) data was successfully uploaded. Internal telemetry event. |

### 4.2 Active Security Methods

These are callable actions, not event listeners:

| Method | What It Does |
|--------|--------------|
| `performSecurityCheck({})` | Triggers a full security sweep. The native layer scans for all detectable conditions and fires the appropriate `on*` callbacks with results. |
| `requestRestrictedApps()` | Specifically requests the list of currently running restricted applications. Results arrive via `onRestrictedAppsReceived`. |
| `terminateGrammarly()` | Force-kills the Grammarly process. Bluebook does this automatically during operational exams but the bridge method can be called manually. |
| `clearClipboard()` | Wipes the system clipboard. Prevents pasting external content into exam fields. |
| `unlockAccountAsStudent()` | Unlocks a student account that has been locked by a proctor or by the system due to a security violation. |
| `enterKioskMode()` | Forces the app into kiosk mode: fullscreen, non-minimizable, menu bar emptied, focus enforcement. |
| `exitKioskMode()` | Exits kiosk mode back to normal windowed operation. |

### 4.3 How We Monitor Detections

The `installSecurityWatch()` function in `devpanel.js` hooks all 10 `on*` channels by calling each method on the bridge object and registering a callback. When any channel fires:

1. A toast notification slides in from the bottom-left of the screen (outside the shadow DOM, visible even during fullscreen kiosk)
2. The toast shows: severity tag (`[!]`), channel name, event payload preview, and timestamp
3. Toasts auto-dismiss after 8 seconds or on click
4. Up to 5 toasts can stack simultaneously

The watcher retries every 500ms for up to 30 seconds on startup, because the bridge object isn't always immediately available after page load.

### 4.4 What's Detectable vs. Not

**Detectable (fires an event during operational exams):**
- Grammarly (extension or desktop app)
- Any app on College Board's restricted app list
- Debugger attachment (DevTools, x64dbg, etc.)
- Virtual machines (VMware, VirtualBox, Hyper-V, QEMU)
- Remote desktop connections (RDP, TeamViewer, AnyDesk)
- New processes launched after lockdown
- Window focus changes (alt-tab)
- Window resize during kiosk
- Low battery

**Not detectable by the bridge (would require separate instrumentation):**
- Physical notes or reference materials
- A second physical monitor (unless via remote desktop)
- Phone-based cheating tools
- Content in the clipboard before `clearClipboard()` is called
- Browser extensions that don't inject into the Electron process

---

## 5. Exam Recorder

The recorder (`installRecorder()`) wraps 10 subsystems to capture everything that happens during an exam session. It produces a JSON recording file containing timestamped events with category tags.

### 5.1 What Gets Recorded

| Subsystem | What's Captured | Event Categories |
|-----------|----------------|-----------------|
| **fetch** | Every HTTP request: URL, method, body preview (2000 chars), response status, duration. GraphQL operations are identified by name. | `fetch` |
| **XMLHttpRequest** | Same as fetch but for XHR-based requests. Method, URL, body, status, duration. | `fetch` |
| **WebSocket** | Connection URL, every message sent/received (800 char cap), close events, errors. | `ws` |
| **Redux dispatch** | Every Redux action: type and full payload. This is the richest data source — captures exam state transitions, answer submissions, heartbeats, and saga flows. | `dispatch` |
| **Bridge events** | All `on*` callbacks: event name and arguments. All outbound bridge method calls: method name, arguments, return value. | `bridge` |
| **ipcRenderer** | All Electron IPC: channel name and arguments for `.on()`, `.invoke()`, and `.send()`. | `ipc` |
| **console** | `console.log/warn/error/info` calls, filtered to exclude Redbook's own output (messages starting with `[redbook]` or `<<RB_IPC>>`). | `console` |
| **window events** | focus, blur, visibilitychange, resize, pagehide, pageshow, beforeunload, online, offline. Includes visibility state, focus status, and window/screen dimensions. | `window` |
| **DOM mutations** | MutationObserver watching for elements with IDs or classes containing: `exam`, `kiosk`, `lockdown`, `waiting`, `security`, `proctor`, `fullscreen`, `warn`, `violation`. Captures tag name, ID, test ID, and class list. | `dom` |
| **Storage writes** | Every `localStorage.setItem` and `sessionStorage.setItem` call: key and value preview (200 chars). | `storage` |

### 5.2 Recording Output Format

```json
{
  "meta": {
    "startedAt": "2026-06-11T18:05:11.736Z",
    "url": "app://dap-electron.collegeboard.org/takeexam/...",
    "eventCount": 295,
    "categories": { "fetch": 38, "dispatch": 56, "bridge": 2, ... },
    "spoof": { "enabled": true, "targetEventTypeCd": 1, "dispatchRewriteCount": 1, ... },
    "flags": { "storeStatus": "attached", "bridgeStatus": "tapped 22 on* methods", ... }
  },
  "events": [
    { "t": 0.1, "cat": "window", "type": "@@RB/recording-start", "data": { ... } },
    { "t": 54321, "cat": "dispatch", "type": "registrations/ADD_REGISTRATION", "data": { ... } },
    ...
  ]
}
```

Each event has:
- `t` — milliseconds since recording start
- `cat` — category (fetch, dispatch, bridge, etc.)
- `type` — event type (action name, method name, event name)
- `data` — payload (object, varies per event type)

### 5.3 Redux Store Discovery

Finding the Redux store in Bluebook's React app is non-trivial because it's not exposed globally. The `findReduxStore()` function uses three strategies in sequence:

**Strategy 1 — Global references:**
Checks `window.__rbStore`, `window.store`, `window.__store`, and Redux DevTools extension stores.

**Strategy 2 — React DevTools hook:**
If the React DevTools global hook exists (`__REACT_DEVTOOLS_GLOBAL_HOOK__`), iterates its renderer map and uses `findFiberByHostInstance()` to find React fiber trees, then walks them for store references.

**Strategy 3 — DOM fiber walking:**
Iterates every DOM element looking for React internal keys (`__reactFiber$*`, `__reactInternalInstance$*`, `__reactContainer$*`). For each fiber found, walks the tree in both directions:
- **Upward** via `fiber.return` (up to 5000 steps)
- **Downward** via BFS on `fiber.child`/`fiber.sibling` (up to 10000 steps)

At each fiber, checks four slots (`memoizedProps`, `memoizedState`, `stateNode`, `pendingProps`) for an object that has `dispatch` and `getState` as functions plus either `subscribe` or `replaceReducer`.

A store is validated by calling `getState()` and checking the returned state is non-null.

---

## 6. Dispatch & Fetch Spoofer

### 6.1 Dispatch Spoofer

The dispatch spoofer intercepts Redux actions at the `store.dispatch()` level and rewrites specific fields before they reach the reducers/sagas.

**Target:** `registrations/ADD_REGISTRATION` actions
**Field:** `payload.registration.event.asmtEventTypeCd`
**Operation:** Changes the exam type code (e.g., 4 → 1) to make a practice test appear as an operational exam to the Redux state.

**How it works:**
1. When the recorder wraps `store.dispatch()`, it checks if the spoofer is enabled
2. If the action type is `registrations/ADD_REGISTRATION`, it deep-clones the action via `JSON.parse(JSON.stringify(action))`
3. Navigates to `cloned.payload.registration.event.asmtEventTypeCd`
4. If the current value differs from the target, overwrites it
5. Passes the cloned (modified) action to the real `store.dispatch()`
6. Tracks the rewrite count and logs before/after values

**Limitation discovered:** Even with a successful dispatch rewrite, kiosk mode doesn't engage because the saga also checks `examCheckinInfo.credentials.sessionToken`, which is a server-issued STS token that's empty for practice tests. The spoofer changes what the client-side state machine sees, but it can't fabricate server-side credentials.

### 6.2 Fetch Spoofer

The fetch spoofer intercepts HTTP responses and rewrites `asmtEventTypeCd` values in the response body before the app processes them.

**How it works:**
1. Wraps `window.fetch` to intercept responses
2. Checks if the response has a JSON content-type
3. Reads the response body as text
4. Uses regex `/\"asmtEventTypeCd\"\s*:\s*(\d+)/g` to find all occurrences
5. Replaces any value that doesn't match the target with the target value
6. Returns a new `Response` object with the modified body

This operates at the network level (before the data reaches Redux) while the dispatch spoofer operates at the state level (before the data reaches reducers). Together they cover both pathways the exam type code can enter the application.

---

## 7. IPC System

The console window (renderer process) communicates with the launcher (main process) via a custom IPC channel built on Electron's `console-message` event.

### 7.1 Protocol

**Renderer → Main:**
The renderer calls `console.log('<<RB_IPC>>' + JSON.stringify({ cmd, args, id }))`. The main process has a listener on `webContents.console-message` that detects messages starting with `<<RB_IPC>>`, parses the JSON, and dispatches the command.

**Main → Renderer:**
After processing, the main process calls `webContents.executeJavaScript()` to invoke `window.__rbIpcResolve(id, result)` in the renderer, resolving the pending Promise.

**Why this approach:** Bluebook's preload script uses `contextBridge.exposeInMainWorld()` which creates read-only proxies. We can't add new IPC channels through the bridge, and we can't modify the existing preload. But `console.log()` is always available in the renderer and `console-message` events are always visible to the main process — it's an unconditional communication channel.

### 7.2 Available Commands

| Command | Arguments | Returns |
|---------|-----------|---------|
| `ping` | — | `'pong'` |
| `session.save` | `{ name?, ...storageData }` | `{ ok, path, name }` |
| `session.load` | `{ name }` | Full session object (includes HttpOnly cookies) |
| `session.list` | — | Array of `{ name, size, mtime }` |
| `session.delete` | `{ name }` | `{ ok }` |
| `recording.save` | `{ name?, payload }` | `{ ok, path, name }` |
| `recording.list` | — | Array of `{ name, size, mtime }` |
| `recording.delete` | `{ name }` | `{ ok }` |
| `log.tail` | `{ lines? }` | Last N lines of `_run.log` |
| `shell.openPath` | `{ path }` | `{ ok }` |
| `app.relaunch` | — | `{ ok }` (then restarts) |
| `window.reload` | — | `{ ok }` |
| `devtools.toggle` | — | `{ ok, state: 'opened'/'closed' }` |
| `devtools.state` | — | `{ open: boolean }` |

Session save/load includes HttpOnly cookies — the main process reads them via `session.cookies.get({})` (which can access HttpOnly cookies that the renderer can't see) and restores them via `session.cookies.set()`.

---

## 8. Bridge API Catalog

The bridge is Bluebook's `contextBridge`-exposed API object. It's the interface between the renderer (web content) and the native Electron layer. Detected by fingerprinting: we scan `window` for an object that has `enterKioskMode`, `exitKioskMode`, `version`, and `systemCheck`.

### Complete Method Reference

#### Window / UI
| Method | Kind | Description |
|--------|------|-------------|
| `enterKioskMode` | action | Fullscreen, non-minimizable, empty menu bar, focus enforcement |
| `exitKioskMode` | action | Return to normal windowed mode |
| `enterFullscreenMode` | action | Simple fullscreen without kiosk restrictions |
| `emptyMenu` | action | Remove all menu bar items |
| `preventSleep` | setter | Prevent system sleep/screen lock |
| `quit` | action | Close the application |

#### Device / System
| Method | Kind | Description |
|--------|------|-------------|
| `version` | value | Bluebook version string |
| `getDeviceInfo` | getter | Hardware/OS details |
| `getDeviceId` | getter | Unique device identifier |
| `getAnalyticsInfo` | getter | Analytics/telemetry configuration |
| `systemCheck` | getter | System compatibility check results |
| `getDefaultKeyboardLanguage` | getter | Current keyboard layout |
| `getAvailableKeyboardLanguages` | getter | All installed keyboard layouts |
| `setKeyboardLanguage` | setter | Switch keyboard layout |
| `noCheckin` | value | Whether check-in is disabled |

#### Updates
| Method | Kind | Description |
|--------|------|-------------|
| `checkUpdateRequired` | getter | Check if an app update is available |
| `installUpdate` | action | Begin installing an update |
| `updateReady` | action | Signal that update is ready to apply |
| `onUpdateAvailable` | event | Fires when an update is found |
| `onUpdateChecking` | event | Fires when update check begins |
| `onUpdateDownloaded` | event | Fires when update download completes |
| `onUpdateError` | event | Fires on update error |
| `onUpdateNotAvailable` | event | Fires when no update exists |

#### RMT (Remote Monitoring Tool)
| Method | Kind | Description |
|--------|------|-------------|
| `getRMT` | getter | Get current RMT configuration |
| `setRMT` | setter | Set RMT configuration |
| `clearRMT` | action | Clear RMT data |
| `setRosterEntryId` | setter | Set the student's roster entry ID |

#### Security & Lockdown
| Method | Kind | Description |
|--------|------|-------------|
| `performSecurityCheck` | setter | Trigger full security sweep |
| `requestRestrictedApps` | action | Request list of running restricted apps |
| `onRestrictedAppsReceived` | event | Restricted app list callback |
| `onSecurityViolationDetected` | event | Generic security violation callback |
| `onDebuggerDetected` | event | Debugger attachment callback |
| `onGrammarlyDetected` | event | Grammarly detection callback |
| `onHModStatus` | event | Hardware modification status callback |
| `onVirtualMachineDetected` | event | Confirmed VM detection callback |
| `onVirtualMachineSuspected` | event | Suspected VM callback |
| `onRemoteDesktopConnectionDetected` | event | Remote desktop detection callback |
| `onLockdownNewProcess` | event | New process during lockdown callback |
| `onLockdownWindowResized` | event | Window resize during lockdown callback |
| `onLowBattery` | event | Low battery warning callback |
| `onWindowFocusChanged` | event | Window focus change callback |
| `onSegmentUpdateSuccess` | event | Telemetry upload success callback |
| `onKeyboardLayoutChanged` | event | Keyboard layout change callback |
| `terminateGrammarly` | action | Force-kill Grammarly |
| `clearClipboard` | action | Wipe system clipboard |
| `unlockAccountAsStudent` | action | Unlock proctor-locked student account |

#### Telemetry
| Method | Kind | Description |
|--------|------|-------------|
| `setSentryUser` | setter | Set the Sentry error reporting user identity |
| `setTelemetryStatus` | setter | Enable/disable telemetry |
| `onAnalyticsReceived` | event | Analytics data callback |
| `onPDFSaved` | event | PDF save completion callback |
| `printPDF` | setter | Generate a PDF from current content |
| `captureScreen` | setter | Take a screenshot |

#### Lifecycle
| Method | Kind | Description |
|--------|------|-------------|
| `appListenersReady` | action | Signal that app event listeners are initialized |
| `rendererReady` | action | Signal that the renderer is ready |
| `openUrl` | setter | Open a URL in the system browser |
| `onDeviceInfoReceived` | event | Device info callback |

---

*Total bridge methods: 54 (17 actions, 9 getters, 10 setters, 16 events, 2 values)*
