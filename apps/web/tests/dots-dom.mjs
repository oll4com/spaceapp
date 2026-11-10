// Shared by the authenticated Dots proof (scripts/dots-chat-proof.mjs) and dots-proof-probe-dom.test.tsx: kept here because the public tree ships apps/web/tests, not that script.
// Only this fixed function is evaluated. The caller cannot supply JavaScript,
// selectors, dimensions, fault targets or arbitrary browser actions.
export function dotsDom(selector, action, value) {
  if (action === 'restore-fetch') {
    const proof = window.__spaceDotsChatProof;
    if (proof) { window.fetch = proof.originalFetch; delete window.__spaceDotsChatProof; }
    return !proof || window.fetch === proof.originalFetch;
  }
  const pane = document.querySelector(selector);
  if (!pane) return null;
  const labels = ['Orbit', 'Nova', 'Byte', 'Comet', 'Luna', 'Cosmo'];
  const visible = node => node instanceof HTMLElement && node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== 'hidden';
  const buttons = scope => [...pane.querySelectorAll(scope)].filter(visible);
  const exact = (scope, name) => buttons(scope).find(b => (b.getAttribute('aria-label') ?? b.textContent.trim()) === name);
  const trigger = () => buttons('button[aria-haspopup="menu"]').find(b => (b.getAttribute('aria-label') ?? '').startsWith('Choose Dot'));
  const menu = () => pane.querySelector('[role="menu"][aria-label="Dots"]');
  const choices = () => menu() ? [...menu().querySelectorAll('button[role="menuitemradio"]')].filter(visible) : [];
  const selected = () => labels.find(name => trigger()?.getAttribute('aria-label') === `Choose Dot (${name})`) ?? null;
  const shell = () => pane.querySelector('.dots-chat-shell');
  const card = () => pane.querySelector('aside.dots-info-card');
  // The pane may be renamed from its first task, which changes the composer's label.
  const textarea = () => pane.querySelector('.codex-composer textarea[aria-label^="Message "]');
  const p = () => pane.getBoundingClientRect();
  const within = node => {
    const r = node?.getBoundingClientRect(), b = p();
    return !!r && r.width > 0 && r.height > 0 && r.left >= b.left - 1 && r.right <= b.right + 1 && r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
  };
  const chatGeometry = () => {
    const transcript = pane.querySelector('.chat-transcript-region'), composer = pane.querySelector('.codex-composer');
    return { transcriptVisible: visible(transcript), transcriptHeight: transcript?.getBoundingClientRect().height ?? 0,
      transcriptWithinPane: within(transcript), composerVisible: visible(composer) && visible(textarea()),
      composerWithinPane: within(composer) && within(textarea()) };
  };
  const draft = () => {
    const text = textarea()?.value;
    // Unexpected text is never returned to the agent or included in errors.
    return ['', 'Owned Stage2 Nova draft — final N', 'Owned Stage2 Orbit draft — final O'].includes(text) ? text : null;
  };
  const media = () => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    color: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', print: matchMedia('print').matches });
  if (action === 'original') return { style: pane.getAttribute('style'), media: media() };
  if (action === 'resize') {
    if (![900, 1040, 550, 360].includes(value)) throw Error('Invalid fixed proof geometry');
    pane.style.cssText += `position:fixed!important;left:80px!important;top:70px!important;width:${value}px!important;height:700px!important;min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;z-index:100!important`;
    return true;
  }
  if (action === 'isolate') {
    // Page controls stacked over the owned pane (for example the Rooms dock's room buttons) are hidden only
    // while a screenshot is taken; nothing inside the pane or containing it is touched.
    document.getElementById('space-dots-proof-isolation')?.remove();
    document.querySelectorAll('[data-space-dots-proof-behind]').forEach(node => node.removeAttribute('data-space-dots-proof-behind'));
    if (!value) return true;
    const box = p();
    for (const node of document.body.querySelectorAll('*')) {
      if (pane.contains(node) || node.contains(pane)) continue;
      const r = node.getBoundingClientRect();
      if (r.width && r.height && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom) node.setAttribute('data-space-dots-proof-behind', '');
    }
    const style = document.createElement('style');
    style.id = 'space-dots-proof-isolation';
    style.textContent = '[data-space-dots-proof-behind]{visibility:hidden!important}';
    document.head.appendChild(style);
    return true;
  }
  if (action === 'restore') {
    document.getElementById('space-dots-proof-isolation')?.remove();
    document.querySelectorAll('[data-space-dots-proof-behind]').forEach(node => node.removeAttribute('data-space-dots-proof-behind'));
    if (value.style === null) pane.removeAttribute('style'); else pane.setAttribute('style', value.style);
    // The details card choice the proof made is forgotten.
    try { localStorage.removeItem(`space.dotPane.panel.${pane.getAttribute('data-space-pane-id')}`); } catch { /* storage unavailable */ }
    const now = media();
    return { dimensions: pane.getAttribute('style') === value.style,
      media: now.reduced === value.media.reduced && now.color === value.media.color && now.print === value.media.print };
  }
  if (action === 'fail-feed') {
    if (window.__spaceDotsChatProof) throw Error('Dots proof interception already exists');
    const proof = { originalFetch: window.fetch, failedRead: false };
    window.__spaceDotsChatProof = proof;
    window.fetch = function(input, init) {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.origin);
      if (!proof.failedRead && url.pathname === `/api/dots/${encodeURIComponent(value)}/feed` &&
        (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase() === 'GET') {
        proof.failedRead = true; window.fetch = proof.originalFetch;
        return Promise.reject(new TypeError('Owned Dots proof: feed read unavailable'));
      }
      return proof.originalFetch.call(this, input, init);
    };
    return true;
  }
  if (action === 'point' || action === 'focus') {
    const node = value.kind === 'menu' ? trigger()
      : value.kind === 'dot' ? choices().find(b => b.getAttribute('aria-label') === `Select ${value.name}`)
        : value.kind === 'composer' ? textarea()
          : value.kind === 'retry' ? buttons('.dots-feed-state button').find(b => b.textContent.trim() === 'Retry')
            : value.kind === 'details' ? exact('button[aria-pressed]', `${value.name} details`)
              : value.kind === 'close-details' ? exact('.dots-info-card button', 'Close details') : null;
    if (!visible(node) || node.disabled) return null;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    if (action === 'focus') node.focus();
    const r = node.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    // Keyboard activation needs the control focused, not uncovered; pointer activation needs it uncovered.
    if (action === 'focus') return document.activeElement === node ? { x, y } : null;
    const hit = document.elementFromPoint(x, y);
    return hit === node || node.contains(hit) ? { x, y } : null;
  }
  if (action === 'draft') return draft();
  if (action === 'snapshot') {
    const status = pane.querySelector('.dots-status')?.textContent.trim();
    return { selected: selected(), menuOpen: !!menu(), status: ['Ready', 'Working', 'Waiting for approval', 'Paused', 'Offline', 'Status unavailable'].includes(status) ? status : null,
      composerReady: visible(textarea()) && !textarea().disabled, ...chatGeometry(), width: p().width,
      noOverflow: pane.scrollWidth <= pane.clientWidth + 1 &&
        [...pane.querySelectorAll('.dots-header, .dots-chat-shell')].every(n => n.scrollWidth <= n.clientWidth + 1) };
  }
  if (action === 'mascots') {
    return labels.map(name => { const b = choices().find(c => c.getAttribute('aria-label') === `Select ${name}`), avatar = b?.querySelector('.dot-avatar');
      const box = avatar?.querySelector('svg')?.getBoundingClientRect();
      return { name, character: avatar?.getAttribute('data-character') ?? null, drawn: !!avatar?.querySelector('.dot-av-figure path'),
        width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0), visible: visible(b) }; });
  }
  if (action === 'home') {
    const feed = pane.querySelector('[role="log"].dots-feed'), composer = pane.querySelector('.codex-composer');
    const has = query => !!composer?.querySelector(query) && visible(composer.querySelector(query));
    return { feedVisible: visible(feed), userMessages: feed?.querySelectorAll('.dots-bubble.user').length ?? 0,
      dotMessages: feed?.querySelectorAll('.dots-bubble.dot:not(.working)').length ?? 0,
      roomAgentLabel: !!pane.querySelector('.room-agent-message-label'), tabs: pane.querySelectorAll('[role="tab"]').length,
      chips: pane.querySelectorAll('.dots-wide-selector button').length, historySelect: !!pane.querySelector('select[aria-label="Dot session history"]'),
      settingsGear: !!pane.querySelector('button[title="Dot settings"]'),
      composer: { add: has('.room-agent-add-trigger'), voice: has('.voice-input-control'), send: has('.codex-send'),
        modelPicker: !!composer?.querySelector('.terminal-model-picker, .codex-model-unavailable'),
        shortcuts: !!composer?.querySelector('button[aria-label="CLI shortcuts"]'), variables: !!composer?.querySelector('button[aria-label^="Prompt variables"]') } };
  }
  if (action === 'feed-state') {
    const state = pane.querySelector('.dots-feed-state');
    return { injected: window.__spaceDotsChatProof?.failedRead === true,
      unavailableVisible: visible(state) && state.textContent.trim().startsWith('Earlier messages are unavailable.'),
      retryVisible: !!state && [...state.querySelectorAll('button')].some(b => visible(b) && b.textContent.trim() === 'Retry'),
      welcomeVisible: visible(pane.querySelector('.dots-feed-welcome')), ready: visible(pane.querySelector('[role="log"].dots-feed')) && !visible(state) };
  }
  if (action === 'card') {
    const aside = card();
    return { open: visible(aside), docked: shell()?.getAttribute('data-panel') === 'docked', overlay: shell()?.getAttribute('data-panel') === 'overlay',
      withinPane: within(aside), call: !!aside && [...aside.querySelectorAll('button')].some(b => visible(b) && b.textContent.trim() === 'Call'),
      computer: !!aside?.querySelector('.dots-info-computer') && visible(aside.querySelector('.dots-info-computer')) };
  }
  if (action === 'narrow') {
    const m = menu(), radios = choices(), rects = radios.map(n => n.getBoundingClientRect()), b = p();
    const positions = key => new Set(rects.map(r => Math.round(r[key]))).size;
    return { ...chatGeometry(), width: b.width, count: radios.length, manage: !!m?.querySelector('button.dots-choice-manage'),
      columns: positions('left'), rows: positions('top'), noOverflow: pane.scrollWidth <= pane.clientWidth + 1 &&
        !!m && m.scrollWidth <= m.clientWidth + 1 && rects.every(r => r.left >= b.left && r.right <= b.right + 1),
      keyboardFocused: radios.includes(document.activeElement), escapeClosed: !m,
      focusedIndex: radios.indexOf(document.activeElement),
      focusReturned: !!trigger() && document.activeElement === trigger(),
      namesMatch: radios.every((r, i) => r.textContent.trim() === labels[i]),
      mascotsDrawn: radios.every(r => (r.querySelector('.dot-avatar svg')?.getBoundingClientRect().width ?? 0) > 0) };
  }
  if (action === 'motion') {
    // The animated avatar inside the header wrapper is what moves.
    const wrapper = pane.querySelector('.dots-selected-mascot .dot-avatar'), style = wrapper && getComputedStyle(wrapper);
    return { matches: media().reduced, selectedMascotFound: visible(wrapper),
      stopped: !!style && (style.animationName === 'none' || style.animationPlayState.split(',').every(state => state.trim() === 'paused')) };
  }
  throw Error('Unknown fixed Dots proof action');
}
