/**
 * Groq adapter.
 *
 * A second, faster, more generous free provider than Gemini: Groq's free tier
 * runs at 30 requests/minute and ~1,000/day per model on LPU hardware that
 * answers in well under a second, which is what makes a live demo reliable
 * where the Gemini free tier rate-limited. Same contract as the Gemini adapter:
 * pinned model, temperature 0, one attempt, hard timeout, structured JSON out.
 *
 * OpenAI-compatible endpoint, so this is a thin POST. A failed call becomes
 * `unsure`, which under the lattice can only escalate, never approve.
 */
import { groqApiKey } from '../config/env.js';
import { containsForbiddenField, FORBIDDEN_FIELDS } from './redact.js';
import { parseVerdict, type JudgeVerdict } from './prompt.js';
import { ProviderError, type Provider, type ProviderRequest } from './provider.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/** Appended to the system prompt so json_object mode returns the exact shape
 *  the schema-enforced Gemini path gets for free. `parseVerdict` is the same
 *  strict parser, so anything off-shape still degrades to `unsure`. */
const JSON_INSTRUCTION =
  ' Respond ONLY with a JSON object of exactly this shape: ' +
  '{"verdict": one of "satisfies" | "wrong_product" | "unsure", ' +
  '"confidence": a number between 0 and 1, "reason": one short sentence}. No other text.';

export interface GroqOptions {
  /** Pinned. Recorded in the certificate so a result can be reproduced. */
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so tests never need a real key. */
  readonly apiKey?: string;
}

export function createGroqProvider(opts: GroqOptions = {}): Provider {
  // Pinned to a model that is actually on Groq's current free lineup: the
  // llama-3.3-70b id was retired. gpt-oss-120b is the flagship free model,
  // returns clean JSON under response_format, and answers in ~0.3s.
  const model = opts.model ?? 'openai/gpt-oss-120b';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  return {
    id: model,

    async judge(req: ProviderRequest): Promise<JudgeVerdict> {
      const body = {
        model,
        // Deterministic decoding. A sampled judge cannot be reproduced.
        temperature: 0,
        max_tokens: 256,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: req.system + JSON_INSTRUCTION },
          { role: 'user', content: req.user },
        ],
      };

      // Same egress tripwire as the Gemini adapter: `req.system`/`req.user`
      // become string values whose quotes are escaped, so a product legitimately
      // named "Address Book" is not a false alarm. What this catches is a
      // refactor that puts a real personal-data KEY into the body shape.
      const leaked = containsForbiddenField(body);
      if (leaked !== null) {
        throw new ProviderError(
          `Refusing to send: payload contains forbidden field "${leaked}". ` +
            `Nothing in ${FORBIDDEN_FIELDS.length} personal-data fields may leave this process.`,
        );
      }

      const key = opts.apiKey ?? groqApiKey();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          const retryAfter = retryAfterMs(res);
          return {
            verdict: 'unsure',
            confidence: 0,
            // Status only, never the body: a provider error can echo the request.
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

/** Groq states its wait in the standard `retry-after` header (seconds). */
function retryAfterMs(res: Response): number | null {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  }
  return null;
}

/** Pull the first choice's message content. Any shape surprise becomes `unsure`. */
function extractText(json: unknown): string {
  const r = json as { choices?: { message?: { content?: string } }[] };
  return r?.choices?.[0]?.message?.content ?? '';
}
