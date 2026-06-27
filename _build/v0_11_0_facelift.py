#!/usr/bin/env python3
"""
Redbook v0.11.0 — Windows 11 Glass Facelift (CSS-Only).

Strict no-HTML, no-JS edit policy. Three operations on mods/devpanel.js:

  1. Replace the :host { --cn-* } token block (lines ~372-390) with the new
     Win11-flavored palette + font-family tokens.
  2. Replace the universal * { box-sizing + font-family } rule so the
     content font is the new var(--cn-font-content). Chrome elements
     override per-class in the appended block.
  3. Append the v0.11.0 restyle CSS block immediately before </style>.
     Cascade order makes the new rules win without any find-and-replace
     of existing selector blocks — original CSS stays intact below.

Then bumps version.json and installer/redbook.iss to 0.11.0.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEVPANEL = ROOT / 'mods' / 'devpanel.js'
VERSION_JSON = ROOT / 'version.json'
ISS = ROOT / 'installer' / 'redbook.iss'

src = DEVPANEL.read_text(encoding='utf-8')

# ─── 1. :host token block ────────────────────────────────────────────────────
OLD_HOST = """      :host {
        all: initial;
        --cn-bg: #0a0e17;
        --cn-surface: #0f1420;
        --cn-border: #1a2035;
        --cn-border-hi: #253050;
        --cn-text: #c8cdd5;
        --cn-dim: #5a6275;
        --cn-faint: #2a3045;
        --cn-accent: #6c7ee1;
        --cn-accent-dim: #3d4f8a;
        --cn-success: #4ade80;
        --cn-warn: #fbbf24;
        --cn-error: #f87171;
        --cn-info: #60a5fa;
        --cn-str: #fbbf24;
        --cn-num: #fb923c;
        --cn-key: #a78bfa;
      }"""

NEW_HOST = """      :host {
        all: initial;
        /* v0.11.0 — Windows 11 glass palette. Token names kept the same so
           every existing rule that references --cn-* picks up the new look
           automatically. */
        --cn-bg:         rgba(20, 24, 32, 0.86);    /* dark tinted glass — Mica base */
        --cn-surface:    rgba(255, 255, 255, 0.05); /* raised tint */
        --cn-border:     rgba(255, 255, 255, 0.08); /* hairline */
        --cn-border-hi:  rgba(76, 194, 255, 0.28);  /* accent-tinted hover border */
        --cn-text:       #F3F3F3;                    /* Win11 dark-mode text */
        --cn-dim:        #A1A1A1;                    /* Win11 dark-mode secondary */
        --cn-faint:      #6E6E6E;                    /* tertiary */
        --cn-accent:     #4CC2FF;                    /* Win11 dark accent */
        --cn-accent-dim: rgba(76, 194, 255, 0.20);
        --cn-success:    #6CCB5F;                    /* Win11 system green */
        --cn-warn:       #FFC83D;                    /* Win11 amber */
        --cn-error:      #FF99A4;                    /* Win11 soft rose */
        --cn-info:       #4CC2FF;
        --cn-str:        #FFC83D;
        --cn-num:        #FFB454;
        --cn-key:        #9CDCFE;                    /* Win Terminal key blue */
        /* Typography */
        --cn-font-chrome:  'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, sans-serif;
        --cn-font-content: 'Cascadia Code', 'Cascadia Mono', 'Consolas', ui-monospace, monospace;
      }"""

if OLD_HOST not in src:
    raise SystemExit('FATAL: :host block not found verbatim.')
src = src.replace(OLD_HOST, NEW_HOST, 1)

# ─── 2. Universal * { font-family } rule ─────────────────────────────────────
OLD_STAR = """      * {
        box-sizing: border-box;
        font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, ui-monospace, monospace;
      }"""

NEW_STAR = """      * {
        box-sizing: border-box;
        font-family: var(--cn-font-content);  /* default to content/monospace; chrome elements override per-class below */
      }"""

if OLD_STAR not in src:
    raise SystemExit('FATAL: universal * { font-family } rule not found verbatim.')
src = src.replace(OLD_STAR, NEW_STAR, 1)

# ─── 3. Append v0.11.0 restyle CSS block before </style> ─────────────────────
FACELIFT_CSS = """
      /* ═══════════════════════════════════════════════════════════════════════
         v0.11.0 — Windows 11 glass facelift (CSS-only).

         These rules are appended *after* the original ruleset so cascade
         order alone wins them. Every selector here targets a class that
         existed in v0.10.3 — no new HTML, no JS changes anywhere. To
         revert: delete this entire block.
         ═══════════════════════════════════════════════════════════════════════ */

      /* Window shell — Mica base glass */
      .win {
        background: var(--cn-bg);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        backdrop-filter: blur(18px) saturate(140%);
        border: 1px solid var(--cn-border);
        border-radius: 8px;
        box-shadow:
          0 12px 28px rgba(0,0,0,0.5),
          0 2px 4px rgba(0,0,0,0.4);
        color: var(--cn-text);
      }

      /* Titlebar — drop the swastika + accent-left stripe, Segoe UI chrome */
      .titlebar {
        background: transparent;
        border-bottom: 1px solid var(--cn-border);
        border-left: none;
        padding: 8px 12px;
        font-family: var(--cn-font-chrome);
        font-size: 12px;
      }
      .tb-brand {
        color: var(--cn-text);
        font-family: var(--cn-font-chrome);
        font-weight: 600;
        letter-spacing: 0;
      }
      .tb-brand::before { content: none; }  /* remove 卐 */
      .tb-meta {
        color: var(--cn-dim);
        font-family: var(--cn-font-chrome);
        font-size: 11px;
        font-weight: 400;
        padding: 1px 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--cn-border);
        border-radius: 6px;
        flex: 0 0 auto;
        margin-right: 8px;
      }

      /* Status pills — chip aesthetic */
      .tb-status { gap: 6px; }
      .tb-stat {
        font-family: var(--cn-font-chrome);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        padding: 2px 10px;
        border-radius: 10px;
        border: 1px solid var(--cn-border);
        background: transparent;
        color: var(--cn-dim);
      }
      .tb-stat.on {
        color: var(--cn-accent);
        border-color: rgba(76,194,255,0.28);
        background: rgba(76,194,255,0.10);
      }
      .tb-stat.err {
        color: var(--cn-error);
        border-color: rgba(255,153,164,0.30);
        background: rgba(255,153,164,0.10);
      }

      /* Close button — Win11 hover behavior */
      .tb-btn {
        background: transparent;
        border: 1px solid transparent;
        color: var(--cn-dim);
        width: 24px;
        height: 22px;
        border-radius: 4px;
        font-family: var(--cn-font-chrome);
      }
      .tb-btn:hover {
        background: rgba(255,255,255,0.06);
        border-color: var(--cn-border);
        color: var(--cn-text);
      }

      /* Scrollback */
      .scrollback {
        padding: 12px 16px;
        font-family: var(--cn-font-content);
        font-size: 12px;
        scrollbar-color: rgba(255,255,255,0.10) transparent;
      }
      .scrollback::-webkit-scrollbar { width: 4px; }
      .scrollback::-webkit-scrollbar-track { background: transparent; }
      .scrollback::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.10); border-radius: 2px; }
      .scrollback::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }

      /* ASCII banner — monochromatic accent (overrides inline rainbow spans) */
      .banner {
        font-family: var(--cn-font-content);
        color: var(--cn-accent);
      }
      .banner span[style*="color"] {
        color: var(--cn-accent) !important;
        text-shadow: 0 0 12px rgba(76,194,255,0.18);
      }

      /* Log tag colors — bracketed format preserved for column alignment */
      .tag-ok   { color: var(--cn-success); }
      .tag-warn { color: var(--cn-warn); }
      .tag-err  { color: var(--cn-error); }
      .tag-info { color: var(--cn-info); }

      /* Echo prompt */
      .echo { color: var(--cn-dim); }

      /* KV pairs */
      .kv-dots { color: var(--cn-faint); }

      /* Provider cards — Acrylic moment */
      .provider-row {
        gap: 12px;
        padding: 10px 0;
      }
      .provider-card {
        background: rgba(255,255,255,0.04);
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        backdrop-filter: blur(20px) saturate(140%);
        border: 1px solid var(--cn-border);
        border-radius: 10px;
        padding: 14px 18px;
        font-family: var(--cn-font-chrome);
        color: var(--cn-dim);
        transition: border-color 180ms, background 180ms, transform 180ms;
      }
      .provider-card:hover {
        border-color: var(--cn-border-hi);
        background: rgba(255,255,255,0.06);
        transform: translateY(-1px);
        color: var(--cn-text);
      }
      .provider-card.selected {
        border-color: var(--cn-accent);
        background: rgba(76,194,255,0.10);
        color: var(--cn-text);
      }
      .provider-card .provider-icon {
        filter: grayscale(1) brightness(1.5) opacity(0.85);
        transition: filter 180ms;
      }
      .provider-card.selected .provider-icon { filter: none; }
      .provider-card .provider-name {
        font-family: var(--cn-font-chrome);
        font-weight: 500;
        font-size: 12px;
      }

      /* START button — biggest Acrylic moment, no rainbow */
      .start-row { padding: 12px 0; }
      .start-btn {
        background: linear-gradient(180deg, rgba(76,194,255,0.12), rgba(76,194,255,0.04));
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        backdrop-filter: blur(20px) saturate(140%);
        border: 1px solid var(--cn-accent-dim);
        border-radius: 8px;
        color: var(--cn-accent);
        font-family: var(--cn-font-chrome);
        font-weight: 600;
        font-size: 13px;
        letter-spacing: 0.04em;
        padding: 10px 32px;
        transition: border-color 180ms, background 180ms, transform 100ms;
      }
      .start-btn:hover {
        animation: none;  /* kill effortGlow */
        border-color: var(--cn-accent);
        background: linear-gradient(180deg, rgba(76,194,255,0.18), rgba(76,194,255,0.06));
        transform: translateY(-1px);
        color: var(--cn-text);
      }
      .start-btn:active { transform: translateY(0); }
      @keyframes effortGlow { /* defused — kept as no-op so any stray reference is harmless */
        from { opacity: 1; } to { opacity: 1; }
      }

      /* Spinner */
      .spin { color: var(--cn-accent); }

      /* Footer status bar — chip pills */
      .status-bar {
        background: transparent;
        border-top: 1px solid var(--cn-border);
        font-family: var(--cn-font-chrome);
        font-size: 11px;
        gap: 8px;
        padding: 6px 12px;
      }
      .sb-pill {
        padding: 2px 10px;
        border-radius: 10px;
        border: 1px solid var(--cn-border);
        background: rgba(255,255,255,0.03);
        color: var(--cn-dim);
        font-size: 11px;
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
      }
      .sb-val {
        font-weight: 600;
        font-family: var(--cn-font-chrome);
      }
      .sb-ok      { color: var(--cn-success); }
      .sb-err     { color: var(--cn-error); }
      .sb-warn    { color: var(--cn-warn); }
      .sb-info    { color: var(--cn-accent); }
      .sb-pending { color: var(--cn-faint); }

      /* Shortcuts row — glass keycaps */
      .shortcuts {
        background: transparent;
        border-top: 1px solid var(--cn-border);
        font-family: var(--cn-font-chrome);
        font-size: 11px;
        color: var(--cn-dim);
        padding: 6px 12px;
        gap: 16px;
      }
      .shortcuts > span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .shortcuts code {
        background: var(--cn-surface);
        border: 1px solid var(--cn-border);
        border-radius: 4px;
        color: var(--cn-text);
        font-family: var(--cn-font-content);
        font-size: 10px;
        padding: 1px 6px;
        margin-right: 0;
        box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset;
      }

      /* Input row */
      .input-row {
        background: transparent;
        border-top: 1px solid var(--cn-border);
        padding: 10px 14px;
      }
      .input-prompt {
        color: var(--cn-accent);
        font-family: var(--cn-font-content);
        font-size: 14px;
        font-weight: 600;
      }
      .input-display {
        font-family: var(--cn-font-content);
        color: var(--cn-text);
      }
      .input-ghost { color: var(--cn-faint); }
      .input-text {
        font-family: var(--cn-font-content);
        caret-color: var(--cn-accent);
        color: transparent;
      }

      /* Autocomplete dropdown — second Acrylic moment */
      .ac-dropdown {
        background: rgba(20,24,32,0.78);
        -webkit-backdrop-filter: blur(24px) saturate(160%);
        backdrop-filter: blur(24px) saturate(160%);
        border: 1px solid var(--cn-border);
        border-bottom: none;
        border-radius: 8px 8px 0 0;
        box-shadow: 0 -8px 24px rgba(0,0,0,0.45);
        font-family: var(--cn-font-chrome);
        font-size: 12px;
        scrollbar-color: rgba(255,255,255,0.10) transparent;
      }
      .ac-item {
        padding: 5px 14px;
        color: var(--cn-text);
        font-family: var(--cn-font-chrome);
      }
      .ac-item .ac-cmd {
        color: var(--cn-accent);
        font-family: var(--cn-font-content);
      }
      .ac-item .ac-cmd .ac-match {
        color: var(--cn-text);
        font-weight: 600;
      }
      .ac-item .ac-help {
        color: var(--cn-dim);
        font-family: var(--cn-font-chrome);
      }
      .ac-item.active {
        background: rgba(76,194,255,0.12);
      }
      .ac-item:hover:not(.active) {
        background: rgba(255,255,255,0.04);
      }
      .ac-item.arg-hint .ac-arg { color: var(--cn-accent); }
      .ac-group-header {
        color: var(--cn-faint);
        font-family: var(--cn-font-chrome);
        border-top-color: var(--cn-border);
      }

      /* Resize grip — subtler */
      .resize-grip {
        opacity: 0.5;
      }

      /* Progress bar — keep existing structure, new accent colors via tokens */
      .progress-bar { font-family: var(--cn-font-content); }
      .progress-fill { color: var(--cn-accent); }
      .progress-empty { color: var(--cn-faint); }
      .progress-label { color: var(--cn-accent); font-weight: 600; }
      .progress-pct { color: var(--cn-text); }

      /* JSON syntax highlighting — pulled toward Win Terminal palette */
      .json .jk { color: var(--cn-key); }
      .json .js { color: var(--cn-str); }
      .json .jn { color: var(--cn-num); }
      .json .jb { color: var(--cn-accent); }

      /* Focus rings — keyboard-nav visible */
      .start-btn:focus-visible,
      .provider-card:focus-visible,
      .input-text:focus-visible,
      .tb-btn:focus-visible,
      .ac-item:focus-visible {
        outline: 2px solid var(--cn-accent);
        outline-offset: 2px;
      }

      /* Reduced motion — respect OS preference */
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }
"""

CLOSE_STYLE = "    </style>"
if CLOSE_STYLE not in src:
    raise SystemExit('FATAL: closing </style> tag not found.')
src = src.replace(CLOSE_STYLE, FACELIFT_CSS + CLOSE_STYLE, 1)

DEVPANEL.write_text(src, encoding='utf-8')
print(f'OK — devpanel.js patched. Size: {DEVPANEL.stat().st_size} bytes')

# ─── 4. Version bumps ────────────────────────────────────────────────────────
VERSION_JSON.write_text('{\n  "version": "0.11.0",\n  "electron": "39.8.10"\n}\n')
print('OK — version.json -> 0.11.0')

iss = ISS.read_text(encoding='utf-8')
iss = iss.replace('AppVersion=0.10.4', 'AppVersion=0.11.0')
iss = iss.replace('UninstallDisplayName=Redbook v0.10.4', 'UninstallDisplayName=Redbook v0.11.0')
iss = iss.replace('OutputBaseFilename=Redbook-v0.10.4-win32-setup', 'OutputBaseFilename=Redbook-v0.11.0-win32-setup')
ISS.write_text(iss, encoding='utf-8')
print('OK — redbook.iss -> 0.11.0')
