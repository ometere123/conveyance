"""Unit tests for rdap.py, run either standalone or under pytest.

    timeout 300 python _build/conveyance-rdap/test_rdap.py

Fixture routing reuses the real `_build/harness/harness.py` FixtureNetwork rather than a
local mock, so `requires_header` and the Cloudflare 400 are reproduced by the same code the
contract will meet. Only `_response` is overridden, to avoid pulling in the stub SDK for a
module that has no contract in it.

Two fixtures, rdap-pending-transfer.json and rdap-transfer-complete.json, come from a real
cross-registrar transfer that has not started. The tests for them are written in full
against the RFC 9083 shape and the manifest's `expect` block, and skip on the missing file.
Nothing is faked and nothing needs rewriting when the captures land.
"""

import ast
import hashlib
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HARNESS_DIR = os.path.join(ROOT, "_build", "harness")
FIXTURE_DIR = os.path.join(ROOT, "_build", "fixtures", "conveyance")

for path in (HERE, HARNESS_DIR):
    if path not in sys.path:
        sys.path.insert(0, path)

import harness as harness_mod          # noqa: E402
import rdap                            # noqa: E402

RDAP_SOURCE = os.path.join(HERE, "rdap.py")


# ======================================================================================
# Fixture plumbing
# ======================================================================================


class _Response(object):
    """`.status` and `.body`, matching GenVM. Not `.status_code`; that does not exist."""

    def __init__(self, status, body=b"", headers=None):
        self.status = int(status)
        self.body = body
        self.headers = headers or {}


class LocalFixtureNetwork(harness_mod.FixtureNetwork):
    """The real routing table and header enforcement, without the stub SDK."""

    @staticmethod
    def _response(status, body, headers=None):
        return _Response(status, body, headers)


def make_fetch(net, headers_override=None, drop_headers=False):
    """An injected `fetch` over the fixture network.

    `drop_headers` exists to prove Cloudflare's 400: it simulates the future edit that
    removes the Accept header, which must fail here rather than in a consensus round.
    """
    def fetch(url, headers=None):
        sent = {} if drop_headers else dict(headers or {})
        if headers_override is not None:
            sent = dict(headers_override)
        return net.handle(url, "GET", None, sent, False)
    return fetch


def net():
    return LocalFixtureNetwork("conveyance")


def fixture(name):
    with io.open(os.path.join(FIXTURE_DIR, name), "rb") as handle:
        return handle.read()


def fixture_exists(name):
    return os.path.exists(os.path.join(FIXTURE_DIR, name))


def manifest():
    with io.open(os.path.join(FIXTURE_DIR, "manifest.json"), encoding="utf-8") as handle:
        return json.load(handle)


def route(name):
    for entry in manifest()["routes"]:
        if entry.get("name") == name:
            return entry
    raise AssertionError("manifest has no route named %r" % name)


def declared_length(name):
    """The byte count the manifest claims for a route, whichever way it claims it.

    The manifest distinguishes two claims on purpose, and the distinction is not cosmetic:

      * `bytes_received` was verified verbatim, by writing `response.read()` to disk and reading
        it back to the same digest. It is a claim about the wire.
      * `bytes_on_disk` is what the file measures now, for the captures predating that discipline.
        The manifest says next to each one why a round trip could not change a conclusion, which
        for RDAP is that the module parses by RFC 9083 field name and never hashes the body.

    Reading whichever key is present, rather than hardcoding one per route, is what keeps a test
    from having to be edited when a fixture is promoted from the weaker claim to the stronger one.
    Declaring neither raises, because a route with no byte claim at all makes the assertion below
    a tautology, and a tautology that reads like a measurement is worse than no test.
    """
    capture = route(name).get("capture") or {}
    for key in ("bytes_received", "bytes_on_disk"):
        if key in capture:
            return int(capture[key])
    raise AssertionError(
        "route %r declares no byte count. Add bytes_received (verbatim verified) or "
        "bytes_on_disk to its capture block in _build/fixtures/conveyance/manifest.json" % name)


def require_fixture(name):
    if not fixture_exists(name):
        raise unittest.SkipTest(
            "%s is not captured yet: it comes from a real cross-registrar transfer that "
            "has not started. The assertions below are written against the manifest's "
            "expect block and need no change when it lands." % name)
    raw = fixture(name)
    if len(raw) == 0:
        raise unittest.SkipTest("%s exists but is a 0 byte placeholder" % name)
    return raw


def refusal(fn, *args, **kwargs):
    """Call something that must refuse, and return the Refusal for tag assertions."""
    try:
        fn(*args, **kwargs)
    except rdap.Refusal as exc:
        return exc
    raise AssertionError("expected a Refusal, got a return value instead. Absence is "
                         "never success.")


BOOTSTRAP = json.loads(fixture("iana-rdap-bootstrap.json").decode("utf-8"))
NOTES = []


def note(text):
    NOTES.append(text)


# ======================================================================================
# 0. The module is what it claims to be
# ======================================================================================


def test_module_is_stdlib_only_and_has_no_io():
    """Static proof of the constraint, not a promise in a docstring."""
    source = io.open(RDAP_SOURCE, encoding="utf-8").read()
    tree = ast.parse(source)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imported.add(node.module.split(".")[0])
    assert imported == {"hashlib", "json"}, imported

    banned_calls = {"open", "input", "eval", "exec", "compile", "__import__"}
    called = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            called.add(node.func.id)
    assert not (called & banned_calls), called & banned_calls

    for banned in ("import time", "import random", "import datetime", "import urllib",
                   "import os", "import requests", "web.request", "gl."):
        assert banned not in source, banned
    note("rdap.py imports exactly {hashlib, json}; no open/eval/exec, no clock, "
         "no filesystem, no gl.* reference")


def test_splice_region_digest_is_reproducible():
    """The drift guard. The digest of the region between the markers is what the contract
    asserts against, so it is recomputed and printed on every run."""
    source = io.open(RDAP_SOURCE, encoding="utf-8", newline="").read()
    begin = "# --- CONVEYANCE-RDAP SPLICE BEGIN ---"
    end = "# --- CONVEYANCE-RDAP SPLICE END ---"
    assert source.count(begin) == 1 and source.count(end) == 1
    start = source.index(begin) + len(begin)
    stop = source.index(end)
    region = source[start:stop]
    normalized = "\n".join(region.replace("\r\n", "\n").split("\n")).strip() + "\n"
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    assert len(digest) == 64
    note("splice region: %d lines, %d bytes normalized, sha256 %s"
         % (normalized.count("\n"), len(normalized.encode("utf-8")), digest))


# ======================================================================================
# 1. IANA bootstrap to registry RDAP routing
# ======================================================================================


def test_bootstrap_measurements_match_the_manifest():
    raw = fixture("iana-rdap-bootstrap.json")
    assert len(raw) == declared_length("iana-bootstrap") == 71095
    services = rdap.bootstrap_services(BOOTSTRAP)
    assert len(services) == 590
    labels = [tld for entry in services for tld in entry[0]]
    assert len(labels) == 1200
    note("bootstrap: %d bytes, %d service entries, %d TLD labels, version %s, "
         "published %s" % (len(raw), len(services), len(labels),
                           BOOTSTRAP["version"], BOOTSTRAP["publication"]))


def test_bootstrap_routes_both_registries():
    """Both PRD section 2 rows, resolved from the live document rather than hardcoded."""
    com = rdap.registry_base_for_domain(BOOTSTRAP, "example.com")
    org = rdap.registry_base_for_domain(BOOTSTRAP, "example.org")
    assert com == "https://rdap.verisign.com/com/v1/", com
    assert org == "https://rdap.publicinterestregistry.org/rdap/", org
    assert rdap.rdap_domain_url(com, "EXAMPLE.COM") == \
        "https://rdap.verisign.com/com/v1/domain/example.com"
    assert rdap.rdap_domain_url(org, "Example.Org") == \
        "https://rdap.publicinterestregistry.org/rdap/domain/example.org"
    # The .org base is shared by 11 labels in one entry, so routing must not assume one
    # TLD per entry.
    for tld in ("ngo", "ong", "charity", "foundation"):
        assert rdap.registry_base_for_domain(BOOTSTRAP, "x." + tld) == org
    note("routed .com -> %s and .org -> %s from the live bootstrap; the .org entry covers "
         "11 labels and all of them route the same way" % (com, org))


def test_bootstrap_matches_the_longest_suffix_not_the_shortest():
    """RFC 9224 section 5. Unexercised by the live file, which has no dotted label, so it
    is exercised with a synthetic entry that the real file is allowed to grow."""
    dotted = [t for entry in BOOTSTRAP["services"] for t in entry[0] if "." in t]
    assert dotted == [], dotted
    synthetic = {"version": "1.0", "services": [
        [["com"], ["https://rdap.verisign.com/com/v1/"]],
        [["example.com"], ["https://rdap.longer-suffix.example/rdap/"]],
    ]}
    assert rdap.registry_base_for_domain(synthetic, "shop.example.com") == \
        "https://rdap.longer-suffix.example/rdap/"
    assert rdap.registry_base_for_domain(synthetic, "other.com") == \
        "https://rdap.verisign.com/com/v1/"
    # The registered name itself is never a candidate suffix, so a name that collides with
    # a bootstrap entry cannot route itself somewhere else.
    assert rdap.registry_base_for_domain(synthetic, "example.com") == \
        "https://rdap.verisign.com/com/v1/"
    note("longest-suffix routing verified on a synthetic bootstrap; the live file has 0 "
         "dotted labels out of 1200, so this path is spec-required and currently unused")


def test_bootstrap_refuses_a_plaintext_http_registry():
    """Measured: two live entries are http, kg and mg. PRD section 2 permits only https."""
    http_tlds = sorted({t for entry in BOOTSTRAP["services"] for t in entry[0]
                        if not entry[1][0].lower().startswith("https://")})
    assert http_tlds == ["kg", "mg"], http_tlds
    for tld in http_tlds:
        exc = refusal(rdap.registry_base_for_domain, BOOTSTRAP, "example." + tld)
        assert exc.tag == rdap.TAG_EXPECTED, exc.tag
        assert "no https RDAP base" in exc.reason
    note("the 2 live http-only TLDs (%s) fail closed as [EXPECTED], not silently "
         "downgraded to plaintext" % ", ".join(http_tlds))


def test_bootstrap_refuses_unknown_and_malformed_domains():
    assert refusal(rdap.registry_base_for_domain, BOOTSTRAP,
                   "example.invalid").tag == rdap.TAG_EXPECTED
    for bad in ("https://example.com", "example.com/path", "example.com.", "example",
                "user@example.com", "*.example.com", "example.com:443", "", "a..com"):
        exc = refusal(rdap.normalize_domain, bad)
        assert exc.tag == rdap.TAG_EXPECTED, (bad, exc.tag)


def test_a_changed_bootstrap_is_transient_not_a_silent_authority_switch():
    """PRD section 6: a bootstrap that moves mid-deal forces a retry, never a switch."""
    stored = rdap.registry_base_for_domain(BOOTSTRAP, "example.com")
    moved = {"version": "1.0", "services": [
        [["com"], ["https://rdap.someone-else.example/com/v1/"]]]}
    exc = refusal(rdap.assert_base_still_authoritative, moved, "example.com", stored)
    assert exc.tag == rdap.TAG_TRANSIENT, exc.tag
    assert rdap.assert_base_still_authoritative(BOOTSTRAP, "example.com", stored) == stored


def test_bootstrap_is_fetched_through_the_injected_fetch():
    network = net()
    doc = rdap.fetch_bootstrap(make_fetch(network))
    assert len(doc["services"]) == 590
    assert network.calls == [("GET", "https://data.iana.org/rdap/dns.json")]
    assert network.served == ["iana-bootstrap"]


# ======================================================================================
# 2. RDAP event and status-flag parsing
# ======================================================================================


COM = None
ORG = None


def test_rdap_both_registries_parse_from_field_names():
    global COM, ORG
    com_raw = fixture("rdap-com-baseline.json")
    org_raw = fixture("rdap-org-baseline.json")
    assert len(com_raw) == declared_length("rdap-com-baseline") == 2440
    assert len(org_raw) == declared_length("rdap-org-baseline") == 7261
    COM = rdap.parse_rdap_domain(200, com_raw)
    ORG = rdap.parse_rdap_domain(200, org_raw)

    com_doc = json.loads(com_raw.decode("utf-8"))
    org_doc = json.loads(org_raw.decode("utf-8"))
    assert len(com_doc) == 11 and len(org_doc) == 12
    # Verisign publishes `handle`; PIR redacts it. Neither is required by the parse.
    assert "handle" in com_doc and "handle" not in org_doc

    assert COM["ldh_name"] == "example.com" and ORG["ldh_name"] == "example.org"
    assert COM["registrar_iana_id"] == "376" == ORG["registrar_iana_id"]
    # Case is normalized: Verisign shouts its nameservers, PIR does not.
    assert COM["nameservers"] == ("elliott.ns.cloudflare.com", "hera.ns.cloudflare.com")
    assert ORG["nameservers"] == ("katelyn.ns.cloudflare.com", "mitch.ns.cloudflare.com")
    note("parsed both registries: .com %d bytes / %d keys / handle present, "
         ".org %d bytes / %d keys / handle redacted; both yield registrar IANA id 376"
         % (len(com_raw), len(com_doc), len(org_raw), len(org_doc)))


def test_event_parsing_is_independent_of_registry_ordering():
    """The load-bearing case: the same four events, two different orders."""
    com_order = [e["eventAction"] for e in
                 json.loads(fixture("rdap-com-baseline.json").decode("utf-8"))["events"]]
    org_order = [e["eventAction"] for e in
                 json.loads(fixture("rdap-org-baseline.json").decode("utf-8"))["events"]]
    assert com_order == ["registration", "expiration", "last changed",
                         "last update of RDAP database"]
    assert org_order == ["expiration", "registration", "last changed",
                         "last update of RDAP database"]
    assert com_order != org_order
    assert set(com_order) == set(org_order)

    com = rdap.parse_rdap_domain(200, fixture("rdap-com-baseline.json"))
    org = rdap.parse_rdap_domain(200, fixture("rdap-org-baseline.json"))
    assert com["event_actions"] == org["event_actions"]
    assert com["registration_at"] == "1995-08-14T04:00:00Z"
    assert com["expiration_at"] == "2027-08-13T04:00:00Z"
    assert com["last_changed_at"] == "2026-08-14T08:01:43Z"
    assert org["registration_at"] == "1995-08-31T04:00:00Z"
    assert org["expiration_at"] == "2026-08-30T04:00:00Z"
    assert org["last_changed_at"] == "2026-08-12T01:22:03.024Z"
    # Neither baseline has a transfer event, and that is None rather than a default date a
    # comparison could accidentally satisfy.
    assert com["transfer_at"] is None and org["transfer_at"] is None

    # An offset-based parser reading events positionally gets expiration where it wanted
    # registration on exactly one of the two. This is that bug, made explicit.
    positional_com = com_order[0]
    positional_org = org_order[0]
    assert positional_com == "registration" and positional_org == "expiration"
    note("event order differs across registries (.com starts registration, .org starts "
         "expiration) and both parse to the same 4 actions with correct dates")


def test_repeated_event_actions_select_the_latest():
    events = rdap.parse_events([
        {"eventAction": "transfer", "eventDate": "2020-01-01T00:00:00Z"},
        {"eventAction": "transfer", "eventDate": "2026-08-20T12:00:00Z"},
        {"eventAction": "registration", "eventDate": "1999-01-01T00:00:00Z"},
    ])
    assert events["transfer"] == ("2020-01-01T00:00:00Z", "2026-08-20T12:00:00Z")
    assert rdap.event_date(events, "transfer") == "2026-08-20T12:00:00Z"
    assert rdap.event_date(events, "TRANSFER") == "2026-08-20T12:00:00Z"
    assert rdap.event_date(events, "expiration") is None
    assert refusal(rdap.event_date, events, "expiration",
                   required=True).tag == rdap.TAG_EXTERNAL


def test_non_zulu_timestamps_are_refused_rather_than_mis_ordered():
    exc = refusal(rdap.assert_zulu_timestamp, "2026-08-20T12:00:00+02:00", "transfer")
    assert exc.tag == rdap.TAG_EXTERNAL
    assert "string ordering is unsafe" in exc.reason
    assert rdap.assert_zulu_timestamp("2026-08-12T01:22:03.024Z", "x").endswith("Z")


def test_client_versus_server_lock_distinction_is_preserved():
    """Both mean transfer prohibited. Only one of them the registrar can lift."""
    com = rdap.parse_rdap_domain(200, fixture("rdap-com-baseline.json"))
    org = rdap.parse_rdap_domain(200, fixture("rdap-org-baseline.json"))

    assert com["statuses"] == ("client delete prohibited", "client transfer prohibited",
                              "client update prohibited")
    assert org["statuses"] == ("server delete prohibited", "server transfer prohibited",
                              "server update prohibited")

    # Same conclusion about whether a transfer is blocked...
    assert com["transfer_locked"] is True and org["transfer_locked"] is True
    # ...and a different, preserved conclusion about who set it.
    assert com["transfer_lock_setters"] == ("client",)
    assert org["transfer_lock_setters"] == ("server",)
    assert com["locks"]["delete"]["setters"] == ("client",)
    assert org["locks"]["update"]["setters"] == ("server",)
    assert com["locks"]["renew"] == {"locked": False, "setters": ()}

    # Both parties at once is representable, because a real domain can carry both.
    both = rdap.parse_status_flags(["client transfer prohibited",
                                    "server transfer prohibited"])
    assert both["transfer_lock_setters"] == ("client", "server")
    # The camelCase EPP spelling normalizes to the same lock rather than to nothing.
    assert rdap.normalize_epp_status("clientTransferProhibited") == \
        "client transfer prohibited"
    assert rdap.parse_status_flags(["clientTransferProhibited"])[
        "transfer_lock_setters"] == ("client",)
    note("lock distinction preserved: .com transfer lock set by client (registrar, "
         "liftable), .org transfer lock set by server (registry, not liftable by the "
         "registrar); both report transfer_locked True")


def test_a_hold_is_detected_even_though_it_carries_no_prohibited_suffix():
    """`clientHold` is the status that removes a domain from DNS, and it is spelled apart.

    The other four locks are `<setter> <operation> prohibited`. A hold is `clientHold` or
    `serverHold` with no suffix, so one format string covering all five matches every lock
    except the only one that means the name is not resolving. The first version of this
    parser did exactly that, and a domain on `clientHold` read as unlocked all the way
    through: escrowable, and deliverable. That is why this test exists and why
    `LOCK_STATES` is separate from `LOCK_PROHIBITIONS`.
    """
    for spelling in (["clientHold"], ["client hold"]):
        flags = rdap.parse_status_flags(spelling)
        assert flags["locks"]["hold"] == {"locked": True, "setters": ("client",)}, spelling
    server = rdap.parse_status_flags(["serverHold"])
    assert server["locks"]["hold"] == {"locked": True, "setters": ("server",)}
    both = rdap.parse_status_flags(["clientHold", "serverHold"])
    assert both["locks"]["hold"]["setters"] == ("client", "server")

    # A hold is not a transfer prohibition, and a transfer prohibition is not a hold.
    held = rdap.parse_status_flags(["client hold"])
    assert held["transfer_locked"] is False
    locked = rdap.parse_status_flags(["client transfer prohibited"])
    assert locked["locks"]["hold"] == {"locked": False, "setters": ()}

    # And the suffix is not accepted for a state, because no registry emits it.
    assert rdap.parse_status_flags(["client hold prohibited"])["locks"]["hold"][
        "locked"] is False

    # Neither captured baseline is held, which is why the captures alone could not catch this.
    for name in ("rdap-com-baseline.json", "rdap-org-baseline.json"):
        parsed = rdap.parse_rdap_domain(200, fixture(name))
        assert parsed["locks"]["hold"] == {"locked": False, "setters": ()}, name
    note("hold detected as clientHold/serverHold rather than '... prohibited'; neither "
         "captured baseline carries a hold, so only a synthetic status array reaches it")


def test_nameserver_level_status_is_not_read_as_domain_status():
    """PIR gives every nameserver its own status ["associated"]. A recursive status scan
    would report a domain lock state that does not exist."""
    org_doc = json.loads(fixture("rdap-org-baseline.json").decode("utf-8"))
    assert [ns["status"] for ns in org_doc["nameservers"]] == [["associated"],
                                                              ["associated"]]
    org = rdap.parse_rdap_domain(200, fixture("rdap-org-baseline.json"))
    assert "associated" not in org["statuses"]
    assert all(s.startswith("server ") for s in org["statuses"])


def test_registrar_selection_is_by_role_and_ignores_the_nested_abuse_entity():
    com_doc = json.loads(fixture("rdap-com-baseline.json").decode("utf-8"))
    assert com_doc["entities"][0]["entities"][0]["roles"] == ["abuse"]
    registrar = rdap.select_registrar(com_doc["entities"])
    assert registrar["iana_id"] == "376"
    assert registrar["name"] == "RESERVED-Internet Assigned Numbers Authority"
    assert rdap.select_registrar(
        json.loads(fixture("rdap-org-baseline.json").decode("utf-8"))["entities"]
    )["name"] == "ICANN"
    assert refusal(rdap.select_registrar,
                   [{"roles": ["abuse"]}]).tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.select_registrar,
                   [{"roles": ["registrar"], "publicIds": [], "handle": "x"}]
                   ).tag == rdap.TAG_EXTERNAL   # handle must still be numeric
    two = [{"roles": ["registrar"], "handle": "1"}, {"roles": ["registrar"],
                                                     "handle": "2"}]
    assert "ambiguous" in refusal(rdap.select_registrar, two).reason


def test_the_zero_byte_404_is_handled_without_an_error_document():
    """Verisign answers a .com miss with 0 bytes and no RFC 9083 error object at all."""
    raw = fixture("rdap-not-found.json")
    assert len(raw) == 0 == declared_length("rdap-not-found")
    exc = refusal(rdap.parse_rdap_domain, 404, raw)
    assert exc.tag == rdap.TAG_EXTERNAL, exc.tag
    assert "no record" in exc.reason
    # And the forbidden inference is nowhere in the message.
    forbidden = route("rdap-not-found")["expect"]["must_not_be"]
    assert forbidden not in str(exc)
    assert "seller" not in str(exc).lower() and "control" not in str(exc).lower()
    # The same condition from PIR, which does return a rich error document, classifies the
    # same way. A parser that needed errorCode would pass here and fall through above.
    pir_style = json.dumps({
        "errorCode": 404, "title": "Domain not found",
        "description": ["The domain you requested does not exist in our database."],
        "rdapConformance": ["rdap_level_0"],
    }).encode("utf-8")
    assert refusal(rdap.parse_rdap_domain, 404, pir_style).tag == rdap.TAG_EXTERNAL
    # A 200 with an empty body is the same absence wearing a success code.
    assert refusal(rdap.parse_rdap_domain, 200, b"").tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_rdap_domain, 200, None).tag == rdap.TAG_EXTERNAL
    note("0-byte 404 classified [EXTERNAL] with no errorCode field present; the PIR-style "
         "rich 404 classifies identically, and neither message says anything about "
         "seller control")


def test_rdap_transport_failures_never_read_as_delivery():
    assert refusal(rdap.parse_rdap_domain, 429, b"").tag == rdap.TAG_TRANSIENT
    assert refusal(rdap.parse_rdap_domain, 403, b"").tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_rdap_domain, 503, b"").tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_rdap_domain, 302, b"body").tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_rdap_domain, 200, b"<html>nope").tag == rdap.TAG_EXTERNAL
    oversize = b'{"x":"' + b"a" * (rdap.MAX_RDAP_BYTES + 10) + b'"}'
    exc = refusal(rdap.parse_rdap_domain, 200, oversize)
    assert exc.tag == rdap.TAG_EXTERNAL and "bound" in exc.reason


def test_rdap_digest_excludes_the_database_timestamp():
    """`last update of RDAP database` moves on every request. Hashing it makes two honest
    validators disagree about a domain that did not change."""
    doc = json.loads(fixture("rdap-com-baseline.json").decode("utf-8"))
    first = rdap.rdap_digest(rdap.parse_rdap_domain(200, json.dumps(doc).encode("utf-8")))
    for event in doc["events"]:
        if event["eventAction"] == "last update of RDAP database":
            event["eventDate"] = "2026-12-31T23:59:59Z"
    second = rdap.rdap_digest(rdap.parse_rdap_domain(200, json.dumps(doc).encode("utf-8")))
    assert first == second, "the database timestamp leaked into the digest"
    # A real change does move it.
    doc["status"] = ["client transfer prohibited"]
    third = rdap.rdap_digest(rdap.parse_rdap_domain(200, json.dumps(doc).encode("utf-8")))
    assert third != first
    note("rdap_digest is stable across the moving `last update of RDAP database` event and "
         "changes on a real status change (%s...)" % first[:16])


def test_rdap_is_fetched_through_the_injected_fetch():
    network = net()
    base = rdap.registry_base_for_domain(BOOTSTRAP, "example.com")
    parsed = rdap.fetch_rdap_domain(make_fetch(network), base, "example.com")
    assert parsed["registrar_iana_id"] == "376"
    assert network.served == ["rdap-com-baseline"]
    # An unrouted URL is a transport failure, never an empty success.
    exc = refusal(rdap.fetch_rdap_domain, make_fetch(net()),
                  "https://rdap.nowhere.example/", "example.com")
    assert exc.tag == rdap.TAG_TRANSIENT


# --- the two uncaptured fixtures. Written in full; skipped, never faked. ----------------


def test_pending_transfer_fixture():
    raw = require_fixture("rdap-pending-transfer.json")
    expect = route("rdap-pending-transfer")["expect"]
    parsed = rdap.parse_rdap_domain(200, raw)
    assert expect["status_contains"] in parsed["statuses"]
    assert parsed["pending_transfer"] is True
    assert expect["status_contains"] in parsed["pending_statuses"]
    assert parsed["registrar_iana_id"].isdigit()
    note("pending-transfer fixture parsed: statuses %s" % (parsed["statuses"],))


def test_transfer_complete_fixture():
    raw = require_fixture("rdap-transfer-complete.json")
    expect = route("rdap-transfer-complete")["expect"]
    parsed = rdap.parse_rdap_domain(200, raw)
    assert expect["events_contains"] in parsed["event_actions"]
    assert parsed["transfer_at"] is not None
    rdap.assert_zulu_timestamp(parsed["transfer_at"], "transfer eventDate")
    assert parsed["pending_transfer"] is False
    if expect.get("registrar_changed"):
        baseline = rdap.parse_rdap_domain(200, require_fixture("rdap-pending-transfer.json"))
        assert parsed["registrar_iana_id"] != baseline["registrar_iana_id"]
        assert parsed["transfer_at"] > (baseline["last_changed_at"] or "")
    note("transfer-complete fixture parsed: transfer at %s, registrar %s"
         % (parsed["transfer_at"], parsed["registrar_iana_id"]))


# ======================================================================================
# 3. Two-resolver DoH TXT corroboration
# ======================================================================================


def test_the_finding_byte_for_byte_disagrees_and_normalized_agrees():
    """The point of the module, made executable.

    Same two captured fixtures, opposite verdicts. Naive byte-for-byte comparison of the
    `data` fields says the two resolvers disagree on both records. Normalized comparison
    says they agree on both.
    """
    cf_raw = fixture("doh-cloudflare-txt.json")
    gg_raw = fixture("doh-google-txt.json")

    # No absolute literal on these two lengths, unlike the RDAP assertions further up, and the
    # reason is a measurement rather than a preference. A DoH body's length is not a stable
    # quantity. Cloudflare reports its own remaining cache TTL, so the digit count changes with
    # it: 58 at the first capture and 299 at the second is one extra digit across two answers,
    # exactly the two bytes by which this file grew. Google adds a Comment naming the anycast
    # node that answered, and that string's length changes too, which is the one byte by which
    # its file grew. Freezing 276 and 315 into the test is what made these two assertions fail
    # on a re-capture that was more correct than the capture it replaced. The manifest and the
    # file are promoted together, so comparing them to each other is the claim worth making.
    assert len(cf_raw) == declared_length("doh-cloudflare-txt")
    assert len(gg_raw) == declared_length("doh-google-txt")
    assert len(cf_raw) != len(gg_raw)

    cf_doc = json.loads(cf_raw.decode("utf-8"))
    gg_doc = json.loads(gg_raw.decode("utf-8"))

    # --- verdict one: byte for byte, the comparison a contract writes by accident -------
    naive_cf = [a["data"] for a in cf_doc["Answer"]]
    naive_gg = [a["data"] for a in gg_doc["Answer"]]
    assert naive_cf != naive_gg
    per_record = [a == b for a, b in zip(naive_cf, naive_gg)]
    assert per_record == [False, False], per_record
    assert len(naive_cf[0].encode("utf-8")) == 13
    assert len(naive_gg[0].encode("utf-8")) == 11
    # The TTL claim, structurally rather than numerically. Google reports the authoritative 300
    # every time; Cloudflare reports whatever is left of its own cache entry, which is why this
    # is the field that moves and why the module excludes it from the digest.
    cf_ttl, gg_ttl = cf_doc["Answer"][0]["TTL"], gg_doc["Answer"][0]["TTL"]
    assert gg_ttl == 300, gg_ttl
    assert 0 < cf_ttl <= 300, cf_ttl
    assert cf_ttl != gg_ttl, (cf_ttl, gg_ttl)
    assert "Comment" not in cf_doc and "Comment" in gg_doc
    assert cf_doc["Question"][0]["name"] == "example.com"
    assert gg_doc["Question"][0]["name"] == "example.com."

    # --- verdict two: normalized, the comparison the module performs -------------------
    cf = rdap.parse_doh(200, cf_raw, rdap.DOH_CLOUDFLARE)
    gg = rdap.parse_doh(200, gg_raw, rdap.DOH_GOOGLE)
    assert cf.values == gg.values, (cf.values, gg.values)
    assert cf.qname == gg.qname == "example.com"
    result = rdap.corroborate(cf, gg)
    assert result.agreed is True, result.reason
    assert result.tag is None
    assert len(result.digest) == 64
    result.require_agreement()

    note("THE FINDING: byte-for-byte the two captured answers disagree on 2 of 2 records "
         "(cloudflare %d B quoted / TTL %d / no Comment / name %r against google %d B "
         "unquoted / TTL %d / Comment present / name %r); normalized they agree on 2 of "
         "2 and corroborate, digest %s..."
         % (len(naive_cf[0].encode("utf-8")), cf_ttl, cf_doc["Question"][0]["name"],
            len(naive_gg[0].encode("utf-8")), gg_ttl, gg_doc["Question"][0]["name"],
            result.digest[:16]))


def test_every_excluded_field_is_actually_excluded():
    """One mutation per line of PROOF_EXCLUDED, so the comment cannot drift from the code."""
    base = json.loads(fixture("doh-google-txt.json").decode("utf-8"))

    def observe(doc, resolver="google"):
        return rdap.parse_doh(200, json.dumps(doc).encode("utf-8"), resolver)

    reference = observe(base)
    canonical = rdap.canonical_control_proof(reference.qname, reference.values)

    mutations = {
        "TTL": lambda d: [a.update({"TTL": 99999}) for a in d["Answer"]],
        "Comment": lambda d: d.update({"Comment": "Response from 8.8.8.8."}),
        "Comment absent": lambda d: d.pop("Comment", None),
        "trailing root label": lambda d: [
            a.update({"name": a["name"].rstrip(".")}) for a in d["Answer"]]
        + [d["Question"][0].update({"name": d["Question"][0]["name"].rstrip(".")})],
        "name case": lambda d: d["Question"][0].update(
            {"name": d["Question"][0]["name"].upper()}),
        "Answer order": lambda d: d["Answer"].reverse(),
        "Authority section": lambda d: d.update(
            {"Authority": [{"name": "com.", "type": 6, "TTL": 900, "data": "junk"}]}),
        "Additional section": lambda d: d.update({"Additional": [{"data": "junk"}]}),
        "AD flag": lambda d: d.update({"AD": False}),
        "CD flag": lambda d: d.update({"CD": True}),
        "TC flag": lambda d: d.update({"TC": True}),
        "RD flag": lambda d: d.update({"RD": False}),
        "RA flag": lambda d: d.update({"RA": False}),
        "TXT quoting": lambda d: [
            a.update({"data": '"%s"' % a["data"]}) for a in d["Answer"]],
    }
    for label, mutate in sorted(mutations.items()):
        doc = json.loads(json.dumps(base))
        mutate(doc)
        mutated = observe(doc)
        assert rdap.canonical_control_proof(mutated.qname, mutated.values) == canonical, \
            "%s changed the canonical proof but is documented as excluded" % label
        assert rdap.corroborate(reference, mutated).agreed is True, label

    # And the one thing that is compared does change it.
    doc = json.loads(json.dumps(base))
    doc["Answer"][0]["data"] = "v=spf1 -all-changed"
    assert rdap.corroborate(reference, observe(doc)).agreed is False
    note("all %d documented exclusions verified by %d mutations (TTL, Comment, quoting, "
         "root label, name case, Answer order, Authority, Additional, TC/RD/RA/AD/CD); "
         "changing a TXT value does break agreement"
         % (len(rdap.PROOF_EXCLUDED), len(mutations)))


def test_nxdomain_has_no_answer_key_and_arrives_with_http_200():
    """Both resolvers' real NXDOMAIN bodies, which is a change from how this test began.

    It used to read one captured body and hand the same bytes to both resolvers, because only
    Google's NXDOMAIN had been captured. That passes, and it proves less than it appears to: a
    two-resolver agreement test in which both sides are the same body cannot detect a shape
    difference between the resolvers, which is the entire subject of this module. Cloudflare's
    NXDOMAIN was captured on 2026-08-25 to close that, and the two bodies do differ (273 B with
    no Comment against 322 B with an Authority section), so the corroboration below is now
    between two genuinely different documents that happen to mean the same thing.
    """
    cf_raw = fixture("doh-cloudflare-nxdomain.json")
    gg_raw = fixture("doh-google-nxdomain.json")
    assert len(cf_raw) == declared_length("doh-cloudflare-nxdomain")
    assert len(gg_raw) == declared_length("doh-google-nxdomain")

    cf_doc = json.loads(cf_raw.decode("utf-8"))
    gg_doc = json.loads(gg_raw.decode("utf-8"))
    cf_expect = route("doh-cloudflare-nxdomain")["expect"]
    gg_expect = route("doh-google-nxdomain")["expect"]

    assert cf_doc["Status"] == cf_expect["dns_status"] == 3
    assert gg_doc["Status"] == gg_expect["dns_status"] == 3
    assert ("Answer" in cf_doc) is cf_expect["has_Answer"] is False
    assert ("Answer" in gg_doc) is gg_expect["has_Answer"] is False
    assert ("Comment" in cf_doc) is cf_expect["has_Comment"] is False
    assert ("Authority" in gg_doc) is gg_expect["has_Authority"] is True
    assert "Authority" in gg_doc   # present, and never a proof source

    obs = rdap.parse_doh(200, gg_raw, rdap.DOH_GOOGLE)   # HTTP 200, note
    assert obs.nxdomain is True
    assert obs.has_answer is False
    assert obs.values == ()
    assert obs.qname == "nonexistent-conveyance-fixture-xyz123.com"

    # Two resolvers both saying the name does not exist is [EXTERNAL]: nothing observed.
    both = rdap.corroborate(obs, rdap.parse_doh(200, cf_raw, rdap.DOH_CLOUDFLARE))
    assert both.agreed is False and both.tag == rdap.TAG_EXTERNAL
    assert rdap.classify_proof(both, "token")["outcome"] == rdap.PROOF_NAME_MISSING

    # NOERROR with no Answer is a different absence: the name exists, the TXT set does not.
    nodata = rdap.parse_doh(200, json.dumps({
        "Status": 0, "Question": [{"name": "example.com.", "type": 16}]
    }).encode("utf-8"), rdap.DOH_GOOGLE)
    assert nodata.nxdomain is False and nodata.has_answer is False
    absent = rdap.corroborate(nodata, nodata)
    assert absent.agreed is False and absent.tag == rdap.TAG_EXTERNAL

    # A name that exists with a TXT set that lacks the token is the third case, and it is
    # retryable because propagation may be incomplete.
    present = rdap.parse_doh(200, fixture("doh-google-txt.json"), rdap.DOH_GOOGLE)
    found = rdap.corroborate(present, present)
    verdict = rdap.classify_proof(found, "_not_the_token_on_the_record")
    assert verdict["outcome"] == rdap.PROOF_ABSENT
    assert verdict["tag"] == rdap.TAG_TRANSIENT
    note("three absences kept distinct: NXDOMAIN (name gone, [EXTERNAL]), NOERROR/NODATA "
         "(no TXT set, [EXTERNAL]) and token-not-in-an-existing-TXT-set (PROOF_ABSENT, "
         "[TRANSIENT]); none of them is delivery")


def test_rfc1035_multi_chunk_values_join_deterministically():
    """A value over 255 octets arrives as several character-strings that a client joins."""
    assert rdap.normalize_txt_value('"chunk1" "chunk2"') == "chunk1chunk2"
    assert rdap.normalize_txt_value('"chunk1""chunk2"') == "chunk1chunk2"
    assert rdap.normalize_txt_value("chunk1chunk2") == "chunk1chunk2"
    assert rdap.normalize_txt_value('"v=spf1 -all"') == "v=spf1 -all"
    assert rdap.normalize_txt_value("v=spf1 -all") == "v=spf1 -all"
    assert rdap.normalize_txt_value('"a\\"b"') == 'a"b'
    assert rdap.normalize_txt_value('"\\065\\066"') == "AB"

    # A real 300-octet value: 255 + 45, which is exactly why the split exists.
    long_value = "d" * 255 + "e" * 45
    assert len(long_value) == 300 > rdap.TXT_CHUNK_LIMIT
    quoted = '"%s" "%s"' % ("d" * 255, "e" * 45)
    assert rdap.normalize_txt_value(quoted) == long_value
    assert rdap.normalize_txt_value(long_value) == long_value

    # And the two presentations corroborate: Cloudflare-style quoted chunks against
    # Google-style pre-joined, same record, agreement.
    def doh(data, name="example.com."):
        return json.dumps({"Status": 0, "Question": [{"name": name, "type": 16}],
                           "Answer": [{"name": name, "type": 16, "TTL": 58,
                                       "data": data}]}).encode("utf-8")

    cf = rdap.parse_doh(200, doh(quoted, "example.com"), rdap.DOH_CLOUDFLARE)
    gg = rdap.parse_doh(200, doh(long_value), rdap.DOH_GOOGLE)
    assert cf.values == gg.values == (long_value,)
    assert rdap.corroborate(cf, gg).agreed is True

    # Malformed presentations fail closed rather than silently truncating. An empty value
    # is absence, so it refuses instead of entering a comparison as an agreed empty proof.
    for bad in ('"unterminated', '"a" trailing', '""', '"\\999"', "", '"" ""'):
        assert refusal(rdap.normalize_txt_value, bad).tag == rdap.TAG_EXTERNAL, bad
    over = '"%s"' % ("z" * 256)
    assert "exceeds 255" in refusal(rdap.normalize_txt_value, over).reason
    note("RFC 1035 chunk join verified on a 300-octet value (255+45): quoted chunks, "
         "unquoted pre-joined and adjacent chunks all normalize identically and "
         "corroborate")


def test_the_one_ambiguous_presentation_is_closed_off_at_the_token():
    """A bare unquoted `a b` cannot be told from a single string containing a space, so the
    proof token is required to be whitespace-free instead."""
    assert rdap.normalize_txt_value("chunk1 chunk2") == "chunk1 chunk2"   # verbatim
    assert rdap.assert_proof_token_shape("_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9")
    for bad in ("has space", 'has"quote', "has\\backslash", "", "a\tb", "x" * 256):
        assert refusal(rdap.assert_proof_token_shape, bad).tag == rdap.TAG_EXPECTED
    assert len(rdap.commitment_digest("token-abc")) == 64
    assert rdap.commitment_digest("token-abc") != rdap.commitment_digest("token-abd")


def test_only_the_answer_section_can_carry_a_proof():
    doc = {"Status": 0, "Question": [{"name": "example.com.", "type": 16}],
           "Authority": [{"name": "example.com.", "type": 16, "TTL": 60,
                          "data": "planted-by-the-seller"}],
           "Additional": [{"name": "example.com.", "type": 16, "TTL": 60,
                           "data": "also-planted"}]}
    obs = rdap.parse_doh(200, json.dumps(doc).encode("utf-8"), rdap.DOH_GOOGLE)
    assert obs.values == () and obs.has_answer is False
    # A CNAME in front of the TXT set is tolerated, and a chain is bounded.
    with_cname = dict(doc)
    with_cname["Answer"] = [
        {"name": "p.example.com.", "type": 5, "TTL": 60, "data": "q.example.com."},
        {"name": "q.example.com.", "type": 16, "TTL": 60, "data": "the-token"},
    ]
    obs = rdap.parse_doh(200, json.dumps(with_cname).encode("utf-8"), rdap.DOH_GOOGLE)
    assert obs.values == ("the-token",) and obs.cname_hops == 1
    looping = dict(doc)
    looping["Answer"] = [{"name": "x", "type": 5, "TTL": 1, "data": "y"}
                         for _ in range(rdap.MAX_CNAME_HOPS + 1)]
    exc = refusal(rdap.parse_doh, 200, json.dumps(looping).encode("utf-8"), "google")
    assert exc.tag == rdap.TAG_EXTERNAL and "CNAME hops" in exc.reason


def test_the_disagreement_fixture_refuses_to_settle():
    raw = fixture("doh-disagreement.json")
    expect = route("doh-disagreement")["expect"]
    assert len(raw) == declared_length("doh-disagreement") == 370
    doc = json.loads(raw.decode("utf-8"))
    # Derived from the real Google capture, so it differs in exactly one respect: the two
    # TXT values. Unquoted like the real capture, so a refusal cannot be blamed on quoting.
    assert doc["Status"] == 0 and doc["Answer"][0]["TTL"] == 300
    assert not doc["Answer"][0]["data"].startswith('"')
    assert ".invalid" in doc["Answer"][0]["data"]   # RFC 2606, cannot collide

    truth = rdap.parse_doh(200, fixture("doh-google-txt.json"), rdap.DOH_GOOGLE)
    liar = rdap.parse_doh(200, raw, rdap.DOH_CLOUDFLARE)
    assert truth.qname == liar.qname == "example.com"      # same question
    assert truth.values != liar.values                     # different answer

    result = rdap.corroborate(truth, liar)
    assert result.agreed is expect["corroborated"] is False
    assert result.tag == rdap.TAG_TRANSIENT, result.tag
    assert "not corroborated" in result.reason
    assert result.digest is None            # nothing to record as a settled proof
    assert result.values == ()
    exc = refusal(result.require_agreement)
    assert exc.tag == rdap.TAG_TRANSIENT

    # And the refusal survives the token lookup: no outcome here is PROOF_FOUND.
    verdict = rdap.classify_proof(result, "_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9")
    assert verdict["outcome"] == rdap.PROOF_ABSENT
    assert verdict["tag"] == rdap.TAG_TRANSIENT
    note("doh-disagreement refuses to settle: agreed False, [TRANSIENT], digest None, "
         "outcome PROOF_ABSENT even though one resolver carries the real token")


def test_one_resolver_is_never_enough():
    only = rdap.parse_doh(200, fixture("doh-google-txt.json"), rdap.DOH_GOOGLE)
    result = rdap.corroborate(only)
    assert result.agreed is False and result.tag == rdap.TAG_TRANSIENT
    assert "at least two" in result.reason
    # One resolver up and one NXDOMAIN is incomplete propagation, not a verdict. Cloudflare's
    # own NXDOMAIN body, not Google's relabelled, so the resolver named in the reason is the
    # resolver the bytes came from.
    gone = rdap.parse_doh(200, fixture("doh-cloudflare-nxdomain.json"), rdap.DOH_CLOUDFLARE)
    split = rdap.corroborate(only, gone)
    assert split.agreed is False and split.tag == rdap.TAG_TRANSIENT
    assert "NXDOMAIN from cloudflare" in split.reason


def test_cloudflare_400s_without_the_accept_header():
    """Reproduced through the manifest's requires_header, so a future edit that drops the
    header fails on a laptop instead of inside a consensus round."""
    entry = route("doh-cloudflare-txt")
    assert entry["requires_header"] == {"Accept": "application/dns-json"}
    assert entry["missing_header_status"] == 400
    assert "requires_header" not in route("doh-google-txt")   # Google needs no header

    # With the header, which fetch_doh_txt always sends.
    network = net()
    obs = rdap.fetch_doh_txt(make_fetch(network), rdap.DOH_CLOUDFLARE, "example.com")
    assert obs.has_answer is True and len(obs.values) == 2
    assert network.served == ["doh-cloudflare-txt"]
    assert network.calls == [
        ("GET", "https://cloudflare-dns.com/dns-query?name=example.com&type=TXT")]

    # Without it: HTTP 400, and a refusal that names the cause.
    stripped = net()
    exc = refusal(rdap.fetch_doh_txt, make_fetch(stripped, drop_headers=True),
                  rdap.DOH_CLOUDFLARE, "example.com")
    assert exc.tag == rdap.TAG_EXTERNAL, exc.tag
    assert "400" in exc.reason and "application/dns-json" in exc.reason

    # Google answers the same stripped request, which is what makes the asymmetry a trap:
    # one resolver keeps working, so a dropped header looks like one resolver failing.
    google = rdap.fetch_doh_txt(make_fetch(net(), drop_headers=True), rdap.DOH_GOOGLE,
                                "example.com")
    assert google.has_answer is True
    assert rdap.DOH_HEADERS == {"Accept": "application/dns-json"}
    note("Cloudflare 400s without Accept: application/dns-json while Google still answers "
         "200; fetch_doh_txt sends the header to both unconditionally")


def test_doh_transport_failures_never_read_as_delivery():
    assert refusal(rdap.parse_doh, 429, b"{}").tag == rdap.TAG_TRANSIENT
    assert refusal(rdap.parse_doh, 403, b"{}").tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_doh, 200, b"").tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_doh, 200, b"not json").tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_doh, 200, b'{"Status":2}').tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_doh, 200, b'{"Status":5}').tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.parse_doh, 200, b'{"TC":false}').tag == rdap.TAG_EXTERNAL
    assert refusal(rdap.doh_txt_url, "quad9", "example.com").tag == rdap.TAG_EXPECTED
    assert refusal(rdap.parse_doh, 200,
                   b'{"Status":0,"Question":[]}').tag == rdap.TAG_EXTERNAL


def test_full_corroborated_fetch_through_both_resolvers():
    network = net()
    result = rdap.fetch_corroborated_txt(make_fetch(network), "example.com")
    assert result.agreed is True
    assert network.served == ["doh-cloudflare-txt", "doh-google-txt"]
    verdict = rdap.classify_proof(result, "_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9")
    assert verdict["outcome"] == rdap.PROOF_FOUND and verdict["tag"] is None
    assert verdict["digest"] == result.digest
    assert result.compared == rdap.PROOF_COMPARED
    assert len(result.excluded) == len(rdap.PROOF_EXCLUDED) == 8


def test_taxonomy_has_exactly_the_four_tags():
    tags = {rdap.TAG_EXPECTED, rdap.TAG_EXTERNAL, rdap.TAG_TRANSIENT, rdap.TAG_LLM_ERROR}
    assert tags == {"[EXPECTED]", "[EXTERNAL]", "[TRANSIENT]", "[LLM_ERROR]"}
    assert rdap.Refusal(rdap.TAG_LLM_ERROR, "x").tag == "[LLM_ERROR]"


# ======================================================================================
# Runner
# ======================================================================================


def main():
    tests = [(name, obj) for name, obj in sorted(globals().items())
             if name.startswith("test_") and callable(obj)]
    passed = failed = skipped = 0
    failures = []
    print("rdap.py unit tests: %d cases\n" % len(tests))
    for name, fn in tests:
        try:
            fn()
        except unittest.SkipTest as exc:
            skipped += 1
            print("  SKIP %s" % name)
            print("       %s" % str(exc).replace("\n", " ")[:200])
        except Exception as exc:  # noqa: BLE001
            failed += 1
            failures.append((name, exc))
            print("  FAIL %s" % name)
            print("       %s: %s" % (type(exc).__name__, str(exc)[:400]))
        else:
            passed += 1
            print("  ok   %s" % name)

    print("\n--- measured, this run " + "-" * 54)
    for line in NOTES:
        print("  * " + line)

    print("\n%d passed, %d failed, %d skipped" % (passed, failed, skipped))
    if failures:
        print("\nfirst failure traceback:")
        import traceback
        name, exc = failures[0]
        traceback.print_exception(type(exc), exc, exc.__traceback__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
