import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { razorpayCredentials, ConfigError } from '../src/config/env.js';

/**
 * SECURITY-MODEL.md Unit V. The test-key guard is a startup precondition:
 * there is no code path to the Razorpay client that skips it.
 *
 * These tests must never be weakened to warnings. The failure they prevent —
 * a live key used by accident — is unrecoverable.
 */
describe('security: Razorpay test-key guard', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env['RAZORPAY_KEY_ID'];
    delete process.env['RAZORPAY_KEY_SECRET'];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts a well-formed test key pair', () => {
    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_AbCdEf123456';
    process.env['RAZORPAY_KEY_SECRET'] = 'aB3xY7kLmN9pQrStUvWx';
    const creds = razorpayCredentials();
    expect(creds.keyId).toBe('rzp_test_AbCdEf123456');
    expect(creds.keySecret).toBe('aB3xY7kLmN9pQrStUvWx');
  });

  it('REFUSES a live key', () => {
    process.env['RAZORPAY_KEY_ID'] = 'rzp_live_AbCdEf123456';
    process.env['RAZORPAY_KEY_SECRET'] = 'aB3xY7kLmN9pQrStUvWx';
    expect(() => razorpayCredentials()).toThrow(ConfigError);
    expect(() => razorpayCredentials()).toThrow(/must be a test key/);
  });

  it('refuses an unprefixed key id', () => {
    process.env['RAZORPAY_KEY_ID'] = 'AbCdEf123456';
    process.env['RAZORPAY_KEY_SECRET'] = 'aB3xY7kLmN9pQrStUvWx';
    expect(() => razorpayCredentials()).toThrow(ConfigError);
  });

  it('catches a key id pasted into the secret field', () => {
    // A mistake we actually made once: the secret has no prefix.
    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_AbCdEf123456';
    process.env['RAZORPAY_KEY_SECRET'] = 'rzp_test_AbCdEf123456';
    expect(() => razorpayCredentials()).toThrow(/looks like a key id/);
  });

  it('reports a missing variable by NAME and never by value', () => {
    process.env['RAZORPAY_KEY_ID'] = 'rzp_test_AbCdEf123456';
    try {
      razorpayCredentials();
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('RAZORPAY_KEY_SECRET');
      expect(msg).not.toContain('rzp_test_AbCdEf123456');
    }
  });

  it('never includes the secret in an error message', () => {
    const secret = 'sUp3rS3cr3tValue';
    process.env['RAZORPAY_KEY_ID'] = 'rzp_live_AbCdEf123456';
    process.env['RAZORPAY_KEY_SECRET'] = secret;
    try {
      razorpayCredentials();
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('treats whitespace-only values as missing', () => {
    process.env['RAZORPAY_KEY_ID'] = '   ';
    process.env['RAZORPAY_KEY_SECRET'] = 'aB3xY7kLmN9pQrStUvWx';
    expect(() => razorpayCredentials()).toThrow(/Missing required/);
  });
});
