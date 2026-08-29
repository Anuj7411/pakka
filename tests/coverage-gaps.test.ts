/**
 * Closes measured coverage gaps. Each test here exists because a coverage run
 * named an untested line, not because it seemed like a good idea.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geminiApiKey, hasGeminiKey, hasRazorpayCredentials, ConfigError } from '../src/config/env.js';
import { loadWebShop, CorpusError } from '../src/corpus/webshop.js';
import { PRODUCT } from '../src/config/product.js';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('config: gemini + presence helpers', () => {
  it('returns the gemini key when set', () => {
    process.env['GEMINI_API_KEY'] = 'abc123';
    expect(geminiApiKey()).toBe('abc123');
  });

  it('throws naming the variable when the gemini key is absent', () => {
    delete process.env['GEMINI_API_KEY'];
    expect(() => geminiApiKey()).toThrow(ConfigError);
    expect(() => geminiApiKey()).toThrow(/GEMINI_API_KEY/);
  });

  it('presence helpers report without throwing', () => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['RAZORPAY_KEY_ID'];
    delete process.env['RAZORPAY_KEY_SECRET'];
    expect(hasGeminiKey()).toBe(false);
    expect(hasRazorpayCredentials()).toBe(false);

    process.env['GEMINI_API_KEY'] = 'k';
    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_x';
    process.env['RAZORPAY_KEY_SECRET'] = 's';
    expect(hasGeminiKey()).toBe(true);
    expect(hasRazorpayCredentials()).toBe(true);
  });

  it('treats whitespace-only as absent', () => {
    process.env['GEMINI_API_KEY'] = '   ';
    expect(hasGeminiKey()).toBe(false);
  });
});

describe('corpus: failure paths', () => {
  it('raises CorpusError naming the file and pointing at PROVENANCE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-'));
    try {
      expect(() => loadWebShop(dir)).toThrow(CorpusError);
      expect(() => loadWebShop(dir)).toThrow(/items_human_ins\.json/);
      expect(() => loadWebShop(dir)).toThrow(/PROVENANCE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('raises on malformed JSON rather than yielding a half-loaded corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-'));
    try {
      writeFileSync(join(dir, 'items_human_ins.json'), '{ not json');
      expect(() => loadWebShop(dir)).toThrow(CorpusError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty PRODUCT list too, not just empty instructions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-'));
    try {
      writeFileSync(
        join(dir, 'items_human_ins.json'),
        JSON.stringify({
          B000000000: [
            {
              asin: 'B000000000',
              instruction: 'buy a thing',
              attributes: [],
              options: [],
              instruction_attributes: [],
              instruction_options: [],
            },
          ],
        }),
      );
      writeFileSync(join(dir, 'items_shuffle_1000.json'), '[]');
      expect(() => loadWebShop(dir)).toThrow(/No products/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a product with a missing name rather than throwing', () => {
    // The source has records with absent fields; a corpus loader that throws
    // on one bad row loses the other 999.
    const dir = mkdtempSync(join(tmpdir(), 'cg-'));
    try {
      writeFileSync(
        join(dir, 'items_human_ins.json'),
        JSON.stringify({
          B000000000: [
            {
              asin: 'B000000000',
              instruction: 'buy a thing',
              attributes: [],
              options: [],
              instruction_attributes: [],
              instruction_options: [],
            },
          ],
        }),
      );
      writeFileSync(
        join(dir, 'items_shuffle_1000.json'),
        JSON.stringify([{ product_information: null, brand: '', pricing: '', product_category: '' }]),
      );
      const data = loadWebShop(dir);
      expect(data.products[0]!.name).toBe('');
      expect(data.products[0]!.topCategory).toBe('Uncategorised');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty corpus instead of returning zero rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-'));
    try {
      writeFileSync(join(dir, 'items_human_ins.json'), '{}');
      writeFileSync(join(dir, 'items_shuffle_1000.json'), '[]');
      expect(() => loadWebShop(dir)).toThrow(/No instructions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('product identity', () => {
  it('keeps the name in exactly one place so renaming stays cheap', () => {
    expect(PRODUCT.name.length).toBeGreaterThan(0);
    expect(PRODUCT.issuer.length).toBeGreaterThan(0);
    expect(PRODUCT.certificateVersion).toBe(1);
  });
});
