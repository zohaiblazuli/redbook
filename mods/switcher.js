/*
 * Redbook theme apply layer — no visible UI.
 *
 * Used to mount a bottom-right pill (theme toggle + dev panel gear); that's been
 * removed at LO's request. The theme apply logic lives on as `window.__rbApplyTheme`
 * so the dev panel's Theme tab can still drive it. The dev panel is now opened by
 * pressing Insert anywhere in the renderer (handler lives in devpanel.js).
 *
 * __RB_CSS is provided by _run.js as a module-level const before this code runs.
 * Idempotent: safe to re-run on every did-navigate.
 */
'use strict';

console.log('[redbook] theme layer entered, CSS bytes:', (typeof __RB_CSS === 'string' ? __RB_CSS.length : 'MISSING'));

const STORAGE_KEY   = 'redbook-theme';
const STYLE_ID      = 'redbook-overrides';
const TITLE_DEFAULT = 'Bluebook';
const TITLE_REDBOOK = 'Redbook';

const WORDMARK_HASHES = [
  '228bdee07df064ae', '6be541363e930c82', '802e74d124150325',
  '965b734d9d73236f', '9b720c6a19b7cc5f', 'eaa5f84647351ab2',
];

// ─── Style tag (lives in real document.head) ──────────────────────────────────
function ensureStyleTag() {
  let s = document.getElementById(STYLE_ID);
  if (!s) {
    s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = __RB_CSS;
    document.head.appendChild(s);
    console.log('[redbook] style tag injected');
  }
  return s;
}

// ─── Wordmark overlay ─────────────────────────────────────────────────────────
function isWordmark(el) {
  if (!el) return false;
  if (el.dataset && el.dataset.rbProcessed) return false;
  const tag = el.tagName && el.tagName.toUpperCase();
  if (tag === 'SVG') {
    const alt = el.getAttribute('alt') || '';
    if (/^bluebook$/i.test(alt)) return true;
  }
  if (tag === 'IMG') {
    const src = el.getAttribute('src') || '';
    for (const h of WORDMARK_HASHES) if (src.includes(h)) return true;
    const alt = el.getAttribute('alt') || '';
    if (/^bluebook$/i.test(alt)) return true;
  }
  return false;
}

function wrapWithOverlay(el) {
  el.dataset.rbProcessed = '1';
  const parent = el.parentElement;
  if (!parent) return;
  if (getComputedStyle(parent).position === 'static') {
    parent.dataset.rbRelative = '1';
    parent.style.position = 'relative';
  }
  const overlay = document.createElement('span');
  overlay.dataset.rbOverlay = '1';
  overlay.style.cssText = [
    'position:absolute', 'inset:0',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-family:Roboto,system-ui,sans-serif', 'font-weight:700',
    'letter-spacing:-0.02em', 'white-space:nowrap',
    'color:inherit', 'pointer-events:none', 'user-select:none',
  ].join(';');
  const rect = el.getBoundingClientRect();
  overlay.style.fontSize = Math.max(12, Math.round((rect.height || 20) * 0.65)) + 'px';
  if (el.closest('.app-loading')) overlay.style.color = '#fff';
  overlay.textContent = 'Redbook';
  el.insertAdjacentElement('afterend', overlay);
}

function unwrapOverlay(el) {
  if (!el || !el.dataset || !el.dataset.rbProcessed) return;
  delete el.dataset.rbProcessed;
  let sib = el.nextElementSibling;
  while (sib) {
    if (sib.dataset && sib.dataset.rbOverlay) { sib.remove(); break; }
    sib = sib.nextElementSibling;
  }
  const p = el.parentElement;
  if (p && p.dataset && p.dataset.rbRelative) {
    p.style.position = '';
    delete p.dataset.rbRelative;
  }
}

function rebrandAllWordmarks() {
  document.querySelectorAll(
    'svg[alt], svg[ALT], img[alt], img[src*=".svg"]'
  ).forEach(el => { if (isWordmark(el)) wrapWithOverlay(el); });
}

function restoreAllWordmarks() {
  document.querySelectorAll('[data-rb-processed]').forEach(unwrapOverlay);
}

// ─── Text replacement ─────────────────────────────────────────────────────────
const TEXT_ORIG = new WeakMap();
function rebrandText() {
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE']);
  if (!document.body) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || skip.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      return /bluebook/i.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const batch = [];
  let cur;
  while ((cur = walker.nextNode())) batch.push(cur);
  for (const tn of batch) {
    if (!TEXT_ORIG.has(tn)) TEXT_ORIG.set(tn, tn.nodeValue);
    tn.nodeValue = tn.nodeValue
      .replace(/BLUEBOOK/g, 'REDBOOK')
      .replace(/Bluebook/g, 'Redbook')
      .replace(/bluebook/g, 'redbook');
  }
}
function restoreText() {
  if (!document.body) return;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (TEXT_ORIG.has(n)) { n.nodeValue = TEXT_ORIG.get(n); TEXT_ORIG.delete(n); }
  }
}

// ─── Theme apply/restore ──────────────────────────────────────────────────────
function getCurrentTheme() {
  try { return localStorage.getItem(STORAGE_KEY) || 'default'; } catch { return 'default'; }
}
function setCurrentTheme(name) {
  try { localStorage.setItem(STORAGE_KEY, name); } catch (_) {}
}

function applyTheme(name) {
  const styleEl = ensureStyleTag();
  setCurrentTheme(name);
  if (name === 'redbook') {
    document.documentElement.classList.add('redbook-active');
    styleEl.disabled = false;
    try { document.title = TITLE_REDBOOK; } catch (_) {}
    rebrandAllWordmarks();
    rebrandText();
  } else {
    document.documentElement.classList.remove('redbook-active');
    styleEl.disabled = true;
    restoreAllWordmarks();
    restoreText();
    try { document.title = TITLE_DEFAULT; } catch (_) {}
  }
  console.log('[redbook] theme applied:', name);
}

// Expose to dev panel
window.__rbApplyTheme = applyTheme;
window.__rbGetTheme   = getCurrentTheme;

// ─── MutationObserver: re-rebrand new mounts when redbook is active ───────────
let _observer = null;
function installObserver() {
  if (_observer) return;
  _observer = new MutationObserver(mutations => {
    if (getCurrentTheme() !== 'redbook') return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          isWordmark(node) ||
          (node.querySelector && (
            node.querySelector('svg[alt]') ||
            node.querySelector('img[alt]') ||
            WORDMARK_HASHES.some(h => node.querySelector(`img[src*="${h}"]`))
          ))
        ) {
          rebrandAllWordmarks();
          rebrandText();
          return;
        }
      }
    }
  });
  _observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', init, { once: true });
    return;
  }
  ensureStyleTag();
  installObserver();
  applyTheme(getCurrentTheme());
}

// Idempotent re-entry on each navigation
if (window.__redbookSwitcherInstalled) {
  ensureStyleTag();
  applyTheme(getCurrentTheme());
} else {
  window.__redbookSwitcherInstalled = true;
  init();
}
