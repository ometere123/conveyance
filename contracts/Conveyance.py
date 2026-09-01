# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""Conveyance: escrow for a cross-registrar domain transfer, settled on public evidence.

A buyer escrows the price. A seller proves DNS control of the domain, then moves it to the
registrar the buyer named. The contract reads the registry's own RDAP record and two
independent DNS resolvers, inside consensus, and releases the escrow only when both agree
that the transfer completed and that the buyer now controls the name.

WHAT THIS CONTRACT DOES NOT DO, stated here because it is the first thing a reader should
know and the last thing a seller will want repeated:

    Conveyance verifies public transfer signals and operational DNS control. It does not
    prove legal title, beneficial ownership, the identity of a private registrant, or that
    a registrar account has no retained delegates.

THERE IS NO MODEL IN THIS CONTRACT. Every consensus block is `gl.eq_principle.strict_eq`.
That is a deliberate divergence from the product document, which specifies an LLM
adjudication step over four dispute grounds, and it is worth the paragraph it costs.

Three of those four grounds are fields. `TRANSFER_REVERSED` is the `transfer` event and the
registrar's IANA id in RDAP. `DOMAIN_SUSPENDED` is `clientHold` or `serverHold` in the
status array. `WRONG_DOMAIN` is a string comparison against `ldhName`. `DNS_CONTROL_REVOKED`
is the absence of a TXT record two resolvers were asked about. The document's fourth ground,
`PRIVATE_ACCOUNT_CUSTODY`, it already marks non-adjudicable. So the model would be asked to
opine on facts the contract can read, which is the one thing the house rule for this project
forbids: the model is asked what the evidence says, never what the contract should do. Here
there is no natural-language evidence for it to read. RDAP is structured JSON and a TXT
record is a byte string. Adding an inference step would add a way to be wrong and no way to
be right, so the dispute methods are replaced by a deterministic `REVERSED` state that
`check_transfer` reaches from the same two sources the happy path already reads.

METHOD NAMES. The offline harness fixes six: `open_deal`, `arm`, `check_transfer`, `settle`,
`refund`, `abandon`. The product document lists ten. The harness is the executable
specification, so the six are authoritative and the mapping is:

    open_deal      open_deal
    arm            accept_deal, plus the seller's DNS control proof
    check_transfer verify_delivery
    settle         accept_delivery and finalize_delivery, merged on the caller
    refund         refund_expired, plus the refund out of REVERSED
    abandon        cancel_offer, widened to cover a seller who gives up after arming

`abandon` needs its rule said out loud, because who may call it is the whole question. While
OFFERED, either party may call it: the seller has committed nothing and the buyer's escrow is
the only thing at stake. Once LOCKED, only the seller may, because the seller may by then
have a real transfer in flight at a registrar, and a buyer who could cancel at will could let
a seller complete a transfer and then walk away with the price. The buyer's remedy after
LOCKED is the transfer deadline, which `refund` enforces without needing the seller present.

THE ESCROW MOVES IN FOUR PLACES AND NOWHERE ELSE: `settle` pays the seller, and `refund`,
`abandon` and nothing else pay the buyer. Every one of them re-reads state, sets the terminal
state before paying, and writes the deal back. There is no partial payout and no protocol
fee, so `total_escrowed == total_released + total_refunded + the balance still held`.

THE EVIDENCE PATH IS SPLICED, NOT IMPORTED. A GenLayer Intelligent Contract is a single
module and cannot import a sibling file, so `_build/conveyance-rdap/rdap.py` is written and
unit-tested standalone (39 tests) and then copied verbatim between the two markers below.
`conveyance/scripts/splice_rdap.py` proves the copy is byte-identical to its source and
re-runs all 39 tests against the copy that ships. Do not edit the region. Edit the source
and re-splice.

The region raises `Refusal`, an exception, rather than returning a refusal value, so every
consensus block here wraps its body in `try/except Refusal` and returns `{"error": str(exc)}`.
`str(Refusal)` already carries one of the four taxonomy tags and the reason, so `_raise_if_error`
re-raises it verbatim and a caller sees the same tag whether the failure happened in a
validator's fetch or in the contract's own checks.
"""

from genlayer import *
from dataclasses import dataclass

# ======================================================================================
# The RDAP and DNS evidence path, spliced verbatim from _build/conveyance-rdap/rdap.py.
# The two imports below are part of the region on purpose: the standalone suite digests
# the region from its own markers inward, and hoisting them out of it would break the
# byte-identity that makes those 39 tests tests of the code that actually ships.
# ======================================================================================

# --- CONVEYANCE-RDAP SPLICE BEGIN ---

import hashlib
import json

TAG_EXPECTED = "[EXPECTED]"
TAG_EXTERNAL = "[EXTERNAL]"
TAG_TRANSIENT = "[TRANSIENT]"
TAG_LLM_ERROR = "[LLM_ERROR]"

# Response-size bounds. Each is set from a measured capture on 2026-08-25 with headroom,
# not guessed: bootstrap 71,095 B, largest RDAP body 7,261 B (PIR .org), largest DoH body
# 370 B. A bound below the real size would turn a working source into a refusal, and no
# bound at all is how a 31 MB body gets parsed inside a consensus round.
MAX_BOOTSTRAP_BYTES = 262144   # 3.7x the measured 71,095
MAX_RDAP_BYTES = 65536         # 9.0x the measured 7,261
MAX_DOH_BYTES = 8192           # 22.1x the measured 370

# DNS record types this module knows about. TXT is the only one a proof may come from.
DNS_TYPE_CNAME = 5
DNS_TYPE_TXT = 16

# A TXT answer set may legitimately be fronted by CNAMEs. Following them is bounded so a
# CNAME loop published by a hostile seller cannot make the parse unbounded.
MAX_CNAME_HOPS = 4

# RFC 1035 section 3.3.14: one TXT character-string is at most 255 octets. A longer value
# is split, and the chunks are what `normalize_txt_value` rejoins.
TXT_CHUNK_LIMIT = 255

# Bounds on caller-supplied strings, so a malformed argument is rejected before it can
# reach a URL or a digest.
MAX_DOMAIN_BYTES = 253         # RFC 1035 section 2.3.4
MAX_LABEL_BYTES = 63
MAX_PROOF_TOKEN_BYTES = 255    # one character-string; see `assert_proof_token_shape`

_DOMAIN_LABEL_OK = set("abcdefghijklmnopqrstuvwxyz0123456789-_")


class Refusal(Exception):
    """A refusal carrying one of the four taxonomy tags.

    Parsing failures raise rather than return, so there is no success-shaped value for a
    caller to read out of a failed parse. The one deliberate exception is
    `corroborate`, which returns a result object because the contract wants to record a
    disagreement on chain before it reverts.
    """

    def __init__(self, tag, reason, detail=None):
        self.tag = tag
        self.reason = reason
        self.detail = detail
        message = "%s %s" % (tag, reason)
        if detail is not None:
            message = "%s (%s)" % (message, detail)
        Exception.__init__(self, message)


def expected(reason, detail=None):
    return Refusal(TAG_EXPECTED, reason, detail)


def external(reason, detail=None):
    return Refusal(TAG_EXTERNAL, reason, detail)


def transient(reason, detail=None):
    return Refusal(TAG_TRANSIENT, reason, detail)


def llm_error(reason, detail=None):
    return Refusal(TAG_LLM_ERROR, reason, detail)


def _sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _require_text(value, what):
    if not isinstance(value, str):
        raise expected("%s must be a string" % what, type(value).__name__)
    return value


def _decode_json(raw, what, max_bytes):
    """Bytes to a parsed document, with the size bound and the empty case explicit.

    The empty case is separated from the malformed case on purpose. Verisign answers a
    .com miss with a zero-byte body, so "there was nothing to parse" is a real and
    common state that must not be reported as a syntax error.
    """
    if raw is None:
        raise external("%s returned no body at all" % what)
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if not isinstance(raw, (bytes, bytearray)):
        raise expected("%s body must be bytes" % what, type(raw).__name__)
    if len(raw) == 0:
        raise external("%s returned an empty body" % what, "0 bytes")
    if len(raw) > max_bytes:
        raise external("%s body exceeds the %d byte bound" % (what, max_bytes),
                       "%d bytes" % len(raw))
    try:
        return json.loads(bytes(raw).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise external("%s body is not parseable JSON" % what, str(exc)[:120])


# ======================================================================================
# 1. IANA bootstrap to registry RDAP routing
# ======================================================================================
#
# The bootstrap is 71,095 bytes with 590 service entries and changes rarely, so the
# contract resolves it once at deal creation, stores the base on chain, and re-resolves
# only on a miss or to detect a mid-deal change (PRD section 6, ordering discipline).
#
# Matching is longest-suffix, per RFC 9224 section 5, which permits an entry to name a
# multi-label suffix. Measured note: the live file on 2026-08-25 contains 1,200 labels and
# not one of them has a dot, so longest-suffix matching is currently unexercised by the
# real document. It is implemented anyway because the file is allowed to grow one, and a
# shortest-match parser would then route a domain to the wrong registry.


def normalize_domain(domain):
    """Lowercase and structurally validate a domain, returning the ASCII LDH form.

    Rejects schemes, paths, ports, credentials, wildcards, trailing dots and empty
    labels, per PRD section 5. Rejects non-ASCII rather than guessing at IDNA: the
    contract normalizes with a real IDNA helper before calling in, and silently accepting
    a Unicode label here would let two validators disagree on the encoding.
    """
    _require_text(domain, "domain")
    if domain != domain.strip():
        raise expected("domain has surrounding whitespace", repr(domain[:40]))
    lowered = domain.lower()
    if not lowered:
        raise expected("domain is empty")
    if len(lowered.encode("utf-8")) > MAX_DOMAIN_BYTES:
        raise expected("domain exceeds %d bytes" % MAX_DOMAIN_BYTES, str(len(lowered)))
    for bad in ("://", "/", "?", "#", "@", ":", "*", " ", "\t"):
        if bad in lowered:
            raise expected("domain contains %r" % bad, lowered[:60])
    if lowered.endswith("."):
        raise expected("domain has a trailing dot", lowered[:60])
    labels = lowered.split(".")
    if len(labels) < 2:
        raise expected("domain has no TLD label", lowered)
    for label in labels:
        if not label:
            raise expected("domain has an empty label", lowered)
        if len(label.encode("utf-8")) > MAX_LABEL_BYTES:
            raise expected("domain label exceeds %d bytes" % MAX_LABEL_BYTES, label[:70])
        for char in label:
            if char not in _DOMAIN_LABEL_OK:
                raise expected("domain label has a disallowed character %r" % char,
                               lowered[:60])
    return lowered


def bootstrap_services(bootstrap):
    """Validate the bootstrap envelope and return its service entries.

    Shape checked against the live file: every one of the 590 entries is a two-element
    list of [[tld, ...], [url, ...]] and every entry carries exactly one URL. The check is
    still written for the general case, because RFC 9224 permits several URLs per entry.
    """
    if not isinstance(bootstrap, dict):
        raise external("bootstrap is not a JSON object", type(bootstrap).__name__)
    services = bootstrap.get("services")
    if not isinstance(services, list) or not services:
        raise external("bootstrap has no services array")
    return services


def registry_base_for_domain(bootstrap, domain):
    """Longest-suffix match a domain to its authoritative RDAP base URL.

    Returns the base with a guaranteed single trailing slash. Verified against the live
    bootstrap: `.com` resolves to https://rdap.verisign.com/com/v1/ and `.org` to
    https://rdap.publicinterestregistry.org/rdap/, matching PRD section 2 exactly.

    Two failure modes are deliberately [EXPECTED] rather than [EXTERNAL]. A TLD absent
    from the bootstrap and a TLD whose only base is plaintext http are both statements
    about the caller's domain, decided before any RDAP request is made, so the deal must
    not be created at all. Measured: two live entries are http, `kg` and `mg`, so the
    scheme check is reachable rather than theoretical, and PRD section 2 requires that
    only an https base from the fetched document is permitted.
    """
    normalized = normalize_domain(domain)
    services = bootstrap_services(bootstrap)

    # tld -> [urls]. Built once, so matching is a lookup per candidate suffix rather than
    # a scan per candidate, and so a duplicated label is caught instead of shadowed. The
    # live file has no duplicates; a future one that did would be ambiguous, not benign.
    table = {}
    for entry in services:
        if not isinstance(entry, list) or len(entry) != 2:
            raise external("bootstrap service entry is not a two-element list")
        tlds, urls = entry
        if not isinstance(tlds, list) or not isinstance(urls, list):
            raise external("bootstrap service entry halves are not both lists")
        for tld in tlds:
            if not isinstance(tld, str) or not tld:
                raise external("bootstrap service entry has a non-string TLD")
            key = tld.lower().strip(".")
            if key in table and table[key] != urls:
                raise external("bootstrap lists TLD %r in two entries with different "
                               "bases, which is ambiguous" % key)
            table[key] = urls

    labels = normalized.split(".")
    # Longest suffix first: for a.b.example.com try b.example.com, then example.com, then
    # com. The domain itself is not a candidate suffix, so a registered name can never
    # shadow the registry it sits under.
    for start in range(1, len(labels)):
        candidate = ".".join(labels[start:])
        urls = table.get(candidate)
        if urls is None:
            continue
        https = sorted(u for u in urls
                       if isinstance(u, str) and u.lower().startswith("https://"))
        if not https:
            raise expected(
                "TLD %r has no https RDAP base in the IANA bootstrap, so it is not a "
                "supported TLD" % candidate,
                ", ".join(str(u) for u in urls)[:120])
        base = https[0]
        if not base.endswith("/"):
            base += "/"
        return base
    raise expected("no IANA bootstrap entry covers %r" % normalized,
                   "checked %d suffixes" % (len(labels) - 1))


def rdap_domain_url(base, domain):
    """Construct the authoritative /domain/{name} URL. The caller never supplies this."""
    _require_text(base, "rdap base")
    if not base.lower().startswith("https://"):
        raise expected("rdap base is not https", base[:80])
    normalized = normalize_domain(domain)
    if not base.endswith("/"):
        base += "/"
    return base + "domain/" + normalized


def assert_base_still_authoritative(bootstrap, domain, stored_base):
    """Re-check a stored base against a freshly fetched bootstrap.

    PRD section 6: the contract fetches IANA again at delivery rather than trusting a
    stored base, and a changed map fails as [TRANSIENT] so settlement never switches
    authority mid-deal. Returns the freshly resolved base when it agrees.
    """
    _require_text(stored_base, "stored rdap base")
    fresh = registry_base_for_domain(bootstrap, domain)
    if fresh != stored_base:
        raise transient(
            "the IANA bootstrap now routes this domain somewhere else, so authority "
            "changed mid-deal",
            "stored %s, now %s" % (stored_base, fresh))
    return fresh


# ======================================================================================
# 2. RDAP event and status-flag parsing
# ======================================================================================
#
# Driven by RFC 9083 field names only. Never by offsets, never by one registry's
# ordering. The two captured registries differ on all of the following for the same
# question, and every one of these was measured on 2026-08-25:
#
#   Verisign .com      2,440 bytes, 11 top-level keys, has `handle`,
#                      events registration / expiration / last changed / last update,
#                      status all `client ...`, ldhName and nameservers UPPERCASE
#   PIR .org           7,261 bytes, 12 top-level keys, no `handle` (redacted),
#                      events expiration / registration / last changed / last update,
#                      status all `server ...`, ldhName and nameservers lowercase,
#                      and each nameserver carries its own status ["associated"]
#
# That last one is a trap: a parser that gathers `status` recursively picks up
# "associated" from the nameserver objects and reports a domain lock state that does not
# exist. Only the top-level `status` array is read.

STATUS_PENDING_TRANSFER = "pending transfer"

#: EPP lock names, without the party prefix. `client` is set by the sponsoring registrar
#: and can be lifted by the registrar on the registrant's instruction. `server` is set by
#: the registry and only the registry can lift it. Both mean the operation is prohibited,
#: so a contract that collapses them knows a transfer is blocked but not who to ask.
LOCK_PROHIBITIONS = ("transfer", "delete", "update", "renew")

#: `hold` is spelled differently and the difference is easy to miss. EPP has `clientHold`
#: and `serverHold` with no `prohibited` suffix, because a hold is not a prohibition on an
#: operation but the registry saying it has pulled the name out of the published zone.
#: Appending " prohibited" to every operation in one loop compiles, reads correctly, and
#: silently never matches the one status that actually removes a domain from DNS. That is
#: exactly the status an escrow most needs to see, so the two spellings are kept apart here
#: rather than papered over with a single format string.
LOCK_STATES = ("hold",)

LOCK_OPERATIONS = LOCK_PROHIBITIONS + LOCK_STATES
LOCK_SETTER_CLIENT = "client"
LOCK_SETTER_SERVER = "server"


def normalize_epp_status(value):
    """Lowercase and collapse whitespace in one EPP status string.

    RDAP status values are already the spaced form ("client transfer prohibited"), but
    registries have historically emitted the camelCase EPP form too, so the camelCase
    spelling is split rather than passed through as a value nothing will ever match.
    """
    _require_text(value, "status value")
    text = value.strip()
    if " " not in text and text != text.lower():
        # clientTransferProhibited -> client transfer prohibited
        parts = []
        current = ""
        for char in text:
            if char.isupper() and current:
                parts.append(current)
                current = char.lower()
            else:
                current += char.lower()
        if current:
            parts.append(current)
        text = " ".join(parts)
    return " ".join(text.lower().split())


def parse_status_flags(statuses):
    """Split a top-level RDAP status array into locks that preserve who set each one.

    Returns a dict with the normalized sorted values plus one entry per operation in
    `LOCK_OPERATIONS`, each recording `locked` and the sorted `setters` that set it. The
    setter list is what the contract needs: a `client transfer prohibited` lock can be
    lifted by the losing registrar, a `server transfer prohibited` lock cannot, and a
    deal blocked by the second one is not going to unblock on its own.
    """
    if statuses is None:
        values = []
    elif isinstance(statuses, list):
        values = [normalize_epp_status(s) for s in statuses]
    else:
        raise external("RDAP status is not an array", type(statuses).__name__)

    unique = sorted(set(values))
    locks = {}
    for operation in LOCK_OPERATIONS:
        suffix = "" if operation in LOCK_STATES else " prohibited"
        setters = []
        for setter in (LOCK_SETTER_CLIENT, LOCK_SETTER_SERVER):
            if "%s %s%s" % (setter, operation, suffix) in unique:
                setters.append(setter)
        locks[operation] = {"locked": bool(setters), "setters": tuple(setters)}

    return {
        "values": tuple(unique),
        "locks": locks,
        "transfer_locked": locks["transfer"]["locked"],
        "transfer_lock_setters": locks["transfer"]["setters"],
        "pending_transfer": STATUS_PENDING_TRANSFER in unique,
        "pending": tuple(v for v in unique if v.startswith("pending ")),
    }


def parse_events(events):
    """Map RFC 9083 eventAction to sorted eventDate strings, order-independent.

    Both captures carry the same four actions in a different order, so the returned map is
    keyed by action and the input sequence is discarded. RFC 9083 permits an action to
    repeat (a domain can have more than one transfer event), so each key holds every date
    seen, sorted; `event_date` then applies one documented selection rule.
    """
    if events is None:
        return {}
    if not isinstance(events, list):
        raise external("RDAP events is not an array", type(events).__name__)
    found = {}
    for event in events:
        if not isinstance(event, dict):
            raise external("RDAP event is not an object", type(event).__name__)
        action = event.get("eventAction")
        date = event.get("eventDate")
        if not isinstance(action, str) or not action.strip():
            raise external("RDAP event has no eventAction")
        if not isinstance(date, str) or not date.strip():
            raise external("RDAP event %r has no eventDate" % action[:40])
        key = " ".join(action.lower().split())
        found.setdefault(key, []).append(date.strip())
    return dict((key, tuple(sorted(dates))) for key, dates in found.items())


def event_date(events, action, required=False):
    """One eventDate for an action, or None.

    Selection rule when an action repeats: the lexicographically greatest value, which for
    the RFC 3339 Zulu timestamps both registries emit is the most recent. That is the one
    `verify_delivery` wants, since the question is whether a transfer happened after the
    baseline, not whether one ever happened. Timestamps are compared as strings only
    because both captures are Zulu with a fixed shape; a registry emitting a numeric
    offset would need real date parsing, and `assert_zulu_timestamp` refuses it loudly
    rather than mis-ordering it.
    """
    key = " ".join(_require_text(action, "event action").lower().split())
    dates = events.get(key)
    if not dates:
        if required:
            raise external("RDAP response has no %r event" % key,
                           "saw %s" % ", ".join(sorted(events)) if events else "no events")
        return None
    return dates[-1]


def assert_zulu_timestamp(value, what):
    """Refuse any timestamp that string comparison would order incorrectly.

    Both captured registries emit RFC 3339 with a literal Z, with and without fractional
    seconds (Verisign 2026-08-14T08:01:43Z, PIR 2026-08-12T01:22:03.024Z). Fractional
    digits are safe for string ordering; a numeric offset such as +02:00 is not, and it
    must fail rather than silently sort before an earlier UTC instant.
    """
    _require_text(value, what)
    text = value.strip()
    if not text.endswith("Z"):
        raise external("%s is not a Zulu timestamp, so string ordering is unsafe" % what,
                       text[:40])
    if len(text) < 20 or text[4] != "-" or text[7] != "-" or text[10] != "T":
        raise external("%s is not an RFC 3339 date-time" % what, text[:40])
    return text


def select_registrar(entities):
    """The entity whose `roles` contains `registrar`, with its IANA id from `publicIds`.

    Both captures nest an `abuse` entity inside the registrar entity, so the search is
    over the top-level entity array only and the nested one cannot win. Exactly one
    registrar is required: zero means the response cannot answer the question the deal
    turns on, and two means the response is ambiguous. Neither is a lock state.
    """
    if not isinstance(entities, list) or not entities:
        raise external("RDAP response has no entities array")
    matches = []
    for entity in entities:
        if not isinstance(entity, dict):
            continue
        roles = entity.get("roles")
        if isinstance(roles, list) and any(
                isinstance(r, str) and r.lower().strip() == "registrar" for r in roles):
            matches.append(entity)
    if not matches:
        raise external("RDAP response has no entity with the registrar role")
    if len(matches) > 1:
        raise external("RDAP response has %d registrar entities, which is ambiguous"
                       % len(matches))
    entity = matches[0]

    iana_id = None
    for public_id in entity.get("publicIds") or []:
        if not isinstance(public_id, dict):
            continue
        kind = public_id.get("type")
        if isinstance(kind, str) and "iana registrar id" in kind.lower():
            identifier = public_id.get("identifier")
            if identifier is not None:
                iana_id = str(identifier).strip()
            break
    if not iana_id:
        # `handle` carries the same value in both captures, but publicIds is the field
        # RFC 9083 defines for it, so handle is only a fallback and is recorded as such.
        handle = entity.get("handle")
        if isinstance(handle, str) and handle.strip():
            iana_id = handle.strip()
    if not iana_id:
        raise external("registrar entity has no IANA registrar id")
    if not iana_id.isdigit():
        raise external("registrar IANA id is not numeric", iana_id[:40])

    name = None
    vcard = entity.get("vcardArray")
    if isinstance(vcard, list) and len(vcard) == 2 and isinstance(vcard[1], list):
        for field in vcard[1]:
            if (isinstance(field, list) and len(field) >= 4
                    and field[0] == "fn" and isinstance(field[3], str)):
                name = field[3].strip()
                break
    return {"iana_id": iana_id, "name": name or ""}


def parse_nameservers(nameservers):
    """Sorted, lowercased, de-duplicated nameserver names from `ldhName`.

    Case is normalized because Verisign emits ELLIOTT.NS.CLOUDFLARE.COM and PIR emits
    katelyn.ns.cloudflare.com, and DNS names are case-insensitive. Each nameserver object
    in the PIR capture also has its own `status: ["associated"]`, which is deliberately
    not read here and not merged into the domain status.
    """
    if nameservers is None:
        return ()
    if not isinstance(nameservers, list):
        raise external("RDAP nameservers is not an array")
    names = set()
    for entry in nameservers:
        if isinstance(entry, str):
            name = entry
        elif isinstance(entry, dict):
            name = entry.get("ldhName") or entry.get("unicodeName")
        else:
            raise external("RDAP nameserver entry is neither string nor object")
        if not isinstance(name, str) or not name.strip():
            raise external("RDAP nameserver entry has no ldhName")
        names.add(name.strip().rstrip(".").lower())
    return tuple(sorted(names))


def classify_rdap_status(status, raw):
    """HTTP status to a refusal, for every non-200. Returns None when the caller may parse.

    The 404 case is the one that matters and it is checked before the body is looked at.
    Verisign answers a .com miss with a zero-byte body and no RFC 9083 error document at
    all, while PIR answers the same condition with a rich one, so a parser that needs an
    `errorCode` field to recognise failure passes against PIR and falls straight through
    against Verisign. Nothing below reads the body to decide that a lookup failed.
    """
    if not isinstance(status, int):
        raise expected("HTTP status must be an int", type(status).__name__)
    size = 0 if raw is None else len(raw)
    if status == 404:
        # A 404 says the registry holds no record for this name. It does not say the
        # domain left the seller's control, and it is never a delivery outcome.
        return external("RDAP returned 404, so the registry has no record for this name",
                        "%d byte body" % size)
    if status == 429:
        return transient("RDAP rate limited", "retry later")
    if status == 403:
        return external("RDAP refused the request with 403")
    if status in (500, 502, 503, 504):
        return external("RDAP is unavailable", "HTTP %d" % status)
    if status != 200:
        return external("unexpected RDAP HTTP status", "HTTP %d" % status)
    if size == 0:
        # A 200 with nothing in it is the same absence as a 404, reported differently.
        return external("RDAP returned 200 with an empty body", "0 bytes")
    return None


def parse_rdap_domain(status, raw):
    """Parse an RDAP domain response into the tuple the equivalence principle compares.

    Raises for every failure. There is no shape of RDAP response that produces a return
    value here meaning "not found" or "no longer under seller control", because both of
    those are inferences this module refuses to make from a missing record.
    """
    refusal = classify_rdap_status(status, raw)
    if refusal is not None:
        raise refusal
    doc = _decode_json(raw, "RDAP", MAX_RDAP_BYTES)
    if not isinstance(doc, dict):
        raise external("RDAP body is not a JSON object", type(doc).__name__)
    if doc.get("objectClassName") not in (None, "domain"):
        raise external("RDAP object is not a domain",
                       str(doc.get("objectClassName"))[:40])
    # An RFC 9083 error document can arrive with a 200 from a misconfigured service. It is
    # recognised when present, and never depended on, per `classify_rdap_status`.
    if "errorCode" in doc:
        raise external("RDAP returned an error document",
                       "errorCode %s" % str(doc.get("errorCode"))[:20])

    ldh = doc.get("ldhName")
    if not isinstance(ldh, str) or not ldh.strip():
        raise external("RDAP response has no ldhName")

    events = parse_events(doc.get("events"))
    flags = parse_status_flags(doc.get("status"))
    registrar = select_registrar(doc.get("entities"))
    nameservers = parse_nameservers(doc.get("nameservers"))

    last_changed = event_date(events, "last changed")
    transfer = event_date(events, "transfer")
    registration = event_date(events, "registration")
    expiration = event_date(events, "expiration")
    for value, what in ((last_changed, "last changed"), (transfer, "transfer"),
                        (registration, "registration"), (expiration, "expiration")):
        if value is not None:
            assert_zulu_timestamp(value, "%s eventDate" % what)

    return {
        "ldh_name": ldh.strip().rstrip(".").lower(),
        "registrar_iana_id": registrar["iana_id"],
        "registrar_name": registrar["name"],
        "events": events,
        "event_actions": tuple(sorted(events)),
        "registration_at": registration,
        "expiration_at": expiration,
        "last_changed_at": last_changed,
        "transfer_at": transfer,
        "statuses": flags["values"],
        "locks": flags["locks"],
        "transfer_locked": flags["transfer_locked"],
        "transfer_lock_setters": flags["transfer_lock_setters"],
        "pending_transfer": flags["pending_transfer"],
        "pending_statuses": flags["pending"],
        "nameservers": nameservers,
    }


def rdap_digest(parsed):
    """A digest over the normalized RDAP facts, excluding anything registry-specific.

    Compared: ldhName, registrar IANA id, the four timestamps, sorted statuses, sorted
    nameservers. Excluded: key order, event order, `notices` and `rdapConformance`
    boilerplate, `secureDNS`, the redaction block, registrar display name, and the
    `last update of RDAP database` event, which moves on every request and would make two
    validators fetching seconds apart disagree about an unchanged domain.
    """
    canonical = json.dumps({
        "ldh": parsed["ldh_name"],
        "registrar": parsed["registrar_iana_id"],
        "registration": parsed["registration_at"],
        "expiration": parsed["expiration_at"],
        "last_changed": parsed["last_changed_at"],
        "transfer": parsed["transfer_at"],
        "statuses": list(parsed["statuses"]),
        "nameservers": list(parsed["nameservers"]),
    }, sort_keys=True, separators=(",", ":"))
    return _sha256_hex(canonical)


# ======================================================================================
# 3. Two-resolver DoH TXT corroboration
# ======================================================================================
#
# MEASURED 2026-08-25, and the reason this function exists. Cloudflare and Google return
# the same TXT records formatted differently on four axes, none of which carry meaning:
#
#   axis            Cloudflare                    Google
#   TXT quoting     "v=spf1 -all", 13 bytes       v=spf1 -all, 11 bytes
#   TTL             58                            300
#   Comment         absent                        "Response from 173.245.58.162."
#   Question name   example.com                   example.com.
#
# The last row is not in the fixture manifest's note and was found while reading the
# captures: Cloudflare omits the root label and Google keeps it. Any of the four makes a
# byte-for-byte comparison report that two agreeing resolvers disagree, which escalates
# to [EXTERNAL] and stalls a transfer that was fine.
#
# Cloudflare returns HTTP 400 without an explicit Accept: application/dns-json header and
# Google needs no such header, so the header is sent to both, always.

DOH_CLOUDFLARE = "cloudflare"
DOH_GOOGLE = "google"

DOH_ENDPOINTS = {
    DOH_CLOUDFLARE: "https://cloudflare-dns.com/dns-query",
    DOH_GOOGLE: "https://dns.google/resolve",
}

#: Sent to both resolvers on every request. Cloudflare 400s without it.
DOH_HEADERS = {"Accept": "application/dns-json"}

DNS_RCODE_NOERROR = 0
DNS_RCODE_SERVFAIL = 2
DNS_RCODE_NXDOMAIN = 3
DNS_RCODE_REFUSED = 5

#: Returned by `classify_proof` when the name exists and the TXT set does not hold the
#: token. Distinct from NXDOMAIN: the name is there, the proof is not there yet.
PROOF_ABSENT = "PROOF_ABSENT"
PROOF_FOUND = "PROOF_FOUND"
PROOF_NAME_MISSING = "PROOF_NAME_MISSING"


def doh_txt_url(resolver, name):
    """Build the DoH JSON query URL for a TXT lookup.

    The name is validated by `normalize_domain`, which allows the underscore that a
    control-proof label needs and rejects everything that would need escaping, so no
    percent-encoding is performed and none is required.
    """
    _require_text(resolver, "resolver")
    endpoint = DOH_ENDPOINTS.get(resolver.lower())
    if endpoint is None:
        raise expected("unknown DoH resolver %r" % resolver,
                       "expected one of %s" % ", ".join(sorted(DOH_ENDPOINTS)))
    return "%s?name=%s&type=TXT" % (endpoint, normalize_domain(name))


def normalize_dns_name(name):
    """Lowercase a DNS name and drop the root label, so example.com. == example.com."""
    _require_text(name, "dns name")
    return name.strip().rstrip(".").lower()


def normalize_txt_value(raw):
    """One DoH `data` field to the RFC 1035 decoded character-string.

    Three presentation forms occur across resolvers, and all three normalize to the same
    value:

        v=spf1 -all              unquoted, already decoded      -> verbatim
        "v=spf1 -all"            one quoted character-string    -> quotes removed
        "chunk1" "chunk2"        several quoted chunks          -> concatenated, no glue

    The concatenation with no separator is what RFC 1035 section 3.3.14 requires of a
    client: a value over 255 octets is transmitted as several character-strings and the
    client joins them. A resolver that reports the same long value already joined gives
    `chunk1chunk2`, which matches.

    One form is deliberately not handled, and it cannot be: a bare unquoted
    `chunk1 chunk2`. That is byte-identical to a single character-string that legitimately
    contains a space, which is exactly what an SPF record is, so no rule can tell them
    apart. `assert_proof_token_shape` closes the gap from the other end by requiring a
    control-proof token to be whitespace-free and to fit in one character-string, which
    makes the ambiguous form unreachable for the value settlement depends on.
    """
    _require_text(raw, "TXT data")
    if not raw:
        # A zero-length character-string is legal DNS and is still absence. Letting it
        # through would let two resolvers "agree" on an empty proof.
        raise external("TXT data is empty")
    if not raw.startswith('"'):
        return raw
    chunks = []
    current = []
    index = 0
    length = len(raw)
    inside = False
    while index < length:
        char = raw[index]
        if not inside:
            if char == '"':
                inside = True
                current = []
            elif char in " \t":
                pass  # separator between quoted character-strings
            else:
                raise external("TXT data has an unquoted character outside a chunk",
                               raw[:80])
            index += 1
            continue
        if char == "\\" and index + 1 < length:
            nxt = raw[index + 1]
            if nxt in '"\\':
                current.append(nxt)
                index += 2
                continue
            if (nxt.isdigit() and index + 3 < length
                    and raw[index + 2].isdigit() and raw[index + 3].isdigit()):
                # RFC 1035 section 5.1 \DDD decimal escape. Decoding it means one resolver
                # emitting \065 and another emitting A are read as agreeing.
                code = int(raw[index + 1:index + 4])
                if code > 255:
                    raise external("TXT data has an out-of-range decimal escape",
                                   raw[index:index + 4])
                current.append(chr(code))
                index += 4
                continue
            current.append(nxt)
            index += 2
            continue
        if char == '"':
            chunk = "".join(current)
            if len(chunk.encode("utf-8")) > TXT_CHUNK_LIMIT:
                raise external("TXT character-string exceeds %d octets" % TXT_CHUNK_LIMIT,
                               "%d octets" % len(chunk.encode("utf-8")))
            chunks.append(chunk)
            inside = False
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    if inside:
        raise external("TXT data has an unterminated quoted chunk", raw[:80])
    if not chunks:
        raise external("TXT data is quoted but holds no chunk", raw[:80])
    joined = "".join(chunks)
    if not joined:
        raise external("TXT data decodes to an empty value", raw[:80])
    return joined


class DohObservation(object):
    """One resolver's answer, normalized. Never says "no proof, therefore delivered"."""

    def __init__(self, resolver, dns_status, qname, values, nxdomain, cname_hops):
        self.resolver = resolver
        self.dns_status = dns_status
        self.qname = qname
        self.values = tuple(values)          # normalized, sorted, TXT only, Answer only
        self.nxdomain = bool(nxdomain)
        self.cname_hops = int(cname_hops)
        self.has_answer = bool(values)

    def __repr__(self):
        return ("DohObservation(%r, dns_status=%r, qname=%r, values=%r, nxdomain=%r)"
                % (self.resolver, self.dns_status, self.qname, self.values, self.nxdomain))


def parse_doh(status, raw, resolver="unknown"):
    """Parse a DoH JSON response into a normalized observation.

    NXDOMAIN is served with HTTP 200 and no `Answer` key at all, so HTTP success proves
    nothing here. A missing `Answer` and a `Status: 3` are both represented, and neither
    is a success value: `values` is empty in both cases and `classify_proof` turns that
    into an explicit failed-proof or [EXTERNAL] verdict.
    """
    if not isinstance(status, int):
        raise expected("HTTP status must be an int", type(status).__name__)
    if status == 400:
        # Cloudflare's documented behaviour without Accept: application/dns-json. Google
        # needs no header, so a 400 from one resolver and a 200 from the other is the
        # exact shape of a dropped header rather than of a broken resolver.
        raise external(
            "DoH returned 400, which is what Cloudflare answers when the "
            "Accept: application/dns-json header is absent",
            resolver)
    if status == 429:
        raise transient("DoH rate limited", resolver)
    if status == 403:
        raise external("DoH refused the request with 403", resolver)
    if status != 200:
        raise external("unexpected DoH HTTP status", "HTTP %d from %s" % (status, resolver))

    doc = _decode_json(raw, "DoH (%s)" % resolver, MAX_DOH_BYTES)
    if not isinstance(doc, dict):
        raise external("DoH body is not a JSON object", type(doc).__name__)

    dns_status = doc.get("Status")
    if not isinstance(dns_status, int):
        raise external("DoH response has no integer Status", resolver)

    questions = doc.get("Question")
    qname = None
    if isinstance(questions, list) and questions and isinstance(questions[0], dict):
        candidate = questions[0].get("name")
        if isinstance(candidate, str) and candidate.strip():
            qname = normalize_dns_name(candidate)
    if qname is None:
        raise external("DoH response has no Question name", resolver)

    if dns_status == DNS_RCODE_NXDOMAIN:
        # Status 3 with HTTP 200 and no Answer key. The name does not exist, which is a
        # different statement from "the name exists and the proof is not on it".
        return DohObservation(resolver, dns_status, qname, (), True, 0)
    if dns_status in (DNS_RCODE_SERVFAIL, DNS_RCODE_REFUSED):
        raise external("DoH resolver returned rcode %d" % dns_status, resolver)
    if dns_status != DNS_RCODE_NOERROR:
        raise external("DoH resolver returned unexpected rcode %d" % dns_status, resolver)

    answers = doc.get("Answer")
    if answers is None:
        # NOERROR with no Answer is NODATA: the name exists, the TXT set does not.
        return DohObservation(resolver, dns_status, qname, (), False, 0)
    if not isinstance(answers, list):
        raise external("DoH Answer is not an array", resolver)

    # Only `Answer` is read. `Authority` and `Additional` are never a proof source, per
    # PRD section 2, because either can be populated by a delegation the seller controls.
    values = []
    cname_hops = 0
    for record in answers:
        if not isinstance(record, dict):
            raise external("DoH answer record is not an object", resolver)
        rtype = record.get("type")
        if rtype == DNS_TYPE_CNAME:
            cname_hops += 1
            if cname_hops > MAX_CNAME_HOPS:
                raise external("DoH answer exceeds %d CNAME hops" % MAX_CNAME_HOPS,
                               resolver)
            continue
        if rtype != DNS_TYPE_TXT:
            continue
        data = record.get("data")
        if not isinstance(data, str):
            raise external("DoH TXT record has no string data", resolver)
        values.append(normalize_txt_value(data))
    return DohObservation(resolver, dns_status, qname, tuple(sorted(values)), False,
                          cname_hops)


# ======================================================================================
# 4. Control-proof normalization
# ======================================================================================

#: What the two resolvers are compared on, and what is thrown away first. This list is the
#: specification; `corroborate` and `canonical_control_proof` implement it and
#: `test_rdap.py` asserts each line.
PROOF_COMPARED = (
    "the DNS rcode, which must be NOERROR from both",
    "the query name, lowercased with the root label dropped",
    "the set of TXT character-string values from Answer only, RFC 1035 decoded, sorted",
)
PROOF_EXCLUDED = (
    "TTL, because each resolver reports its own remaining cache time, 58 against 300 in "
    "the captures, and neither is a fact about the record",
    "the Comment field, which Google uses to name the answering resolver IP and "
    "Cloudflare omits entirely, so hashing it guarantees disagreement",
    "literal quoting of TXT character-strings, present on Cloudflare and absent on "
    "Google, worth 2 bytes per record and no meaning",
    "the trailing root label on the query name, kept by Google and dropped by Cloudflare",
    "record order within Answer, which no resolver promises to preserve",
    "the Authority and Additional sections, which are never a proof source",
    "the TC, RD, RA, AD and CD header flags, which describe the transport and the "
    "resolver's own DNSSEC posture rather than the record",
    "HTTP response headers and body length",
)


def assert_proof_token_shape(token):
    """A control-proof token must be one whitespace-free character-string.

    This is what makes `normalize_txt_value`'s one unhandled presentation form
    unreachable for the value money depends on. A token with a space could not be
    distinguished from a multi-chunk value that a resolver joined with spaces, and a token
    over 255 octets would have to be multi-chunk. Both are rejected at deal creation
    instead of becoming an ambiguous comparison at settlement.
    """
    _require_text(token, "proof token")
    if not token:
        raise expected("proof token is empty")
    if len(token.encode("utf-8")) > MAX_PROOF_TOKEN_BYTES:
        raise expected("proof token exceeds %d octets, so it cannot be a single TXT "
                       "character-string" % MAX_PROOF_TOKEN_BYTES,
                       "%d octets" % len(token.encode("utf-8")))
    for char in token:
        if char.isspace() or char in '"\\':
            raise expected("proof token contains %r, which is ambiguous across resolver "
                           "presentation formats" % char, token[:60])
    return token


def canonical_control_proof(qname, values):
    """The canonical string two validators must agree on, byte for byte.

    Built only from what `PROOF_COMPARED` names. JSON with sorted keys and no whitespace
    is used rather than an ad hoc join so that a value containing the separator cannot
    forge a different tuple with the same canonical form.
    """
    return json.dumps({
        "qname": normalize_dns_name(qname),
        "txt": sorted(values),
    }, sort_keys=True, separators=(",", ":"))


def control_proof_digest(qname, values):
    """sha256 hex of `canonical_control_proof`. This is `dns_proof_digest` on chain."""
    return _sha256_hex(canonical_control_proof(qname, values))


def commitment_digest(token):
    """sha256 hex of a validated proof token, for comparison to `buyer_proof_commitment`."""
    return _sha256_hex(assert_proof_token_shape(token))


class Corroboration(object):
    """The two-resolver verdict. `agreed` is never True on absence of any kind.

    This is the one result object in the module rather than an exception, because the
    contract records the disagreement on chain before it reverts, and an exception would
    leave nothing to record.
    """

    def __init__(self, observations, agreed, tag=None, reason=None):
        self.observations = tuple(observations)
        self.agreed = bool(agreed)
        self.tag = tag
        self.reason = reason
        first = self.observations[0] if self.observations else None
        self.qname = first.qname if first is not None else None
        self.values = first.values if (agreed and first is not None) else ()
        self.digest = (control_proof_digest(self.qname, self.values)
                       if self.agreed and self.qname else None)
        self.compared = PROOF_COMPARED
        self.excluded = PROOF_EXCLUDED

    def require_agreement(self):
        if not self.agreed:
            raise Refusal(self.tag or TAG_TRANSIENT,
                          self.reason or "resolvers do not agree")
        return self

    def __repr__(self):
        return ("Corroboration(agreed=%r, tag=%r, values=%r)"
                % (self.agreed, self.tag, self.values))


def corroborate(*observations):
    """Require every resolver to agree on the normalized proof, and say why if they do not.

    Disagreement is [TRANSIENT], never a delivery failure and never a delivery: PRD
    section 2 says conflicting answers revert as [TRANSIENT], and PRD section 7 lists
    "sources disagree" and "DNS propagation incomplete" there. One resolver seeing the
    token is not delivery, so a single observation is refused outright rather than treated
    as unanimous.
    """
    if len(observations) < 2:
        return Corroboration(observations, False, TAG_TRANSIENT,
                             "corroboration needs at least two independent resolvers, "
                             "got %d" % len(observations))
    for obs in observations:
        if not isinstance(obs, DohObservation):
            raise expected("corroborate takes DohObservation values",
                           type(obs).__name__)

    if any(obs.nxdomain for obs in observations):
        names = ", ".join(o.resolver for o in observations if o.nxdomain)
        if all(obs.nxdomain for obs in observations):
            return Corroboration(observations, False, TAG_EXTERNAL,
                                 "every resolver returned NXDOMAIN, so the name does not "
                                 "exist and nothing was observed")
        return Corroboration(observations, False, TAG_TRANSIENT,
                             "NXDOMAIN from %s but not from the others, which is "
                             "incomplete propagation, not a verdict" % names)

    if not all(obs.has_answer for obs in observations):
        silent = ", ".join(o.resolver for o in observations if not o.has_answer)
        return Corroboration(observations, False, TAG_EXTERNAL,
                             "no TXT Answer from %s, so there is nothing to corroborate"
                             % silent)

    names = set(obs.qname for obs in observations)
    if len(names) != 1:
        return Corroboration(observations, False, TAG_TRANSIENT,
                             "resolvers answered different query names: %s"
                             % ", ".join(sorted(names)))

    canonical = set(canonical_control_proof(obs.qname, obs.values)
                    for obs in observations)
    if len(canonical) != 1:
        detail = "; ".join("%s=%s" % (o.resolver, ",".join(o.values))
                           for o in observations)
        return Corroboration(observations, False, TAG_TRANSIENT,
                             "resolvers returned different normalized TXT sets, so the "
                             "proof is not corroborated: %s" % detail[:300])
    return Corroboration(observations, True)


def classify_proof(corroboration, expected_token):
    """Is the corroborated TXT set carrying the expected token?

    Returns one of `PROOF_FOUND`, `PROOF_ABSENT` or `PROOF_NAME_MISSING` together with the
    tag a refusal would carry, so the caller can tell "the name does not exist" from "the
    name exists and the token is not on it yet" from "the token is there". A proof that
    cannot be found is not a proof that failed, and neither is delivery.
    """
    assert_proof_token_shape(expected_token)
    if not isinstance(corroboration, Corroboration):
        raise expected("classify_proof takes a Corroboration",
                       type(corroboration).__name__)
    if not corroboration.agreed:
        if any(obs.nxdomain for obs in corroboration.observations):
            return {"outcome": PROOF_NAME_MISSING, "tag": corroboration.tag,
                    "reason": corroboration.reason}
        return {"outcome": PROOF_ABSENT, "tag": corroboration.tag,
                "reason": corroboration.reason}
    if expected_token in corroboration.values:
        return {"outcome": PROOF_FOUND, "tag": None,
                "reason": None, "digest": corroboration.digest}
    return {"outcome": PROOF_ABSENT, "tag": TAG_TRANSIENT,
            "reason": "both resolvers agree on the TXT set and the expected token is not "
                      "in it, which is an absent proof and may be incomplete propagation"}


# ======================================================================================
# Injected-fetch helpers. The only code here that touches a network, and only through the
# callable the caller passes in.
# ======================================================================================


def _call_fetch(fetch, url, headers):
    if not callable(fetch):
        raise expected("fetch must be callable", type(fetch).__name__)
    try:
        response = fetch(url, headers=headers)
    except Refusal:
        raise
    except Exception as exc:
        raise transient("fetch raised for %s" % url[:120], str(exc)[:160])
    status = getattr(response, "status", None)
    if status is None:
        # `.status`, not `.status_code`. Named loudly because the published GenLayer docs
        # example uses the other one and the failure is silent otherwise.
        raise expected("fetch response has no .status attribute; GenVM returns .status, "
                       "not .status_code", type(response).__name__)
    return int(status), getattr(response, "body", b"")


def fetch_bootstrap(fetch, url="https://data.iana.org/rdap/dns.json"):
    """Fetch and parse the IANA bootstrap. Called once per deal, not once per check."""
    status, raw = _call_fetch(fetch, url, None)
    if status == 429:
        raise transient("IANA bootstrap rate limited")
    if status != 200:
        raise external("IANA bootstrap is unavailable", "HTTP %d" % status)
    doc = _decode_json(raw, "IANA bootstrap", MAX_BOOTSTRAP_BYTES)
    bootstrap_services(doc)
    return doc


def fetch_rdap_domain(fetch, base, domain):
    """Fetch and parse one authoritative RDAP domain response."""
    url = rdap_domain_url(base, domain)
    status, raw = _call_fetch(fetch, url, {"Accept": "application/rdap+json"})
    return parse_rdap_domain(status, raw)


def fetch_doh_txt(fetch, resolver, name):
    """Fetch one resolver's TXT answer, always sending the Accept header.

    Sent to both resolvers unconditionally. Cloudflare 400s without it and Google ignores
    it, so there is no branch here that could drop it for one resolver and not the other.
    """
    url = doh_txt_url(resolver, name)
    status, raw = _call_fetch(fetch, url, dict(DOH_HEADERS))
    return parse_doh(status, raw, resolver=resolver)


def fetch_corroborated_txt(fetch, name, resolvers=(DOH_CLOUDFLARE, DOH_GOOGLE)):
    """Fetch every resolver and corroborate. The whole DNS side of a check, in one call."""
    observations = [fetch_doh_txt(fetch, resolver, name) for resolver in resolvers]
    return corroborate(*observations)

# --- CONVEYANCE-RDAP SPLICE END ---

# ======================================================================================
# Contract constants
# ======================================================================================

#: The four taxonomy tags, aliased so a reader of this half never has to remember that the
#: spliced region calls them TAG_*. Same four strings, same meanings as in every other
#: contract in this set.
ERROR_EXPECTED = TAG_EXPECTED     # caller input, wrong actor, wrong state, inside a window
ERROR_EXTERNAL = TAG_EXTERNAL     # a source misbehaved: empty, non-200, throttled, over a cap
ERROR_TRANSIENT = TAG_TRANSIENT   # validators disagree, authority moved, propagation incomplete
ERROR_LLM = TAG_LLM_ERROR         # unreachable here, and named so its absence is visible

#: Top-level callables the spliced region must define. Cross-checked by the splice guard, so
#: a copy that silently drops a function fails a script rather than a live deal.
EMBEDDED_FUNCTION_COUNT = 40

#: RFC 9224. Fetched fresh on every delivery check rather than trusted from storage, so a
#: registry that moves its RDAP service cannot be settled against a stale base.
IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json"

#: The two control-proof record names. Both are derived from the deal, never supplied.
SELLER_PROOF_LABEL = "_conveyance-seller"
BUYER_PROOF_LABEL = "_conveyance-buyer"
PROOF_VERSION = "v1"

MAX_ID_CHARS = 64
MAX_REGISTRAR_ID_CHARS = 12
MIN_NAMESERVERS = 2
MAX_NAMESERVERS = 8
MAX_NAMESERVER_CHARS = 253
COMMITMENT_CHARS = 64

#: An engineering control, not an economic opinion. This contract has had no adversarial
#: review at scale, and a ceiling bounds what a bug in it can cost. Raise it deliberately.
MAX_DEAL_VALUE_WEI = 100 * 10 ** 18

#: 48 hours for the seller to arm, 10 days to complete the transfer, 72 hours for the buyer
#: to inspect before anyone may finalize. The transfer window is the ICANN inter-registrar
#: transfer period plus room for a losing registrar's five-day hold.
ACCEPT_WINDOW_SECONDS = 172800
TRANSFER_WINDOW_SECONDS = 864000
INSPECTION_WINDOW_SECONDS = 259200

#: Minimum gap between two permissionless delivery checks on one deal. RDAP services and
#: both DoH resolvers rate limit per source, and every validator fetches independently, so an
#: uncapped poll is a way to get this contract's whole validator set throttled.
CHECK_INTERVAL_SECONDS = 300

ST_OFFERED = "OFFERED"
ST_LOCKED = "LOCKED"
ST_VERIFIED = "VERIFIED"
ST_REVERSED = "REVERSED"
ST_RELEASED = "RELEASED"
ST_REFUNDED = "REFUNDED"

#: The two states in which a deal holds no money and can no longer move any. Both are
#: terminal: `closed_at` is set, the escrow has already gone to one party or the other, and
#: every method that could act on the deal refuses it. This is a tuple rather than a set so
#: that it is immutable at module scope, which the splice guard requires of module state.
CLOSED_STATES = (ST_RELEASED, ST_REFUNDED)

#: What one `check_transfer` observed. Recorded on the deal whether or not it advanced the
#: state, because a check that leaves no record is indistinguishable from a check never run.
OUT_VERIFIED = "VERIFIED"
OUT_PENDING_TRANSFER = "PENDING_TRANSFER"
OUT_AWAITING_TRANSFER = "AWAITING_TRANSFER"
OUT_AWAITING_DELEGATION = "AWAITING_DELEGATION"
OUT_AWAITING_DNS = "AWAITING_DNS"
OUT_SUSPENDED = "SUSPENDED"
OUT_REVERSED = "REVERSED"

STATUS_PENDING_DELETE = "pending delete"


# ======================================================================================
# Adapters. The only two lines in this file that leave the machine or move value.
# ======================================================================================

def _fetch(url, headers=None):
    """Fail-closed sentinel; live fetch adapters are defined inside EP blocks.

    Two parameters, because that is the contract `_call_fetch` in the region expects:
    `fetch(url, headers=headers)`. `gl.nondet.web.request` has no `timeout` keyword, and its
    response exposes `.status`. It is `.status`, not `.status_code`. The published SDK
    example is wrong about this, and the region raises a named refusal saying so if it ever
    receives a response object without it.
    """
    raise RuntimeError("network fetch attempted outside an equivalence-principle block")


@gl.evm.contract_interface
class _Payee:
    """The minimum interface needed to send value to an address."""

    class View:
        pass

    class Write:
        pass


def _flatten_rdap(parsed):
    """The parsed RDAP facts as a flat dict of strings and bools.

    `strict_eq` compares the block's return value across validators, so every field has to
    serialise the same way for all of them. Tuples, nested dicts and None each have more than
    one plausible encoding, and none of those is worth discovering on a live deal. Absent
    values become the empty string rather than None so that "the registry published no
    transfer event" and "a transfer event whose date would not parse" cannot both arrive as
    null: the second one raises inside the region and never reaches here.

    `registrar_name` is carried for display and is deliberately not part of `digest`.
    Registrars rename, resell and rebrand, and a display string moving is not a transfer.
    """
    locks = parsed["locks"]
    return {
        "ldh_name": str(parsed["ldh_name"]),
        "registrar_id": str(parsed["registrar_iana_id"]),
        "registrar_name": str(parsed["registrar_name"] or ""),
        "registration_at": str(parsed["registration_at"] or ""),
        "expiration_at": str(parsed["expiration_at"] or ""),
        "last_changed_at": str(parsed["last_changed_at"] or ""),
        "transfer_at": str(parsed["transfer_at"] or ""),
        "statuses": ",".join(parsed["statuses"]),
        "nameservers": ",".join(parsed["nameservers"]),
        "transfer_locked": bool(parsed["transfer_locked"]),
        "transfer_lock_setters": ",".join(parsed["transfer_lock_setters"]),
        "pending_transfer": bool(parsed["pending_transfer"]),
        "pending_statuses": ",".join(parsed["pending_statuses"]),
        "hold_locked": bool(locks["hold"]["locked"]),
        "hold_setters": ",".join(locks["hold"]["setters"]),
        "digest": str(rdap_digest(parsed)),
    }


def _flatten_proof(corroboration, verdict):
    """One two-resolver TXT verdict as a flat dict.

    `values` is the corroborated set joined with commas, and it is only ever non-empty when
    both resolvers agreed. The raw response bodies are not here and must never be: the two
    resolvers format the same records differently on four measured axes, so the only thing
    two validators can be asked to agree on is the normalized record set.
    """
    return {
        "proof_outcome": str(verdict["outcome"]),
        "proof_tag": str(verdict["tag"] or ""),
        "proof_reason": str(verdict["reason"] or "")[:300],
        "proof_digest": str(verdict.get("digest") or ""),
        "proof_qname": str(corroboration.qname or ""),
        "proof_values": ",".join(sorted(corroboration.values)),
        "proof_agreed": bool(corroboration.agreed),
        "proof_resolvers": ",".join(o.resolver for o in corroboration.observations),
    }


# ======================================================================================
# Storage
# ======================================================================================

@allow_storage
@dataclass
class Deal:
    """One escrowed transfer. Flat on purpose.

    Every field is a str, a bool or a u256. `TreeMap[str, Deal]` is already one generic
    deep, and a nested generic inside the record would not survive GenVM storage, so the
    baseline and the latest observation are prefixed field families rather than sub-records.

    Three snapshots of the same domain live here at once, and keeping them apart is the
    point. `baseline_*` is what the registry said when the escrow was accepted, and it is
    what "the registrar changed" is measured against. `last_check_*` is the most recent
    observation, recorded whatever it showed. `delivered_*` is frozen at the moment the
    contract accepted delivery, and it is what `settle` re-verifies against so that a
    delivery cannot be settled twice against two different transfer events.
    """

    deal_id: str
    buyer: Address
    seller: Address
    domain: str
    tld: str
    rdap_base: str
    target_registrar_id: str
    target_nameservers: str
    seller_proof_name: str
    seller_proof_token: str
    buyer_proof_name: str
    buyer_proof_commitment: str
    buyer_proof_token: str
    escrow: u256
    state: str

    opened_at: str
    accept_deadline: str
    armed_at: str
    transfer_deadline: str
    verified_at: str
    inspection_deadline: str
    closed_at: str

    baseline_registrar_id: str
    baseline_registrar_name: str
    baseline_nameservers: str
    baseline_statuses: str
    baseline_transfer_at: str
    baseline_last_changed_at: str
    baseline_digest: str
    baseline_client_transfer_locked: bool

    last_check_at: str
    last_check_outcome: str
    last_check_note: str
    last_check_registrar_id: str
    last_check_nameservers: str
    last_check_statuses: str
    last_check_transfer_at: str
    last_check_digest: str
    last_proof_outcome: str
    last_proof_values: str
    checks: u256

    delivered_registrar_id: str
    delivered_transfer_at: str
    delivered_digest: str
    delivered_proof_digest: str

    paid_to_seller: u256
    returned_to_buyer: u256


class Conveyance(gl.Contract):
    deal_ids: DynArray[str]
    deals: TreeMap[str, Deal]
    domain_to_deal: TreeMap[str, str]
    total_escrowed: u256
    total_released: u256
    total_refunded: u256
    deals_opened: u256
    checks_run: u256
    deliveries_verified: u256
    reversals_recorded: u256

    def __init__(self):
        self.total_escrowed = u256(0)
        self.total_released = u256(0)
        self.total_refunded = u256(0)
        self.deals_opened = u256(0)
        self.checks_run = u256(0)
        self.deliveries_verified = u256(0)
        self.reversals_recorded = u256(0)

    # ------------------------------------------------------------------
    # Time. Every timestamp this contract compares is produced by `_require_now` or
    # `_add_seconds`, in the same fixed-width shape, which is what makes string
    # comparison valid. Registry timestamps are never compared against these.
    # ------------------------------------------------------------------

    def _require_now(self) -> str:
        """The block time, or a revert. Never a default.

        A missing or short datetime would make every deadline the empty string, and an empty
        deadline compares as never reached, which fails closed for expiry but silently stores
        a deal whose windows can never open. Tagged EXTERNAL rather than EXPECTED because the
        clock is a source the caller does not control.
        """
        raw = str(gl.message_raw.get("datetime", ""))
        if len(raw) < 19:
            raise gl.vm.UserError(
                "%s the block datetime is unusable (%r), so no deadline on this deal could "
                "be computed" % (ERROR_EXTERNAL, raw[:40]))
        return raw

    def _at_or_after(self, now: str, deadline: str) -> bool:
        """True when `now` is at or past `deadline`.

        Valid only because both sides are produced by `_require_now` or `_add_seconds` in the
        same "YYYY-MM-DDTHH:MM:SSZ" shape. An empty deadline is never reached, so a deal that
        somehow stored one cannot be timed out by accident.
        """
        if now == "" or deadline == "":
            return False
        return now >= deadline

    def _add_seconds(self, iso: str, seconds: int) -> str:
        """Add seconds to an ISO instant with no date library. Same code as Recourse.

        GenVM has no `datetime`, and three deadlines decide who gets the escrow, so this is
        written out rather than approximated with day arithmetic.
        """
        if len(iso) < 19:
            return ""
        year = int(iso[0:4])
        month = int(iso[5:7])
        day = int(iso[8:10])
        hour = int(iso[11:13])
        minute = int(iso[14:16])
        second = int(iso[17:19])

        total = second + int(seconds)
        second = total % 60
        total = total // 60
        minute = minute + total
        total = minute // 60
        minute = minute % 60
        hour = hour + total
        total = hour // 24
        hour = hour % 24
        day = day + total

        days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        if (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0):
            days_in_month[1] = 29
        while day > days_in_month[month - 1]:
            day = day - days_in_month[month - 1]
            month = month + 1
            if month > 12:
                month = 1
                year = year + 1
                days_in_month = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
                if (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0):
                    days_in_month[1] = 29
        return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (year, month, day, hour, minute, second)

    # ------------------------------------------------------------------
    # Deterministic input validation. Nothing here reaches the network.
    # ------------------------------------------------------------------

    def _reject(self, reason: str) -> None:
        raise gl.vm.UserError("%s %s" % (ERROR_EXPECTED, reason))

    def _reject_transient(self, reason: str) -> None:
        """Nothing was decided, so a retry is the answer. Kept next to `_reject` so that the
        difference between "a rule fired" and "try again" stays a one-word difference at the
        call site rather than a hand-built string.
        """
        raise gl.vm.UserError("%s %s" % (ERROR_TRANSIENT, reason))

    def _require_id(self, deal_id: str) -> str:
        text = str(deal_id or "").strip()
        if text == "" or len(text) > MAX_ID_CHARS:
            self._reject("deal_id must be 1 to %d characters, got %d"
                         % (MAX_ID_CHARS, len(text)))
        for char in text:
            if not (char.isalnum() or char in "-_."):
                self._reject("deal_id may hold letters, digits, dot, dash and underscore "
                             "only; %r is not one of those" % char)
        return text

    def _require_domain(self, domain: str) -> str:
        """The caller's domain as an ASCII LDH name, or a revert naming what was wrong.

        `normalize_domain` in the spliced region does the structural work and refuses
        non-ASCII rather than guessing at IDNA, so an internationalised name has to arrive
        already punycoded as its xn-- A-label. That is stated in the revert rather than
        silently encoded here: two validators that disagreed about an encoding would be
        looking up two different domains and would still agree with each other about it.
        """
        try:
            return normalize_domain(str(domain or ""))
        except Refusal as exc:
            raise gl.vm.UserError(str(exc))

    def _require_registrar_id(self, value: str) -> str:
        text = str(value or "").strip()
        if text == "" or len(text) > MAX_REGISTRAR_ID_CHARS:
            self._reject("target_registrar_id must be 1 to %d characters, got %d"
                         % (MAX_REGISTRAR_ID_CHARS, len(text)))
        if not text.isdigit():
            self._reject("target_registrar_id must be the numeric IANA registrar id, "
                         "got %r. The registrar's name is not accepted, because two "
                         "registrars can trade under one brand and one brand can hold "
                         "several ids." % text[:40])
        return text

    def _require_nameservers(self, raw: str) -> str:
        """A JSON array of nameserver names as one canonical comma-joined string.

        A JSON array rather than a list because GenVM contract arguments carry no list type.
        Sorted, lowercased and de-duplicated so that the stored target and the observed set
        from `parse_nameservers` are comparable as strings.

        At least two, because an empty list would have to mean either "any delegation" or
        "no delegation at all" and there is no value that says which. A buyer who does not
        care about delegation is asking for a different deal than this contract settles.
        """
        text = str(raw or "").strip()
        if text == "":
            self._reject("target_nameservers must be a JSON array of at least %d names"
                         % MIN_NAMESERVERS)
        try:
            parsed = json.loads(text)
        except Exception:
            self._reject("target_nameservers must be valid JSON, got %r" % text[:80])
            return ""
        if not isinstance(parsed, list):
            self._reject("target_nameservers must be a JSON array, got %s"
                         % type(parsed).__name__)
        names = set()
        for entry in parsed:
            if not isinstance(entry, str) or not entry.strip():
                self._reject("every target nameserver must be a non-empty string")
            name = entry.strip().rstrip(".").lower()
            if len(name) > MAX_NAMESERVER_CHARS:
                self._reject("nameserver %r exceeds %d characters"
                             % (name[:60], MAX_NAMESERVER_CHARS))
            if "." not in name:
                self._reject("nameserver %r is not a dotted host name" % name[:60])
            for char in name:
                if not (char.isalnum() or char in "-."):
                    self._reject("nameserver %r holds a disallowed character %r"
                                 % (name[:60], char))
            names.add(name)
        if len(names) < MIN_NAMESERVERS:
            self._reject("target_nameservers needs at least %d distinct names, got %d"
                         % (MIN_NAMESERVERS, len(names)))
        if len(names) > MAX_NAMESERVERS:
            self._reject("target_nameservers holds %d names, over the %d cap"
                         % (len(names), MAX_NAMESERVERS))
        return ",".join(sorted(names))

    def _require_commitment(self, value: str) -> str:
        text = str(value or "").strip().lower()
        if len(text) != COMMITMENT_CHARS:
            self._reject("buyer_proof_commitment must be %d lowercase hex characters, got %d"
                         % (COMMITMENT_CHARS, len(text)))
        for char in text:
            if char not in "0123456789abcdef":
                self._reject("buyer_proof_commitment must be hex; %r is not" % char)
        return text

    def _require_address(self, value: str, label: str) -> Address:
        text = str(value or "").strip()
        if text == "":
            self._reject("%s is required" % label)
        if text.lower() == "0x" + "00" * 20:
            self._reject("%s must not be the zero address" % label)
        try:
            return Address(text)
        except Exception:
            self._reject("%s is not a 20-byte address: %r" % (label, text[:60]))
            raise

    def _proof_token(self, kind: str, deal_id: str, who: Address) -> str:
        """The control-proof token for one party, derived and never supplied.

        `v1;deal=<id>;seller=<address>` for the seller, and the buyer's is committed to as a
        digest at deal creation instead, because the buyer's token has to be unguessable: a
        seller who could predict it could publish the buyer's record themselves and forge the
        buyer's side of DNS control. The seller's token needs no secret, because publishing
        it under the domain already requires the control it proves.

        WHY THE ADDRESS IS LOWERCASED, WHICH IS NOT COSMETIC. `Address.as_hex` returns the EIP-55
        checksummed form, measured: a gltest account came back as
        `0x81b637d8fCD2C6da6359E6963113a1170de795e4`. This token is compared to a TXT value byte for
        byte, because `classify_proof` asks `expected_token in corroboration.values` and
        `canonical_control_proof` normalizes the query name but never the values. So whatever case
        is chosen here is the case the seller has to publish, exactly.

        Lower case is chosen for three reasons. It is what the interface already displays, so a
        seller who copies the line they are given can actually arm the deal, which was not true
        while this read `as_hex` directly. It is the safer thing to ask a human to put in a zone
        file, because a registrar's DNS panel that normalizes case would otherwise silently break
        the proof. And the buyer's side already committed to a lowercased address, so both tokens
        now carry one convention rather than two that have to be remembered separately.

        The failure this prevents was worse than a refusal. A token that is not in the TXT set is an
        absent proof, and an absent proof is tagged `[TRANSIENT]` with "may be incomplete
        propagation", so a case mismatch would have told the seller to keep waiting for a
        propagation that was never going to help.
        """
        token = "%s;deal=%s;%s=%s" % (PROOF_VERSION, deal_id, kind, who.as_hex.lower())
        try:
            return assert_proof_token_shape(token)
        except Refusal as exc:
            raise gl.vm.UserError(str(exc))

    def _proof_name(self, label: str, domain: str) -> str:
        try:
            return normalize_dns_name("%s.%s" % (label, domain))
        except Refusal as exc:
            raise gl.vm.UserError(str(exc))

    def _require_deal(self, deal_id: str) -> Deal:
        key = self._require_id(deal_id)
        if key not in self.deals:
            self._reject("no deal %r" % key[:64])
        return self.deals[key]

    def _require_state(self, deal: Deal, allowed, what: str) -> None:
        if deal.state not in allowed:
            self._reject("deal %s is %s; %s needs %s"
                         % (deal.deal_id, deal.state, what, " or ".join(allowed)))

    # ------------------------------------------------------------------
    # Value movement and error re-raising
    # ------------------------------------------------------------------

    def _pay(self, who: Address, amount: u256) -> None:
        if int(amount) <= 0:
            return
        _Payee(who).emit_transfer(value=amount)

    def _error_text(self, result) -> str:
        """The tagged refusal a consensus block marshalled back, or the empty string.

        A block that did not return a dict means the validators could not agree on the result
        itself, which is not the same as agreeing that a source failed, so it reads as
        TRANSIENT and retryable rather than resolving anything.

        Split out from `_raise_if_error` so that the one payable method can return a refusal
        where the other eleven raise it. Both callers get the same text; only the mechanism
        differs, which is what keeps the two paths from drifting apart.
        """
        if not isinstance(result, dict):
            return "%s validators did not agree on an observation; retry" % ERROR_TRANSIENT
        return str(result.get("error", ""))

    def _raise_if_error(self, result) -> None:
        """Turn a marshalled refusal back into a revert, tag intact."""
        message = self._error_text(result)
        if message != "":
            raise gl.vm.UserError(message)

    def _decline(self, message: str) -> str:
        """Refuse a payable call, return the escrow, and report why.

        `_reject` raises, which is right for the eleven methods that carry no value: the
        revert rolls storage back and there is nothing to hand back. `open_deal` cannot use
        it. This chain rolls storage back on a revert but does *not* return
        `gl.message.value`, which was measured on a live deployment rather than assumed. A
        refused payable call left its wei in the contract with no deal to claim it and no
        method able to move it out, and `ledger()` reported a balance above `held` for ever
        after. The worst case is not a typo: `[EXTERNAL]` means a registry did not answer and
        `[TRANSIENT]` means nothing was decided, so a buyer would have paid the full escrow
        for an outage and paid it again on every retry.

        The tag is carried through rather than flattened into one refusal word. `[EXPECTED]`
        and `[TRANSIENT]` mean different things to a caller deciding whether to try again,
        and a caller who has just been refused is exactly the caller who needs to know. A
        successful `open_deal` returns a sentence that starts with the deal id, so a return
        value starting with `[` means declined, escrow returned, nothing stored.
        """
        self._pay(gl.message.sender_address, u256(int(gl.message.value)))
        return message

    # ------------------------------------------------------------------
    # Consensus blocks. Every one is strict_eq: each field is a comparison over fetched
    # bytes, so a disagreement means two validators read different records and the only
    # correct outcome is a retryable revert, never a resolved payout.
    # ------------------------------------------------------------------

    def _rdap_block(self, domain: str) -> dict:
        """Resolve the registry from IANA and read the domain record. Used at deal creation.

        The bootstrap is fetched here rather than assumed because the base URL is what makes
        the RDAP answer authoritative, and a base supplied by a caller is a base a caller
        chose. This is also the only block that does not re-check a stored base, because
        there is not one yet.
        """
        def work():
            try:
                def ep_fetch(url, headers=None):
                    return gl.nondet.web.request(url, method="GET", headers=headers or {})
                bootstrap = fetch_bootstrap(ep_fetch, IANA_BOOTSTRAP_URL)
                base = registry_base_for_domain(bootstrap, domain)
                parsed = fetch_rdap_domain(ep_fetch, base, domain)
                observed = _flatten_rdap(parsed)
                observed["error"] = ""
                observed["base"] = str(base)
                return observed
            except Refusal as exc:
                return {"error": str(exc)}

        return gl.eq_principle.strict_eq(work)

    def _proof_block(self, proof_name: str, token: str) -> dict:
        """Two resolvers on one TXT name. Used when arming, where RDAP has nothing to say.

        Both resolvers are always asked, and both are always sent the `application/dns-json`
        Accept header, because Cloudflare answers 400 without it and Google ignores it. There
        is no branch in the region that could send it to one and not the other.
        """
        def work():
            try:
                def ep_fetch(url, headers=None):
                    return gl.nondet.web.request(url, method="GET", headers=headers or {})
                corroboration = fetch_corroborated_txt(ep_fetch, proof_name)
                verdict = classify_proof(corroboration, token)
                observed = _flatten_proof(corroboration, verdict)
                observed["error"] = ""
                return observed
            except Refusal as exc:
                return {"error": str(exc)}

        return gl.eq_principle.strict_eq(work)

    def _delivery_block(self, domain: str, base: str, proof_name: str, token: str) -> dict:
        """The whole delivery question in one round: IANA, RDAP, and both resolvers.

        One block rather than three, because the four fetches have to describe the same
        instant. Split across blocks, a domain could pass the RDAP half of one round and the
        DNS half of another, and neither round would ever have seen a delivered domain.

        The stored base is re-derived from a fresh bootstrap rather than reused.
        `assert_base_still_authoritative` refuses TRANSIENT if the map moved, so authority
        cannot change under a deal between arming and settlement.

        A DNS disagreement is returned rather than raised. `classify_proof` hands back an
        outcome and the tag a refusal would have carried, which lets `check_transfer` write
        the disagreement onto the deal before deciding what to do about it. A raise here
        would revert the transaction and take the record with it.
        """
        def work():
            try:
                def ep_fetch(url, headers=None):
                    return gl.nondet.web.request(url, method="GET", headers=headers or {})
                bootstrap = fetch_bootstrap(ep_fetch, IANA_BOOTSTRAP_URL)
                fresh = assert_base_still_authoritative(bootstrap, domain, base)
                parsed = fetch_rdap_domain(ep_fetch, fresh, domain)
                observed = _flatten_rdap(parsed)
                corroboration = fetch_corroborated_txt(ep_fetch, proof_name)
                verdict = classify_proof(corroboration, token)
                observed.update(_flatten_proof(corroboration, verdict))
                observed["error"] = ""
                observed["base"] = str(fresh)
                return observed
            except Refusal as exc:
                return {"error": str(exc)}

        return gl.eq_principle.strict_eq(work)

    # ------------------------------------------------------------------
    # Delivery arithmetic, over an already-agreed observation. No network, no model.
    # ------------------------------------------------------------------

    def _suspension(self, observed: dict) -> str:
        """Why this domain is not deliverable right now, or the empty string.

        `clientHold` and `serverHold` are the two statuses that pull a domain out of the
        DNS root zone, and `pending delete` is the registry saying it is on the way out.
        Delete and update prohibitions are deliberately not here: `clientDeleteProhibited`
        is a protective lock that most well-run domains carry, and reading it as a
        suspension would refuse to deliver exactly the domains that are best looked after.
        """
        if bool(observed.get("hold_locked", False)):
            return "the registry reports a %s hold, which removes the domain from DNS" % (
                str(observed.get("hold_setters", "")) or "hold")
        pending = str(observed.get("pending_statuses", ""))
        for value in pending.split(","):
            if value.strip() == STATUS_PENDING_DELETE:
                return "the registry reports %r" % STATUS_PENDING_DELETE
        return ""

    def _transfer_is_newer(self, observed_transfer_at: str, baseline_transfer_at: str) -> bool:
        """Did a transfer event land after the one recorded at deal creation?

        Both operands come from the same registry's RDAP service for the same domain, which
        is what makes the string comparison sound. A cross-registrar transfer does not change
        the registry, so the fractional-second convention cannot change under a deal either.
        Comparing a registry timestamp against a block timestamp would not be sound, because
        `2026-08-26T01:00:00.024Z` sorts below `2026-08-26T01:00:00Z`, and this contract
        never does it.
        """
        if observed_transfer_at == "":
            return False
        if baseline_transfer_at == "":
            return True
        return observed_transfer_at > baseline_transfer_at

    def _classify_delivery(self, deal: Deal, observed: dict) -> dict:
        """One observation against one deal's terms. Pure, ordered, and total.

        The order is not cosmetic. Suspension first, because a held domain is not delivered
        whoever holds it. Pending transfer next, because it is the one state that is neither
        a failure nor a delivery and must never be read as either. Then the registrar, then
        the transfer event, then the delegation, then the buyer's DNS proof, because that is
        the order in which a real transfer completes and reporting the last unmet condition
        is more use to a caller than reporting the first.
        """
        suspended = self._suspension(observed)
        if suspended != "":
            return {"outcome": OUT_SUSPENDED, "note": suspended}

        if bool(observed.get("pending_transfer", False)):
            return {"outcome": OUT_PENDING_TRANSFER,
                    "note": "the registry reports %r, so a transfer is in flight and has "
                            "not completed" % STATUS_PENDING_TRANSFER}

        registrar = str(observed.get("registrar_id", ""))
        if registrar != deal.target_registrar_id:
            return {"outcome": OUT_AWAITING_TRANSFER,
                    "note": "the sponsoring registrar is IANA id %s, and this deal is for a "
                            "transfer to %s" % (registrar or "unknown",
                                                deal.target_registrar_id)}

        if not self._transfer_is_newer(str(observed.get("transfer_at", "")),
                                       deal.baseline_transfer_at):
            return {"outcome": OUT_AWAITING_TRANSFER,
                    "note": "the domain is at the target registrar but the registry has "
                            "published no transfer event later than the %s recorded when "
                            "this deal opened"
                            % (deal.baseline_transfer_at or "(none)")}

        nameservers = str(observed.get("nameservers", ""))
        if nameservers != deal.target_nameservers:
            return {"outcome": OUT_AWAITING_DELEGATION,
                    "note": "the domain delegates to %s, and this deal names %s"
                            % (nameservers or "(none)", deal.target_nameservers)}

        outcome = str(observed.get("proof_outcome", ""))
        if outcome != PROOF_FOUND:
            reason = str(observed.get("proof_reason", "")) or "the proof record is not there"
            return {"outcome": OUT_AWAITING_DNS,
                    "note": "%s %s" % (str(observed.get("proof_tag", "")) or ERROR_TRANSIENT,
                                       reason)}

        return {"outcome": OUT_VERIFIED,
                "note": "the registry reports the transfer to IANA id %s at %s, the "
                        "delegation matches, and both resolvers see the buyer's control "
                        "proof" % (registrar, str(observed.get("transfer_at", "")))}

    def _record_observation(self, deal: Deal, now: str, observed: dict,
                            verdict: dict) -> None:
        """Write what was seen onto the deal. Called on every check, whatever it showed.

        A check that only records success turns every other outcome into silence, and
        silence is what a stalled transfer and an unrun check look like from the outside.
        """
        deal.last_check_at = now
        deal.last_check_outcome = str(verdict["outcome"])
        deal.last_check_note = str(verdict["note"])[:400]
        deal.last_check_registrar_id = str(observed.get("registrar_id", ""))
        deal.last_check_nameservers = str(observed.get("nameservers", ""))
        deal.last_check_statuses = str(observed.get("statuses", ""))
        deal.last_check_transfer_at = str(observed.get("transfer_at", ""))
        deal.last_check_digest = str(observed.get("digest", ""))
        deal.last_proof_outcome = str(observed.get("proof_outcome", ""))
        deal.last_proof_values = str(observed.get("proof_values", ""))[:400]
        deal.checks = u256(int(deal.checks) + 1)

    # ==================================================================================
    # open_deal
    # ==================================================================================

    @gl.public.write.payable
    def open_deal(
        self,
        deal_id: str,
        domain: str,
        seller: str,
        target_registrar_id: str,
        target_nameservers: str,
        buyer_proof_commitment: str,
    ) -> str:
        """Escrow the price and record what the registry says about the domain today.

        This method never reverts on a refusal. It refunds and returns the reason, because
        this chain rolls storage back on a revert but keeps `gl.message.value`, so a reverting
        payable method charges the caller for being told no. `_decline` carries the reason,
        and a return value starting with `[` means the escrow came back and nothing was
        stored. Every other method in this contract raises instead, and should: none of them
        can be sent value.

        That is what makes the refusals after the first network call safe to have. A caller
        can rehearse the deterministic prefix with no value attached, but no rehearsal can
        promise what a registry will say a second later, and an `[EXTERNAL]` or `[TRANSIENT]`
        outcome is nobody's mistake. Those are the outcomes a refund exists for.

        `target_nameservers` is a JSON array because GenVM contract arguments carry no list
        type. `seller` is a plain string for the same reason every address in this project is:
        any 40-hex-character argument is coerced to an `Address` by the CLI, which would make
        a typo in a hex string indistinguishable from a deliberate address.

        `buyer_proof_commitment` is sha256 of a token only the buyer knows. It is a
        commitment and not the token itself so that the seller cannot publish the buyer's
        control record before the buyer does. The token is revealed to `check_transfer` once
        it is already public in DNS, which is why that method can stay permissionless.
        """
        # Every refusal between here and the first storage write is a refund, including the
        # ones raised inside the `_require_*` helpers and the ones marshalled back from the
        # network block. Catching at one place rather than converting nine call sites is
        # deliberate: a refusal added to this prefix later is refunded without anyone having
        # to remember to make it so. The block ends before the first write, so nothing can be
        # both refunded and stored.
        try:
            key = self._require_id(deal_id)
            name = self._require_domain(domain)
            registrar = self._require_registrar_id(target_registrar_id)
            nameservers = self._require_nameservers(target_nameservers)
            commitment = self._require_commitment(buyer_proof_commitment)

            buyer = gl.message.sender_address
            seller_address = self._require_address(seller, "seller")
            if seller_address == buyer:
                self._reject("seller must not be the buyer; an escrow with one party on both "
                             "sides settles nothing")

            escrow = int(gl.message.value)
            if escrow <= 0:
                self._reject("a deal needs an escrow; this call carried no value")
            if escrow > MAX_DEAL_VALUE_WEI:
                self._reject("escrow of %d wei is over this deployment's %d wei ceiling"
                             % (escrow, MAX_DEAL_VALUE_WEI))

            if key in self.deals:
                self._reject("deal %r already exists" % key[:64])
            if name in self.domain_to_deal:
                # Only a *live* deal blocks the domain. Two open escrows on one name would let
                # a single transfer settle both, which is the whole reason for this index. A
                # closed one cannot settle anything, and a domain whose sale fell through has
                # to be sellable again, so a terminal predecessor is superseded not fatal.
                previous_key = self.domain_to_deal[name]
                previous_state = ST_OFFERED
                if previous_key in self.deals:
                    previous_state = str(self.deals[previous_key].state)
                if previous_state not in CLOSED_STATES:
                    self._reject("deal %r already covers %s and is %s; a second live escrow "
                                 "on one domain would let one transfer settle both"
                                 % (previous_key[:64], name, previous_state))

            seller_token = self._proof_token("seller", key, seller_address)
            seller_name = self._proof_name(SELLER_PROOF_LABEL, name)
            buyer_name = self._proof_name(BUYER_PROOF_LABEL, name)
            now = self._require_now()

            # Everything above is deterministic. The first network call happens here.
            observed = self._rdap_block(name)
            marshalled = self._error_text(observed)
            if marshalled != "":
                return self._decline(marshalled)

            if str(observed.get("ldh_name", "")) != name:
                self._reject_transient(
                    "the registry answered about %r when asked about %r"
                    % (str(observed.get("ldh_name", ""))[:80], name))

            suspended = self._suspension(observed)
            if suspended != "":
                self._reject("%s cannot be escrowed: %s" % (name, suspended))

            if bool(observed.get("pending_transfer", False)):
                self._reject("%s is already %r at the registry. A transfer already in flight "
                             "was not started for this deal, and settling against it would "
                             "pay for work this escrow did not buy."
                             % (name, STATUS_PENDING_TRANSFER))

            baseline_registrar = str(observed.get("registrar_id", ""))
            if baseline_registrar == registrar:
                self._reject("%s is already sponsored by IANA id %s, so there is no transfer "
                             "for this deal to verify" % (name, registrar))

            setters = str(observed.get("transfer_lock_setters", ""))
            if LOCK_SETTER_SERVER in setters.split(","):
                self._reject("%s carries a server transfer prohibition, which only the "
                             "registry can lift. The transfer this deal is for cannot "
                             "complete, so the escrow is refused rather than held." % name)
            client_locked = LOCK_SETTER_CLIENT in setters.split(",")
        except gl.vm.UserError as exc:
            # `.message`, not `str(exc)`. `gl.vm.UserError` is a dataclass whose `__str__` is
            # defined as `repr(self)`, so the obvious spelling yields
            # `UserError(message='[EXPECTED] ...')` and buries the tag inside a Python repr. A
            # caller checking for a leading `[` to tell "declined" from "opened" would then read
            # every refusal as a successful deal id. Caught by the direct suite against the real
            # SDK, which is the only layer where `gl.vm.UserError` is the SDK's class.
            return self._decline(exc.message)

        deal = Deal(
            deal_id=key,
            buyer=buyer,
            seller=seller_address,
            domain=name,
            tld=name.split(".")[-1],
            rdap_base=str(observed.get("base", "")),
            target_registrar_id=registrar,
            target_nameservers=nameservers,
            seller_proof_name=seller_name,
            seller_proof_token=seller_token,
            buyer_proof_name=buyer_name,
            buyer_proof_commitment=commitment,
            buyer_proof_token="",
            escrow=u256(escrow),
            state=ST_OFFERED,
            opened_at=now,
            accept_deadline=self._add_seconds(now, ACCEPT_WINDOW_SECONDS),
            armed_at="",
            transfer_deadline="",
            verified_at="",
            inspection_deadline="",
            closed_at="",
            baseline_registrar_id=baseline_registrar,
            baseline_registrar_name=str(observed.get("registrar_name", "")),
            baseline_nameservers=str(observed.get("nameservers", "")),
            baseline_statuses=str(observed.get("statuses", "")),
            baseline_transfer_at=str(observed.get("transfer_at", "")),
            baseline_last_changed_at=str(observed.get("last_changed_at", "")),
            baseline_digest=str(observed.get("digest", "")),
            baseline_client_transfer_locked=client_locked,
            last_check_at="",
            last_check_outcome="",
            last_check_note="",
            last_check_registrar_id="",
            last_check_nameservers="",
            last_check_statuses="",
            last_check_transfer_at="",
            last_check_digest="",
            last_proof_outcome="",
            last_proof_values="",
            checks=u256(0),
            delivered_registrar_id="",
            delivered_transfer_at="",
            delivered_digest="",
            delivered_proof_digest="",
            paid_to_seller=u256(0),
            returned_to_buyer=u256(0),
        )

        self.deals[key] = deal
        self.deal_ids.append(key)
        self.domain_to_deal[name] = key
        self.total_escrowed = u256(int(self.total_escrowed) + escrow)
        self.deals_opened = u256(int(self.deals_opened) + 1)

        lock_note = ("" if not client_locked else
                     " The domain carries a client transfer prohibition, which the losing "
                     "registrar can lift on the registrant's instruction and must, before "
                     "the transfer can start.")
        return ("%s %s: %d wei escrowed on %s, today at IANA id %s and due at %s. The "
                "seller has until %s to publish %s IN TXT %r and call arm().%s"
                % (key, ST_OFFERED, escrow, name, baseline_registrar, registrar,
                   deal.accept_deadline, seller_name, seller_token, lock_note))

    # ==================================================================================
    # arm
    # ==================================================================================

    @gl.public.write
    def arm(self, deal_id: str) -> str:
        """The seller accepts, by proving DNS control of the domain. Seller only.

        Arming is not a signature. A named seller who cannot publish a TXT record under the
        domain has no operational relationship with it, and taking their acceptance on
        assertion alone would start a ten-day clock against a buyer for nothing. The proof is
        the acceptance.

        The token has no secret in it, because publishing anything at all under the domain is
        the control being proven. The buyer's token does need one, and `_proof_token` says why.

        This reverts on a proof that is absent or on resolvers that disagree, rather than
        recording it. The seller is the caller here, so there is no third party who needs the
        attempt on chain, and a seller whose record has not propagated yet retries.
        """
        deal = self._require_deal(deal_id)
        key = deal.deal_id
        self._require_state(deal, (ST_OFFERED,), "arm()")

        if gl.message.sender_address != deal.seller:
            self._reject("only the named seller can arm deal %s" % key)

        now = self._require_now()
        if self._at_or_after(now, deal.accept_deadline):
            self._reject("the offer on deal %s lapsed at %s; the escrow is refundable "
                         "instead" % (key, deal.accept_deadline))

        observed = self._proof_block(deal.seller_proof_name, deal.seller_proof_token)
        self._raise_if_error(observed)

        outcome = str(observed.get("proof_outcome", ""))
        if outcome != PROOF_FOUND:
            tag = str(observed.get("proof_tag", "")) or ERROR_TRANSIENT
            raise gl.vm.UserError(
                "%s the seller's control proof is not corroborated at %s: %s. Publish %s IN "
                "TXT %r and retry once both resolvers see it."
                % (tag, deal.seller_proof_name,
                   str(observed.get("proof_reason", "")) or outcome,
                   deal.seller_proof_name, deal.seller_proof_token))

        deal.state = ST_LOCKED
        deal.armed_at = now
        deal.transfer_deadline = self._add_seconds(now, TRANSFER_WINDOW_SECONDS)
        deal.last_proof_outcome = outcome
        deal.last_proof_values = str(observed.get("proof_values", ""))[:400]
        self.deals[key] = deal

        return ("%s %s: both resolvers see the seller's control proof at %s. The transfer to "
                "IANA id %s must complete by %s, after which the escrow is refundable."
                % (key, ST_LOCKED, deal.seller_proof_name, deal.target_registrar_id,
                   deal.transfer_deadline))

    # ==================================================================================
    # check_transfer
    # ==================================================================================

    @gl.public.write
    def check_transfer(self, deal_id: str, buyer_proof_token: str) -> str:
        """Read the registry and both resolvers, and record what they say. Callable by anyone.

        Permissionless on purpose. Delivery is a fact about public records, so whether it has
        happened must not depend on either party being willing to say so, and the buyer in
        particular must not be able to withhold a check to run the seller into the deadline.

        `buyer_proof_token` is the token the commitment at deal creation committed to. Anyone
        can supply it, because by the time it matters the buyer has published it in DNS and it
        is public. The first successful check stores it so that `settle` needs no argument.

        Five outcomes advance nothing and are recorded: SUSPENDED, PENDING_TRANSFER,
        AWAITING_TRANSFER, AWAITING_DELEGATION and AWAITING_DNS. That is deliberate and it is
        the line this contract draws: a source that failed reverts with its tag, because
        nothing was observed, and an observation that shows an incomplete transfer returns,
        because something was. Neither is a delivery, and the deadline keeps running through
        both.

        From VERIFIED this method still runs, and it is how a reversal is caught. See
        `_check_from_verified` for why only a reversal back to the seller's own registrar
        counts.
        """
        deal = self._require_deal(deal_id)
        key = deal.deal_id
        self._require_state(deal, (ST_LOCKED, ST_VERIFIED), "check_transfer()")

        now = self._require_now()
        if deal.last_check_at != "":
            ready = self._add_seconds(deal.last_check_at, CHECK_INTERVAL_SECONDS)
            if not self._at_or_after(now, ready):
                self._reject("deal %s was checked at %s; the next check is due at %s. Every "
                             "validator fetches independently, and RDAP and both resolvers "
                             "rate limit per source." % (key, deal.last_check_at, ready))

        token = self._require_revealed_token(deal, buyer_proof_token)

        observed = self._delivery_block(deal.domain, deal.rdap_base,
                                        deal.buyer_proof_name, token)
        self._raise_if_error(observed)

        if str(observed.get("ldh_name", "")) != deal.domain:
            raise gl.vm.UserError(
                "%s the registry answered about %r when asked about %r"
                % (ERROR_TRANSIENT, str(observed.get("ldh_name", ""))[:80], deal.domain))

        verdict = self._classify_delivery(deal, observed)
        self._record_observation(deal, now, observed, verdict)
        self.checks_run = u256(int(self.checks_run) + 1)

        if deal.buyer_proof_token == "":
            deal.buyer_proof_token = token

        outcome = str(verdict["outcome"])

        if deal.state == ST_VERIFIED:
            return self._check_from_verified(deal, now, observed, outcome, verdict)

        if outcome != OUT_VERIFIED:
            self.deals[key] = deal
            return ("%s %s: %s. The transfer deadline is %s."
                    % (key, outcome, str(verdict["note"]), deal.transfer_deadline))

        deal.state = ST_VERIFIED
        deal.verified_at = now
        deal.inspection_deadline = self._add_seconds(now, INSPECTION_WINDOW_SECONDS)
        deal.delivered_registrar_id = str(observed.get("registrar_id", ""))
        deal.delivered_transfer_at = str(observed.get("transfer_at", ""))
        deal.delivered_digest = str(observed.get("digest", ""))
        deal.delivered_proof_digest = str(observed.get("proof_digest", ""))
        self.deals[key] = deal
        self.deliveries_verified = u256(int(self.deliveries_verified) + 1)

        return ("%s %s: %s. The buyer may settle now, and anyone may settle from %s."
                % (key, ST_VERIFIED, str(verdict["note"]), deal.inspection_deadline))

    def _require_revealed_token(self, deal: Deal, supplied: str) -> str:
        """The buyer's proof token, checked against the commitment made at deal creation.

        Required on every call rather than optional once stored, because a method whose
        argument is sometimes ignored is a method whose caller stops checking what they pass.
        A stored token still has to match, which also means a deal cannot be moved onto a
        second token after the first one verified.
        """
        text = str(supplied or "").strip()
        if text == "":
            self._reject("buyer_proof_token is required. It is the token whose sha256 is the "
                         "buyer_proof_commitment recorded on deal %s, and by the time a "
                         "check can succeed it is already public in DNS." % deal.deal_id)
        try:
            digest = commitment_digest(text)
        except Refusal as exc:
            raise gl.vm.UserError(str(exc))
        if digest != deal.buyer_proof_commitment:
            self._reject("buyer_proof_token hashes to %s, and deal %s committed to %s"
                         % (digest, deal.deal_id, deal.buyer_proof_commitment))
        if deal.buyer_proof_token != "" and deal.buyer_proof_token != text:
            self._reject("deal %s already verified against a different token" % deal.deal_id)
        return text

    def _check_from_verified(self, deal: Deal, now: str, observed: dict, outcome: str,
                             verdict: dict) -> str:
        """A check run after delivery was accepted. Either nothing changed, or it reversed.

        A reversal is narrow on purpose, and this is the one place in the contract where the
        narrowness matters more than the coverage. Requiring only "no longer delivered" would
        hand the buyer a way to take both the domain and the escrow: they now control the
        name, so they can move it and delete the proof record whenever they like.

        So a reversal is only recorded when the domain has gone back to the registrar the
        SELLER had it at when the deal opened, and the buyer's control proof is gone. Moving
        the domain to some third registrar is the buyer exercising the control they paid for
        and is not a reversal. The window is the inspection period, which bounds this to 72
        hours after delivery rather than leaving it open for the life of the deal.

        The residual risk is stated rather than closed: a buyer who transfers the domain back
        to the seller's original registrar and deletes their own proof record would reach
        REVERSED. They would be giving up the asset to recover the price, and the seller would
        end up holding the domain again, so the trade is not obviously profitable. It is a
        real gap and not a claimed one.
        """
        key = deal.deal_id
        if outcome == OUT_VERIFIED:
            self.deals[key] = deal
            return ("%s %s: delivery still stands as of %s. The buyer may settle now, and "
                    "anyone may settle from %s."
                    % (key, ST_VERIFIED, now, deal.inspection_deadline))

        back_to_seller = (str(observed.get("registrar_id", ""))
                          == deal.baseline_registrar_id)
        proof_gone = str(observed.get("proof_outcome", "")) != PROOF_FOUND
        inside_window = not self._at_or_after(now, deal.inspection_deadline)

        if back_to_seller and proof_gone and inside_window:
            deal.state = ST_REVERSED
            deal.last_check_outcome = OUT_REVERSED
            deal.last_check_note = (
                "the domain is back at IANA id %s, the registrar it was at when this deal "
                "opened, and the buyer's control proof is gone: %s"
                % (deal.baseline_registrar_id, str(verdict["note"])))[:400]
            self.deals[key] = deal
            self.reversals_recorded = u256(int(self.reversals_recorded) + 1)
            return ("%s %s: %s. The escrow is refundable to the buyer."
                    % (key, ST_REVERSED, deal.last_check_note))

        self.deals[key] = deal
        why = "outside the inspection window" if not inside_window else (
            "not a reversal to the seller's registrar" if not back_to_seller
            else "the buyer's control proof is still corroborated")
        return ("%s %s: %s. Recorded and not treated as a reversal, because it is %s."
                % (key, ST_VERIFIED, str(verdict["note"]), why))

    # ==================================================================================
    # settle
    # ==================================================================================

    @gl.public.write
    def settle(self, deal_id: str) -> str:
        """Release the escrow to the seller. The buyer any time, anyone after inspection.

        Delivery is re-verified here against the registry and both resolvers, using the token
        the successful check stored, and it has to still hold. Re-verification is what makes
        the earlier check a claim about retrievable public records rather than about a row
        this contract wrote down for itself: without it, a delivery that qualified once could
        be settled against forever, including after it stopped being true.

        The transfer event must be the delivered one or later, not earlier. Later is allowed
        because a buyer who moves the domain between resellers under the same IANA id has done
        nothing the seller should lose the price over. Earlier means the registry rolled the
        event back, which is not something to pay against.
        """
        deal = self._require_deal(deal_id)
        key = deal.deal_id
        self._require_state(deal, (ST_VERIFIED,), "settle()")

        now = self._require_now()
        caller = gl.message.sender_address
        if caller != deal.buyer and not self._at_or_after(now, deal.inspection_deadline):
            self._reject("the buyer's inspection window on deal %s is open until %s; until "
                         "then only the buyer can settle"
                         % (key, deal.inspection_deadline))

        observed = self._delivery_block(deal.domain, deal.rdap_base,
                                        deal.buyer_proof_name, deal.buyer_proof_token)
        self._raise_if_error(observed)

        if str(observed.get("ldh_name", "")) != deal.domain:
            raise gl.vm.UserError(
                "%s the registry answered about %r when asked about %r"
                % (ERROR_TRANSIENT, str(observed.get("ldh_name", ""))[:80], deal.domain))

        verdict = self._classify_delivery(deal, observed)
        if str(verdict["outcome"]) != OUT_VERIFIED:
            raise gl.vm.UserError(
                "%s deal %s no longer verifies and cannot be settled: %s. Run "
                "check_transfer() to put this on the record."
                % (ERROR_EXTERNAL, key, str(verdict["note"])))

        transfer_at = str(observed.get("transfer_at", ""))
        if transfer_at < deal.delivered_transfer_at:
            raise gl.vm.UserError(
                "%s the registry now publishes a transfer event at %s, earlier than the %s "
                "this delivery was verified against, so the record moved backwards"
                % (ERROR_EXTERNAL, transfer_at or "(none)", deal.delivered_transfer_at))

        payout = int(deal.escrow)
        deal.state = ST_RELEASED
        deal.closed_at = now
        deal.paid_to_seller = u256(payout)
        self._record_observation(deal, now, observed, verdict)
        self.deals[key] = deal
        self.total_released = u256(int(self.total_released) + payout)
        self._pay(deal.seller, u256(payout))

        return ("%s %s: delivery re-verified at %s and %d wei released to the seller. "
                "Conveyance verified public transfer signals and operational DNS control. "
                "It did not prove legal title, beneficial ownership, the identity of a "
                "private registrant, or that a registrar account has no retained delegates."
                % (key, ST_RELEASED, now, payout))

    # ==================================================================================
    # refund
    # ==================================================================================

    @gl.public.write
    def refund(self, deal_id: str) -> str:
        """Return the escrow to the buyer. Callable by anyone, on a deadline or a reversal.

        Three doors, and no others. From OFFERED once the seller's 48 hours to arm have run
        out. From LOCKED once the 10 days to complete the transfer have run out. From REVERSED
        immediately, because `check_transfer` already established the fact on chain.

        Not callable from VERIFIED. A seller who delivered is owed the price, and a buyer who
        thinks delivery came apart has `check_transfer`, which will record it and reach
        REVERSED if the registry agrees.

        Permissionless because the destination is fixed: the money goes to the buyer whoever
        calls, so a third party calling it can only ever help.
        """
        deal = self._require_deal(deal_id)
        key = deal.deal_id
        now = self._require_now()

        if deal.state == ST_OFFERED:
            if not self._at_or_after(now, deal.accept_deadline):
                self._reject("the seller has until %s to arm deal %s"
                             % (deal.accept_deadline, key))
            why = ("the seller did not arm by %s" % deal.accept_deadline)
        elif deal.state == ST_LOCKED:
            if not self._at_or_after(now, deal.transfer_deadline):
                self._reject("the transfer on deal %s has until %s to complete; the last "
                             "check said: %s"
                             % (key, deal.transfer_deadline,
                                deal.last_check_note or "no check has run yet"))
            why = ("the transfer did not complete by %s, and the last observation was %s"
                   % (deal.transfer_deadline, deal.last_check_outcome or "none"))
        elif deal.state == ST_REVERSED:
            why = deal.last_check_note or "the delivery reversed"
        else:
            self._reject("deal %s is %s; a refund needs %s, %s or %s"
                         % (key, deal.state, ST_OFFERED, ST_LOCKED, ST_REVERSED))
            return ""

        returned = int(deal.escrow)
        deal.state = ST_REFUNDED
        deal.closed_at = now
        deal.returned_to_buyer = u256(returned)
        self.deals[key] = deal
        self.total_refunded = u256(int(self.total_refunded) + returned)
        self._pay(deal.buyer, u256(returned))

        return ("%s %s: %s, so %d wei returned to the buyer."
                % (key, ST_REFUNDED, why, returned))

    # ==================================================================================
    # abandon
    # ==================================================================================

    @gl.public.write
    def abandon(self, deal_id: str) -> str:
        """Give the deal up early and return the escrow to the buyer.

        While OFFERED, either party may. The seller has committed nothing and the buyer's
        escrow is the only thing at stake, so shortening a 48-hour wait costs nobody anything.

        Once LOCKED, only the seller may. The seller has proven DNS control and may have a
        real inter-registrar transfer in flight, and a buyer who could cancel at will could
        let that transfer complete and then walk off with the price. The buyer's remedy after
        LOCKED is the transfer deadline, which `refund` enforces without the seller present.

        Never from VERIFIED, RELEASED, REFUNDED or REVERSED. After delivery this is no longer
        anyone's to give up, and the three terminal states are terminal.
        """
        deal = self._require_deal(deal_id)
        key = deal.deal_id
        self._require_state(deal, (ST_OFFERED, ST_LOCKED), "abandon()")

        caller = gl.message.sender_address
        if deal.state == ST_LOCKED:
            if caller != deal.seller:
                self._reject("deal %s is %s, and only the seller can abandon it from there. "
                             "The seller may have a transfer in flight, so the buyer's exit "
                             "is the transfer deadline at %s."
                             % (key, ST_LOCKED, deal.transfer_deadline))
            who = "the seller"
        else:
            if caller != deal.seller and caller != deal.buyer:
                self._reject("only the buyer or the named seller can abandon deal %s" % key)
            who = "the seller" if caller == deal.seller else "the buyer"

        now = self._require_now()
        returned = int(deal.escrow)
        previous = deal.state
        deal.state = ST_REFUNDED
        deal.closed_at = now
        deal.returned_to_buyer = u256(returned)
        self.deals[key] = deal
        self.total_refunded = u256(int(self.total_refunded) + returned)
        self._pay(deal.buyer, u256(returned))

        return ("%s %s: %s abandoned the deal from %s, so %d wei returned to the buyer."
                % (key, ST_REFUNDED, who, previous, returned))

    # ==================================================================================
    # probe_domain
    # ==================================================================================

    @gl.public.write
    def probe_domain(self, domain: str) -> dict:
        """Read a domain's public record without opening a deal. Writes nothing.

        This exists because `open_deal` compares the observed delegation to the buyer's
        `target_nameservers` for exact equality, and a buyer guessing at that list would open
        a deal that can never verify. The interface calls this first and fills the form from
        the answer.

        A write method rather than a view, because it fetches, and a view that fetches has no
        consensus behind it. It moves no value and touches no storage, so the worst an abusive
        caller achieves is paying for their own wasted round.
        """
        name = self._require_domain(domain)
        observed = self._rdap_block(name)
        self._raise_if_error(observed)
        return {
            "domain": name,
            "rdap_base": str(observed.get("base", "")),
            "registrar_iana_id": str(observed.get("registrar_id", "")),
            "registrar_name": str(observed.get("registrar_name", "")),
            "nameservers": str(observed.get("nameservers", "")),
            "statuses": str(observed.get("statuses", "")),
            "registration_at": str(observed.get("registration_at", "")),
            "expiration_at": str(observed.get("expiration_at", "")),
            "last_changed_at": str(observed.get("last_changed_at", "")),
            "transfer_at": str(observed.get("transfer_at", "")),
            "transfer_locked": str(observed.get("transfer_locked", False)),
            "transfer_lock_setters": str(observed.get("transfer_lock_setters", "")),
            "pending_transfer": str(observed.get("pending_transfer", False)),
            "digest": str(observed.get("digest", "")),
            "seller_proof_name": self._proof_name(SELLER_PROOF_LABEL, name),
            "buyer_proof_name": self._proof_name(BUYER_PROOF_LABEL, name),
            "escrowable": str(self._suspension(observed) == ""
                              and not bool(observed.get("pending_transfer", False))),
        }

    # ==================================================================================
    # Views
    # ==================================================================================

    @gl.public.view
    def get_deal(self, deal_id: str) -> dict:
        key = str(deal_id or "").strip()
        if key not in self.deals:
            return {}
        deal = self.deals[key]
        return {
            "deal_id": deal.deal_id,
            "state": deal.state,
            "buyer": deal.buyer.as_hex,
            "seller": deal.seller.as_hex,
            "domain": deal.domain,
            "tld": deal.tld,
            "rdap_base": deal.rdap_base,
            "target_registrar_id": deal.target_registrar_id,
            "target_nameservers": deal.target_nameservers,
            "seller_proof_name": deal.seller_proof_name,
            "seller_proof_token": deal.seller_proof_token,
            "buyer_proof_name": deal.buyer_proof_name,
            "buyer_proof_commitment": deal.buyer_proof_commitment,
            "buyer_proof_revealed": str(deal.buyer_proof_token != ""),
            "escrow": str(int(deal.escrow)),
            "opened_at": deal.opened_at,
            "accept_deadline": deal.accept_deadline,
            "armed_at": deal.armed_at,
            "transfer_deadline": deal.transfer_deadline,
            "verified_at": deal.verified_at,
            "inspection_deadline": deal.inspection_deadline,
            "closed_at": deal.closed_at,
            "baseline_registrar_id": deal.baseline_registrar_id,
            "baseline_registrar_name": deal.baseline_registrar_name,
            "baseline_nameservers": deal.baseline_nameservers,
            "baseline_statuses": deal.baseline_statuses,
            "baseline_transfer_at": deal.baseline_transfer_at,
            "baseline_last_changed_at": deal.baseline_last_changed_at,
            "baseline_digest": deal.baseline_digest,
            "baseline_client_transfer_locked": str(deal.baseline_client_transfer_locked),
            "checks": str(int(deal.checks)),
            "last_check_at": deal.last_check_at,
            "last_check_outcome": deal.last_check_outcome,
            "last_check_note": deal.last_check_note,
            "last_check_registrar_id": deal.last_check_registrar_id,
            "last_check_nameservers": deal.last_check_nameservers,
            "last_check_statuses": deal.last_check_statuses,
            "last_check_transfer_at": deal.last_check_transfer_at,
            "last_check_digest": deal.last_check_digest,
            "last_proof_outcome": deal.last_proof_outcome,
            "last_proof_values": deal.last_proof_values,
            "delivered_registrar_id": deal.delivered_registrar_id,
            "delivered_transfer_at": deal.delivered_transfer_at,
            "delivered_digest": deal.delivered_digest,
            "delivered_proof_digest": deal.delivered_proof_digest,
            "paid_to_seller": str(int(deal.paid_to_seller)),
            "returned_to_buyer": str(int(deal.returned_to_buyer)),
        }

    @gl.public.view
    def list_deals(self) -> list:
        out = []
        for key in self.deal_ids:
            deal = self.deals[key]
            out.append({
                "deal_id": deal.deal_id,
                "state": deal.state,
                "domain": deal.domain,
                "escrow": str(int(deal.escrow)),
                "target_registrar_id": deal.target_registrar_id,
                "last_check_outcome": deal.last_check_outcome,
                "last_check_at": deal.last_check_at,
            })
        return out

    @gl.public.view
    def delivery_status(self, domain: str) -> dict:
        """The most recent deal on one domain, by name rather than by id.

        One domain carries at most one live deal, so while a sale is in flight this is that
        deal. After it closes the index keeps pointing at it until a later deal supersedes
        it, which makes this "the current answer for this domain" rather than "the open
        escrow": a caller that needs to know whether money is still held reads `state`.
        """
        name = str(domain or "").strip().rstrip(".").lower()
        if name not in self.domain_to_deal:
            return {}
        return self.get_deal(self.domain_to_deal[name])

    @gl.public.view
    def ledger(self) -> dict:
        """Escrow conservation, checkable by addition.

        There is no protocol fee, so every wei that came in is either released, refunded, or
        still held. `held` is computed from the counters rather than read from the balance,
        and `balance` is reported next to it: the two disagreeing is the shape a value bug
        would take.
        """
        escrowed = int(self.total_escrowed)
        released = int(self.total_released)
        refunded = int(self.total_refunded)
        return {
            "total_escrowed": str(escrowed),
            "total_released": str(released),
            "total_refunded": str(refunded),
            "held": str(escrowed - released - refunded),
            "balance": str(int(self.balance)),
            "deals_opened": str(int(self.deals_opened)),
            "checks_run": str(int(self.checks_run)),
            "deliveries_verified": str(int(self.deliveries_verified)),
            "reversals_recorded": str(int(self.reversals_recorded)),
            "protocol_fee": "0",
        }

    @gl.public.view
    def parameters(self) -> dict:
        """Every constant a caller's decision depends on, readable from the chain."""
        return {
            "iana_bootstrap_url": IANA_BOOTSTRAP_URL,
            "seller_proof_label": SELLER_PROOF_LABEL,
            "buyer_proof_label": BUYER_PROOF_LABEL,
            "proof_version": PROOF_VERSION,
            "accept_window_seconds": str(ACCEPT_WINDOW_SECONDS),
            "transfer_window_seconds": str(TRANSFER_WINDOW_SECONDS),
            "inspection_window_seconds": str(INSPECTION_WINDOW_SECONDS),
            "check_interval_seconds": str(CHECK_INTERVAL_SECONDS),
            "max_deal_value_wei": str(MAX_DEAL_VALUE_WEI),
            "min_nameservers": str(MIN_NAMESERVERS),
            "max_nameservers": str(MAX_NAMESERVERS),
            "resolvers": "%s,%s" % (DOH_CLOUDFLARE, DOH_GOOGLE),
            "embedded_function_count": str(EMBEDDED_FUNCTION_COUNT),
            "uses_a_model": "false",
            "boundary": (
                "Conveyance verifies public transfer signals and operational DNS control. "
                "It does not prove legal title, beneficial ownership, the identity of a "
                "private registrant, or that a registrar account has no retained delegates."
            ),
        }
