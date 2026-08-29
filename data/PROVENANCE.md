# Data provenance

## Source
**WebShop** — Yao, Shen, Chen, Karthik, Narasimhan. *WebShop: Towards Scalable Real-World Web
Interaction with Grounded Language Agents.* NeurIPS 2022.
Repository: <https://github.com/princeton-nlp/WebShop>
**Licence: MIT** (`LICENSE.md` in that repository).

MIT permits use, modification and redistribution with attribution. This project derives a
corpus from the instruction records; that derivative is covered by the same attribution
requirement, which this file discharges.

## Why WebShop
The corpus must be grounded in **real human-authored shopping instructions with real stated
constraints.** A corpus of constraints we invented could only ever demonstrate that our checker
catches our own imagination.

What the instruction records give us, per record:
- `instruction` — the human's free-text request, verbatim
- `instruction_attributes` / `instruction_options` — **what the human explicitly stated**
- `attributes` / `options` — what the correct target product actually has

That is the constraint set *and* its ground truth, authored by crowd workers rather than by us.

## How these files were obtained — and a caveat
The official `setup.sh` fetches these from Google Drive via `gdown`. **As of 2026-08-28 those
Drive links require Google sign-in**, and both `gdown` and direct `curl` fail with a sign-in
interstitial.

They were therefore obtained from a public HuggingFace mirror:
`https://huggingface.co/datasets/zhangdw/webshop` → `raw/webshop-small.tar.gz`

**This is a third-party mirror.** The underlying data is Princeton's and MIT-licensed, but the
mirror is not an official distribution channel. The SHA-256 hashes below pin exactly what was
used, so anyone can verify they have identical bytes regardless of where they got them.

## Integrity

| SHA-256 | Bytes | File |
|---|---|---|
| `cf78667548a71786e1d9049c24b802e48e1084ad4bb021cae56ce1f6d96954a3` | 5,137,548 | `items_human_ins.json` |
| `30a4765c3a327af72d9a9a95a6b2486d516f0fa1d3ecd83681901ce82a21b269` | 4,467,013 | `items_shuffle_1000.json` |
| `f88a36314a397b53b3d9c3fa5878e5f7b26d35019a51ec83fbedeca61a948f6f` | 147,099 | `items_ins_v2_1000.json` |
| `37261e0875a4875600b05fa9e8dfac3a4ef5593e3a0ab0999c1514afe8e63a29` | 2,142,159 | `webshop-small.tar.gz` |

Verify with `npm run data:verify`.

## What is actually in the data (measured, not quoted from the paper)

| Quantity | Value |
|---|---|
| Instruction records | **12,251** across **10,136** target ASINs |
| With both stated attributes and options (usable for constraint injection) | **9,605** |
| With stated attributes only | 2,482 |
| With stated options only | 38 |
| With neither tagged | 126 |
| Products in the small set | 1,000 (481 carry an ASIN) |

**Real variant axes** available to perturb, by frequency: `size` (7,354), `color` (7,005),
`flavor name` (1,217), `style` (969), `flavor` (293), `fit type` (276), `scent` (271),
`pattern name` (148), `item shape` (66), `material type` (58).

**Most common stated attributes:** living room (598), gluten free (530), long lasting (381),
high quality (266), easy use (251), long sleeve (246), machine wash (232), easy install (228),
easy clean (214), rubber sole (210).

## Corrections to our own earlier notes
1. **Licence.** `research/validation/EVAL-METHODOLOGY.md` recorded WebShop as **CC-BY-4.0**.
   It is **MIT**. Corrected here and there.
2. **The 126 untagged records are NOT abstention candidates.** They were briefly considered as
   "underspecified instructions". Inspection shows the opposite — e.g. *"i'm looking for a 3
   foot micro usb cable that offers high speeds and is colored silver"* is highly specific; the
   attribute extractor simply did not tag it. Using them as ambiguity cases would have
   mislabelled specific instructions as vague.

## Stated limitations
1. **The catalogue is US/Amazon, not Indian.** Our thesis concerns Indian *rails* — UPI has no
   not-as-described dispute ground — and that argument is about the consequence of a wrong
   purchase, not about the catalogue. The conformance *mechanism* is market-independent.
   We do not claim an Indian product distribution.
2. **Prices are USD and are treated as minor units of a single unnamed currency.** We do not
   convert, because inventing an exchange rate would put a fabricated number into money
   arithmetic. Price-bound reasoning is therefore currency-agnostic.
3. **Only 4 ASINs intersect** between the 1,000-product subset and the instruction set. The
   corpus therefore pairs real instructions with category-matched products from the catalogue
   rather than requiring exact ASIN identity. The full 1.18M-product file would remove this
   constraint but is behind the sign-in-gated Drive link.
4. `items_ins_v2_1000.json` attributes are frequently empty; we do not depend on it.
