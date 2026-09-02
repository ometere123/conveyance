# Conveyance submission record

## Thesis and boundary

Conveyance is domain-name escrow settled by public transfer evidence and independently
corroborated DNS control. GenLayer is necessary because RDAP, IANA bootstrap data and DNS
answers are live web facts unavailable to a deterministic chain. Deterministic code owns input
validation, state transitions, deadlines, permissions and wei accounting. Consensus owns only
retrieval and strict comparison of those public observations. The contract does not decide legal
title, private registrar custody or beneficial ownership.

## Canonical deployment

Live app: https://conveyance-five.vercel.app

Canonical StudioNet deployment: `0x7C2f0B5F397957214b7D15120dCb9A5cDbd282d1`, transaction
`0xfe5547f665b6750cf91b31b917779f9af3ed5876a34c24c8b56eb70e4f2b29b6`, finalized with GenVM
SUCCESS and raw source parity against commit `3eb6d8e7ddc0bee424ed63323a338829026e77b8`. The
previous deployment remains **HISTORICAL / SUPERSEDED**.
The previous deployment remains preserved in `DEPLOYMENT.json` and `evidence/studionet.json` as
**HISTORICAL / SUPERSEDED**. The canonical record contains the final commit, SHA-256, byte count,
finalized deployment transaction, schema result and byte-for-byte source proof.

## Verification

```text
npm ci
npm run verify
python -m pytest tests/direct -q
npm run verify:deployment
npm run verify:schema
```

`tests/direct` is **PROVEN DIRECT**. The old deployment evidence is **HISTORICAL / SUPERSEDED**.
Full transfer completion requires a real domain event and is **NOT PROVEN LIVE** unless a fresh
record says otherwise. The value invariant is `total_escrowed = total_released + total_refunded
+ balance still held`; every payable refusal returns a tagged refusal rather than raising after
crediting value.

## Reviewer walkthrough

1. Read `contracts/Conveyance.py` and inspect the three `strict_eq` blocks.
2. Run the direct suite and `genvm-lint` through `npm run verify`.
3. Run the deployment and schema scripts against the explicit record in `DEPLOYMENT.json`.
4. Inspect `evidence/studionet.json`; distinguish **PROVEN LIVE**, **PROVEN DIRECT**, and
   **NOT PROVEN LIVE** rather than treating deployment submission as execution success.
