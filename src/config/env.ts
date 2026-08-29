/**
 * Environment loading with a hard safety guard.
 *
 * SECURITY-MODEL.md, Unit V: a live Razorpay key must never be usable by this
 * process, even by accident. The guard is a startup precondition, not a runtime
 * check — there is no code path that reaches the Razorpay client without it.
 *
 * Secrets are never logged, never returned in errors, and never serialised.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv();

/** Razorpay test-mode key ids are prefixed. Live keys use `rzp_live_`. */
const TEST_KEY_PREFIX = 'rzp_test_';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function read(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function require_(key: string): string {
  const v = read(key);
  if (v === undefined) {
    // Names the key, never the value.
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return v;
}

/**
 * Razorpay credentials, guarded to test mode.
 *
 * @throws ConfigError if the key id is not a test key. This is deliberate and
 * must never be downgraded to a warning: the alternative is a project that can
 * move real money by typo.
 */
export function razorpayCredentials(): { keyId: string; keySecret: string } {
  const keyId = require_('RAZORPAY_KEY_ID');
  const keySecret = require_('RAZORPAY_KEY_SECRET');

  if (!keyId.startsWith(TEST_KEY_PREFIX)) {
    throw new ConfigError(
      `RAZORPAY_KEY_ID must be a test key (expected prefix "${TEST_KEY_PREFIX}"). ` +
        `Refusing to start. This project never runs against live credentials.`,
    );
  }

  // A secret that looks like a key id means the two fields were swapped or
  // pasted wrong — a real mistake we have already hit once.
  if (keySecret.startsWith('rzp_')) {
    throw new ConfigError(
      'RAZORPAY_KEY_SECRET looks like a key id (starts with "rzp_"). ' +
        'The secret has no prefix. Check .env.',
    );
  }

  return { keyId, keySecret };
}

export function geminiApiKey(): string {
  return require_('GEMINI_API_KEY');
}

/** True when credentials are present, without throwing. For test skipping. */
export function hasRazorpayCredentials(): boolean {
  return read('RAZORPAY_KEY_ID') !== undefined && read('RAZORPAY_KEY_SECRET') !== undefined;
}

export function hasGeminiKey(): boolean {
  return read('GEMINI_API_KEY') !== undefined;
}
