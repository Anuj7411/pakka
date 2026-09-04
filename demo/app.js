/**
 * Pakka console - the ported design of record, wired to the real gate.
 *
 * Plain ES module, no framework, no build step. Nothing about a decision is
 * computed here: the browser posts a run to `demo/api.ts`, which calls the same
 * `evaluate()` the harness and the Razorpay demo use, signs the certificate with
 * a real Ed25519 key, and appends it to the real hash-chained audit log. This
 * file renders what comes back.
 *
 * That division is deliberate. The private signing key must never reach a
 * browser, and a gate whose verdict is computed client-side is a gate an
 * attacker edits with devtools.
 *
 * The three surfaces are one document switched by `state.view`, because the
 * playground, the certificate and the checkout share one run. `/`, `/play` and
 * `/checkout` are real routes: the server returns this page for all three and
 * the module reads `location.pathname` on boot.
 */

/* ── seals ───────────────────────────────────────────────────────────────
 * Inlined rather than linked so they take `currentColor` and cost no request.
 * Geometry is the brand's, unchanged: chamfer top-right, butt caps, mitre
 * joins. The asking seal draws one stemless chevron - the layer that can raise
 * a hand - and never the stem.
 */
const SEAL_ASKING = (px) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 32 32" aria-label="checking">` +
  `<path d="M0 0H22L32 10V32H0Z" fill="none" stroke="currentColor" stroke-width="1.4"></path>` +
  `<g transform="translate(-0.6,0.6)" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="butt" stroke-linejoin="miter">` +
  `<path d="M25 8L17 16L25 24"></path></g></svg>`;

const SEAL_SIGNED_INK = (px) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 32 32" aria-hidden="true">` +
  `<path d="M0 0H22L32 10V32H0Z" fill="#0E100C"></path>` +
  `<g transform="translate(-0.6,0.6)" stroke="#F5F2E9" stroke-width="3" fill="none" stroke-linejoin="miter">` +
  `<path d="M8 8V24"></path><path d="M16 8L8 16L16 24"></path><path d="M25 8L17 16L25 24"></path></g></svg>`;

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Everything interpolated into markup goes through this. */
function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const $ = (sel) => document.querySelector(sel);

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

/* ── state ───────────────────────────────────────────────────────────── */

const state = {
  view: 'argument',
  /** Boot payload: the scenario list, the catalogue, categories, keys, chain. */
  meta: null,
  activeScenario: null,
  showCustom: false,
  /** The viewer's custom inputs; index null until they open the sandbox. */
  custom: { itemIndex: 5, quantity: 3, statedQuantity: 1, authorisedCategory: 'Tools & Home Improvement' },
  running: false,
  stage: '',
  run: null,
  chain: null,
  error: null,
  vpa: 'success@razorpay',
  pay: 'idle',
  failCode: '',
  order: null,
  orderError: null,
  /** What the SERVER confirmed after re-fetching from Razorpay. Never Checkout's word. */
  payment: null,
};

/* ── the run ─────────────────────────────────────────────────────────── */

/** Shared prologue: clear the last run, show the waiting seal, then fetch. */
async function performRun(label, fetcher) {
  state.activeScenario = label;
  state.running = true;
  state.stage = 'normalising mandate and cart';
  state.run = null;
  state.error = null;
  state.pay = 'idle';
  state.order = null;
  state.orderError = null;
  state.payment = null;
  render();

  // Two frames so the asking seal is actually on screen before the request
  // blocks. It holds still while it is there: it is a state, not a spinner.
  // Raced against a timeout because requestAnimationFrame is paused in a
  // background tab: without the fallback, starting a run and switching away
  // would stall it until you came back.
  await new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => requestAnimationFrame(fin));
    setTimeout(fin, 150);
  });
  state.stage = 'real gate · deterministic checkers, judge, lattice join, Ed25519';
  render();

  try {
    const view = await fetcher();
    if (view.error) throw new Error(view.error);
    state.run = view;
    state.chain = view.chain;
  } catch (e) {
    // An outage is not a verdict. It must never render as a decision.
    state.error = e.message;
  } finally {
    state.running = false;
    state.stage = '';
    render();
  }
}

function runScenario(id) {
  state.showCustom = false;
  return performRun(id, () => getJSON(`/api/run?scenario=${encodeURIComponent(id)}`));
}

function runCustom() {
  return performRun('custom', () =>
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.custom),
    }).then((r) => r.json()),
  );
}

function reset() {
  state.activeScenario = null;
  state.showCustom = false;
  state.run = null;
  state.error = null;
  state.pay = 'idle';
  state.order = null;
  state.orderError = null;
  state.payment = null;
  render();
  // The chain is not reset: it is a real append-only log, and a Reset button
  // that emptied it would be advertising exactly the property it does not have.
  getJSON('/api/chain').then((c) => { state.chain = c; render(); }).catch(() => {});
}

function payFailed(code, reason) {
  state.pay = 'failed';
  state.failCode = code;
  state.orderError = reason;
  state.payment = null;
  render();
}

/**
 * Hand a checkout callback to the server and render what the server confirms.
 *
 * Never what Checkout said. The browser's `razorpay_payment_id` is a claim; the
 * server verifies the signature and then re-fetches the payment from Razorpay,
 * and it is that fetched `status` which decides whether this page says captured.
 */
async function settle(body) {
  state.pay = 'confirming';
  render();

  let r;
  try {
    const res = await fetch('/api/payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    r = await res.json();
  } catch (e) {
    payFailed('CONFIRM_ERROR', e.message);
    return;
  }

  if (!r.ok) {
    payFailed('UNVERIFIED', r.reason);
    return;
  }

  state.payment = r;
  const status = r.payment.status;
  if (status === 'captured' || status === 'authorized') {
    state.pay = 'captured';
  } else {
    state.pay = 'failed';
    state.failCode = `${r.payment.errorCode || 'PAYMENT'} · ${r.payment.errorReason || status}`;
    state.orderError = null;
  }
  render();
}

async function doPay(vpa) {
  state.pay = 'creating';
  state.orderError = null;
  state.payment = null;
  render();

  let o;
  try {
    o = await getJSON('/api/order');
  } catch (e) {
    payFailed('ORDER_ERROR', e.message);
    return;
  }

  if (!o.ok) {
    payFailed(o.refused ? `GATE_REFUSAL · ${o.decision}` : 'ORDER_ERROR', o.reason);
    return;
  }

  state.order = o;
  if (o.chain) state.chain = o.chain;

  if (typeof Razorpay !== 'function') {
    // The order exists and the certificate stands; only the SDK is missing.
    // Said plainly rather than rendered as a payment failure.
    payFailed('CHECKOUT_UNAVAILABLE', 'Razorpay Checkout did not load. The order was created and the certificate is unaffected.');
    return;
  }

  state.pay = 'awaiting';
  render();

  const rzp = new Razorpay({
    key: o.keyId,
    order_id: o.order.id,
    amount: o.order.amountPaise,
    currency: o.order.currency,
    name: 'Pakka',
    description: o.description,
    notes: { conformance_certificate_id: o.certificateId },
    prefill: { method: 'upi', vpa },
    theme: { color: '#E8C400' },
    handler: (resp) =>
      settle({
        payment_id: resp.razorpay_payment_id,
        order_id: resp.razorpay_order_id,
        signature: resp.razorpay_signature,
      }),
    modal: {
      ondismiss: () => {
        state.pay = 'idle';
        render();
      },
    },
  });

  // A declined payment carries no signature, so it is settled by id alone -
  // the server still re-fetches it and still checks it belongs to this order.
  rzp.on('payment.failed', (e) => {
    const d = (e && e.error) || {};
    const pid = d.metadata && d.metadata.payment_id;
    if (pid) settle({ payment_id: pid, order_id: o.order.id });
    else payFailed(`${d.code || 'PAYMENT_FAILED'} · ${d.reason || 'declined'}`, d.description || null);
  });

  rzp.open();
}

/* ── routing ─────────────────────────────────────────────────────────── */

const PATHS = { argument: '/', play: '/play', checkout: '/checkout' };

function viewFromPath(p) {
  if (p.startsWith('/play')) return 'play';
  if (p.startsWith('/checkout')) return 'checkout';
  return 'argument';
}

function go(view, push = true) {
  state.view = view;
  if (push && location.pathname !== PATHS[view]) history.pushState({ view }, '', PATHS[view]);
  render();
  window.scrollTo(0, 0);
  ensurePlayRun();
}

// The v2 playground is designed around a run always being present. Opening it
// with no run auto-runs the injection, so the page shows the full design rather
// than an empty shell. It is a real run: it signs a certificate and grows the
// chain, exactly like pressing the tab.
function ensurePlayRun() {
  if (state.view === 'play' && state.meta && !state.run && !state.running) {
    runScenario('injection');
  }
}

window.addEventListener('popstate', () => {
  state.view = viewFromPath(location.pathname);
  render();
  ensurePlayRun();
});

/* ── rendering ───────────────────────────────────────────────────────── */

const kvRows = (rows) =>
  rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');

const PAY_STATUS = {
  idle: 'test mode · no money moves',
  creating: 'creating the real order · re-deriving cart hash',
  awaiting: 'Razorpay Checkout is open · test mode',
  confirming: 'verifying the signature and re-fetching the payment',
};

/* ── v2 playground rendering ─────────────────────────────────────────────
 * The "six objects, six forms" design of record, ported. Each object takes the
 * form of the thing it is; none is a generic table. See demo/play.css.
 */

const VC = { allow: 'allow', escalate: 'escalate', block: 'block' };

// Seals, inlined so they take fixed brand colours and cost no request.
const NAV_SEAL =
  '<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path d="M0 0H20L32 12V32H0Z" fill="#E8C400"></path>' +
  '<g transform="translate(-0.6,0.6)" stroke="#0E100C" stroke-width="3.5" fill="none" stroke-linecap="butt" stroke-linejoin="miter">' +
  '<path d="M8 8V24"></path><path d="M16 8L8 16L16 24"></path><path d="M25 8L17 16L25 24"></path></g></svg>';
const NAV_WORDMARK =
  '<svg viewBox="-2 -2 132 38" width="86" height="25" fill="none" stroke="#F5F2E9" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="1.05" stroke-width="4.6" aria-label="PAKKA">' +
  '<path d="M2.3 0V32"></path><path d="M2.3 2.3H13.3L17.7 6.7V16.5H2.3"></path><path d="M26.2 32L34.2 2.3H41.2L49.2 32"></path><path d="M29.7 22.5H45.7"></path><path d="M57.3 0V32"></path><path d="M74 0L57.3 16L74 32"></path><path d="M79.3 0V32"></path><path d="M96 0L79.3 16L96 32"></path><path d="M103.7 32L111.7 2.3H118.7L126.7 32"></path><path d="M107.2 22.5H123.2"></path></svg>';
const SIG_SEAL =
  '<svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><path d="M0 0H20L32 12V32H0Z" fill="#0E100C"></path>' +
  '<g transform="translate(-0.6,0.6)" stroke="#F5F2E9" stroke-width="3.5" fill="none" stroke-linejoin="miter"><path d="M8 8V24"></path><path d="M16 8L8 16L16 24"></path><path d="M25 8L17 16L25 24"></path></g></svg>';
const CERT_SEAL =
  '<svg width="46" height="46" viewBox="0 0 32 32" aria-hidden="true"><path d="M0 0H22L32 10V32H0Z" fill="#E8C400"></path>' +
  '<g transform="translate(-0.6,0.6)" stroke="#0E100C" stroke-width="3" fill="none" stroke-linecap="butt" stroke-linejoin="miter"><path d="M8 8V24"></path><path d="M16 8L8 16L16 24"></path><path d="M25 8L17 16L25 24"></path></g></svg>';
const STATE_SEAL = (running) =>
  `<svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true"><path d="M0 0H22L32 10V32H0Z" fill="${running ? '#E8C400' : 'none'}" stroke="#0E100C" stroke-width="1.4"></path>` +
  '<g transform="translate(-0.6,0.6)" stroke="#0E100C" stroke-width="3" fill="none" stroke-linejoin="miter"><path d="M25 8L17 16L25 24"></path></g></svg>';

const BOUND_KEY = {
  'authorised category': 'category',
  'stated quantity': 'quantity',
  'stated finish': 'finish',
  'stated ceiling': 'ceiling',
  'mandate expires': 'expires',
};
const CAT_SHORT = (c) => (c === 'Tools & Home Improvement' ? 'Tools & Home' : c);

function pvNavbar() {
  const meta = state.meta;
  const signed = state.chain ? state.chain.records : 0;
  const policy = state.run ? state.run.policyShort : (meta ? '-' : '-');
  return `<div class="pv-nav">
    <div class="pv-nav-left">
      <a href="/" data-view="argument" aria-label="Pakka home" style="display:flex;align-items:center;gap:13px">${NAV_SEAL}${NAV_WORDMARK}</a>
      <span class="pv-nav-chip">playground</span>
    </div>
    <div class="pv-nav-right">
      <a href="/" data-view="argument">the argument</a>
      <a href="/checkout" data-view="checkout">checkout</a>
      <span class="pv-nav-policy">policy ${esc(policy)}</span>
      <span class="pv-nav-signed">${signed} signed</span>
    </div>
  </div>`;
}

function pvRunbar() {
  const meta = state.meta;
  const tabs = (meta ? meta.scenarios : [])
    .map((s) => {
      const on = state.activeScenario === s.id && !state.showCustom;
      return `<button class="pv-tab${on ? ' is-active' : ''}" data-act="run" data-id="${esc(s.id)}" title="${esc(s.blurb)}">
        <div class="pv-tab-top"><span class="pv-tab-dot pv-bg-${esc(s.expect)}"></span>
          <span class="pv-tab-title">${esc(s.title)}</span></div>
        <div class="pv-tab-verdict pv-verdict-${esc(s.expect)}${s.expect === 'escalate' ? '-c' : ''}">${esc(s.expect)}</div>
      </button>`;
    })
    .join('');
  return `<div class="pv-runbar">
    <div class="pv-runbar-label">Run</div>
    ${tabs}
    <button class="pv-runbtn${state.showCustom ? ' is-active' : ''}" data-act="toggle-custom">Sandbox</button>
    <button class="pv-runbtn pv-runbtn--reset" data-act="reset">Reset</button>
  </div>`;
}

function pvSandbox() {
  if (!state.showCustom) return '';
  const meta = state.meta;
  const c = state.custom;
  const items = meta.catalogue
    .map((p, i) => `<option value="${i}"${i === c.itemIndex ? ' selected' : ''}>${esc(p.idx + '  ' + p.name)}</option>`)
    .join('');
  const cats = meta.categories
    .map((cat) => `<option value="${esc(cat)}"${cat === c.authorisedCategory ? ' selected' : ''}>${esc(cat)}</option>`)
    .join('');
  const statedVal = c.statedQuantity === null ? 'unstated' : String(c.statedQuantity);
  const stated = ['1', '2', '3', 'unstated']
    .map((v) => `<option value="${v === 'unstated' ? 'null' : v}"${statedVal === v ? ' selected' : ''}>${v}</option>`)
    .join('');
  return `<div class="pv-sandbox">
    <div class="pv-sandbox-head"><b>Sandbox</b><span>Set the four things that decide the verdict, then run it.</span></div>
    <div class="pv-sandbox-grid">
      <label><span>Item the agent adds</span><select class="pv-select" data-custom="itemIndex">${items}</select></label>
      <label><span>Quantity in cart</span><input class="pv-input" type="number" min="1" max="9" value="${esc(c.quantity)}" data-custom="quantity"></label>
      <label><span>Quantity stated</span><select class="pv-select" data-custom="statedQuantity">${stated}</select></label>
      <label><span>Authorised category</span><select class="pv-select" data-custom="authorisedCategory">${cats}</select></label>
      <button class="pv-sandbox-run" data-act="run-custom">Run the gate</button>
    </div>
  </div>`;
}

function pvInstruction() {
  const r = state.run;
  const meta = state.meta;
  const instruction = r ? r.instruction : (meta ? 'i need a wall sconce for the hallway, brushed brass, just one, under ₹4,000' : '');
  const mandate = r ? r.mandateHashShort : '-';
  const bounds = r
    ? r.constraints.map(([k, v]) => ({ k: BOUND_KEY[k] || k, v: String(v).split(' · ')[0] }))
    : [];
  const chips = bounds.map((b) => `<span class="pv-bound"><b>${esc(b.k)}</b>${esc(b.v)}</span>`).join('');
  return `<div class="pv-panel pv-instruction">
    <div>
      <div class="pv-head"><span class="pv-ordinal">01 &nbsp;the instruction</span><span class="pv-sub--mono" style="color:var(--muted)">signed by the human</span></div>
      <p class="pv-quote">"${esc(instruction)}"</p>
      <div class="pv-sigline">${SIG_SEAL}<span>mandate ${esc(mandate)}</span></div>
    </div>
    <div>
      <div class="pv-label" style="margin-bottom:14px">Bounds it authorises</div>
      <div class="pv-bounds">${chips || '<span class="pv-sub">pick a run above</span>'}</div>
    </div>
  </div>`;
}

function pvShelf() {
  const meta = state.meta;
  const r = state.run;
  if (!meta) return '';
  const picked = r ? r.pickedIndex : -1;
  const poison = r ? r.poisonIndex : null;
  const cards = meta.catalogue.map((p, i) => {
    const chosen = i === picked;
    const poisoned = i === poison;
    const cls = poisoned ? ' is-poisoned' : chosen ? ' is-chosen' : '';
    const flags =
      (poisoned ? '<span class="pv-card-poison"></span>' : '') +
      (chosen ? '<span class="pv-card-picked">agent picked</span>' : '');
    const elec = p.category !== 'Tools & Home Improvement';
    return `<div class="pv-card${cls}">
      <div class="pv-card-top"><span class="pv-card-idx">${esc(p.idx)}</span><div class="pv-card-flags">${flags}</div></div>
      <div class="pv-card-name">${esc(p.name)}</div>
      <div class="pv-card-foot"><span class="pv-card-cat${elec ? ' pv-card-cat--elec' : ''}">${esc(CAT_SHORT(p.category))}</span><span class="pv-card-price">${esc(p.price)}</span></div>
    </div>`;
  }).join('');
  const note = poison !== null
    ? `<span class="pv-sub--mono" style="color:var(--vermilion)">row 05 carries an injected instruction</span>`
    : `<span class="pv-sub--mono" style="color:var(--muted)">${r ? 'clean' : 'pick a run above'}</span>`;
  const payload = poison !== null
    ? `<div class="pv-payload">
        <div class="pv-payload-head"><b>Injected instruction found in row 05</b><span>merchant-controlled text · read by the agent</span></div>
        <p>${esc(meta.payload)}</p>
      </div>` : '';
  return `<div class="pv-panel">
    <div class="pv-head-row">
      <div class="pv-head"><span class="pv-ordinal">02 &nbsp;the shelf</span><span class="pv-sub">nine products the agent could pick from</span></div>
      ${note}
    </div>
    <div class="pv-shelf">${cards}</div>
    ${payload}
  </div>`;
}

function pvCart() {
  const r = state.run;
  const receipt = r
    ? `<div class="pv-receipt">
        <div class="pv-receipt-head"><b>Cart</b><span>1 line · ${r.cart[0].qty} unit${r.cart[0].qty === 1 ? '' : 's'}</span></div>
        ${r.cart.map((l) => `<div class="pv-receipt-line">
          <div class="pv-receipt-line-name">${esc(l.name)}</div>
          <div class="pv-receipt-line-meta"><span>${l.qty} × ${esc(l.unit)} · <span class="${l.mismatch ? 'pv-mismatch' : ''}">${esc(l.category)}</span></span><span>${esc(l.total)}</span></div>
        </div>`).join('')}
        <div class="pv-receipt-total"><b>Total</b><span>${esc(r.cartTotal)}</span></div>
        <div class="pv-receipt-hash">cart ${esc(r.cartHashShort)}</div>
      </div>`
    : `<div class="pv-receipt-empty">Empty · pick a run above</div>`;
  const compare = r
    ? `<div class="pv-compare">${r.compare.map((c) => `<div class="pv-compare-cell">
        <div class="pv-compare-k">${esc(c.k)}</div>
        <div class="pv-compare-got${c.breach ? ' is-breach' : ''}">${esc(CAT_SHORT(c.got))}</div>
        <div class="pv-compare-want">asked ${esc(CAT_SHORT(c.want))}</div>
      </div>`).join('')}</div>`
    : `<div class="pv-sub" style="padding:20px 0">run a scenario to compare the cart against the bounds</div>`;
  return `<div class="pv-panel pv-cartzone">
    <div>
      <div class="pv-head" style="margin-bottom:16px"><span class="pv-ordinal">03 &nbsp;the cart</span><span class="pv-sub--mono" style="color:var(--muted)">what it actually added</span></div>
      ${receipt}
    </div>
    <div>
      <div class="pv-label" style="margin-bottom:14px">Against the bounds</div>
      ${compare}
    </div>
  </div>`;
}

function pvVerdict() {
  const r = state.run;
  if (!r) {
    return `<div class="pv-panel"><div class="pv-head" style="margin-bottom:12px"><span class="pv-ordinal">04 &nbsp;the verdict</span></div><div class="pv-sub">pick a run above</div></div>`;
  }
  const dec = r.decision;
  const reached = ['allow', 'escalate', 'block'].indexOf(dec);
  const v = r.findings.filter((f) => f.result === 'violation').length;
  const u = r.findings.filter((f) => f.result === 'undecidable').length;
  const cl = r.findings.filter((f) => f.result === 'clear').length;
  const outcome = dec === 'block' ? 'order not created' : dec === 'escalate' ? 'held for a human' : 'cleared to pay';
  const line = dec === 'block'
    ? 'Nothing in this refusal read the prose. decision = max(deterministic, semantic).'
    : dec === 'escalate'
      ? 'A checker could not decide, so the decision rose. The model can raise it and nothing can lower it.'
      : 'Every check cleared. The model layer agreed, which changed nothing - it cannot approve.';
  const lat = (name, idx) => {
    const on = reached === idx;
    const struck = idx < reached ? ' pv-struck' : '';
    const blockCls = name === 'block' && on ? ' pv-lat-block' : '';
    return `<span class="${on ? 'pv-lat-on' : 'pv-lat-off'}${blockCls}${struck}">${name}</span>`;
  };
  const reserve = r.reserve ? { a: r.reserve.amount, r: r.reserve.rationale } : { a: '-', r: '-' };
  return `<div class="pv-verdict pv-verdict--${dec}">
    <div class="pv-verdict-row">
      <div class="pv-verdict-left">
        <div>
          <div class="pv-verdict-ord">04 &nbsp;the verdict</div>
          <div class="pv-verdict-word">${esc(dec)}</div>
        </div>
        <div class="pv-lattice">${lat('allow', 0)}${lat('escalate', 1)}${lat('block', 2)}</div>
        <div class="pv-verdict-detail">${esc(outcome)}<br>${v} violation${v === 1 ? '' : 's'} · ${u} undecidable · ${cl} clear</div>
      </div>
      <div class="pv-verdict-reserve">reserve <span class="pv-strong">${esc(reserve.a)}</span><br>rationale <span class="pv-strong">${esc(reserve.r)}</span></div>
    </div>
    <p class="pv-verdict-line">${esc(line)}</p>
  </div>`;
}

function pvChecks() {
  const r = state.run;
  const order = { violation: 0, undecidable: 1, clear: 2 };
  const rows = r
    ? r.findings.slice().sort((a, b) => order[a.result] - order[b.result]).map((f) => {
        const cls = f.result === 'violation' ? ' pv-check--violation' : f.result === 'undecidable' ? ' pv-check--undecidable' : '';
        return `<div class="pv-check${cls}">
          <div class="pv-check-status"><span class="pv-check-swatch"></span><span class="pv-check-word">${esc(f.result)}</span></div>
          <div class="pv-check-code">${esc(f.code)}</div>
          <div class="pv-check-ev">${esc(f.evidence)}</div>
        </div>`;
      }).join('')
    : `<div class="pv-sub" style="padding:14px 0">pick a run above to see the per-line checks</div>`;
  return `<div class="pv-panel">
    <div class="pv-head-row">
      <div class="pv-head"><span class="pv-ordinal">05 &nbsp;the checks</span><span class="pv-sub">worst first</span></div>
      <div class="pv-check-chips">
        <span class="pv-check-chip">deterministic FP <b>0.0%</b> n=813</span>
        <span class="pv-check-chip">semantic <b>27.8%</b> [12–51] n=18</span>
        <span class="pv-check-chip pv-check-chip--withheld">semantic FP: not measurable</span>
      </div>
    </div>
    <div class="pv-checks">${rows}</div>
  </div>`;
}

function pvCertChain() {
  const r = state.run;
  const chain = state.chain;
  const cert = r
    ? `<div class="pv-cert">
        <div class="pv-cert-head">${CERT_SEAL}<div><div class="pv-cert-hash">${esc(r.certShort)}</div><div class="pv-cert-sub">${r.certVerifies ? 'signed · tamper-evident' : 'SIGNATURE DID NOT VERIFY'}</div></div></div>
        ${r.certV2.map((f) => `<div class="pv-cert-row"><div class="pv-cert-k">${esc(f.k)}</div><div class="pv-cert-v${f.brk === 'break-all' ? ' brk' : ''}">${esc(f.v)}</div></div>`).join('')}
      </div>`
    : `<div class="pv-sub" style="padding:14px 0">no certificate yet</div>`;

  const entries = chain && chain.entries ? chain.entries : [];
  const nodes = entries.map((e) => `<div class="pv-node">
      <div class="pv-node-dot" style="border-color:${e.decision === 'allow' ? 'var(--go)' : e.decision === 'escalate' ? 'var(--haldi)' : 'var(--vermilion)'}"></div>
      <div class="pv-node-top"><span class="pv-node-decision" style="color:${e.decision === 'allow' ? 'var(--go)' : e.decision === 'escalate' ? '#9a7a00' : 'var(--vermilion)'}">${esc(e.decision)}</span><span class="pv-node-time">${esc(e.time)}</span></div>
      <div class="pv-node-link">${esc(e.prev)} → ${esc(e.hash)}</div>
    </div>`).join('');
  const head = chain ? chain.head : '-';
  const running = state.running;
  const stateWord = running ? 'checking' : 'idle';
  const stateNote = running ? 'running the real gate · deterministic checkers, judge, lattice join, Ed25519' : 'the seal holds still - a state, not a spinner';

  return `<div class="pv-panel pv-panel--last pv-certzone">
    <div>
      <div class="pv-head" style="margin-bottom:16px"><span class="pv-ordinal">06 &nbsp;the certificate</span><span class="pv-sub--mono" style="color:var(--muted)">Ed25519</span></div>
      ${cert}
    </div>
    <div class="pv-chain">
      <div class="pv-chain-head">
        <div class="pv-head"><span class="pv-ordinal">07 &nbsp;the chain</span><span class="pv-sub--mono" style="color:var(--muted)">append-only</span></div>
        <span class="pv-chain-headchip">head ${esc(head)}</span>
      </div>
      <div class="pv-spine">
        <div class="pv-spine-rule"></div>
        ${nodes}
        <div class="pv-node pv-node--pending">
          <div class="pv-node-dot"></div>
          <div class="pv-node-decision">${running ? 'signing' : 'pending'}</div>
          <div class="pv-node-note">${running ? 'hashing the cart and the decision' : esc(head) + ' → next run appends here'}</div>
        </div>
      </div>
      <div class="pv-chain-state${running ? ' is-checking' : ''}">
        ${STATE_SEAL(running)}
        <div><div class="pv-chain-state-word">${stateWord}</div><div class="pv-chain-state-note">${esc(stateNote)}</div></div>
      </div>
    </div>
  </div>`;
}

function renderPlay() {
  if (!state.meta) {
    $('#view-play').innerHTML = `<div class="pv-play">${pvNavbar()}<div class="pv-panel"><div class="pv-sub">Loading…</div></div></div>`;
    return;
  }
  const failure = state.error
    ? `<div class="pv-panel"><div class="pv-head" style="margin-bottom:12px"><span class="pv-ordinal">the gate did not complete</span></div>
        <div class="pv-check pv-check--undecidable"><div class="pv-check-status"><span class="pv-check-swatch"></span><span class="pv-check-word">undecidable</span></div>
        <div class="pv-check-code">GATE_UNAVAILABLE</div><div class="pv-check-ev">${esc(state.error)} - an outage, not a decision. No certificate was issued.</div></div></div>`
    : '';
  $('#view-play').innerHTML =
    `<div class="pv-play">
      ${pvNavbar()}
      ${pvRunbar()}
      ${pvSandbox()}
      ${pvInstruction()}
      ${pvShelf()}
      ${pvCart()}
      ${pvVerdict()}
      ${failure}
      ${pvChecks()}
      ${pvCertChain()}
    </div>`;
}


function renderCheckout() {
  const r = state.run;
  const sc = state.meta;
  const dec = r ? r.decision : null;

  const headline = dec === 'block' ? 'There is nothing to pay for.' : dec ? 'Confirm and pay' : 'No cart yet';
  const sub =
    dec === 'block'
      ? 'The gate refused this cart before authorisation. A blocked cart never reaches order creation, so no payment is attempted at all.'
      : dec
        ? 'The cart passed the gate. The certificate is already signed and chained; the cart hash is re-derived here and checked against it before the order is created.'
        : 'Run the gate in the playground first - checkout binds to a certificate, not to a cart.';

  let body = '';

  if (!dec) {
    body =
      `<div class="pk-nocart">
        ${SEAL_ASKING(52)}
        <p>Checkout binds to a certificate, not to a cart. Run the gate once and this page will carry the cart hash, the reserve, and the certificate it was signed into.</p>
        <div class="pk-nocart-btns">
          <button class="pk-btn pk-btn--solid pk-btn--md" data-act="go-poisoned">Run the poisoned catalogue</button>
          <button class="pk-btn pk-btn--ghost pk-btn--md" data-act="go-play">Open the playground</button>
        </div>
      </div>`;
  } else if (dec === 'block') {
    body =
      `<div class="pk-refused">
        <div class="pk-label">Order not created</div>
        <div class="pk-refused-word">block</div>
        <p>The gate refused this cart before authorisation, so there is nothing to pay for. Nothing was sent to Razorpay - <code>createOrder</code> takes a certified decision and throws on a block, so this is enforced by the gate rather than by this page.</p>
        <button class="pk-btn pk-btn--onink" data-act="go-play">Back to the playground</button>
      </div>`;
  } else {
    const payable = state.pay !== 'failed' && state.pay !== 'captured';
    if (payable) {
      body =
        `<div class="pk-paypanel">
          <div class="pk-paypanel-top">
            <div class="pk-label pk-label--dim" style="margin-bottom:14px">Pay by UPI</div>
            <label class="pk-vpa-label" for="pk-vpa">VPA</label>
            <input id="pk-vpa" class="pk-vpa" value="${esc(state.vpa)}" placeholder="name@bank">
            <div class="pk-vpa-chips">
              <button class="pk-btn pk-btn--chip" data-act="vpa-success">success@razorpay</button>
              <button class="pk-btn pk-btn--chip" data-act="vpa-failure">failure@razorpay</button>
            </div>
          </div>
          <div class="pk-paypanel-foot">
            <button class="pk-btn pk-btn--pay" data-act="pay">Pay ${esc(r.cartTotal)}</button>
            <span class="pk-paystatus">${esc(PAY_STATUS[state.pay] ?? PAY_STATUS.idle)}</span>
          </div>
        </div>
        <div class="pk-testnote">Razorpay Checkout, test mode. The signature on the callback is verified server-side and the payment is then re-fetched from Razorpay - this page reports that status, not Checkout's. In test mode a <em>cancelled</em> UPI payment resolves as a successful one, so cancellation can only be tested in live mode. Printed here rather than left to look like a success we earned.</div>`;
    }

    if (state.pay === 'failed') {
      const o = state.order;
      const p = state.payment;
      const rows = p
        ? [
            ['razorpay payment_id', p.payment.id + ' · fetched from Razorpay'],
            ['status', p.payment.status],
            ['code', p.payment.errorCode || '-'],
            ['reason', p.payment.errorReason || '-'],
            ['step', p.payment.errorStep || '-'],
            ['description', p.payment.errorDescription || '-'],
            ['razorpay order_id', p.orderId],
            ['cart hash re-check', o ? (o.recheck.ok ? 'match · ' + o.recheck.certificate : 'MISMATCH · ' + o.recheck.reason) : '-'],
            ['gate certificate', r.certShort + ' · unaffected'],
          ]
        : [
            ['code', state.failCode],
            ['reason', state.orderError || '-'],
            ['razorpay order_id', o ? o.order.id + ' · real, test mode' : 'no order created'],
            ['gate certificate', r.certShort + ' · unaffected'],
          ];
      body +=
        `<div class="pk-payfail">
          <div class="pk-payfail-head">
            <span class="pk-payfail-word">payment failed</span>
            <span class="pk-payfail-code">${esc(state.failCode)}</span>
          </div>
          <table class="pk-kv"><tbody>${kvRows(rows)}</tbody></table>
          <p class="pk-payprose">The certificate is unaffected. It records what was asked, what was in the cart, and what the gate decided - a failed payment does not change any of those, and the conformance evidence survives for the dispute.</p>
          <div class="pk-paybtns">
            <button class="pk-btn pk-btn--sm" data-act="retry">Try the payment again</button>
            <button class="pk-btn pk-btn--sm pk-btn--quiet" data-act="pay-success">Pay with success@razorpay</button>
          </div>
        </div>`;
    }

    if (state.pay === 'captured') {
      const o = state.order;
      const p = state.payment;
      const rows = [
        ['razorpay payment_id', p.payment.id + ' · fetched from Razorpay'],
        ['status', p.payment.status],
        ['amount', p.payment.amount],
        ['method', p.payment.method + (p.payment.vpa ? ' · ' + p.payment.vpa : '')],
        ['signature', p.signatureVerified
          ? 'verified · HMAC-SHA256 over order_id|payment_id'
          : 'not present on this callback'],
        ['razorpay order_id', p.orderId],
        ['cart hash re-check', o.recheck.ok ? 'match' : 'MISMATCH · ' + o.recheck.reason],
        ['re-check certificate', o.recheck.ok ? o.recheck.certificate + ' · signed and chained' : '-'],
        ['gate certificate', r.certShort + ' · evidence.others[]'],
      ];
      body +=
        `<div class="pk-paycap">
          <div class="pk-paycap-word">payment captured</div>
          <table class="pk-kv"><tbody>${kvRows(rows)}</tbody></table>
          <p class="pk-payprose">The cart hash was re-derived at authorisation and matched the one inside the certificate. Had it moved between the gate and the order, this payment would have been refused.</p>
        </div>`;
    }
  }

  const rz = sc && sc.razorpay;
  const summaryRows = [
    ['cart total', r ? r.cartTotal : '-'],
    ['gate decision', dec || 'not run'],
    ['cart hash', r ? r.cartHashShort : '-'],
    ['certificate', r ? r.certShort : '-'],
    ['reserve (OC-228)', r && r.reserve ? r.reserve.amount : '-'],
    ['reserve rationale', r && r.reserve ? r.reserve.rationale : '-'],
    ['key mode', rz && rz.enabled ? `${rz.keyId} · guard refuses a live key` : 'rzp_test_ · not configured'],
  ];

  $('#view-checkout').innerHTML =
    `<div class="pk-checkout-grid">
      <div>
        <div class="pk-label pk-label--dim" style="margin-bottom:18px">Checkout · Razorpay test mode</div>
        <h2 class="pk-checkout-h">${esc(headline)}</h2>
        <p class="pk-checkout-sub">${esc(sub)}</p>
        ${body}
      </div>
      <div class="pk-summary">
        <div class="pk-summary-head"><div class="pk-label">Order summary</div></div>
        <div class="pk-summary-lines">
          ${r
            ? r.cart.map((l) => `<div class="pk-summary-line"><span>${esc(l.name)} × ${esc(l.qty)}</span><span class="pk-num">${esc(l.total)}</span></div>`).join('')
            : `<div class="pk-summary-nocart">No cart · run the gate first</div>`}
        </div>
        <table><tbody>${kvRows(summaryRows)}</tbody></table>
        <div class="pk-summary-note">Reserve sizing follows NPCI OC-228 as triangulated from three secondary sources; the primary circular returns HTTP 403 to automated fetching. If it differs, one file is wrong.</div>
      </div>
    </div>`;
}

function render() {
  const v = state.view;

  $('#view-argument').hidden = v !== 'argument';
  $('#view-play').hidden = v !== 'play';
  $('#view-checkout').hidden = v !== 'checkout';

  // The v2 playground carries its own Ink navbar, so the shared nav steps aside
  // on that view and returns for the argument and checkout.
  const sharedNav = $('.pk-nav');
  if (sharedNav) sharedNav.hidden = v === 'play';

  document.querySelectorAll('[data-view]').forEach((b) => {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  $('#pk-chainlen').textContent = String(state.chain ? state.chain.records : 0);

  if (v === 'play') renderPlay();
  if (v === 'checkout') renderCheckout();
  if (v === 'argument') wireReveal();
}

/* ── nav height ──────────────────────────────────────────────────────────
 * The action bar sticks to `--pk-navh`. The nav is 60px at desktop and wraps
 * to roughly 122px below 760px, so this must be measured. A reading under one
 * touch target is a transient mid-layout value, not a layout: taking it would
 * pin the action bar underneath the nav.
 */
function measureNav() {
  const nav = $('.pk-nav');
  if (!nav) return;
  const h = Math.round(nav.getBoundingClientRect().height);
  if (h >= 44) document.documentElement.style.setProperty('--pk-navh', h - 1 + 'px');
}

/* ── motion ──────────────────────────────────────────────────────────────
 * Seven items, and this is the whole list. Figures never animate: the page's
 * claims include 0.0% and 0, and a figure that reads zero until JavaScript
 * arrives is unacceptable here.
 */
let revealPending = null;
let revealCheck = null;
let revealTimer = 0;

function wireReveal() {
  if (revealPending) return;

  const els = Array.from(document.querySelectorAll('[data-pk-reveal]'));
  if (!els.length) return;

  // The hidden state is set here, not in CSS, so content is visible if this
  // script never runs at all.
  els.forEach((el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(18px)';
    el.classList.add('pk-reveal');
  });

  revealPending = els.slice();
  revealCheck = () => {
    for (let i = revealPending.length - 1; i >= 0; i--) {
      const el = revealPending[i];
      if (el.getBoundingClientRect().top < window.innerHeight * 0.88) {
        el.style.opacity = '1';
        el.style.transform = 'none';
        revealPending.splice(i, 1);
      }
    }
    if (!revealPending.length && revealCheck) {
      window.removeEventListener('scroll', revealCheck);
      window.removeEventListener('resize', revealCheck);
    }
  };
  window.addEventListener('scroll', revealCheck, { passive: true });
  window.addEventListener('resize', revealCheck, { passive: true });
  revealCheck();

  // Fail-safe: nothing may stay hidden if no scroll event ever arrives.
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    revealPending.forEach((el) => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
    revealPending.length = 0;
  }, 2200);
}

function wireHero() {
  const hero = $('.pk-hero');
  const h = $('.pk-display');
  if (!hero || !h) return;
  window.addEventListener(
    'mousemove',
    (ev) => {
      const b = hero.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - b.left) / (b.width || 1)));
      document.documentElement.style.setProperty('--pk-wght', String(Math.round(340 + x * 480)));
    },
    { passive: true },
  );
  h.style.animation = 'pk-rise 620ms cubic-bezier(.2,.7,.3,1) both';
}

/* ── events ──────────────────────────────────────────────────────────── */

const ACTIONS = {
  'go-argument': () => go('argument'),
  'go-play': () => go('play'),
  'go-checkout': () => go('checkout'),
  // The landing-page and empty-state CTAs run the two headline scenarios.
  'go-poisoned': () => { go('play'); runScenario('injection'); },
  'go-clean': () => { go('play'); runScenario('honest'); },
  // A preset chip. `el.dataset.id` names the scenario.
  run: (el) => runScenario(el.dataset.id),
  'toggle-custom': () => { state.showCustom = !state.showCustom; if (state.showCustom) state.activeScenario = 'custom'; render(); },
  'run-custom': () => runCustom(),
  reset,
  'vpa-success': () => { state.vpa = 'success@razorpay'; render(); },
  'vpa-failure': () => { state.vpa = 'failure@razorpay'; render(); },
  pay: () => doPay(state.vpa),
  retry: () => { state.pay = 'idle'; state.orderError = null; state.payment = null; render(); },
  'pay-success': () => { state.vpa = 'success@razorpay'; state.pay = 'idle'; doPay('success@razorpay'); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], [data-view]');
  if (!el) return;
  const act = el.dataset.act || 'go-' + el.dataset.view;
  const fn = ACTIONS[act];
  if (fn) { e.preventDefault(); fn(el); }
});

// The VPA field and the custom-run fields bind to state on edit. No re-render on
// keystroke: the number input would lose its cursor, and the run reads state at
// submit time regardless.
function bindField(e) {
  if (e.target.id === 'pk-vpa') { state.vpa = e.target.value; return; }
  const el = e.target.closest('[data-custom]');
  if (!el) return;
  const k = el.dataset.custom;
  const v = el.value;
  if (k === 'itemIndex' || k === 'quantity') state.custom[k] = Number(v);
  else if (k === 'statedQuantity') state.custom[k] = v === 'null' ? null : Number(v);
  else state.custom[k] = v;
}
document.addEventListener('input', bindField);
document.addEventListener('change', bindField);

/* ── boot ────────────────────────────────────────────────────────────── */

state.view = viewFromPath(location.pathname);
render();
measureNav();
wireHero();

getJSON('/api/scenario')
  .then((meta) => {
    state.meta = meta;
    state.chain = meta.chain;
    render();
    ensurePlayRun();
  })
  .catch((e) => {
    state.error = e.message;
    render();
  });

if (typeof ResizeObserver === 'function') {
  const nav = $('.pk-nav');
  if (nav) new ResizeObserver(measureNav).observe(nav);
}
window.addEventListener('resize', measureNav, { passive: true });
requestAnimationFrame(measureNav);
setTimeout(measureNav, 260);
