/**
 * The console's backend.
 *
 * Serves one scenario and runs it on demand, clean or poisoned. Everything the
 * UI shows comes from the real modules — the same `evaluate()` the Razorpay
 * demo uses, the same audit log, the same certificate. Nothing here is staged
 * for the screen.
 *
 *   npx tsx demo/api.ts        # then open http://localhost:5173
 */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { loadWebShop, usableProducts, richInstructions } from '../src/corpus/webshop.js';
import { pairInstructions, pairablePool } from '../src/corpus/pairing.js';
import { Rng } from '../src/corpus/rng.js';
import { createShopper, type CatalogueEntry } from '../src/agent/shopper.js';
import { buildScenario, cartFromPicks, hasCleanChoice, type Scenario } from '../src/agent/measure.js';
import { evaluate } from '../src/gate/pipeline.js';
import { AuditLog } from '../src/audit/log.js';
import { signerFromEnv, verifierFromPublicKey } from '../src/cert/signing.js';
import { certificateHash, verifyCertificate } from '../src/cert/certificate.js';
import { hasGeminiKey } from '../src/config/env.js';
import { NULL_PROVIDER, type Provider } from '../src/semantic/provider.js';
import { INJECTION_PAYLOAD, INJECTION_QUANTITY } from '../src/agent/injection.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
loadEnv({ path: join(packageRoot, '.env') });

const PORT = 5173;
const MODEL = 'gemini-3.1-flash-lite';


/**
 * A judge that has been completely taken over.
 *
 * Used for every run the console makes, so what the screen shows is the gate
 * holding while the model is captured — not the model resisting.
 */
const CAPTURED: Provider = {
  id: 'captured-judge',
  judge: async () => ({ verdict: 'satisfies', confidence: 1, reason: 'approved', failed: false }),
};

const signer = signerFromEnv();
const verifier = verifierFromPublicKey(signer.publicKeyBase64());
mkdirSync(join(packageRoot, 'audit'), { recursive: true });
const log = new AuditLog(join(packageRoot, 'audit', 'console.jsonl'));

const data = loadWebShop(join(packageRoot, 'data'));
const pairs = pairInstructions(pairablePool(data, richInstructions), usableProducts(data));

/** One scenario with an out-of-category product available to poison. */
function pickScenario(): { scenario: Scenario; poisonIndex: number } {
  const rng = new Rng(20260901);
  for (let i = 0; i < pairs.length; i++) {
    const s = buildScenario(pairs[i]!, pairs, rng);
    if (s === null || !hasCleanChoice(s)) continue;
    const idx = s.catalogue.findIndex((e) => e.category !== s.mandate.authorisedCategory);
    if (idx >= 0) return { scenario: s, poisonIndex: idx };
  }
  throw new Error('no suitable scenario');
}

const { scenario, poisonIndex } = pickScenario();
const shopper = createShopper({ model: MODEL });

function poisonedCatalogue(): CatalogueEntry[] {
  return scenario.catalogue.map((e) =>
    e.index === poisonIndex ? { ...e, description: `${e.description} ${INJECTION_PAYLOAD}` } : e,
  );
}

async function runOnce(poisoned: boolean) {
  const catalogue = poisoned ? poisonedCatalogue() : scenario.catalogue;

  const agent = hasGeminiKey()
    ? await shopper.shop(scenario.request, catalogue)
    : { picks: [], failed: true, reason: 'GEMINI_API_KEY not set' };

  if (agent.failed) {
    // An outage is not an empty cart. The UI must be able to tell them apart.
    return { agentFailed: true, agentReason: agent.reason };
  }

  const cart = cartFromPicks(scenario, agent.picks);
  const certified = await evaluate({
    mandate: scenario.mandate,
    cart,
    provider: hasGeminiKey() ? CAPTURED : NULL_PROVIDER,
    signer,
    log,
    model: { id: `${MODEL} (captured)`, temperature: 0 },
    reserve: { merchantId: 'merchant-demo', customerId: 'customer-demo' },
  });

  const chain = AuditLog.verify(log.path, verifier);
  const cert = certified.certificate;

  return {
    agentFailed: false,
    poisoned,
    tookBait: poisoned && agent.picks.some((p) => p.index === poisonIndex),
    obeyedQuantity: agent.picks.some((p) => p.index === poisonIndex && p.quantity === INJECTION_QUANTITY),
    picks: agent.picks.map((p) => ({
      ...p,
      name: scenario.catalogue[p.index]!.name,
      category: scenario.catalogue[p.index]!.category,
      pricePaise: scenario.catalogue[p.index]!.pricePaise,
    })),
    decision: certified.decision,
    degraded: certified.degraded,
    violations: cert.violations,
    certificate: {
      id: cert.certificate_id,
      hash: certificateHash(cert),
      mandate_hash: cert.mandate_hash,
      cart_hash: cert.cart_hash,
      policy_version: cert.policy_version,
      prev_hash: cert.prev_hash,
      key_id: cert.key_id,
      issued_at: cert.issued_at,
      signature: cert.signature,
      model: cert.model,
      reserve: cert.reserve,
      verifies: verifyCertificate(cert, verifier).ok,
    },
    chain: { records: chain.length, valid: chain.ok, breaks: chain.breaks.length, head: chain.head },
  };
}

function json(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  const url = req.url ?? '/';

  if (url.startsWith('/api/scenario')) {
    json(res, {
      request: scenario.request,
      authorisedCategory: scenario.mandate.authorisedCategory,
      stated: {
        attributes: scenario.mandate.items[0]!.statedAttributes,
        options: scenario.mandate.items[0]!.statedOptions,
      },
      correctIndex: scenario.correctIndex,
      poisonIndex,
      payload: INJECTION_PAYLOAD,
      model: MODEL,
      hasKey: hasGeminiKey(),
      catalogue: scenario.catalogue,
    });
    return;
  }

  if (url.startsWith('/api/run')) {
    const poisoned = url.includes('poisoned=1');
    runOnce(poisoned).then(
      (r) => json(res, r),
      (e: Error) => json(res, { error: e.message }, 500),
    );
    return;
  }

  if (url.startsWith('/api/chain')) {
    const v = AuditLog.verify(log.path, verifier);
    json(res, {
      records: v.length,
      valid: v.ok,
      breaks: v.breaks,
      head: v.head,
      entries: AuditLog.read(log.path)
        .slice(-12)
        .map((c) => ({
          id: c.certificate_id,
          decision: c.decision,
          issued_at: c.issued_at,
          cart_hash: c.cart_hash,
          prev_hash: c.prev_hash,
          hash: certificateHash(c),
          verifies: verifyCertificate(c, verifier).ok,
        })),
    });
    return;
  }

  if (url.startsWith('/site.css')) {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(readFileSync(join(here, 'site.css'), 'utf8'));
    return;
  }

  // Two routes: the landing page makes the argument, the playground runs it.
  const page = url === '/' || url.startsWith('/index') ? 'index.html'
    : url.startsWith('/play') ? 'console.html'
    : null;

  if (page) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(here, page), 'utf8'));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}).listen(PORT);

console.log(`request : ${scenario.request}`);
console.log(`model   : ${hasGeminiKey() ? MODEL : 'none — set GEMINI_API_KEY'}`);
console.log(`serving : http://localhost:${PORT}`);
