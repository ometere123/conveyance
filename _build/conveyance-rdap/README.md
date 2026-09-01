# conveyance-rdap

Stdlib-only RDAP and DoH primitives for the Conveyance contract. No network, filesystem,
clock or randomness; HTTP goes only through an injected `fetch`. 32 pass, 2 skip, exit 0.

## Public signatures

```python
# Failures raise Refusal, .tag one of TAG_EXPECTED/EXTERNAL/TRANSIENT/LLM_ERROR. Never success.
# 1. IANA bootstrap -> registry RDAP routing. Longest suffix, https bases only.
normalize_domain(domain) -> str              bootstrap_services(bootstrap) -> list
registry_base_for_domain(bootstrap, domain)  rdap_domain_url(base, domain) -> str
assert_base_still_authoritative(bootstrap, domain, stored_base) -> str    # [TRANSIENT]
# 2. RDAP parsing, by RFC 9083 field name only, never by offset or one registry's order.
normalize_epp_status(value) -> str           parse_status_flags(statuses) -> dict
parse_events(events) -> dict                 event_date(events, action, required=False)
assert_zulu_timestamp(value, what) -> str    select_registrar(entities) -> dict
parse_nameservers(nameservers) -> tuple      classify_rdap_status(status, raw)
parse_rdap_domain(status, raw) -> dict       rdap_digest(parsed) -> str
# 3. Two-resolver DoH corroboration. DOH_CLOUDFLARE, DOH_GOOGLE, DOH_HEADERS.
doh_txt_url(resolver, name) -> str           normalize_dns_name(name) -> str
normalize_txt_value(raw) -> str              parse_doh(status, raw, resolver)
corroborate(*obs) -> Corroboration           # .agreed .tag .digest .require_agreement()
# 4. Control proof. PROOF_COMPARED and PROOF_EXCLUDED are the specification.
assert_proof_token_shape(token) -> str       canonical_control_proof(qname, values)
control_proof_digest(qname, values) -> str   commitment_digest(token) -> str
classify_proof(corroboration, token)         # PROOF_FOUND / ABSENT / NAME_MISSING
# injected fetch(url, headers=None) -> .status (int) and .body (bytes). Not .status_code.
fetch_bootstrap(fetch, url=...)              fetch_rdap_domain(fetch, base, domain)
fetch_doh_txt(fetch, resolver, name)         fetch_corroborated_txt(fetch, name, resolvers)
```

## Splice contract

Copy the region between `# --- CONVEYANCE-RDAP SPLICE BEGIN ---` and `... SPLICE END ---`
inline into `conveyance/contracts/Conveyance.py`, unchanged, and bind
`fetch = lambda url, headers=None: gl.nondet.web.request(url, method="GET", headers=headers)`.
Drift guard: sha256 over that region, CRLF folded to LF, ends stripped, one trailing newline.
`test_splice_region_digest_is_reproducible` recomputes and prints it every run. On 2026-08-25:
1107 lines, 50294 bytes, `0e552decc51f21966acfb7b49757029f077082a0b3010430bd288667740ccbb6`.
