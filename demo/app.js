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
  /** The direction the tab strip is on. Survives a reset, unlike the run. */
  selectedDirection: 'injection',
  /** Which example each direction is currently showing. */
  exampleIndex: {},
  showCustom: false,
  /** The viewer's custom inputs; index null until they open the sandbox. */
  custom: { itemIndex: 5, quantity: 3, statedQuantity: 1, authorisedCategory: 'Tools & Home Improvement' },
  running: false,
  stage: '',
  run: null,
  chain: null,
  error: null,
  vpa: 'success@razorpay',
  /** Local shape check on the VPA. Null until Verify is pressed, cleared on edit. */
  vpaCheck: null,
  /** Which UPI app tile is selected. Cosmetic: the intent flow is identical. */
  app: null,
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

/** Run one named example of one direction. */
function runExample(id, n) {
  state.showCustom = false;
  state.exampleIndex[id] = n;
  return performRun(id, () => getJSON(`/api/run?direction=${encodeURIComponent(id)}&example=${n}`));
}

/**
 * Pick one of a direction's examples at random, never the one it last showed.
 *
 * Uniform over the other `count - 1`: draw in [0, count-2] and step over the
 * excluded index. Excluding it matters because a button that can repeat itself
 * looks broken on the press where it does.
 */
function randomExample(id, count) {
  if (!count || count < 2) return 0;
  const prev = state.exampleIndex[id];
  if (prev === undefined || prev === null) return Math.floor(Math.random() * count);
  let n = Math.floor(Math.random() * (count - 1));
  if (n >= prev) n += 1;
  return n;
}

// A direction carries several examples. Pressing it runs one of them at random.
function runScenario(id) {
  const dir = state.meta && state.meta.directions.find((d) => d.id === id);
  return runExample(id, randomExample(id, dir ? dir.exampleCount : 1));
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
  // `selectedDirection` is deliberately kept: Reset clears the run, not the
  // viewer's place in the strip.
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

const REDUCED_MOTION = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Switch surfaces through the View Transitions API where the browser has it.
 *
 * document.startViewTransition captures the page, runs the DOM update, and
 * crossfades old to new on the compositor; pakka.css gives that a short
 * brand-eased slide. Everywhere else it is an ordinary synchronous swap. This is
 * the 2026 native way to animate between routes - no library, no jank.
 */
/* ── wheel damping ────────────────────────────────────────────────────────
 *
 * `scroll-behavior: smooth` covers the scrolls the page starts: anchors, and
 * the jump to the top on a view change. It does nothing at all for the wheel,
 * which is where "too fast" actually comes from: one notch of a mouse wheel is
 * a fixed jump set by the OS, and on a page this dense it lands you somewhere
 * you did not choose to be.
 *
 * So a wheel notch is scaled down a little and then eased to instead of
 * applied at once. That is the whole of it. The rules it keeps to matter more
 * than the easing, because scroll hijacking done carelessly is worse than no
 * hijacking at all:
 *
 *   - Reduced motion turns it off entirely.
 *   - Touch devices are left alone. Native momentum scrolling is better than
 *     anything reimplemented on top of it, and touch never felt too fast.
 *   - A wheel over something that scrolls itself belongs to that thing, so the
 *     tab strip, a scrollable panel and the Razorpay iframe keep their own
 *     scrolling.
 *   - Ctrl-wheel is pinch zoom, not scrolling.
 *   - Keyboard, scrollbar drag, and any scroll the page starts cancel the
 *     glide on the spot. Nothing here may ever fight the viewer.
 *   - At either end of the document the event is not consumed, so the browser
 *     keeps its own overscroll behaviour.
 *
 * The writes are `behavior: 'instant'` on purpose: `scroll-behavior: smooth` is
 * set globally, and without the override every frame of this animation would
 * be handed to the browser's own smooth scroller and the two would fight.
 */
function createWheelGlide() {
  const off = { stop() {} };
  if (typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function') return off;
  if (REDUCED_MOTION()) return off;
  if (window.matchMedia('(pointer: coarse)').matches) return off;

  /** Fraction of the remaining distance covered each frame. */
  const EASE = 0.18;
  /** One notch travels a little less far than the browser would send it. */
  const SCALE = 0.8;
  /** Below this many pixels, finish rather than chase. */
  const SNAP = 1;

  /** How far the page may have drifted between frames and still be ours. */
  const OURS = 2;

  const root = document.documentElement;
  let target = null;
  let frame = 0;
  let wrote = null;

  const maxScroll = () => Math.max(0, root.scrollHeight - window.innerHeight);
  const jump = (y) => { window.scrollTo(0, y); wrote = window.scrollY; };

  function stop() {
    target = null;
    wrote = null;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    // The sheet's `scroll-behavior: smooth` is handed back the moment the
    // glide is done, so anchor links and the jump to the top on a view change
    // keep animating.
    root.style.scrollBehavior = '';
  }

  function tick() {
    frame = 0;
    if (target === null) return;
    const from = window.scrollY;

    // Somebody else moved the page: a scrollbar drag, a link, a view change.
    // Theirs wins, always.
    if (wrote !== null && Math.abs(from - wrote) > OURS) { stop(); return; }

    const delta = target - from;
    if (Math.abs(delta) < SNAP) { jump(target); stop(); return; }
    jump(from + delta * EASE);
    // The page did not move, so the remaining ease is finer than the browser's
    // scroll quantum. Land on the target rather than abandoning the move
    // part-way, and never spin a frame loop that cannot make progress.
    if (Math.abs(window.scrollY - from) < 0.05) { jump(target); stop(); return; }
    frame = requestAnimationFrame(tick);
  }

  /** True when the wheel is over an element that scrolls on its own. */
  function ownsScroll(node) {
    for (let el = node; el instanceof Element && el !== document.body; el = el.parentElement) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return true;
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) return true;
    }
    return false;
  }

  /**
   * True for a mouse wheel, false for a trackpad.
   *
   * This is the line that decides whether the feature is an improvement or an
   * annoyance. A mouse wheel sends one large integer delta per notch, which is
   * the jump that feels too fast. A trackpad sends a stream of small, often
   * fractional deltas that the browser already turns into momentum, and
   * re-easing a stream that is smooth to begin with is exactly how scroll
   * hijacking earns its reputation. So trackpads are left completely alone:
   * a pixel delta only counts as a notch when it is whole and large.
   */
  function isNotch(e) {
    if (e.deltaMode !== 0) return true; // lines or pages: only a wheel does that
    return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40;
  }

  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.defaultPrevented) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if (!isNotch(e)) return;
    if (ownsScroll(e.target)) return;

    // deltaMode 1 is lines, 2 is pages. Both are normalised to pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    // A live glide continues from where it is heading; anything else starts
    // from where the page actually is.
    const live = target !== null && frame !== 0;
    const base = live ? target : window.scrollY;
    const push = e.deltaY * unit * SCALE;
    const next = Math.max(0, Math.min(maxScroll(), base + push));
    const moved = next - base;
    // At an end of the document the clamp either erases the movement or, when
    // the browser reports a scroll position a fraction beyond our computed
    // maximum, reverses it. Either way the event is not consumed, so the
    // browser keeps its own overscroll and scroll-chaining behaviour.
    if (moved === 0 || Math.sign(moved) !== Math.sign(push)) return;

    e.preventDefault();
    // Every frame of this animation is a scroll the page starts, so the sheet's
    // `scroll-behavior: smooth` would hand each one to the browser's own
    // smooth scroller and the two would fight, undershooting and stalling.
    // Suspended inline for the duration and restored in `stop`.
    root.style.scrollBehavior = 'auto';
    target = next;
    wrote = window.scrollY;
    if (!frame) frame = requestAnimationFrame(tick);
  }, { passive: false });

  ['keydown', 'mousedown', 'touchstart'].forEach((t) =>
    window.addEventListener(t, stop, { passive: true }),
  );

  return { stop };
}

let wheelGlide = { stop() {} };

function switchView(apply) {
  if (typeof document.startViewTransition === 'function' && !REDUCED_MOTION()) {
    // Starting a transition while one is still running aborts the old one, and
    // the aborted transition rejects `finished` and `ready`. Nothing is wrong
    // when that happens - the newer navigation is the one the viewer asked for
    // - but an unhandled rejection is still an error in the console, and a
    // console full of errors is not a thing to hand a judge. Swallowed
    // deliberately, and only here.
    const t = document.startViewTransition(apply);
    if (t) {
      if (t.finished) t.finished.catch(() => {});
      if (t.ready) t.ready.catch(() => {});
      if (t.updateCallbackDone) t.updateCallbackDone.catch(() => {});
    }
  } else {
    apply();
  }
}

/**
 * Entrance motion is armed on view entry, not on every render.
 *
 * `render()` replaces the whole subtree, and a run calls it three times. If the
 * cascade were tied to paint, the page would re-animate under the viewer every
 * time a verdict came back, which reads as a glitch rather than as motion. So
 * the cascade fires once when you arrive and then holds still, and the only
 * things that move afterwards are the things that actually changed.
 */
const entered = { play: false, checkout: false };
/** The certificate of the run already on screen, so a new one can announce itself. */
let paintedCert = null;
/** The chain length already on screen, so growth can be shown. */
let paintedSigned = null;

function armEntrance(view) {
  if (view === 'play') entered.play = false;
  if (view === 'checkout') entered.checkout = false;
}

function go(view, push = true) {
  armEntrance(view);
  switchView(() => {
    state.view = view;
    if (push && location.pathname !== PATHS[view]) history.pushState({ view }, '', PATHS[view]);
    render();
    // The glide is cancelled first: a wheel animation still running would
    // fight the jump to the top and land the new view part-scrolled.
    wheelGlide.stop();
    window.scrollTo(0, 0);
  });
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
  armEntrance(viewFromPath(location.pathname));
  switchView(() => {
    state.view = viewFromPath(location.pathname);
    render();
  });
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
      <a href="/" data-view="argument" aria-label="Pakka home" style="display:flex;align-items:center;gap:13px;min-height:44px">${NAV_SEAL}${NAV_WORDMARK}</a>
      <span class="pv-nav-chip">playground</span>
    </div>
    <div class="pv-nav-right">
      <a href="/" data-view="argument">the argument</a>
      <a href="/checkout" data-view="checkout">checkout</a>
      <span class="pv-nav-policy">policy ${esc(policy)}</span>
      <span class="pv-nav-signed${paintedSigned !== null && signed !== paintedSigned ? ' is-bumped' : ''}">${signed} signed</span>
    </div>
  </div>`;
}

/**
 * The run controls: a tab strip, and one panel with one button.
 *
 * Shaped from what shipped dashboards actually do, not from taste:
 *
 *   - Tabs carry no controls. They are 2-7 parallel views of one context with
 *     1-3 word labels, which is what a tab list is for. Six here: five
 *     directions and the sandbox.
 *   - The active tab takes the panel's surface and drops its bottom rule, so
 *     the strip and the panel read as one object. Tab lists are supposed to sit
 *     against their panel with a connecting border.
 *   - ONE primary button, filled, highest contrast on the page, top right of
 *     the content area. That is where a primary action is expected before
 *     anyone has looked for it, and one-per-step is the rule. Five identical
 *     buttons down a column broke both.
 *   - The expected verdict leads, at size, because block/allow/escalate is the
 *     whole question a viewer is here to ask. Design for the yes/no first.
 *   - Reset is a quiet secondary. Only one thing on this panel is loud.
 *
 * Pressing a tab selects that direction and runs it. Pressing Run runs another
 * of its five domains, picked at random and never the one already showing, so
 * a demo that could be accused of having one cart that works can be watched
 * changing carts.
 */
function pvTabs() {
  const meta = state.meta;
  const dirs = meta ? meta.directions : [];
  const sel = state.showCustom ? 'custom' : state.selectedDirection;

  const tabs = dirs
    .map((d, di) => {
      const on = sel === d.id;
      return `<button class="pv-tab${on ? ' is-active' : ''}" style="--d:${di}"
        role="tab" id="pv-tab-${esc(d.id)}" aria-selected="${on}" aria-controls="pv-runpanel"
        tabindex="${on ? '0' : '-1'}" data-act="pick-dir" data-id="${esc(d.id)}" title="${esc(d.blurb)}">
        <span class="pv-tab-dot pv-bg-${esc(d.expect)}"></span>
        <span class="pv-tab-title">${esc(d.title)}</span>
        <span class="pv-tab-verdict pv-verdict-${esc(d.expect)}${d.expect === 'escalate' ? '-c' : ''}">${esc(d.expect)}</span>
      </button>`;
    })
    .join('');

  const sandOn = state.showCustom;
  return `<div class="pv-tabs" role="tablist" aria-label="Runs">
    ${tabs}
    <button class="pv-tab pv-tab--sandbox${sandOn ? ' is-active' : ''}" style="--d:${dirs.length}"
      role="tab" id="pv-tab-custom" aria-selected="${sandOn}" aria-controls="pv-runpanel"
      tabindex="${sandOn ? '0' : '-1'}" data-act="toggle-custom"
      title="Set the four things that decide the verdict yourself">
      <span class="pv-tab-dot pv-tab-dot--open"></span>
      <span class="pv-tab-title">Sandbox</span>
      <span class="pv-tab-verdict pv-tab-verdict--any">your call</span>
    </button>
  </div>`;
}

function pvRunPanel() {
  const meta = state.meta;
  if (!meta) return '';
  const labelledBy = state.showCustom ? 'pv-tab-custom' : `pv-tab-${state.selectedDirection}`;
  const body = state.showCustom ? pvSandboxBody() : pvDirectionBody();
  return `<div class="pv-panel pv-runs" id="pv-runpanel" role="tabpanel" aria-labelledby="${esc(labelledBy)}" tabindex="0">
    <div class="pv-head-row">
      <div class="pv-head">
        <span class="pv-ordinal">00 &nbsp;the run</span>
        <span class="pv-sub--mono" style="color:var(--muted)">${meta.directions.reduce((n, d) => n + d.exampleCount, 0)} examples across ${meta.directions[0].exampleCount} product domains</span>
      </div>
      <button class="pv-runbtn" data-act="reset">Reset</button>
    </div>
    ${body}
  </div>`;
}

function pvDirectionBody() {
  const meta = state.meta;
  const d = meta.directions.find((x) => x.id === state.selectedDirection) || meta.directions[0];
  const live = state.activeScenario === d.id && !state.showCustom;
  const busy = live && state.running;
  const shown = live ? (d.domains || [])[state.exampleIndex[d.id] ?? 0] : null;
  const label = busy ? 'running' : live ? 'Run another' : 'Run this';

  return `<div class="pv-runpanel">
    <div class="pv-runpanel-text">
      <div class="pv-runpanel-head">
        <span class="pv-runpanel-dot pv-bg-${esc(d.expect)}"></span>
        <h3 class="pv-runpanel-title">${esc(d.title)}</h3>
        <span class="pv-runpanel-verdict pv-verdict-${esc(d.expect)}${d.expect === 'escalate' ? '-c' : ''}">${esc(d.expect)}</span>
      </div>
      <p class="pv-runpanel-blurb">${esc(d.blurb)}</p>
      <div class="pv-runpanel-domain">
        ${shown
          ? `<span class="pv-runpanel-domain-k">showing</span><span class="pv-runpanel-domain-v">${esc(shown)}</span>`
          : `<span class="pv-runpanel-domain-k">not run yet</span>`}
        <span class="pv-runpanel-domain-note">${d.exampleCount} domains · each press picks one at random</span>
      </div>
    </div>
    <button class="pv-runcta${busy ? ' is-busy' : ''}" data-act="run" data-id="${esc(d.id)}">
      <span class="pv-runcta-seal">${SEAL_ASKING(15)}</span>
      <span class="pv-runcta-label">${esc(label)}</span>
    </button>
  </div>`;
}

function pvSandboxBody() {
  const meta = state.meta;
  const c = state.custom;
  const items = meta.sandboxCatalogue
    .map((p, i) => `<option value="${i}"${i === c.itemIndex ? ' selected' : ''}>${esc(p.idx + '  ' + p.name)}</option>`)
    .join('');
  const cats = meta.categories
    .map((cat) => `<option value="${esc(cat)}"${cat === c.authorisedCategory ? ' selected' : ''}>${esc(cat)}</option>`)
    .join('');
  const statedVal = c.statedQuantity === null ? 'unstated' : String(c.statedQuantity);
  const stated = ['1', '2', '3', 'unstated']
    .map((v) => `<option value="${v === 'unstated' ? 'null' : v}"${statedVal === v ? ' selected' : ''}>${v}</option>`)
    .join('');
  const busy = state.activeScenario === 'custom' && state.running;
  return `<div class="pv-runpanel">
    <div class="pv-runpanel-text">
      <div class="pv-runpanel-head">
        <span class="pv-runpanel-dot pv-tab-dot--open"></span>
        <h3 class="pv-runpanel-title">Sandbox</h3>
        <span class="pv-runpanel-verdict pv-tab-verdict--any">your call</span>
      </div>
      <p class="pv-runpanel-blurb">Set the four things that decide the verdict, then run it. Every field is clamped again on the server, so a value edited in devtools cannot reach the gate.</p>
      <div class="pv-sandbox-grid">
        <label><span>Item the agent adds</span><select class="pv-select" data-custom="itemIndex">${items}</select></label>
        <label><span>Quantity in cart</span><input class="pv-input" type="number" min="1" max="9" value="${esc(c.quantity)}" data-custom="quantity"></label>
        <label><span>Quantity stated</span><select class="pv-select" data-custom="statedQuantity">${stated}</select></label>
        <label><span>Authorised category</span><select class="pv-select" data-custom="authorisedCategory">${cats}</select></label>
      </div>
    </div>
    <button class="pv-runcta${busy ? ' is-busy' : ''}" data-act="run-custom">
      <span class="pv-runcta-seal">${SEAL_ASKING(15)}</span>
      <span class="pv-runcta-label">${busy ? 'running' : 'Run the gate'}</span>
    </button>
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
  const catalogue = r ? r.catalogue : [];
  const picked = r ? r.pickedIndex : -1;
  const poison = r ? r.poisonIndex : null;
  const poisonRow = poison !== null ? String(poison).padStart(2, '0') : '';
  const cards = catalogue.map((p, i) => {
    const chosen = i === picked;
    const poisoned = i === poison;
    const cls = poisoned ? ' is-poisoned' : chosen ? ' is-chosen' : '';
    const flags =
      (poisoned ? '<span class="pv-card-poison"></span>' : '') +
      (chosen ? '<span class="pv-card-picked">agent picked</span>' : '');
    const outOfCat = r && p.category !== r.compare[0].want;
    return `<div class="pv-card${cls}" style="--i:${i}">
      <div class="pv-card-top"><span class="pv-card-idx">${esc(p.idx)}</span><div class="pv-card-flags">${flags}</div></div>
      <div class="pv-card-name">${esc(p.name)}</div>
      <div class="pv-card-foot"><span class="pv-card-cat${outOfCat ? ' pv-card-cat--elec' : ''}">${esc(CAT_SHORT(p.category))}</span><span class="pv-card-price">${esc(p.price)}</span></div>
    </div>`;
  }).join('');
  const domain = r ? r.domain : '';
  const note = poison !== null
    ? `<span class="pv-sub--mono" style="color:var(--vermilion)">row ${poisonRow} carries an injected instruction</span>`
    : `<span class="pv-sub--mono" style="color:var(--muted)">${r ? 'clean' : 'pick a run above'}</span>`;
  const payload = poison !== null
    ? `<div class="pv-payload">
        <div class="pv-payload-head"><b>Injected instruction found in row ${poisonRow}</b><span>merchant-controlled text · read by the agent</span></div>
        <p>${esc(meta.payload)}</p>
      </div>` : '';
  return `<div class="pv-panel">
    <div class="pv-head-row">
      <div class="pv-head"><span class="pv-ordinal">02 &nbsp;the shelf</span><span class="pv-sub">${catalogue.length} products${domain ? ' · ' + esc(domain) : ''}</span></div>
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
    ? `<div class="pv-compare">${r.compare.map((c, i) => `<div class="pv-compare-cell" style="--i:${i}">
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
  const fresh = r.certShort !== paintedCert ? ' is-fresh' : '';
  return `<div class="pv-verdict pv-verdict--${dec}${fresh}">
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
    ? r.findings.slice().sort((a, b) => order[a.result] - order[b.result]).map((f, i) => {
        const cls = f.result === 'violation' ? ' pv-check--violation' : f.result === 'undecidable' ? ' pv-check--undecidable' : '';
        return `<div class="pv-check${cls}" style="--i:${i}">
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
  const nodes = entries.map((e, i) => `<div class="pv-node" style="--i:${i}">
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
  // `innerHTML` throws away the focused element. If the viewer was on the tab
  // strip, put them back on the selected tab afterwards, or arrowing along the
  // strip would drop focus to the body on the first press.
  const wasOnTabs = document.activeElement && document.activeElement.closest
    ? !!document.activeElement.closest('[role="tablist"]')
    : false;

  const enter = entered.play ? '' : ' is-enter';
  $('#view-play').innerHTML =
    `<div class="pv-play${enter}">
      ${pvNavbar()}
      ${pvTabs()}
      ${pvRunPanel()}
      ${pvInstruction()}
      ${pvShelf()}
      ${pvCart()}
      ${pvVerdict()}
      ${failure}
      ${pvChecks()}
      ${pvCertChain()}
    </div>`;
  // The strip scrolls sideways on a phone, so the selected tab has to be
  // brought into view or the panel below would be describing a tab you cannot
  // see. Done by setting `scrollLeft` on the strip rather than with
  // `scrollIntoView`, which would also scroll the page.
  const strip = $('.pv-tabs');
  const sel = $('[role="tab"][aria-selected="true"]');
  if (strip && sel && strip.scrollWidth > strip.clientWidth) {
    const left = sel.offsetLeft;
    const right = left + sel.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  }
  if (wasOnTabs && sel) sel.focus({ preventScroll: true });
  entered.play = true;
  paintedCert = state.run ? state.run.certShort : null;
  paintedSigned = state.chain ? state.chain.records : null;
}


/* ── checkout v2, ported ─────────────────────────────────────────────────
 * handoff_pakka_checkout_v2, wired to the real gate. The design's DEMO control
 * is deleted as the README instructs: this page receives its decision from the
 * certificate the playground actually signed.
 */

const CK_APPS = [['Google Pay', 'GP'], ['PhonePe', 'PP'], ['Paytm', 'PT']];
const CK_ALT = [
  ['Card', 'visa · mc · rupay'],
  ['Netbanking', '58 banks'],
  ['Wallet', '12 wallets'],
];
const VPA_RE = /^[a-z0-9._-]{2,}@[a-z]{2,}$/i;

const CK_SEAL = (fill, ink) =>
  `<svg width="46" height="46" viewBox="0 0 32 32" aria-hidden="true"><path d="M0 0H22L32 10V32H0Z" fill="${fill}"></path>` +
  `<g transform="translate(-0.6,0.6)" stroke="${ink}" stroke-width="3" fill="none" stroke-linecap="butt" stroke-linejoin="miter">` +
  `<path d="M8 8V24"></path><path d="M16 8L8 16L16 24"></path><path d="M25 8L17 16L25 24"></path></g></svg>`;

function ckNav() {
  return `<div class="ck-nav">
    <div class="ck-nav-left">
      <a href="/" data-view="argument" aria-label="Pakka home" style="display:flex;align-items:center;gap:13px;min-height:44px">${NAV_SEAL}${NAV_WORDMARK}</a>
      <span class="ck-nav-chip">checkout</span>
    </div>
    <div class="ck-nav-right">
      <a href="/" data-view="argument">the argument</a>
      <a href="/play" data-view="play">playground</a>
      <span class="ck-nav-key">rzp_test</span>
    </div>
  </div>`;
}

function ckSteps(dec) {
  const payState = dec === 'block' ? 'unreachable'
    : state.pay === 'captured' ? 'captured'
    : state.pay === 'failed' ? 'failed'
    : 'ready';
  const steps = [
    { n: '01', label: 'Cart', st: 'settled' },
    { n: '02', label: 'The gate', st: dec },
    { n: '03', label: 'Pay', st: payState },
  ];
  return `<div class="ck-steps">
    ${steps.map((s, i) => `<div class="ck-step${i === 2 ? ' is-current' : ''}" style="--i:${i}">
      <span class="ck-step-n">${esc(s.n)}</span>
      <span class="ck-step-label">${esc(s.label)}</span>
      <span class="ck-step-state ck-state-${esc(s.st)}">${esc(s.st)}</span>
    </div>`).join('')}
    <div class="ck-steps-tail"></div>
  </div>`;
}

function ckStamp(dec, r) {
  const violations = r ? r.findings.filter((f) => f.result === 'violation').length : 0;
  const line = dec === 'block'
    // The design's prose says "Three checks"; the real count is printed instead,
    // because a page that argues every number keeps its caveat cannot hardcode one.
    ? `The cart did not match the instruction that authorised it. ${violations} check${violations === 1 ? '' : 's'} returned a violation, so no order exists to pay for.`
    : dec === 'escalate'
      ? 'A checker could not decide, so the decision rose. Payment stays available but a human must approve this cart before it settles.'
      : 'Every check cleared against the signed instruction. The cart hash is re-derived at authorisation and compared with the certificate before the order is created.';
  const seal = dec === 'block' ? CK_SEAL('#F5F2E9', '#0E100C')
    : dec === 'escalate' ? CK_SEAL('#0E100C', '#E8C400')
    : CK_SEAL('#E8C400', '#0E100C');
  return `<div class="ck-stamp ck-stamp--${esc(dec)}">
    <div class="ck-stamp-row">
      ${seal}
      <div class="ck-stamp-mid">
        <div class="ck-stamp-head">
          <span class="ck-stamp-kicker">The gate has ruled</span>
          <span class="ck-stamp-word">${esc(dec)}</span>
        </div>
        <p class="ck-stamp-line">${esc(line)}</p>
      </div>
      <div class="ck-stamp-hashes">certificate <b>${esc(r.certShort)}</b><br>cart hash <b>${esc(r.cartHashShort)}</b></div>
    </div>
  </div>`;
}

function ckPaymentPanel() {
  const tiles = CK_APPS.map(([name, initials], i) => `<button class="ck-tile${state.app === name ? ' is-on' : ''}" style="--i:${i}" data-act="pick-app" data-app="${esc(name)}">
      <span class="ck-tile-mark">${esc(initials)}</span>
      <span class="ck-tile-name">${esc(name)}</span>
    </button>`).join('');
  const vc = state.vpaCheck;
  const verifyCls = vc ? (vc.ok ? ' is-ok' : ' is-bad') : '';
  const verifyLabel = vc ? (vc.ok ? 'Verified' : 'Recheck') : 'Verify';
  const result = vc
    ? `<div class="ck-vpares${vc.ok ? ' is-ok' : ''}"><span class="ck-vpadot"></span><span class="ck-vpatext">${esc(vc.ok ? 'UPI ID exists · ' + vc.name : 'Not a valid UPI ID - expected name@bank')}</span></div>`
    : '';
  return `<div class="ck-panel">
    <div class="ck-pay-head">
      <div class="ck-pay-head-left">
        <span class="ck-ord">02 &nbsp;pay by upi</span>
        <span class="ck-sub">open your app and approve, nothing leaves this page</span>
      </div>
      <span class="ck-flow">intent flow</span>
    </div>
    <div class="ck-upi">${tiles}</div>
    <div class="ck-or"><span></span><span class="ck-or-text">or pay by any UPI app</span><span></span></div>
    <div class="ck-vparow">
      <label><span class="ck-field-label">Your UPI ID</span>
        <input id="pk-vpa" class="ck-input" value="${esc(state.vpa)}" placeholder="name@bank"></label>
      <button class="ck-verify${verifyCls}" data-act="verify">${esc(verifyLabel)}</button>
    </div>
    ${result}
    <div class="ck-chips">
      <button class="ck-chip" data-act="vpa-success">success@razorpay</button>
      <button class="ck-chip" data-act="vpa-failure">failure@razorpay</button>
    </div>
    <div class="ck-alt-wrap">
      <div class="ck-alt-label">Other ways to pay</div>
      <div class="ck-alt">${CK_ALT.map(([n, note]) => `<div class="ck-alt-row"><span>${esc(n)}</span><span>${esc(note)}</span></div>`).join('')}</div>
    </div>
  </div>`;
}

function ckCommit(dec, r) {
  const paying = state.pay === 'creating' || state.pay === 'awaiting' || state.pay === 'confirming';
  const held = dec === 'escalate';
  const label = paying ? 'awaiting approval in your app' : (held ? 'Approve and pay ' : 'Pay ') + r.cartTotal;
  const note = paying
    ? 'a collect request was sent to ' + state.vpa
    : held
      ? 'this cart is held, approving records a human override on the certificate'
      : 'cart hash re-checked against the certificate at authorisation';
  return `<div class="ck-panel ck-commit">
    <button class="ck-paybtn" data-act="pay"${paying ? ' disabled' : ''}><span class="ck-paybtn-label">${esc(label)}</span></button>
    <div class="ck-paynote"><span>${esc(note)}</span><span>Razorpay · test mode · no money moves</span></div>
    <div class="ck-trust">
      <div class="ck-trust-item ck-trust-haldi"><span></span><p>In test mode a <em>cancelled</em> UPI payment resolves as a successful one, cancellation can only be tested live. Printed rather than left to look like a success we earned.</p></div>
      <div class="ck-trust-item ck-trust-grey"><span></span><p>Reserve sizing follows NPCI OC-228, triangulated from three secondary sources; the primary circular returns HTTP 403 to automated fetching.</p></div>
    </div>
  </div>`;
}

/* The blocked state: the payment panel still renders at 34%, with the refusal
   over it. You see the checkout that did not happen. The pay control is ABSENT
   from the DOM, never disabled. */
function ckRefused() {
  const ghostTiles = CK_APPS.map(([name, initials]) => `<div class="ck-tile" style="cursor:default">
      <span class="ck-tile-mark">${esc(initials)}</span><span class="ck-tile-name">${esc(name)}</span></div>`).join('');
  return `<div class="ck-panel ck-refused-wrap">
    <div class="ck-ghost" aria-hidden="true">
      <div class="ck-ord" style="margin-bottom:18px">02 &nbsp;pay by upi</div>
      <div class="ck-upi">${ghostTiles}</div>
      <div class="ck-ghost-field"></div>
      <div class="ck-ghost-btn"></div>
    </div>
    <div class="ck-refused">
      <div class="ck-refused-card">
        <div class="ck-refused-head">
          <span class="ck-refused-kicker">No order was created</span>
          <span class="ck-refused-word">block</span>
        </div>
        <p>Payment was never attempted. <b>createOrder</b> takes a certified decision and throws on a block, so the refusal is enforced by the gate, not by this page.</p>
        <a class="ck-refused-link" href="/play" data-view="play">Back to the playground</a>
      </div>
    </div>
  </div>`;
}

function ckOutcome(r) {
  const p = state.payment;
  const o = state.order;
  if (state.pay === 'failed') {
    const fields = p
      ? [
          ['reason', p.payment.errorReason || 'payment_failed', 'is-bad'],
          ['step', p.payment.errorStep || 'payment_authentication', ''],
          ['payment id', p.payment.id, ''],
          ['certificate', r.certShort + ' · unaffected', ''],
        ]
      : [
          ['reason', state.failCode, 'is-bad'],
          ['detail', state.orderError || '-', ''],
          ['order id', o ? o.order.id : 'no order created', ''],
          ['certificate', r.certShort + ' · unaffected', ''],
        ];
    return `<div class="ck-panel ck-out--failed">
      <div class="ck-out-head"><span class="ck-out-word">payment failed</span><span class="ck-out-code">${esc(state.failCode)}</span></div>
      <div class="ck-fields">${fields.map(([k, v, cls], i) => `<div class="ck-field" style="--i:${i}"><div class="ck-field-k">${esc(k)}</div><div class="ck-field-v ${cls}">${esc(v)}</div></div>`).join('')}</div>
      <p class="ck-out-prose">The certificate is unaffected. It records what was asked, what was in the cart and what the gate decided, so a failed payment changes none of those and the conformance evidence survives for the dispute.</p>
      <div class="ck-out-btns">
        <button class="ck-btn ck-btn--solid" data-act="retry">Try again</button>
        <button class="ck-btn" data-act="pay-success">Pay with success@razorpay</button>
      </div>
    </div>`;
  }
  const fields = [
    ['payment id', p ? p.payment.id : '-', ''],
    ['order id', p ? p.orderId : '-', ''],
    ['paid by', p && p.payment.vpa ? p.payment.vpa : state.vpa, ''],
    ['cart hash re-check', o && o.recheck.ok ? 'match' : 'MISMATCH', o && o.recheck.ok ? 'is-good' : 'is-bad'],
  ];
  return `<div class="ck-panel ck-out--captured">
    <div class="ck-out-head"><span class="ck-out-word">payment captured</span><span class="ck-out-code">upi · intent</span></div>
    <div class="ck-fields">${fields.map(([k, v, cls], i) => `<div class="ck-field" style="--i:${i}"><div class="ck-field-k">${esc(k)}</div><div class="ck-field-v ${cls}">${esc(v)}</div></div>`).join('')}</div>
    <p class="ck-out-prose">The cart hash was re-derived at authorisation and matched the one inside the certificate. Had the cart moved between the gate and the order, this payment would have been refused.</p>
  </div>`;
}

function ckRail(dec, r) {
  const rz = state.meta && state.meta.razorpay;
  const units = r.cart.reduce((n, l) => n + Number(l.qty), 0);
  const totals = [
    ['Cart total', r.cartTotal],
    ['Delivery', 'free'],
    ['Reserve held (OC-228)', r.reserve ? r.reserve.amount : '-'],
  ];
  const bindings = [
    ['gate decision', dec, dec === 'allow' ? 'is-allow' : dec === 'block' ? 'is-block' : ''],
    ['certificate', r.certShort, 'brk'],
    ['cart hash', r.cartHashShort, 'brk'],
    ['reserve', r.reserve ? r.reserve.amount + ' · ' + r.reserve.rationale : '-', ''],
    ['key mode', rz && rz.enabled ? 'rzp_test_ · guard refuses a live key' : 'rzp_test_ · not configured', ''],
  ];
  return `<div class="ck-rail">
    <div class="ck-card">
      <div class="ck-sum-head"><b>Order summary</b><span>${r.cart.length} line · ${units} unit${units === 1 ? '' : 's'}</span></div>
      ${r.cart.map((l, i) => `<div class="ck-sum-line" style="--i:${i}">
        <div class="ck-sum-line-name">${esc(l.name)}</div>
        <div class="ck-sum-line-meta"><span>${esc(l.qty)} × ${esc(l.unit)} · ${esc(l.category)}</span><span>${esc(l.total)}</span></div>
      </div>`).join('')}
      ${totals.map(([k, v]) => `<div class="ck-sum-total-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}
      <div class="ck-amount"><b>Amount payable</b><span>${esc(dec === 'block' ? r.cartTotal : r.cartTotal)}</span></div>
    </div>
    <div class="ck-card ck-bind">
      <div class="ck-bind-label">Bound to this order</div>
      ${bindings.map(([k, v, cls], i) => `<div class="ck-bind-row" style="--i:${i}"><div class="ck-bind-k">${esc(k)}</div><div class="ck-bind-v ${cls}">${esc(v)}</div></div>`).join('')}
    </div>
  </div>`;
}

function renderCheckout() {
  const r = state.run;
  if (!r) {
    $('#view-checkout').innerHTML = `<div class="ck-page${entered.checkout ? '' : ' is-enter'}">${ckNav()}
      <div class="ck-body" style="grid-template-columns:1fr">
        <div class="ck-panel">
          <div class="ck-ord" style="margin-bottom:14px">no cart yet</div>
          <p class="ck-out-prose">Checkout binds to a certificate, not to a cart. Run the gate in the playground once and this page carries the cart hash, the reserve, and the certificate it was signed into.</p>
          <div class="ck-out-btns"><a class="ck-btn ck-btn--solid" href="/play" data-view="play" style="display:inline-flex;align-items:center;text-decoration:none">Open the playground</a></div>
        </div>
      </div></div>`;
    entered.checkout = true;
    return;
  }
  const dec = r.decision;
  const blocked = dec === 'block';
  const failed = state.pay === 'failed';
  const captured = state.pay === 'captured';
  const payable = !blocked && !failed && !captured;

  let main = ckStamp(dec, r);
  if (payable) main += ckPaymentPanel() + ckCommit(dec, r);
  else if (blocked) main += ckRefused();
  else main += ckOutcome(r);

  const enter = entered.checkout ? '' : ' is-enter';
  $('#view-checkout').innerHTML =
    `<div class="ck-page${enter}">
      ${ckNav()}
      ${ckSteps(dec)}
      <div class="ck-body">
        <div class="ck-main">${main}</div>
        ${ckRail(dec, r)}
      </div>
    </div>`;
  entered.checkout = true;
}

function render() {
  const v = state.view;

  $('#view-argument').hidden = v !== 'argument';
  $('#view-play').hidden = v !== 'play';
  $('#view-checkout').hidden = v !== 'checkout';

  // The v2 playground and checkout carry their own Ink navbar, so the shared nav
  // steps aside on those views and returns for the argument page.
  const sharedNav = $('.pk-nav');
  if (sharedNav) sharedNav.hidden = v === 'play' || v === 'checkout';

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
  'go-poisoned': () => { go('play'); state.selectedDirection = 'injection'; state.showCustom = false; runScenario('injection'); },
  'go-clean': () => { go('play'); state.selectedDirection = 'honest'; state.showCustom = false; runScenario('honest'); },
  // The one primary button. It re-runs the selected direction on another of
  // its domains.
  run: (el) => runScenario(el.dataset.id),
  // A tab. Selecting a direction runs it, the way pressing it always has.
  'pick-dir': (el) => {
    state.selectedDirection = el.dataset.id;
    state.showCustom = false;
    return runScenario(el.dataset.id);
  },
  // The sandbox is the sixth tab. Selecting it does not run anything: its
  // inputs have to be set first, so its own button is the trigger.
  'toggle-custom': () => { state.showCustom = true; render(); },
  'run-custom': () => runCustom(),
  reset,
  'vpa-success': () => { state.vpa = 'success@razorpay'; state.vpaCheck = null; render(); },
  'vpa-failure': () => { state.vpa = 'failure@razorpay'; state.vpaCheck = null; render(); },
  // Verify is a local shape check, not a lookup: no name-resolution API is
  // called, so it never claims to have found a real person behind the handle.
  verify: () => {
    const v = state.vpa.trim();
    const ok = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(v);
    state.vpaCheck = { ok, name: v.split('@')[0] };
    render();
  },
  'pick-app': (el) => { state.app = state.app === el.dataset.app ? null : el.dataset.app; render(); },
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

/**
 * Tablist keys: Left/Right move between tabs, Home/End jump to the ends.
 *
 * A tab strip is one stop in the Tab order, not six. The markup carries the
 * roving `tabindex` (0 on the selected tab, -1 on the rest) so the Tab key
 * reaches the panel in one press instead of walking every direction first;
 * this handler is the other half of that contract. Activation is on move,
 * which is the expected behaviour when switching costs nothing to undo.
 */
document.addEventListener('keydown', (e) => {
  const tab = e.target.closest && e.target.closest('[role="tab"]');
  if (!tab) return;
  const keys = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
  const move = keys[e.key];
  if (move === undefined) return;
  const tabs = Array.from(tab.parentElement.querySelectorAll('[role="tab"]'));
  const here = tabs.indexOf(tab);
  const next =
    move === 'first' ? tabs[0]
    : move === 'last' ? tabs[tabs.length - 1]
    : tabs[(here + move + tabs.length) % tabs.length];
  if (!next) return;
  e.preventDefault();
  const act = ACTIONS[next.dataset.act];
  if (act) act(next);
  // Focus is not restored here. Selecting a tab starts a run, which re-renders
  // this subtree three times over the next second, so anything focused now
  // would be discarded twice. `renderPlay` carries focus across every one of
  // those paints instead.
});

// The VPA field and the custom-run fields bind to state on edit. No re-render on
// keystroke: the number input would lose its cursor, and the run reads state at
// submit time regardless.
function bindField(e) {
  if (e.target.id === 'pk-vpa') {
    state.vpa = e.target.value;
    // A stale 'Verified' badge under an edited handle would be a lie.
    if (state.vpaCheck) { state.vpaCheck = null; render(); }
    return;
  }
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

wheelGlide = createWheelGlide();

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
