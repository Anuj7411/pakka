/**
 * The product name lives HERE and nowhere else.
 *
 * Renaming must be a two-line change. Never write the product name as a literal
 * string in any other module, doc-generating code, or the certificate schema —
 * always import PRODUCT.
 */
export const PRODUCT = {
  /**
   * Hindi, and everyday Gen-Z speech: confirmed, certain, solid.
   *
   * "Pakka?" is exactly the question this asks about a cart, and "pakka" is
   * exactly its answer. Chosen over Sahi and Vouch, which are both already
   * taken in Indian fintech.
   */
  name: 'Pakka',
  /** Certificate issuer field. Changes with the name. */
  issuer: 'pakka',
  /**
   * Certificate schema version. Independent of the product name — bump only on
   * a breaking change to the certificate shape.
   */
  certificateVersion: 1,
} as const;
