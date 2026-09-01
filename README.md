# Conveyance

Domain-name escrow settled by verified control, not by a statement of intent.

The money moves when the registry says the domain did, and when the zone answers for the
buyer, and when two independent resolvers agree it does. Those three questions are asked
inside a consensus block by the contract itself, against the authoritative RDAP base the
IANA bootstrap names for that TLD, and against Cloudflare and Google DNS over HTTPS. No
oracle, no signer of record, no trusted relayer, and nobody who has to be online for the
escrow to resolve.

The contract states its own boundary, in its header and in `parameters()`:

> Conveyance verifies public transfer signals and operational DNS control. It does not
> prove legal title, beneficial ownership, the identity of a private registrant, or that a
> registrar account has no retained delegates.

- Network: StudioNet
- Canonical StudioNet deployment: `0x7C2f0B5F397957214b7D15120dCb9A5cDbd282d1`
- Historical / superseded deployment: `0x104767ad5d51b5004953e4fB9d5B548501aa9bd9`
- Historical deployment transaction: `0x27ae8b590ece7c91280d21b28ca9817598b2d3e297453f113e17cdcaa0a9ac6d`
- Submission record: [`docs/SUBMISSION.md`](docs/SUBMISSION.md)

## Why GenLayer is essential

A domain transfer is settled by facts that live on the public internet and nowhere else.
The registry publishes the sponsoring registrar and the transfer event over RDAP; the zone
either answers for the buyer's proof record or it does not. Neither fact is on any chain,
and neither can be put on one without somebody being trusted to copy it across.

Every other way to build this needs that somebody. An oracle network needs a quorum you
have to trust off-chain. A keeper needs a bot that must be running at the moment a window
closes. A multisig needs the two parties, which is the thing escrow exists to avoid. Each
of those is a person or a process who can be wrong, absent, or bought.

GenLayer removes the copy. `gl.nondet.web.request` runs inside the consensus block, so
every validator fetches the registry record and the resolver answers itself, and
`gl.eq_principle.strict_eq` requires them all to arrive at the same bytes before anything
is written. The escrow is not released because someone reported a transfer. It is released
because the validator set independently read the transfer and agreed on what it said.

That is also why every state transition here is permissionless. `check_transfer` takes no
privileged caller, `settle` is gated on the state machine rather than on who is asking, and
`refund` is gated on a clock. A stranger can press any of them and the answer is the same.
There is nothing to keep running and nobody to wait for.

## What it decides, and what it refuses to decide

Delivery is not one question, and treating it as one is how escrow for a domain gets it
wrong. A registry can record a transfer to a party who never gets the zone. A zone can
answer for a name whose registration never moved. So three conditions are read from three
places inside one consensus block and written down separately:

| | The condition | Read from |
| --- | --- | --- |
| First | The domain can be delivered at all: no holds, no pending deletion, no transfer mid-flight | The authoritative RDAP base named for this TLD by the IANA bootstrap |
| Second | The registration moved to the named party, with the deal's registrar and its nameserver set | The same RDAP object, compared against the baseline frozen when the seller armed |
| Third | The buyer controls the zone, proven by a deal-bound TXT record | Cloudflare and Google DNS over HTTPS, and the escrow moves only if the two agree |

Each condition records one of five outcomes, not three: met, blocking, not reached,
reversed, or unchecked. "The check stopped before this question" and "this question was
answered no" are different facts and only one of them says anything about the transfer.
Collapsing them is how an interface ends up telling a seller their delegation is wrong when
nothing ever looked at it.

Four tags separate the kinds of bad news, and only the first is a verdict:

- `[EXPECTED]` a rule fired. This is a decision.
- `[EXTERNAL]` a source did not answer. Nothing was decided about the domain.
- `[TRANSIENT]` nothing was decided; the same call may succeed later.
- `[LLM_ERROR]` an answer came back in an unusable shape.

## Contract surface

Twelve methods, all in [contracts/Conveyance.py](contracts/Conveyance.py). Seven write,
five read, one payable, constructor takes no arguments.

| Call | Kind | Who may call it |
| --- | --- | --- |
| `open_deal` | write, payable | anyone, and the value they send becomes the escrow |
| `arm` | write | the named seller only, and only with a DNS control proof |
| `check_transfer` | write | anyone |
| `settle` | write | anyone, once the state is VERIFIED |
| `refund` | write | anyone, once the relevant window has closed |
| `abandon` | write | either party while OFFERED, the seller only once LOCKED |
| `probe_domain` | write | anyone, and it stores nothing |
| `get_deal` | read | |
| `list_deals` | read | |
| `delivery_status` | read | |
| `ledger` | read | |
| `parameters` | read | |

`abandon` narrows rather than widens once the deal is locked, and the reason is in the
contract header: the seller may by then have a real transfer in flight at a registrar, and a
buyer who could cancel at will could let a seller complete a transfer and then walk away
with the price.

The escrow moves in four places and nowhere else, and the invariant is stated so it can be
read off the live contract: `total_escrowed == total_released + total_refunded + the balance
still held`. The plate prints that reconciliation on every load, and prints whether it holds
rather than assuming it does.

## The two deliberate divergences from the specification

Both are stated in the contract's own header rather than only here, so a reader who never
opens this file still finds them.

### There is no model in this contract

Every consensus block is `gl.eq_principle.strict_eq`. The specification asks for an LLM
adjudication step over four dispute grounds. All four are decidable without inference:

- `TRANSFER_REVERSED` is the transfer event plus the registrar's IANA id in RDAP.
- `DOMAIN_SUSPENDED` is `clientHold` or `serverHold`.
- `WRONG_DOMAIN` is a string comparison against `ldhName`.
- `DNS_CONTROL_REVOKED` is the absence of a TXT record two resolvers were asked about.

The specification's fifth ground, `PRIVATE_ACCOUNT_CUSTODY`, it already marks
non-adjudicable, and this contract agrees. Adding an inference step over the other four
would add a way to be wrong and no way to be right.

The claim is checkable rather than asserted. `parameters()` reports `uses_a_model` as
`false`, the `/docs` page prints that row by reading it off the deployment, and an end-to-end
test asserts the rendered value is the deployment's answer and not the page's opinion.

### Six calls where the specification named ten

The mapping, as the header records it:

| This contract | The specification |
| --- | --- |
| `open_deal` | `open_deal` |
| `arm` | `accept_deal`, plus the seller's DNS control proof |
| `check_transfer` | `verify_delivery` |
| `settle` | `accept_delivery` and `finalize_delivery`, merged on the caller |
| `refund` | `refund_expired`, plus the refund out of REVERSED |
| `abandon` | `cancel_offer`, widened |

Merging `accept_delivery` and `finalize_delivery` is the substantive one. Two calls implies
someone whose acceptance matters. Here the state machine decides and anyone may press it, so
a second call would only be a second chance to press the same button.

## Historical / superseded StudioNet evidence

Nine transactions are preserved against the superseded deployment, by label, and re-checked in one
command:

```bash
npm run verify:studionet
```

The script re-reads every hash off the chain and exits non-zero if any of them no longer
says what [evidence/studionet.json](evidence/studionet.json) claims. These checks prove only the
historical contract. A new canonical deployment must earn a fresh evidence record. The script also asserts each
transaction's `recipient` equals the contract under test, which is not decoration: the arity
control below was first captured against deployment 3, whose crash payload is byte-identical
to deployment 4's, so every other assertion in the loop passed on a stale hash. Feeding that
stale hash back in produces exactly one failure, the recipient mismatch, and no others.

| Label | What it proves |
| --- | --- |
| `open1`, `open2` | Two deals lodged with real value, 0.25 GEN and 0.05 GEN |
| `zeroControl` | A payable call with no value is refused by returning, not by raising |
| `fundedRefusal` | A funded call the contract refuses returns the caller's value |
| `arm` | Only the named seller can arm, and the tag survives the rollback |
| `settle` | Settlement is gated on state, not on identity |
| `refund` | The escrow cannot be pulled back before the window closes |
| `checkTransfer` | A check on an unarmed deal is refused before any network call |
| `arityError` | An untagged crash is distinguishable from a tagged refusal |

### A funded refusal must not keep the money

This is the requirement that forced a redeployment. StudioNet does not return
`gl.message.value` when an execution reverts, so a payable method cannot refuse by raising:
storage rolls back, and the caller's escrow stays in the contract with no way to retrieve
it. `open_deal` therefore refuses by returning a tagged string, and the refund rides out on
a message.

Transaction `0xadec94d871007024683de4f5592a463b4f416b277ecfb299e8a522fc98fde1f0` sent 0.05
GEN at an id that already existed. The receipt reads `SUCCESS` with
`[EXPECTED] deal 'cv-demo-example-com-1' already exists`, stores nothing, and carries
`messages[0]` with `value: 50000000000000000` and the caller as recipient. That message sits
at the top level of the transaction object, a sibling of `sender` and `tx_id`, and not inside
`consensus_data.leader_receipt`. Looking for it in the receipt finds nothing and reads as an
absent refund.

### The refund is dispatched at finalization, not at acceptance

The refund message carries `onAcceptance: false`. A `ledger()` read taken seconds after a
funded refusal therefore shows the balance exceeding the held sum by exactly the refunded
amount, which is the same shape as the value-stranding defect the contract was redeployed to
fix. Measured triple, recorded because the trap is easy to fall into twice:

| When | balance | held | equal |
| --- | --- | --- | --- |
| before the funded refusal | 0.3 GEN | 0.3 GEN | yes |
| immediately after the receipt, at ACCEPTED | 0.35 GEN | 0.3 GEN | no |
| after 55 seconds, at FINALIZED | 0.3 GEN | 0.3 GEN | yes |

So anything asserting `balance == held` must wait for FINALIZED, and
`scripts/exercise-studionet.mjs` asserts it exactly once, after every labelled hash has been
polled that far. The discriminator between the two situations is the message, not the
balance: stranding is a permanent gap with no value-bearing message, a refund in flight is a
temporary gap with a message whose recipient is the caller.

### The defect that only a live deal could find

`Address.as_hex` returns the EIP-55 checksummed form. The contract built the seller's
control-proof token from bare `as_hex`; the interface built the same token with
`toLowerCase()`. That token is compared to a fetched DNS TXT value byte for byte, so **every
deal on the first three deployments named a seller who could not arm it.**

The failure mode is worse than a refusal. A token absent from the TXT set is an absent
proof, and an absent proof is tagged `[TRANSIENT]` with a note that propagation may be
incomplete, so the seller would have been told to wait for a propagation that was never
going to help.

Two things about how it was found are worth more than the fix. It was found by reading a
live response, not by any automated layer: the contract test suite runs against a
hand-written stub for the fast layer and against the real SDK for the direct layer, and
neither had a reason to compare two independently built strings. And the measurement came
before the diagnosis. The invariant was written into
[tests/direct/test_open_deal.py](tests/direct/test_open_deal.py) as a permanent assertion
first and allowed to fail, so the expected-versus-actual line in the pytest output is the
evidence rather than a guess written up afterwards.

### Why the contract was redeployed three times

Every superseded address is labelled as superseded at the point of use, and no live claim
rests on any of them.

| Contract | Superseded because |
| --- | --- |
| `0xB869533BEE20269514c7552dc85215e10d8b7A75` | A defect in the per-domain deal index |
| `0x07a615f2F2D7fC48AF2630b410e403a82B1d261b` | `open_deal` refused by raising after value had arrived |
| `0xC162BA113137539fD734e986403C1FA5fAbA6109` | The seller token casing defect above |

A fourth address, `0x513B913dfbCB1790a35630f100CB59140a67B4ba`, is recorded separately
because it never existed as a contract. It reported ACCEPTED, then FINALIZED, and returned an
address with nothing registered at it, which is what a missing GenVM runtime pin does. It
fails like a success. The first line of the contract is now
`# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }` and
`DEPLOYMENT.json` records why.

## Verification

### Offline and reproducible

```bash
npm run verify
```

Frontend unit tests, contract tests, the fixture digests, the em dash check, the type check,
the linter and the production build, in that order. Measured on this build: **242 frontend
tests, 96 contract tests, 0 failures.**

The 96 contract tests in [tests/direct](tests/direct) are the only place this contract runs
under the real GenLayer SDK. They matter because the fast layer cannot substitute for them:
the Direct Mode tests use the real GenLayer SDK and the repository is self-contained.

There is a second, faster layer that does not run in CI and lives outside this repository
because the whole build set shares it:

The fast shared harness is intentionally not a reviewer prerequisite; use `tests/direct` from
this repository for reproducible contract execution.

### The evidence path, tested standalone

The RDAP and DoH evidence path is spliced out of the contract into a standalone module and
run under pytest with no node and no SDK, against captured wire bytes:

```bash
python scripts/splice_rdap.py
```

It extracts the region between two markers, checks it against the shipped copy, and re-runs
the suite. Measured: **35 tests collected, 33 passed, 2 skipped**, 13 structural checks, 40
region callables. The two skips are the uncaptured transfer fixtures below, and they are
skipped rather than stubbed because a stubbed transfer fixture would be a fabricated one.

### Fixtures, and what "pinned" actually means

```bash
npm run verify:fixtures
```

Eleven routes, and flattening them into one number would hide the part worth looking at:

- **Five are verbatim wire bytes.** The two DoH NXDOMAIN controls, the RDAP not-found
  control, and the two DoH TXT captures.
- **Three are live captures whose byte-for-byte identity is not re-verified**, and each says
  so in its own field: the IANA bootstrap and the `.com` and `.org` RDAP baselines. All
  three are parsed by field name and never hashed, so a JSON round trip could not change a
  conclusion. The manifest records `bytes_on_disk` rather than `bytes_received` so the
  distinction is not lost.
- **One is synthetic and declares it**, `verbatim: false`: `doh-disagreement.json`, derived
  mechanically from the real Google capture with two TXT values substituted, under a name in
  `.invalid` so a fabricated name can never collide with a real one. The real world will not
  produce two resolvers contradicting each other on demand, and the refusal path still has
  to be tested.
- **Two are not captured at all**, and are asserted to still be uncaptured. See honest limits.

Every present body's byte count and full sha256 are pinned, so the check fails if a single
byte changes. It also makes a claim the sibling projects cannot: the shipped captures are
compared byte for byte against the copies carried by this repository, which the direct evidence
checks assert.

### Live StudioNet

```bash
npm run verify:studionet    # the nine asserted transactions, re-read off the chain
npm run verify:deployment   # fails closed until a current canonical address is configured
npm run verify:schema       # verifies the configured canonical method table
```

The current Git source is not canonically deployed yet. `verify:deployment` and
`verify:schema` require an explicit current deployment configuration and fail closed when it
is absent. The byte-for-byte retrieval details and digest below belong to the historical,
superseded address only; they are retained so the old claim remains auditable and cannot be
mistaken for proof of this source.

### End to end against a served build

```bash
npx next build && npx next start -p 3210
npx playwright test
```

The Playwright suite contains 29 tests against a served production build. It is a local
production-build check unless `E2E_BASE_URL` is explicitly supplied; it is not evidence of a
published origin or a current StudioNet deployment.

There is no published origin, so the base URL defaults to `http://localhost:3210` and
`E2E_BASE_URL` points the same suite elsewhere the day there is one. One property is
therefore **not verified and is recorded as not verified**: a CORS preflight from a
published origin against the GenLayer RPC. A preflight is a property of a browser origin
talking to a third-party host, and localhost is not the origin a reviewer would use.

The two recoveries were StudioNet's read budget, which is thirty requests a minute and says
so by name in its own error. Every route is `force-dynamic`, so a serialized pass spends far
more than thirty reads and exhausts the budget twice. The retries are the right response and
they are kept. What was wrong was the report afterwards: Playwright called those two tests
`flaky` and stopped there, and `flaky` is the label that gets a real regression ignored.
[tests/e2e/read-budget.ts](tests/e2e/read-budget.ts) now reads the cause off the failed page
and attaches it, recorded twice on purpose because the `list` reporter prints no annotations
at all. It cannot turn a red into a green.

That failure is also, accidentally, the strongest evidence in the build that the read path is
right, and the only place it is exercised against a real adverse network rather than a
constructed one. Under the rate limit the page printed `[EXTERNAL] Read failed` beside the
node's own sentence and said the parameters could not be read, so the panel states nothing
about them in either direction. A transport fault reported as a transport fault.

### Dependency audit

`npm audit`: **0 vulnerabilities across 458 dependencies** (244 production, 176 development,
89 optional). Five runtime dependencies, all pinned or caret-pinned in
[package.json](package.json): `genlayer-js 1.1.8`, `next 16.3.2`, `react 19.2.4`,
`react-dom 19.2.4`, `lucide-react ^1.27.0`. Node v24.16.0, Python 3.14.4, pytest 8.4.2,
genlayer CLI 0.39.2.

### Hygiene sweep

[docs/HYGIENE.md](docs/HYGIENE.md) records a token-class sweep of 105 files: unfinished-work
markers, key material, hardcoded origins, superseded addresses, and fixture leakage. It
opens by stating that it is weaker than the sibling projects' sweeps and why, because with
no repository the three `git` assertions those make cannot be made here and none of them is
claimed.

Zero TODO, FIXME, HACK or XXX markers exist anywhere in the project, in any language,
including inside the captured fixture bodies.

## What the frontend had to be fixed for

Four defects, none of which touched the contract, all of which would have made a correct
contract look wrong or a broken read look decided.

**Static prerendering froze the contract reads at build time.** Next 16 prerendered the
routes, so the figures were real figures, read from the real contract, and simply older than
the page claimed. Nothing looked broken. A stale escrow total on an escrow register is worse
than a missing one, because a missing one is visibly missing. Fixed with
`export const dynamic = "force-dynamic"`; the build table now shows all five routes as
dynamic. `export const revalidate` was considered as a middle ground and declined, because a
window in which a settled deal still shows as held is a window in which someone acts on it.

**The read path undid the contract's care on the last hop.** A helper turned any thrown read
into `NOT_FOUND`, so a transport fault became a verdict about storage: the contract
distinguishes four kinds of bad news and the frontend collapsed two of them one layer before
the screen. Measured before assuming, and the measurement was the interesting part: both
keyed reads answer `{}` for an unknown key rather than raising, so the helper was not even
serving the case it was written for. The guard was proven by reintroducing the defect, which
turned four of the nine read-classification tests red, and then proven again live and by
accident under the rate limit above.

**`/deals/new` read the contract three times per request** where one read serves all three
consumers. React's `cache()` is unavailable in that module because two client components
import from it, so the read result is passed down instead.

**A refusal sentence carried its own article and then got another one.** Worth recording for
how it was found rather than for what it was: a refusal sentence renders exactly when
something has already gone wrong, so it is the least exercised prose in the build and the
most closely read when it appears. Seven sites exist and this was the only one carrying its
own article. Proven by reintroducing the defect: 9 passed, 1 failed.

## Main user flow

1. A buyer opens [/deals/new](src/app/deals/new/page.tsx), generates a secret in the browser,
   optionally wraps it in a passphrase, rehearses the terms against the contract, and lodges
   the offer with the price attached. The rehearsal is not optional decoration: the one
   control in this interface that sends value is disabled until it has run, and the reason is
   printed beside it.
2. The seller arms the deal, which requires publishing a deal-bound TXT record proving DNS
   control and freezes the RDAP baseline the transfer will later be compared against.
3. The seller transfers the domain at their registrar, and the buyer publishes their own
   deal-bound TXT record.
4. Anyone presses check. The contract fetches the IANA bootstrap, the TLD's RDAP base and
   both resolvers inside one consensus block, and records each of the three conditions
   separately.
5. Once all three are met, anyone presses settle and the escrow goes to the seller. If the
   window closes first, or the registry takes the domain back, anyone presses refund and it
   goes to the buyer.

Every page prints which mode it is serving above the content, and the end-to-end suite
asserts on each route that the live line is present and the fixture line absent.

## Signing

An injected wallet is the only signer. There is no key generation, no keystore, no chooser
panel, and nothing is ever stored: the wallet suite asserts that after loading four routes,
neither `localStorage` nor `sessionStorage` holds anything matching a 64-hex string,
`privateKey`, `mnemonic` or `keystore`.

The write gate is printed above every write control and names which of three problems it
has: no extension, not connected, or connected to the wrong chain with both chain ids in the
sentence. The chain the build writes to is read from `DEPLOYMENT.json` rather than written
out, so a build pointed at a different network fails the suite instead of passing quietly. A
refused `wallet_switchEthereumChain` is reported in the wallet's own words, kept verbatim,
because a paraphrased wallet message is a message nobody can search for.

Nothing in the test suites can sign. The stub implements three read methods and throws
`-32601` on everything else, so the suite costs no GEN however often anyone runs it.

## Authority sources

- `https://data.iana.org/rdap/dns.json`, the IANA RDAP bootstrap, fetched rather than
  hardcoded, so the registry base for a TLD is whatever IANA currently says it is.
- The per-TLD RDAP base that bootstrap names, for holds, pending states, the sponsoring
  registrar, the transfer event and the delegation.
- `https://cloudflare-dns.com/dns-query` and `https://dns.google/resolve`, both asked for the
  same TXT record, and the escrow moves only if the two agree.

Two live TLDs, `.kg` and `.mg`, publish their RDAP base over cleartext HTTP with no HTTPS
alternative. `registry_base_for_domain` fails closed on them rather than downgrading, so a
deal on one of those domains is refused. That was read out of the live bootstrap, not
invented.

## Honest limits

Recorded in full under `notProvenOnChain` in
[evidence/studionet.json](evidence/studionet.json), summarised here:

- **The successful half of the lifecycle is not proven on chain.** `arm`, a passing
  `check_transfer`, a `settle` that releases and a `refund` that returns are each exercised
  only in the direct suite. The two demonstration deals are lodged against `example.com` and
  `example.net`, which are IANA reserved, so nobody can publish a TXT record under them or
  transfer them. Every live proof of those four calls is therefore a refusal, and each
  refusal is labelled as one wherever it appears.
- **The two transfer fixtures are not captured.** `rdap-pending-transfer` and
  `rdap-transfer-complete` carry `TO FILL` for their URL and a `blocked` routing, because a
  real cross-registrar transfer has not completed yet. They are the only placeholders in the
  project, they are asserted absent rather than assumed absent, and
  `scripts/verify_fixtures.py` fails if a body ever appears beside a placeholder URL. Routing
  flips from `blocked` to `prefer` the moment the URL is real.
- **The successful direction of the time gate is not proven on chain.** Only the refusing
  direction is, and the two windows close on 2026-09-02.
- **No reversal has been observed live,** and no live deal was opened against a `.kg` or `.mg`
  domain to demonstrate the cleartext refusal.
- **`[EXTERNAL]` and `[LLM_ERROR]` have no live transaction.** `[EXTERNAL]` has been observed
  in the interface, under the rate limit described above, but not as a stored check outcome.
- **No CORS preflight from a published origin,** because there is no published origin.

One further item, recorded rather than corrected. The deployed contract's docstring says the
spliced evidence path is unit-tested with `39 tests`, three times, at lines 57, 59 and 76.
The suite actually collects 35: 33 passed and 2 skipped. Nothing asserts 39, and
`scripts/splice_rdap.py` counts at run time and reports correctly, so nothing was passing on
a false number. The file is byte-locked to the deployment, and correcting a count in a
comment would change the digest, break the on-chain parity, and need a fifth deployment,
which would invalidate all nine asserted hashes, both demonstration deals and the whole value
ledger. That trade is not worth making, so the number stays wrong and is written down here
and in `knownStaleTextInTheDeployedSource`.

## Layout

```
contracts/Conveyance.py     the whole product, current source; parity is required before a deployment is canonical
src/app                     five routes, all dynamic
src/components              interface
src/lib/genlayer            client plumbing, shared across the build set
src/lib/data-source.ts      the single seam between fixtures and the contract
tests/direct                96 tests, the real GenLayer SDK
tests/frontend              242 tests, node --test, no browser
tests/e2e                   29 tests, Playwright against a served build
scripts/splice_rdap.py      extracts the evidence path and tests it standalone
scripts/verify_fixtures.py  pins every captured body by byte count and sha256
evidence/studionet.json     every live measurement, including the ones that failed
docs/HYGIENE.md             the token-class sweep
DEPLOYMENT.json             addresses, digests, and every superseded deployment
```

## Submission notes

- The historical deployment is not the current source. Editing the contract requires a fresh
  deployment and fresh parity/evidence before any address can be called canonical.
- The historical demonstration deals belong to the superseded deployment and are not claimed as
  current state.
- `evidence/studionet.json` records the measurements that failed and the ones that nearly
  went in wrong, including a false negative that would have read as a defect. Those are the
  entries worth reading.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
