"""Conveyance RDAP and DoH primitives. Standalone, stdlib only, no I/O of its own.

A GenLayer Intelligent Contract cannot import a sibling Python file, so this module is
developed and unit tested here and then spliced verbatim into `contracts/Conveyance.py`
between the two SPLICE markers below. `test_rdap.py` recomputes the digest of that region
so the spliced copy can be diffed against this source; see README.md for the contract.

Everything here is a pure function of its arguments. There is no network access, no
filesystem access, no clock and no randomness. HTTP happens only through a `fetch`
callable the caller injects, whose contract is:

    fetch(url, headers=None) -> response with `.status` (int) and `.body` (bytes)

`.status`, not `.status_code`. GenVM returns `.status`; the published docs example is
wrong, and a helper written against the wrong attribute fails only on chain.

Refusal taxonomy, from PRD 05 section 7. Absence is never success: no branch in this
module can return a value that a caller could read as "the transfer completed".

    [EXPECTED]   caller error: unsupported TLD, malformed domain, bad argument
    [EXTERNAL]   source unreachable or silent: 404, 403, empty body, NXDOMAIN, no Answer
    [TRANSIENT]  transport or agreement failure: 429, resolver disagreement, proof absent
    [LLM_ERROR]  malformed model output (dispute path only, not reached from here)

Where this module diverges from a literal reading of the two source documents, it follows
the PRD and says so:

  * The build brief groups 429 under [EXTERNAL]. PRD section 7 lists "rate limited" under
    [TRANSIENT] and PRD section 2 says "429 is retryable". 429 is classified [TRANSIENT].
  * The brief groups NXDOMAIN under [EXTERNAL]; a proof that is absent from an existing
    TXT set is instead [TRANSIENT], because PRD section 7 lists "DNS propagation
    incomplete" there. The two cases are distinguished rather than merged, which is the
    point of `DohObservation.nxdomain` versus `PROOF_ABSENT`.
"""

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

    Also returns `corroborated_absent`, which is narrower than "not PROOF_FOUND" and is the
    only field a caller may use to conclude the proof is actually gone rather than merely
    unconfirmed this round. It is True in exactly two cases, both of them two independent
    resolvers agreeing with each other: they saw the same non-empty TXT set and the token is
    not in it, or they both returned NXDOMAIN for the name. Every other case that reaches
    here is disagreement between the resolvers, one of them answering nothing, mismatched
    query names, or a single NXDOMAIN against an answer from the other resolver, and none of
    those is evidence that a record was removed. The contract's `_check_from_verified` is the
    caller this matters for: reading disagreement as disappearance there would let ordinary
    DNS propagation lag or one resolver's outage reverse a delivery that never actually moved.
    """
    assert_proof_token_shape(expected_token)
    if not isinstance(corroboration, Corroboration):
        raise expected("classify_proof takes a Corroboration",
                       type(corroboration).__name__)
    if not corroboration.agreed:
        all_nxdomain = (len(corroboration.observations) >= 2
                        and all(obs.nxdomain for obs in corroboration.observations))
        if any(obs.nxdomain for obs in corroboration.observations):
            return {"outcome": PROOF_NAME_MISSING, "tag": corroboration.tag,
                    "reason": corroboration.reason, "corroborated_absent": all_nxdomain}
        return {"outcome": PROOF_ABSENT, "tag": corroboration.tag,
                "reason": corroboration.reason, "corroborated_absent": False}
    if expected_token in corroboration.values:
        return {"outcome": PROOF_FOUND, "tag": None,
                "reason": None, "digest": corroboration.digest,
                "corroborated_absent": False}
    return {"outcome": PROOF_ABSENT, "tag": TAG_TRANSIENT,
            "reason": "both resolvers agree on the TXT set and the expected token is not "
                      "in it, which is an absent proof and may be incomplete propagation",
            "corroborated_absent": True}


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
