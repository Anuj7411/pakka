# Filing a certificate as dispute evidence

**Status: specified, not built.** Razorpay test mode returns an empty dispute
collection — confirmed three ways below — so there is no test-mode dispute to
file against. Building an untestable integration and calling it done would be
worse than writing down exactly what it would take.

## Why this is the right home for the artifact

The certificate is not a new system of record. It is designed to drop into one
Razorpay already runs: the Disputes API accepts merchant-supplied evidence under
`evidence.others[]`, each entry a `{ type, document_ids }` pair.

That matters more than it sounds. A conformance gate that needs its own
evidence store, its own retention policy and its own access controls is a
procurement project. One that files into an existing enterprise record is a
feature.

## The shape

```jsonc
PATCH /v1/disputes/:id/contest
{
  "evidence": {
    "others": [
      {
        "type": "instruction_conformance_certificate",
        "document_ids": ["doc_<id returned by the Documents API>"]
      }
    ]
  }
}
```

The document itself is the certificate JSON, uploaded first:

```jsonc
POST /v1/documents          // multipart, purpose: dispute_evidence
```

## What the certificate answers, and for whom

A dispute over an agent purchase asks a question no payment record can answer:
**the customer does not deny paying — they deny asking for this.** The card
network's own evidence categories all assume the dispute is about delivery,
authorisation, or quality. None of them has a field for "the agent bought the
wrong thing".

The certificate supplies:

| Field | The question it settles |
|---|---|
| `mandate_hash` | what was actually asked for |
| `cart_hash` | what was actually bought |
| `decision` + `violations` | whether the system saw a divergence at the time |
| `policy_version` | which ruleset produced that decision |
| `model` | which model, at what temperature, if one was consulted |
| `issued_at`, `nonce`, `prev_hash` | when, and where in an append-only chain |
| `signature` | that none of the above has been edited since |

Crucially it is contemporaneous. It was written **before** the order existed —
see `src/gate/pipeline.ts` — so it is not a reconstruction made after the
dispute arrived.

## The honest limits

1. **We do not store the mandate or cart, only their hashes.** The certificate
   proves *that* a specific instruction and a specific cart were seen. It does
   not by itself reveal what they said. Filing it as evidence means also filing
   the plaintext mandate and cart, and *those* carry PII — which is exactly why
   they are not in the certificate. The split is deliberate and the filing flow
   has to handle both halves.

2. **A signature proves issuance, not honesty.** It shows the record has not
   changed since we signed it. It does not show our process was uncompromised.
   Certificates are tamper-evident, not tamper-proof.

3. **Nothing here is a dispute-outcome claim.** Whether an issuing bank finds a
   conformance certificate persuasive is an empirical question we have no data
   on, and we should not imply otherwise. The claim is narrower and defensible:
   the evidence a dispute of this shape needs does not currently exist anywhere,
   and this produces it in a format Razorpay can already file.

4. **UPI is a different story.** UPI can dispute a payment that failed, went
   astray, or bought nothing. It cannot dispute a payment that bought the wrong
   thing. The certificate is aimed at the card rails where a chargeback path
   exists, and at the merchant's own internal resolution everywhere else.

## Test-mode confirmation

`GET /v1/disputes` returns an empty collection in test mode; disputes cannot be
created synthetically; and the dashboard exposes no dispute-simulation control.
That is why this document specifies rather than ships.
