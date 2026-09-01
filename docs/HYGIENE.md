# Repository hygiene sweep

This project was swept for the token classes that most often hide a leaked
secret, an unfinished thought, or a stale on-chain claim. Every match below was
read and classified. Nothing was suppressed to make a count look better, and
where a match is legitimate the reason is stated rather than implied.

## This sweep is weaker than Recourse's, and the reason is stated first

**There is no git repository here.** Recourse's sweep could assert about
history: `git ls-files` proved no credential file was tracked, `git log --all
--name-only` proved none was committed and later removed, and `git check-ignore
-q` proved each ignore rule behaves rather than merely exists. None of those
three commands can be run for Conveyance, so none of those three claims is made.

Every claim below is about the working tree as it stands today. That is a
strictly weaker statement, and it is the only one available. `.gitignore` exists
and is listed at the end of this file, but it is listed as a pattern list and not
as verified behaviour, because nothing here can verify it. Source provenance is
bound a different way instead, by digest: `DEPLOYMENT.json` records the contract
file's sha256 and byte count, `npm run verify:deployment` re-reads the deployed
code off the chain and compares it, and `npm run verify:schema` compares the
deployed method table. Those prove the deployed contract is this file. They
prove nothing about what a repository once contained, because there is no
repository to ask.

## Scope

105 files, being everything under `conveyance/` except this document and except
`node_modules`, `.next`, `test-results`, `playwright-report`, `artifacts/`,
`__pycache__` and `.pytest_cache`. `tsconfig.tsbuildinfo` is a build artefact
that happens to contain the text of the files it compiled, so where it inflates a
count that is noted rather than netted out. This file is excluded from every
count in it, because it quotes each pattern it searches for: counted, the tree is
106 files and the unfinished-work row would read 5 instead of 0.

Command form, using the Grep tool rather than a shell recursion, because
recursively grepping this tree from bash is slow enough to be unusable:

```bash
rg -n --glob '!**/{node_modules,.next,test-results,playwright-report,artifacts,__pycache__,.pytest_cache}/**' -e '<pattern>' .
```

## Results

| Pattern | Matches | Classification |
| --- | --- | --- |
| `\b(TODO\|FIXME\|HACK\|XXX\|TEMP)\b` | **0** | No unfinished-work marker exists anywhere in this project, in any language, including the captured fixture bodies. |
| `TO FILL` | 10, in 5 files | Two are load-bearing and eight describe them. The two are `tests/direct/fixtures/manifest.json:221` and `:241`, the `rdap-pending-transfer` and `rdap-transfer-complete` routes, which are the flagship artefact and are not captured yet because a real cross-registrar transfer has not completed. They are the only placeholders in the project, they are asserted absent rather than assumed absent, and `scripts/verify_fixtures.py` fails if a body ever appears beside one. The other eight are prose and checker code naming the marker: `scripts/verify_fixtures.py` (4), `evidence/studionet.json` (2), `tests/direct/evidence.py` (1) and the manifest's own header (1). |
| `localhost`, `127.0.0.1` | 7, in 4 files | **This count rose from 2 during this build and the rise is deliberate.** Five are the local end-to-end origin: `playwright.config.ts:56` and four in `evidence/studionet.json`, two of which are the origin and two of which are prose explaining that a CORS preflight from localhost would prove nothing. `playwright.config.ts` used to default to a Vercel hostname carried over from Recourse, which does not resolve for this project, so a bare `npx playwright test` failed on DNS against an origin that was never ours. Defaulting to `http://localhost:3210` is honest about what is being tested; `E2E_BASE_URL` points the same suite at a real origin the day there is one. The remaining two are rejection test inputs: `tests/frontend/proof-records.test.ts:280` asserts `domainFault("localhost")` returns a fault, and `tests/direct/test_open_deal.py:346` asserts a nameserver list containing `localhost` is refused for not being a dotted host name. Neither is a URL the code would ever fetch. |
| `example.com`, `example.net`, `example.org` | 108, in 19 files | **Used live, on purpose, and this is the opposite of Recourse's reasoning.** Recourse used `example.com` because RFC 2606 reserves it so it cannot resolve to a real host. Conveyance needs the reverse property: it needs a domain the registries carry a real RDAP record for. They do. `https://rdap.verisign.com/com/v1/domain/example.com` and `https://rdap.publicinterestregistry.org/rdap/domain/example.org` both answer, and those two answers are the `rdap-com-baseline` and `rdap-org-baseline` captures. The two demonstration deals on the live contract are lodged against `example.com` at 0.25 GEN and `example.net` at 0.05 GEN, which means the validators really did fetch a registry record for a real domain neither party controls. The remainder are test inputs and the captured DoH bodies for the same names. No deal was ever opened against a domain someone owns. |
| `mnemonic`, `keystore`, `privateKey`, `private key` | 5, in 5 files | Every one either asserts the negative or enforces it. Two are `evidence/studionet.json` recording that no key was exported, no wallet or keystore was created, no mnemonic or keystore file was opened, and no password was supplied. One is `tests/e2e/wallet.spec.ts:289`, the banned-token pattern that fails the run if any served page leaves any of those in `localStorage` or `sessionStorage` on any of the four routes. One is the `*keystore*.json` rule in `.gitignore`. The fifth is inside `tsconfig.tsbuildinfo`, which is the compiler's copy of the test file above. No key material, keystore, password or mnemonic exists anywhere in this tree. |
| `passphrase` | 30, in 4 files | A product feature, not a credential. The buyer's commitment is a secret the buyer generates in the browser and may optionally wrap in a passphrase before saving it, so the word names a user-supplied wrapper for a user-held value: `src/lib/secret.ts` (11), `tests/frontend/proof-records.test.ts` (9), `src/components/lodge-offer.tsx` (8) and `tests/e2e/production.spec.ts` (2). Nothing is transmitted, nothing is stored server-side, and there is no server side. `production.spec.ts` asserts the field is absent until a wallet has reported an address, because the buyer's token is bound to the address that lodges the offer. |
| `MOCK_`, `mock-data` | 32, in 7 files | The documented fixture mode. `src/lib/mock-data.ts` is the fixture register and is read only by `src/lib/data-source.ts`, the single seam between fixtures and the contract. `tests/frontend/fixture-gate.test.ts` enforces that seam and fails if any page or component names a fixture constant, or if a reader returns a fixture without first checking the data mode. One match is in `.env.example` documenting the switch, one is in `src/lib/genlayer/config.ts` reading it, one is the provenance strip in `src/components/app-shell.tsx` that prints which mode a page is serving, and one is in `tsconfig.tsbuildinfo`. The live build sets the switch to `live`, and the end-to-end suite asserts on each of the four routes it loads directly that the fixture strip is absent and the live one is present. |
| `http://` | 10, in 8 files | Three are the Apache licence URL in `LICENSE` and `NOTICE`. One is the SVG XML namespace in `src/app/icon.svg`, which is an identifier and not a fetch. Three are the local end-to-end origin counted above. One is prose in `evidence/studionet.json` explaining the last two, which are real and are the interesting ones: `http://rdap.cctld.kg/` and `http://rdap.nic.mg/`, inside the captured IANA bootstrap. Two live TLDs publish an RDAP base over cleartext with no HTTPS alternative, so `registry_base_for_domain` fails closed on them rather than downgrading, and a deal on a `.kg` or `.mg` domain is refused. That was read out of the live bootstrap, not invented. No live deal was opened against either TLD, and `evidence/studionet.json` says so under `notProvenOnChain`. |
| Contract addresses | 5 distinct | The live deployment `0x104767ad5d51b5004953e4fB9d5B548501aa9bd9`, three superseded ones and one that failed. Every superseded address is labelled as superseded at the point of use and appears only in `DEPLOYMENT.json` under `historicalDeployments` and in `evidence/studionet.json`: `0xC162BA113137539fD734e986403C1FA5fAbA6109` carried the seller casing defect, `0x07a615f2F2D7fC48AF2630b410e403a82B1d261b` refused invalid input by raising after value had already arrived, and `0xB869533BEE20269514c7552dc85215e10d8b7A75` had a defect in the per-domain deal index. `0x513B913dfbCB1790a35630f100CB59140a67B4ba` is listed separately because it reported ACCEPTED and then FINALIZED and returned an address while registering nothing, which is what a missing GenVM runtime pin does. No live claim rests on any of the four. `.env.local` and `.env.example` name the live address only. |
| Other 40-hex strings | 15 | Eight are the fixture register's invented parties in `src/lib/mock-data.ts`, reachable only in fixture mode. Four are test literals: `0x1234...5678` and `0xfedc...ba98` in two frontend tests, `0x0000...00e2` in the wallet stub, and `0x1111...1111` as the second account in the wallet suite. Two are real accounts and are public by nature: the signer `0xb29Ead15B1E8A2420faE84de974088f67a15ccC2`, and the seller `0xac3AC69dC0Bde389256dD6748C75817ead9286D9`, which appears in five files because four of them explain the casing defect it exposed. The last is `0x81b637d8fCD2C6da6359E6963113a1170de795e4`, the GenLayer SDK's own test address, quoted in `contracts/Conveyance.py:1656` and in a frontend test to show what `Address.as_hex` returns. None is a credential. |
| Transaction hashes | 20 distinct, in 2 files | Every `0x`-prefixed 64-hex string in the project is confined to `DEPLOYMENT.json` and `evidence/studionet.json`. Nineteen sit in a `transaction`, `deploymentTransaction` or `hash` field; the twentieth, `0xdb412812c8c9210d508ce15ab5410435eec39d08a9e2dd60d21f4f93c493bf0f`, appears only inside a sentence, and that sentence is a demonstration that `npm run verify:studionet` rejects a stale hash rather than accepting it. Nine hashes are the current deployment's asserted proofs and are re-checkable by that one command, which re-reads all nine off the chain and exits non-zero if any no longer says what is written. The rest belong to the three superseded deployments and are confined to `historicalDeployments`, where each is stated to prove the behaviour of that contract only. Two hashes record refusals rather than successes and say so wherever they appear. |
| `fixture` | 179, in 30 files | Two distinct senses share the word and both are documented: the frontend's fixture data mode, and the byte-pinned captures the direct suite runs against. Unlike Recourse, **the word does appear inside three captured bodies**, and it is worth saying why rather than claiming otherwise. The two NXDOMAIN controls were captured by querying `nonexistent-conveyance-fixture-xyz123.com`, so the name we asked for is echoed back in the answer, which is exactly what a resolver is supposed to do. The third is `doh-disagreement.json`, discussed below. |

## What the captured fixture set actually is

Recourse's captures are eleven-for-eleven verbatim wire bytes. Conveyance's
eleven routes are not uniform, and flattening them into one number would hide
the part a reviewer should look at:

- **Five are verbatim**, marked `verbatim: true`: the two DoH NXDOMAIN controls,
  the RDAP not-found control, and the two DoH TXT captures.
- **Three are live captures whose byte-for-byte identity to the wire is not
  re-verified**, and each says so in its own `verbatim` field with the reason:
  the IANA bootstrap, and the `.com` and `.org` RDAP baselines. All three are
  parsed by field name and never hashed by the contract, so a JSON round trip
  could not change a conclusion. The manifest records `bytes_on_disk` rather
  than `bytes_received` so the distinction is not lost.
- **One is synthetic on purpose and declares it**, `verbatim: false`:
  `doh-disagreement.json`, derived mechanically from the real Google capture
  with two TXT values substituted, so agreement and disagreement differ in
  exactly one respect. The real world will not produce two resolvers
  contradicting each other on demand, and the refusal path still has to be
  tested. The substituted name sits under `.invalid`, which RFC 2606 reserves,
  so a fabricated name can never collide with a real one.
- **Two are not captured at all** and are asserted to still be uncaptured.

`npm run verify:fixtures` pins every present body's byte count and full sha256
against the bytes on disk, so Conveyance can now make Recourse's claim that the
check fails if a single byte changes. It also makes a claim Recourse cannot:
the shipped captures are compared byte for byte against the copies in
`_build/fixtures/conveyance/`, which `tests/direct/evidence.py` has always
asserted in its header and which nothing previously checked.

## What the sweep found and fixed

Three defects, all in the checking apparatus rather than in the contract, and
all of the class a reader misses and a checker does not:

1. **A shadowed duplicate key.** `doh-disagreement` declared `capture` twice.
   JSON is specified to keep the last value, so the first block was dead text
   that read as live provenance.
2. **Half digests.** Five of the nine present captures recorded a 32-character
   sha256, which is half a digest, and four recorded none at all. Every recorded
   prefix did match its file, so this was truncation rather than a wrong value,
   but a 32-character prefix in a field named `sha256` invites the reader to
   believe a check happened that had not. All nine now carry the full 64.
3. **A checker that contradicted itself.** The shared
   `_build/harness/verify_fixtures.py` counted the two blocked transfer routes
   as a problem in its body pass and as `wait` in its routing pass, so one run
   reported failure in its exit code and waiting in its prose, against its own
   docstring. Holdfast at 16 of 16 and quorum-clean at 10 of 10 were unaffected
   either way, which is why it had gone unnoticed.

## Secrets and artifacts

Three filenames in the tree are credential-shaped, and none holds a credential:

- `.env.example`, 629 bytes, a template.
- `.env.local`, 207 bytes, the live wiring. All four of its variables are
  prefixed `NEXT_PUBLIC_`, which means Next inlines them into the client bundle,
  so none of them was ever capable of being secret: the contract address, the
  public StudioNet endpoint, the chain id, and the data-mode switch.
- `tsconfig.tsbuildinfo`, 232829 bytes, the TypeScript build cache.

No `.pem`, `.key`, `id_rsa`, keystore or `.vercel` file exists in the tree. The
StudioNet proofs were signed through the CLI's own client path against an
OS-keychain cache populated by `genlayer account unlock`. No key was read,
decrypted, exported or logged, no wallet or keystore was created, no mnemonic or
keystore file was opened, and no password was supplied on a command line or
written to a file.

`.gitignore` lists `node_modules`, `.next`, `out`, `build`, `*.pem`, `*.key`,
`*keystore*.json`, `.env*` with `!.env.example`, `.vercel`, `next-env.d.ts`,
`artifacts`, `*.tsbuildinfo`, `.pytest_cache/`, `__pycache__/`, `*.py[cod]`,
`test-results/` and `playwright-report/`. That list is reported as a list. With
no repository, nothing here verifies that any of those rules takes effect, and
this file does not pretend otherwise.
