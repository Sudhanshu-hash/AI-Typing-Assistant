// contentScript.js — ALL-FIELDS grammar underline + suggestions + translate picker
// Supports: contenteditable, textarea, input[type="text"]
// Uses overlay mirror for inputs/textarea, spans for contenteditable.
// Language & autoReplace settings received from popup via runtime messages or storage.

const DEFAULTS = { enabled: true, targetLang: 'no', autoReplace: false };
let settings = { ...DEFAULTS };

// Keep maps of overlays and stored grammar results per element
const elementState = new WeakMap();

chrome.storage.sync.get(DEFAULTS, (s) => (settings = { ...DEFAULTS, ...s }));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'AI_SETTINGS_UPDATED' && msg.payload) {
    settings = { ...settings, ...msg.payload };
    sendResponse({ ok: true });
  }
  if (msg.type === 'AI_RUN_ON_SELECTION' && msg.text) {
    (async () => {
      const out = await runGrammarAndTranslate(msg.text);
      alert('Corrected:\n' + out.corrected + (out.translated ? '\n\nTranslated:\n' + out.translated : ''));
    })();
    sendResponse({ status: 'processing' });
  }
});

// Debounce factory
function debounceFactory(ms) {
  let t = null;
  return (fn) => {
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        fn(...args);
      }, ms);
    };
  };
}
const debounce = debounceFactory(850);

// Small helper: create element with attrs
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'style') Object.assign(e.style, attrs[k]);
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  children.forEach(c => (typeof c === 'string' ? e.appendChild(document.createTextNode(c)) : e.appendChild(c)));
  return e;
}

// LANGUAGE/TRANSLATE helpers
async function translateText(text, target) {
  if (!target || target === 'no') return null;
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
      + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(text);
    const res = await fetch(url);
    if (!res.ok) throw new Error('Translate failed ' + res.status);
    const json = await res.json();
    // Extract first translation chunk
    return (json && json[0] && json[0][0] && json[0][0][0]) ? json[0][0][0] : null;
  } catch (e) {
    console.warn('translateText error', e);
    return null;
  }
}

async function callGrammarAPI(text) {
  // LanguageTool public instance
  try {
    const body = new URLSearchParams();
    body.append('text', text);
    body.append('language', 'auto'); // let LT detect
    const res = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      body
    });
    if (!res.ok) throw new Error('LT returned ' + res.status);
    return await res.json();
  } catch (e) {
    console.warn('callGrammarAPI error', e);
    return null;
  }
}

// central combined run
async function runGrammarAndTranslate(text) {
  const grammar = await callGrammarAPI(text);
  let corrected = text;
  if (grammar && grammar.matches) {
    corrected = applyGrammarReplacements(text, grammar.matches);
  }
  let translated = null;
  if (settings.targetLang && settings.targetLang !== 'no') {
    translated = await translateText(corrected, settings.targetLang);
  }
  return { corrected, grammar, translated };
}

// safe application of grammar suggestions using offsets (applies replacements backward to keep offsets)
function applyGrammarReplacements(original, matches) {
  if (!matches || matches.length === 0) return original;
  const edits = [];
  for (const m of matches) {
    // prefer m.offset & m.length (LanguageTool), fallback to context
    const start = (typeof m.offset === 'number') ? m.offset : (m.context && typeof m.context.offset === 'number' ? m.context.offset : null);
    const len = (typeof m.length === 'number') ? m.length : (m.context && typeof m.context.length === 'number' ? m.context.length : null);
    const replacement = (m.replacements && m.replacements[0]) ? m.replacements[0].value : null;
    if (start !== null && len !== null && replacement !== null) {
      edits.push({ start, end: start + len, replacement, message: m.message, original: original.substring(start, start + len) });
    }
  }
  if (edits.length === 0) return original;
  edits.sort((a, b) => b.start - a.start);
  let out = original;
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  return out;
}

// UTILS: create overlay for inputs/textarea
function createMirrorOverlayFor(elm) {
  // if overlay already exists return it
  const st = elementState.get(elm) || {};
  if (st.overlay) return st.overlay;

  // create overlay container
  const overlay = el('div', { class: 'ai-overlay' });
  overlay.style.position = 'absolute';
  overlay.style.pointerEvents = 'none'; // allow clicks to pass to input by default (we attach handlers to spans)
  overlay.style.whiteSpace = 'pre-wrap';
  overlay.style.overflow = 'hidden';
  overlay.style.zIndex = 2147483646; // just under suggestion popups
  overlay.style.display = 'none';

  document.body.appendChild(overlay);
  st.overlay = overlay;
  elementState.set(elm, st);
  return overlay;
}

// position overlay to match element
function syncOverlayPosition(elm) {
  const st = elementState.get(elm);
  if (!st || !st.overlay) return;
  const rect = elm.getBoundingClientRect();
  const style = getComputedStyle(elm);
  const overlay = st.overlay;

  overlay.style.left = rect.left + window.scrollX + 'px';
  overlay.style.top = rect.top + window.scrollY + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  overlay.style.font = `${style.fontSize} ${style.fontFamily}`;
  overlay.style.lineHeight = style.lineHeight;
  overlay.style.padding = `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`;
  overlay.style.borderRadius = style.borderRadius;
  overlay.style.boxSizing = 'border-box';
  overlay.style.color = 'transparent'; // hide text caret duplication
}

// build overlay html with underlines using matches offsets
function renderOverlay(elm, text, matches) {
  const overlay = createMirrorOverlayFor(elm);
  if (!text) { overlay.style.display = 'none'; return; }
  overlay.style.display = 'block';

  // Build a simple array of segments: normal + underlined
  const segments = [];
  if (!matches || matches.length === 0) {
    segments.push({ text, underline: false });
  } else {
    // Build edit ranges from matches (use their start/length offsets)
    const ranges = [];
    for (const m of matches) {
      const start = (typeof m.offset === 'number') ? m.offset : (m.context && typeof m.context.offset === 'number' ? m.context.offset : null);
      const len = (typeof m.length === 'number') ? m.length : (m.context && typeof m.context.length === 'number' ? m.context.length : null);
      if (start !== null && len !== null) ranges.push({ start, end: start + len, match: m });
    }
    ranges.sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const r of ranges) {
      if (r.start > cursor) segments.push({ text: text.slice(cursor, r.start), underline: false });
      segments.push({ text: text.slice(r.start, r.end), underline: true, match: r.match, start: r.start, end: r.end });
      cursor = r.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), underline: false });
  }

  // Build innerHTML safely
  const frag = document.createDocumentFragment();
  segments.forEach(seg => {
    if (!seg.underline) {
      const span = document.createElement('span');
      span.textContent = seg.text;
      span.style.color = 'transparent'; // don't show mirrored text (we only want underline decorations)
      frag.appendChild(span);
    } else {
      const s = document.createElement('span');
      s.className = 'ai-underline';
      s.dataset.start = seg.start;
      s.dataset.end = seg.end;
      s.dataset.message = seg.match && seg.match.message ? seg.match.message : '';
      s.dataset.replacements = JSON.stringify(seg.match && seg.match.replacements ? seg.match.replacements.map(r => r.value) : []);
      s.textContent = seg.text;
      // pointer events on underline so click registers
      s.style.pointerEvents = 'auto';
      s.style.color = 'transparent';
      frag.appendChild(s);
    }
  });

  // Clear and append
  overlay.innerHTML = '';
  overlay.appendChild(frag);

  // Position overlay exactly
  syncOverlayPosition(elm);
}

// For contenteditable we replace innerHTML with spans (loses formatting — acceptable MVP)
function renderContentEditable(elm, text, matches) {
  // Build segments similarly using offsets of textContent
  if (!text) { return; }
  const segments = [];
  if (!matches || matches.length === 0) segments.push({ text, underline: false });
  else {
    const ranges = [];
    for (const m of matches) {
      const start = (typeof m.offset === 'number') ? m.offset : (m.context && typeof m.context.offset === 'number' ? m.context.offset : null);
      const len = (typeof m.length === 'number') ? m.length : (m.context && typeof m.context.length === 'number' ? m.context.length : null);
      if (start !== null && len !== null) ranges.push({ start, end: start + len, match: m });
    }
    ranges.sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const r of ranges) {
      if (r.start > cursor) segments.push({ text: text.slice(cursor, r.start), underline: false });
      segments.push({ text: text.slice(r.start, r.end), underline: true, match: r.match, start: r.start, end: r.end });
      cursor = r.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), underline: false });
  }

  // Create html
  const frag = document.createDocumentFragment();
  segments.forEach(seg => {
    if (!seg.underline) {
      frag.appendChild(document.createTextNode(seg.text));
    } else {
      const s = document.createElement('span');
      s.className = 'ai-underline';
      s.dataset.start = seg.start;
      s.dataset.end = seg.end;
      s.dataset.message = seg.match && seg.match.message ? seg.match.message : '';
      s.dataset.replacements = JSON.stringify(seg.match && seg.match.replacements ? seg.match.replacements.map(r => r.value) : []);
      s.textContent = seg.text;
      frag.appendChild(s);
    }
  });

  // Replace content safely — attempt to preserve caret by saving selection (best-effort)
  const sel = window.getSelection();
  const ranges = sel.rangeCount > 0 ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i).cloneRange()) : null;
  elm.innerHTML = '';
  elm.appendChild(frag);
  // restore selection to end
  if (elm.childNodes.length > 0) {
    placeCaretAtEnd(elm);
  }
}

// place caret at end (for contenteditable)
function placeCaretAtEnd(el) {
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Create and show suggestion bubble near a target element/span
let currentSuggestion = null;
function showSuggestionPopup(anchorRect, message, replacements, onReplace) {
  removeSuggestionPopup();
  const popup = el('div', { class: 'ai-suggestion-popup' });
  popup.style.position = 'absolute';
  popup.style.zIndex = 2147483647;
  popup.style.background = '#fff';
  popup.style.border = '1px solid #ccc';
  popup.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
  popup.style.padding = '8px';
  popup.style.borderRadius = '8px';
  popup.style.minWidth = '200px';
  popup.style.fontSize = '13px';

  const msgP = el('div', {}, [message || 'Suggestion']);
  popup.appendChild(msgP);

  // list replacements
  if (replacements && replacements.length > 0) {
    const ul = el('div', { style: { marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' } });
    replacements.forEach(r => {
      const btn = el('button', { class: 'ai-sugg-btn' }, [r]);
      btn.style.padding = '6px 8px';
      btn.style.borderRadius = '6px';
      btn.style.border = '1px solid #ddd';
      btn.style.background = '#f7f7f7';
      btn.addEventListener('click', () => {
        onReplace(r);
        removeSuggestionPopup();
      });
      ul.appendChild(btn);
    });
    popup.appendChild(ul);
  } else {
    // fallback replace button (no alternatives provided)
    const btn = el('button', {}, ['Replace']);
    btn.addEventListener('click', () => {
      onReplace(null);
      removeSuggestionPopup();
    });
    popup.appendChild(el('div', { style: { marginTop: '6px', textAlign: 'right' } }, [btn]));
  }

  document.body.appendChild(popup);
  // position
  const top = anchorRect.bottom + window.scrollY + 6;
  const left = Math.min(window.scrollX + anchorRect.left, window.innerWidth - 240);
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  currentSuggestion = popup;
}

function removeSuggestionPopup() {
  if (currentSuggestion && currentSuggestion.parentNode) currentSuggestion.parentNode.removeChild(currentSuggestion);
  currentSuggestion = null;
}

// Translation picker small UI
function showTranslatePicker(anchorRect, currentText, onTranslateChoose) {
  removeTranslatePicker();
  const pick = el('div', { class: 'ai-translate-picker' });
  Object.assign(pick.style, {
    position: 'absolute', zIndex: 2147483647, background: '#fff', border: '1px solid #ccc',
    padding: '8px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
  });

  const label = el('div', {}, ['Translate to:']);
  const select = el('select', { style: { marginTop: '6px', width: '100%' } });
  const languages = [
    ['no', '— None —'],
    ['hi', 'Hindi'],
    ['mr', 'Marathi'],
    ['bn', 'Bengali'],
    ['ta', 'Tamil'],
    ['te', 'Telugu'],
    ['de', 'German'],
    ['fr', 'French'],
    ['it', 'Italian'],
    ['pt', 'Portuguese'],
    ['ru', 'Russian'],
    ['nl', 'Dutch'],
    ['pl', 'Polish'],
    ['sv', 'Swedish'],
    ['ja', 'Japanese'],
    ['ko', 'Korean'],
    ['zh', 'Chinese'],
    ['es', 'Spanish'],
    ['ar', 'Arabic']
  ];
  languages.forEach(([code, name]) => {
    const op = el('option', { value: code }, [name]);
    select.appendChild(op);
  });
  // default to current setting
  select.value = settings.targetLang || 'no';

  const btn = el('button', {}, ['Translate']);
  btn.style.marginTop = '8px';
  btn.addEventListener('click', async () => {
    const tgt = select.value;
    if (!tgt || tgt === 'no') {
      removeTranslatePicker();
      return;
    }
    const translated = await translateText(currentText, tgt);
    onTranslateChoose(tgt, translated);
    removeTranslatePicker();
  });

  pick.appendChild(label);
  pick.appendChild(select);
  pick.appendChild(btn);

  document.body.appendChild(pick);
  pick.style.left = Math.min(window.scrollX + anchorRect.left, window.innerWidth - 260) + 'px';
  pick.style.top = anchorRect.bottom + window.scrollY + 8 + 'px';
}

function removeTranslatePicker() {
  const ex = document.querySelectorAll('.ai-translate-picker');
  ex.forEach(n => n.remove());
}

// small floating translate button near focused element
function createOrShowTranslateButton(elm) {
  removeTranslateButton();
  const rect = elm.getBoundingClientRect();
  const btn = el('button', { class: 'ai-translate-btn' }, ['🌐']);
  Object.assign(btn.style, {
    position: 'absolute',
    zIndex: 2147483647,
    width: '34px',
    height: '34px',
    borderRadius: '8px',
    border: '1px solid #ccc',
    background: '#fff',
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,0.12)'
  });
  btn.title = 'Translate this field';
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const text = getTextFromField(elm);
    showTranslatePicker(rect, text, async (tgt, translated) => {
      if (!translated) return;
      // apply translation either autoReplace or via suggestion
      if (settings.autoReplace) {
        setTextToField(elm, translated);
      } else {
        // show inline suggestion popup with single replacement
        showSuggestionPopup(rect, 'Translated text', [translated], (r) => {
          setTextToField(elm, r || translated);
        });
      }
    });
  });
  document.body.appendChild(btn);
  // position it near top-right of field
  btn.style.left = (rect.right + window.scrollX - 40) + 'px';
  btn.style.top = (rect.top + window.scrollY - 6) + 'px';

  // store so we can remove later
  document._ai_current_translate_btn = btn;
}

function removeTranslateButton() {
  if (document._ai_current_translate_btn) {
    document._ai_current_translate_btn.remove();
    document._ai_current_translate_btn = null;
  }
}

// helpers to get/set field text
function getTextFromField(field) {
  if (!field) return '';
  if (field.isContentEditable) return field.innerText || '';
  if (field.tagName === 'TEXTAREA' || field.tagName === 'INPUT') return field.value || '';
  return '';
}
function setTextToField(field, newText) {
  if (!field) return;
  if (field.isContentEditable) {
    field.innerText = newText;
    placeCaretAtEnd(field);
  } else {
    field.value = newText;
    // try to set selection at end
    try {
      field.setSelectionRange(newText.length, newText.length);
    } catch (e) {}
  }
  // trigger input event
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// main process for an element (get grammar matches and render)
async function processField(elm) {
  if (!settings.enabled) return;
  const text = getTextFromField(elm);
  if (!text || !text.trim()) {
    // hide overlays/suggestions
    const st = elementState.get(elm);
    if (st && st.overlay) st.overlay.style.display = 'none';
    return;
  }

  // store state
  const st = elementState.get(elm) || {};
  elementState.set(elm, st);

  const grammar = await callGrammarAPI(text);
  const matches = (grammar && grammar.matches) ? grammar.matches : [];

  // Save matches on element state
  st.matches = matches;

  if (elm.isContentEditable) {
    renderContentEditable(elm, text, matches);
  } else {
    renderOverlay(elm, text, matches);
  }

  // If autoReplace ON: apply full corrected text
  if (settings.autoReplace && (matches && matches.length > 0)) {
    const corrected = applyGrammarReplacements(text, matches);
    setTextToField(elm, corrected);
  }
}

// map of currently observed elements (to manage overlays and event handlers)
const observed = new WeakSet();

// attach events to an element
function attachToField(elm) {
  if (!elm || observed.has(elm)) return;
  observed.add(elm);

  // create overlay for non-contenteditable
  if (!elm.isContentEditable) createMirrorOverlayFor(elm);

  // sync overlay position on scroll/resize
  const reposition = () => {
    if (elm.isContentEditable) return;
    syncOverlayPosition(elm);
  };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  // show translate button on focus
  elm.addEventListener('focus', (ev) => {
    createOrShowTranslateButton(elm);
    // initial quick process
    debounce(() => processField(elm))();
  });

  elm.addEventListener('blur', (ev) => {
    // hide overlay after short delay so clicks on underline still work
    setTimeout(() => {
      const st = elementState.get(elm);
      if (st && st.overlay) st.overlay.style.display = 'none';
      removeTranslateButton();
      removeSuggestionPopup();
    }, 200);
  });

  // on input, debounce check
  elm.addEventListener('input', debounce(() => processField(elm)));

  // clicks on overlay/underline (for inputs we placed underline spans in overlay)
  // Because overlay spans have pointer-events: auto, handle clicks at document level
  document.addEventListener('click', (e) => {
    if (!settings.enabled) return;
    const target = e.target;
    // if clicked on an underline span
    if (target && target.classList && target.classList.contains('ai-underline')) {
      e.preventDefault();
      e.stopPropagation();
      // identify parent field by searching which field has overlay containing this span (for inputs)
      let parentField = null;
      // check inputs/textarea
      for (const node of document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [contenteditable]')) {
        // contenteditable case: target will be inside that node
        if (node.contains(target)) {
          parentField = node;
          break;
        }
        // overlay case: overlay is separate; check elementState overlay
        const st = elementState.get(node);
        if (st && st.overlay && st.overlay.contains(target)) {
          parentField = node;
          break;
        }
      }

      // extract match info
      const replacements = JSON.parse(target.dataset.replacements || '[]');
      const message = target.dataset.message || 'Suggestion';
      const rect = target.getBoundingClientRect();

      // show popup so user can pick a replacement
      showSuggestionPopup(rect, message, replacements, (chosen) => {
        // replace the specific substring in the field
        const st = elementState.get(parentField) || {};
        const mstart = parseInt(target.dataset.start || '-1', 10);
        const mend = parseInt(target.dataset.end || '-1', 10);
        if (parentField) {
          if (parentField.isContentEditable) {
            // replace by reconstructing the text
            const txt = getTextFromField(parentField);
            const newTxt = txt.slice(0, mstart) + (chosen || (replacements[0] || '')) + txt.slice(mend);
            setTextToField(parentField, newTxt);
            // re-run grammar for accuracy
            debounce(() => processField(parentField))();
          } else {
            const txt = getTextFromField(parentField);
            const newTxt = txt.slice(0, mstart) + (chosen || (replacements[0] || '')) + txt.slice(mend);
            setTextToField(parentField, newTxt);
            debounce(() => processField(parentField))();
          }
        }
      });
    } else {
      // if clicked elsewhere — close popups
      removeSuggestionPopup();
      removeTranslatePicker();
    }
  }, true); // capture so we handle overlay spans that might be above inputs
}

// observe the page and attach to editable nodes
function initObserver() {
  // attach to existing fields
  document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [contenteditable]').forEach(el => {
    if (el.tagName === 'INPUT' && el.type !== 'text') return;
    attachToField(el);
  });

  // MutationObserver to catch dynamic fields (single-pass)
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement)) return;
          // find nested editable fields
          node.querySelectorAll && node.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [contenteditable]').forEach(el => {
            if (el.tagName === 'INPUT' && el.type !== 'text') return;
            attachToField(el);
          });
          if (node.matches && (node.matches('textarea') || node.matches('input[type="text"]') || node.matches('[contenteditable]'))) {
            attachToField(node);
          }
        });
      }
    }
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

// initial boot
try {
  initObserver();
} catch (e) {
  console.warn('AI assistant init error', e);
}
