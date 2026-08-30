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

      // LAST GATE before egress. The allowlist in redact.ts should already make
      // this impossible; this catches a refactor that reintroduces a field by
      // another path. Checking the serialised payload catches nesting too.
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
          // Status only. A provider error body can echo the request, and this
          // message may end up in a log.
          return {
            verdict: 'unsure',
            confidence: 0,
            reason: `provider HTTP ${res.status}`,
            failed: true,
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

/** Pull the first candidate's text. Any shape surprise becomes `unsure` upstream. */
function extractText(json: unknown): string {
  const r = json as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return r?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}
