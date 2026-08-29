/**
 * The product name lives HERE and nowhere else.
 *
 * Renaming must be a two-line change. Never write the product name as a literal
 * string in any other module, doc-generating code, or the certificate schema —
 * always import PRODUCT.
 */
export const PRODUCT = {
  /** Working placeholder. Deliberately ugly so it cannot accidentally stick. */
  name: 'conformance-gate',
  /** Certificate issuer field. Changes with the name. */
  issuer: 'conformance-gate',
  /**
   * Certificate schema version. Independent of the product name — bump only on
   * a breaking change to the certificate shape.
   */
  certificateVersion: 1,
} as const;
