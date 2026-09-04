/**
 * Pakka console — the ported design of record, wired to the real gate.
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
 * joins. The asking seal draws one stemless chevron — the layer that can raise
 * a hand — and never the stem.
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
  scenario: null,
  mode: null,
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

async function run(mode) {
  state.mode = mode;
  state.running = true;
  state.stage = 'normalising mandate and cart';
  state.run = null;
  state.error = null;
  state.pay = 'idle';
  state.order = null;
  state.orderError = null;
  render();

  // Two frames so the asking seal is actually on screen before the request
  // blocks. It holds still while it is there — it is a state, not a spinner.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  state.stage = 'real gate · deterministic checkers, judge, lattice join, Ed25519';
  render();

  try {
    const view = await getJSON(`/api/run?mode=${mode}`);
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

function reset() {
  state.mode = null;
  state.run = null;
  state.error = null;
  state.pay = 'idle';
  state.order = null;
  state.orderError = null;
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

  // A declined payment carries no signature, so it is settled by id alone —
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
}

window.addEventListener('popstate', () => {
  state.view = viewFromPath(location.pathname);
  render();
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

function renderPlay() {
  const sc = state.scenario;
  const r = state.run;

  if (!sc) {
    $('#pk-play-left').innerHTML = `<div class="pk-panel"><div class="pk-empty">Loading the scenario…</div></div>`;
    $('#pk-play-right').innerHTML = '';
    return;
  }

  const catalogueLabel =
    state.mode === 'poisoned' ? '9 items · one description carries an injected instruction'
    : state.mode === 'clean' ? '9 items · clean'
    : '9 items · not yet run';

  /* left column */
  const left =
    `<div class="pk-panel">
      <div class="pk-panel-head">
        <div class="pk-label pk-label--dim">The mandate · signed by the human</div>
        <div class="pk-micro">key ${esc(sc.keyId)}</div>
      </div>
      <p class="pk-quote">“${esc(sc.instruction)}”</p>
      <table class="pk-kv"><tbody>${kvRows(sc.constraints)}</tbody></table>
    </div>
    <div class="pk-panel">
      <div class="pk-panel-head">
        <div class="pk-label pk-label--dim">The catalogue the agent chooses from</div>
        <div class="pk-micro">${esc(catalogueLabel)}</div>
      </div>
      <table class="pk-tbl">
        <thead><tr>
          <th style="width:28px;padding-left:0">#</th>
          <th>product</th>
          <th style="width:190px">declared category</th>
          <th class="pk-r pk-last" style="width:96px">price</th>
        </tr></thead>
        <tbody>${sc.catalogue.map((p, i) => {
          const poisoned = state.mode === 'poisoned' && i === sc.poisonIndex;
          return `<tr>
            <td class="pk-idx">${esc(p.idx)}</td>
            <td>${esc(p.name)}${poisoned
              ? `<div class="pk-poison">${esc(sc.payload)}</div>
                 <div class="pk-poison-tag">merchant-controlled text · read by the agent</div>`
              : ''}</td>
            <td class="pk-cat">${esc(p.category)}</td>
            <td class="pk-r pk-last pk-num">${esc(p.price)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;

  /* cart */
  const cartBlock =
    `<div class="pk-panel">
      <div class="pk-panel-head">
        <div class="pk-label">What the agent put in the cart</div>
        <div class="pk-micro">${r ? 'cart ' + esc(r.cartHashShort) : 'cart —'}</div>
      </div>
      ${r
        ? `<table class="pk-tbl">
            <thead><tr>
              <th>line</th>
              <th style="width:170px">category</th>
              <th class="pk-r" style="width:52px">qty</th>
              <th class="pk-r pk-last" style="width:110px">line total</th>
            </tr></thead>
            <tbody>
              ${r.cart.map((l) => `<tr>
                <td style="padding-block:11px">${esc(l.name)}</td>
                <td class="pk-cat" style="padding-block:11px">${esc(l.category)}</td>
                <td class="pk-r pk-num" style="padding-block:11px">${esc(l.qty)}</td>
                <td class="pk-r pk-last pk-num" style="padding-block:11px">${esc(l.total)}</td>
              </tr>`).join('')}
              <tr style="border-bottom:0">
                <td colspan="3" class="pk-carttotal-l">Cart total</td>
                <td class="pk-carttotal-v">${esc(r.cartTotal)}</td>
              </tr>
            </tbody>
          </table>`
        : `<div class="pk-empty">No run yet — press a run button above</div>`}
    </div>`;

  /* waiting — a state, not a spinner */
  const waiting = state.running
    ? `<div class="pk-checking">
         ${SEAL_ASKING(44)}
         <div>
           <div class="pk-checking-word">checking</div>
           <div class="pk-checking-stage">${esc(state.stage)}</div>
         </div>
       </div>`
    : '';

  /* an outage renders as an outage, never as a verdict */
  const failure = state.error
    ? `<div class="pk-panel">
        <div class="pk-label pk-label--dim" style="margin-bottom:12px">The gate did not complete</div>
        <div class="pk-finding pk-finding--undecidable">
          <div class="pk-finding-code">GATE_UNAVAILABLE</div>
          <div class="pk-finding-ev">${esc(state.error)} — this is an outage, not a decision. No certificate was issued.</div>
          <div class="pk-finding-status">undecidable</div>
        </div>
      </div>`
    : '';

  /* verdict band */
  const dec = r ? r.decision : null;
  let verdict = '';
  if (dec === 'allow') {
    verdict =
      `<div class="pk-verdict pk-verdict--allow">
        <div class="pk-verdict-top">
          <div>
            <div class="pk-label pk-label--dim">Verdict</div>
            <div class="pk-verdict-word">allow</div>
            <div class="pk-verdict-gloss">No colour is spent on the happy path.</div>
          </div>
          <div class="pk-strip">
            <span class="pk-on">allow</span><span class="pk-off">escalate</span><span class="pk-off">block</span>
          </div>
        </div>
      </div>`;
  } else if (dec === 'escalate') {
    const u = r.findings.find((f) => f.result === 'undecidable');
    verdict =
      `<div class="pk-verdict pk-verdict--escalate">
        <div class="pk-verdict-top">
          <div>
            <div class="pk-label" style="color:var(--pk-ink)">Verdict · a hand is raised</div>
            <div class="pk-verdict-word">escalate</div>
            <div class="pk-verdict-gloss">${esc(u ? u.evidence : 'A checker could not decide, so the decision rose.')}</div>
          </div>
          <div class="pk-strip">
            <span class="pk-struck">allow</span><span class="pk-on">escalate</span><span class="pk-off">block</span>
          </div>
        </div>
      </div>`;
  } else if (dec === 'block') {
    verdict =
      `<div class="pk-verdict pk-verdict--block">
        <div class="pk-verdict-top">
          <div>
            <div class="pk-label">Verdict · order not created</div>
            <div class="pk-verdict-word">block</div>
          </div>
          <div class="pk-strip">
            <span class="pk-struck">allow</span><span class="pk-struck">escalate</span><span class="pk-on">block</span>
          </div>
        </div>
        <p>Nothing in this refusal read the prose. <b>decision = max(deterministic, semantic)</b></p>
      </div>`;
  }

  /* per-line evidence, grouped violations -> undecidables -> clears */
  const findingRow = (f) =>
    `<div class="pk-finding pk-finding--${f.result}">
      <div class="pk-finding-code">${esc(f.code)}</div>
      <div class="pk-finding-ev">${esc(f.evidence)}</div>
      <div class="pk-finding-status">${esc(f.result)}</div>
    </div>`;

  let findings = '';
  if (r && r.findings.length) {
    const v = r.findings.filter((f) => f.result === 'violation');
    const u = r.findings.filter((f) => f.result === 'undecidable');
    const c = r.findings.filter((f) => f.result === 'clear');
    findings =
      `<div class="pk-panel">
        <div class="pk-label pk-label--dim" style="margin-bottom:14px">Per-line evidence · ${v.length} violation${v.length === 1 ? '' : 's'} · ${u.length} undecidable · ${c.length} clear</div>
        ${v.map(findingRow).join('')}${u.map(findingRow).join('')}${c.map(findingRow).join('')}
      </div>`;
  }

  /* certificate */
  const certBlock = r
    ? `<div class="pk-panel">
        <div class="pk-panel-head">
          <div class="pk-label pk-label--dim">The signed certificate</div>
          <div class="pk-micro">tamper-evident, not tamper-proof</div>
        </div>
        <div class="pk-cert">
          <table><tbody>${kvRows(r.certificate)}</tbody></table>
          <div class="pk-cert-foot">
            ${SEAL_SIGNED_INK(40)}
            <div>cert ${esc(r.certShort)}<br>
              <small>Ed25519, signed server-side under key ${esc(r.keyId)} · signature ${r.certVerifies ? 'verifies' : 'DOES NOT VERIFY'} · the private key never reaches this page</small>
            </div>
          </div>
        </div>
      </div>`
    : '';

  /* audit chain */
  const ch = state.chain;
  const chainBlock =
    `<div class="pk-chainpanel">
      <div class="pk-panel-head">
        <div class="pk-label">The audit chain</div>
        <div class="pk-micro">head ${esc(ch ? ch.head : '—')}${ch ? ' · ' + (ch.valid ? 'valid' : `${ch.breaks} BREAKS`) : ''}</div>
      </div>
      ${ch && ch.entries.length
        ? `<table class="pk-tbl pk-chain">
            <thead><tr>
              <th style="width:28px;padding-left:0">#</th>
              <th style="width:120px">decision</th>
              <th>prev → hash</th>
              <th class="pk-r pk-last" style="width:88px">time</th>
            </tr></thead>
            <tbody>${ch.entries.map((e) => `<tr>
              <td class="pk-idx">${esc(e.n)}</td>
              <td class="pk-dec">${esc(e.decision)}</td>
              <td class="pk-link">${esc(e.prev)}&nbsp;&nbsp;→&nbsp;&nbsp;${esc(e.hash)}</td>
              <td class="pk-r pk-last pk-time">${esc(e.time)}</td>
            </tr>`).join('')}</tbody>
          </table>
          <p class="pk-chainnote">A truncated log is internally consistent. Only an externally pinned head reveals it — which is why the head is printed above.</p>`
        : `<div class="pk-chainempty">
            ${SEAL_ASKING(44)}
            <div>Chain empty · nothing signed yet</div>
          </div>`}
    </div>`;

  $('#pk-play-left').innerHTML = left;
  $('#pk-play-right').innerHTML = cartBlock + waiting + failure + verdict + findings + certBlock + chainBlock;
}

function renderCheckout() {
  const r = state.run;
  const sc = state.scenario;
  const dec = r ? r.decision : null;

  const headline = dec === 'block' ? 'There is nothing to pay for.' : dec ? 'Confirm and pay' : 'No cart yet';
  const sub =
    dec === 'block'
      ? 'The gate refused this cart before authorisation. A blocked cart never reaches order creation, so no payment is attempted at all.'
      : dec
        ? 'The cart passed the gate. The certificate is already signed and chained; the cart hash is re-derived here and checked against it before the order is created.'
        : 'Run the gate in the playground first — checkout binds to a certificate, not to a cart.';

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
        <p>The gate refused this cart before authorisation, so there is nothing to pay for. Nothing was sent to Razorpay — <code>createOrder</code> takes a certified decision and throws on a block, so this is enforced by the gate rather than by this page.</p>
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
        <div class="pk-testnote">Razorpay Checkout, test mode. The signature on the callback is verified server-side and the payment is then re-fetched from Razorpay — this page reports that status, not Checkout's. In test mode a <em>cancelled</em> UPI payment resolves as a successful one, so cancellation can only be tested in live mode. Printed here rather than left to look like a success we earned.</div>`;
    }

    if (state.pay === 'failed') {
      const o = state.order;
      const p = state.payment;
      const rows = p
        ? [
            ['razorpay payment_id', p.payment.id + ' · fetched from Razorpay'],
            ['status', p.payment.status],
            ['code', p.payment.errorCode || '—'],
            ['reason', p.payment.errorReason || '—'],
            ['step', p.payment.errorStep || '—'],
            ['description', p.payment.errorDescription || '—'],
            ['razorpay order_id', p.orderId],
            ['cart hash re-check', o ? (o.recheck.ok ? 'match · ' + o.recheck.certificate : 'MISMATCH · ' + o.recheck.reason) : '—'],
            ['gate certificate', r.certShort + ' · unaffected'],
          ]
        : [
            ['code', state.failCode],
            ['reason', state.orderError || '—'],
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
          <p class="pk-payprose">The certificate is unaffected. It records what was asked, what was in the cart, and what the gate decided — a failed payment does not change any of those, and the conformance evidence survives for the dispute.</p>
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
        ['re-check certificate', o.recheck.ok ? o.recheck.certificate + ' · signed and chained' : '—'],
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
    ['cart total', r ? r.cartTotal : '—'],
    ['gate decision', dec || 'not run'],
    ['cart hash', r ? r.cartHashShort : '—'],
    ['certificate', r ? r.certShort : '—'],
    ['reserve (OC-228)', r && r.reserve ? r.reserve.amount : '—'],
    ['reserve rationale', r && r.reserve ? r.reserve.rationale : '—'],
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
  'go-poisoned': () => { go('play'); run('poisoned'); },
  // Its twin actually runs. A button labelled "Run it clean" that only changed
  // view left the previous block verdict on screen underneath the word "clean",
  // which reads as a clean cart being blocked.
  'go-clean': () => { go('play'); run('clean'); },
  'run-poisoned': () => run('poisoned'),
  'run-clean': () => run('clean'),
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
  if (fn) { e.preventDefault(); fn(); }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'pk-vpa') state.vpa = e.target.value;
});

/* ── boot ────────────────────────────────────────────────────────────── */

state.view = viewFromPath(location.pathname);
render();
measureNav();
wireHero();

getJSON('/api/scenario')
  .then((sc) => {
    state.scenario = sc;
    state.chain = sc.chain;
    render();
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
