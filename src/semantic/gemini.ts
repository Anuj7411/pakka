/**
 * Gemini adapter.
 *
 * The only place in this project that talks to a third party. Everything about
 * it is deliberately boring: pinned model, temperature 0, provider-enforced
 * structured output, one attempt, hard timeout.
 *
 * No retries. A retry that produces a different verdict makes a run
 * irreproducible, and reproducibility is the thing we are selling. A failed
 * call becomes `unsure`, which under the lattice can only escalate — never
 * approve.
 */
import { geminiApiKey } from '../config/env.js';
import { containsForbiddenField, FORBIDDEN_FIELDS } from './redact.js';
import { parseVerdict, type JudgeVerdict } from './prompt.js';
import { ProviderError, type Provider, type ProviderRequest } from './provider.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Gemini's schema dialect is OpenAPI-ish with uppercase type names. */
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['satisfies', 'wrong_product', 'unsure'] },
    confidence: { type: 'NUMBER' },
    reason: { type: 'STRING' },
  },
  required: ['verdict', 'confidence', 'reason'],
} as const;

export interface GeminiOptions {
  /** Pinned. Recorded in the certificate so a result can be reproduced. */
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so tests never need a real key. */
  readonly apiKey?: string;
}

export function createGeminiProvider(opts: GeminiOptions = {}): Provider {
  const model = opts.model ?? 'gemini-2.5-flash';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  return {
    id: model,

    async judge(req: ProviderRequest): Promise<JudgeVerdict> {
      const body = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          // Deterministic decoding. A sampled judge cannot be reproduced.
          temperature: 0,
          candidateCount: 1,
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      };

      // LAST GATE before egress — and, deliberately, one that cannot fire from
      // this function's own arguments.
      //
      // containsForbiddenField matches a name in UNESCAPED quotes, i.e. a real
      // JSON key. `req.system` and `req.user` become string values, so their
      // quotes are escaped and a product legitimately named "Address Book" is
      // not a false alarm. That is the right trade: refusing honest catalogue
      // text would break the gate for everyone.
      //
      // What remains is a tripwire for a REFACTOR that puts a personal-data
      // field into the body shape. tests/gemini.test.ts pins the invariant it
      // protects — the exact keys this body carries — so adding one is a
      // visible, failing change rather than a silent egress.
      const leaked = containsForbiddenField(body);
      if (leaked !== null) {
        throw new ProviderError(
          `Refusing to send: payload contains forbidden field "${leaked}". ` +
            `Nothing in ${FORBIDDEN_FIELDS.length} personal-data fields may leave this process.`,
        );
      }

      const key = opts.apiKey ?? geminiApiKey();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await doFetch(`${ENDPOINT}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          // A 429 body states how long to wait ("Please retry in 3.99s"). Blind
          // exponential backoff ignored that and compounded to 60s while the
          // server was asking for 4 - which is how a paced run turned into a
          // stall. Surface the number so the caller can honour it.
          const retryAfter = await extractRetryDelay(res);
          return {
            verdict: 'unsure',
            confidence: 0,
            // Status only, never the body: a provider error can echo the
            // request, and this string may reach a log.
            reason: `provider HTTP ${res.status}`,
            failed: true,
            ...(retryAfter === null ? {} : { retryAfterMs: retryAfter }),
          };
        }

        const json = (await res.json()) as unknown;
        return parseVerdict(extractText(json));
      } catch (e) {
        const why = (e as Error).name === 'AbortError' ? 'timeout' : 'transport error';
        return { verdict: 'unsure', confidence: 0, reason: `provider ${why}`, failed: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The server's own retry delay, in ms.
 *
 * Prefers the `Retry-After` header, falls back to the seconds embedded in the
 * Gemini quota message. Returns null when neither is present, so the caller
 * falls back to its own pacing rather than guessing zero.
 */
async function extractRetryDelay(res: Response): Promise<number | null> {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  }
  try {
    const body = await res.text();
    const m = /retry in ([\d.]+)s/i.exec(body) ?? /"retryDelay"\s*:\s*"([\d.]+)s"/i.exec(body);
    if (m?.[1]) {
      const secs = Number(m[1]);
      if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
    }
  } catch {
    // Body unreadable; caller uses its own pacing.
  }
  return null;
}

/** Pull the first candidate's text. Any shape surprise becomes `unsure` upstream. */
function extractText(json: unknown): string {
  const r = json as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return r?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
