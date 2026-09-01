"""The bytes these tests answer the network with, and where they come from.

EVERY BODY HERE STARTS AS A REAL CAPTURE. The four DoH bodies and the two RDAP bodies in
`fixtures/` were fetched from Cloudflare, Google, Verisign and PIR and are byte-identical to
`_build/fixtures/conveyance/`, which the offline harness reads. Nothing in this module writes a
response from scratch: each builder loads the capture, substitutes only the field under test, and
leaves the rest exactly as it arrived. That is what keeps the parser's real opinions in play. A
hand-written DoH body would omit Google's `Comment`, would not disagree with Cloudflare about the
root label or about literal quoting, and would quietly stop exercising the four measured
divergences that are the whole reason the corroboration rule looks the way it does. A hand-written
RDAP body would drop the nested abuse entity that `select_registrar` must not pick, the `notices`
array, `secureDNS`, and the real event set.

WHAT IS SYNTHESIZED, AND WHY IT HAS TO BE. Two things cannot be captured.

A control-proof token is derived from a deal id and an address, so no record published on the
public internet can contain the token belonging to a test's address. Every proof body here
therefore carries a substituted TXT value.

A completed cross-registrar transfer needs the same domain's RDAP record before and after the
transfer, and this project has one live capture per domain. `manifest.json` reserves two routes
for it, `rdap-pending-transfer` and `rdap-transfer-complete`, both marked `routing: blocked` with
`captured_url: "TO FILL: the real transfer domain"`, and the offline harness raises
`FixtureNotCaptured` rather than green-ticking them. Until those land, a delivered record in this
suite is the `.com` capture with its registrar entity, its transfer event and its nameservers
substituted. So the assertions below are about what the contract concludes from a record of that
shape, and never a claim that this repository has watched a transfer complete. When the real
captures arrive, `delivered()` is what they replace.
"""

import json
from copy import deepcopy
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"

#: Every URL the contract can reach, as the pattern that answers it. `mock_web` matches these
#: against the URL the contract built, so a pattern that stops matching is a URL the contract
#: changed, and the test fails with an unmocked-request error rather than passing on a stale body.
URL_BOOTSTRAP = r".*data\.iana\.org/rdap/dns\.json.*"
URL_RDAP_COM = r".*rdap\.verisign\.com/com/v1/domain/.*"
URL_RDAP_ORG = r".*rdap\.publicinterestregistry\.org.*"
URL_CLOUDFLARE = r".*cloudflare-dns\.com/dns-query.*"
URL_GOOGLE = r".*dns\.google/resolve.*"

#: The registrar the `.com` capture is actually sponsored by, read once here so no test repeats it.
BASELINE_REGISTRAR_ID = "376"
BASELINE_NAMESERVERS = ["ELLIOTT.NS.CLOUDFLARE.COM", "HERA.NS.CLOUDFLARE.COM"]
BASELINE_STATUSES = [
    "client delete prohibited",
    "client transfer prohibited",
    "client update prohibited",
]

_cache: dict[str, bytes] = {}


def raw(name: str) -> bytes:
    """One capture, verbatim, cached so the 71 KB bootstrap is read once per session."""
    if name not in _cache:
        _cache[name] = (FIXTURES / f"{name}.json").read_bytes()
    return _cache[name]


def _document(name: str) -> dict:
    return json.loads(raw(name).decode("utf-8"))


def _encode(document: dict) -> bytes:
    return json.dumps(document).encode("utf-8")


# ----------------------------------------------------------------------------------------------
# RDAP
# ----------------------------------------------------------------------------------------------


def rdap(
    *,
    registrar_id: str = BASELINE_REGISTRAR_ID,
    registrar_name: str | None = None,
    statuses: list[str] | None = None,
    nameservers: list[str] | None = None,
    transfer_at: str | None = None,
    last_changed: str | None = None,
    ldh_name: str | None = None,
) -> bytes:
    """The `.com` capture with only the named fields changed.

    `registrar_id` is written to both the entity handle and the IANA Registrar ID publicId,
    because those are the two places a registrar identifies itself in an RDAP record and a
    document where they disagree is not a document any registry publishes.

    `transfer_at` appends a real `transfer` event rather than rewriting an existing one, which
    is how a registry publishes one: the registration and expiration events stay where they are.
    """
    document = deepcopy(_document("rdap-com-baseline"))

    for entity in document["entities"]:
        if "registrar" in entity.get("roles", []):
            entity["handle"] = registrar_id
            for public_id in entity.get("publicIds", []):
                if public_id.get("type") == "IANA Registrar ID":
                    public_id["identifier"] = registrar_id
            if registrar_name is not None:
                for field in entity["vcardArray"][1]:
                    if field[0] == "fn":
                        field[3] = registrar_name

    if statuses is not None:
        document["status"] = list(statuses)
    if nameservers is not None:
        document["nameservers"] = [
            {"objectClassName": "nameserver", "ldhName": host} for host in nameservers
        ]
    if ldh_name is not None:
        document["ldhName"] = ldh_name

    if transfer_at is not None:
        document["events"].append({"eventAction": "transfer", "eventDate": transfer_at})
    if last_changed is not None:
        for event in document["events"]:
            if event["eventAction"] == "last changed":
                event["eventDate"] = last_changed

    return _encode(document)


def delivered(
    *,
    registrar_id: str,
    nameservers: list[str],
    transfer_at: str = "2026-03-05T09:14:22Z",
) -> bytes:
    """An RDAP record of the shape a completed transfer produces.

    Synthesized, and the file header says why: the two captures that would show this are the
    ones waiting on a real transfer. The locks are cleared here because a registrar clears
    `clientTransferProhibited` before a transfer can start and the gaining registrar sets its
    own afterwards, so a delivered record carrying the losing registrar's transfer lock would
    be a record no registry publishes.
    """
    return rdap(
        registrar_id=registrar_id,
        registrar_name="Gaining Registrar, Inc.",
        statuses=["client delete prohibited", "client update prohibited"],
        nameservers=nameservers,
        transfer_at=transfer_at,
        last_changed=transfer_at,
    )


# ----------------------------------------------------------------------------------------------
# DNS over HTTPS
# ----------------------------------------------------------------------------------------------


def doh_txt(resolver: str, name: str, values: list[str]) -> bytes:
    """One resolver's TXT answer for `name`, in that resolver's own presentation format.

    The format differences are the captured ones and they are deliberate. Cloudflare drops the
    root label from the query name and wraps each character-string in literal quotes; Google
    keeps the root label, publishes the value bare, and adds a `Comment` naming the machine that
    answered. The TTLs differ by one second in the captures for the same reason they differ in
    life: each resolver reports its own remaining cache time. Every one of those is an axis the
    contract excludes from comparison, so a builder that normalised them would remove the only
    evidence that the exclusion works.
    """
    document = deepcopy(_document(f"doh-{resolver}-txt"))
    template = deepcopy(document["Answer"][0])
    quoted = str(template["data"]).startswith('"')
    rooted = str(document["Question"][0]["name"]).endswith(".")

    qname = f"{name}." if rooted else name
    document["Question"][0]["name"] = qname
    document["Answer"] = []
    for value in values:
        record = deepcopy(template)
        record["name"] = qname
        record["data"] = f'"{value}"' if quoted else value
        document["Answer"].append(record)

    return _encode(document)


def doh_nxdomain(resolver: str, name: str) -> bytes:
    """The captured NXDOMAIN body, asked about a different name.

    The Authority SOA section is left exactly as captured. It has to be: the contract's rule
    that the Authority section is never a proof source is only tested by a body that has one.
    """
    document = deepcopy(_document(f"doh-{resolver}-nxdomain"))
    rooted = str(document["Question"][0]["name"]).endswith(".")
    document["Question"][0]["name"] = f"{name}." if rooted else name
    return _encode(document)


# ----------------------------------------------------------------------------------------------
# Installing them
# ----------------------------------------------------------------------------------------------


class Sources:
    """The network, for one test.

    `serve` clears the mock table before every registration, and that is the point of the class
    rather than an implementation detail. Mock lookup returns the FIRST pattern that matches, so
    registering a second answer for a URL that already has one is silently ignored: a second
    consensus round would re-read the first round's bodies, and the test would pass while
    measuring the wrong thing. Clearing on the way in makes that mistake unavailable, which is
    better than a comment asking each test to remember.
    """

    def __init__(self, vm):
        self._vm = vm
        self.rounds = 0

    def serve(
        self,
        *,
        rdap_body: bytes | None = None,
        rdap_status: int = 200,
        cloudflare: bytes | None = None,
        google: bytes | None = None,
        bootstrap: bytes | None = None,
        bootstrap_status: int = 200,
    ) -> None:
        """Answer this round. Anything not named here is left unmocked and will raise if fetched."""
        self._vm.clear_mocks()
        self.rounds += 1

        self._vm.mock_web(
            URL_BOOTSTRAP,
            {
                "status": bootstrap_status,
                "body": raw("iana-rdap-bootstrap") if bootstrap is None else bootstrap,
            },
        )
        if rdap_body is not None or rdap_status != 200:
            self._vm.mock_web(
                URL_RDAP_COM,
                {"status": rdap_status, "body": rdap_body if rdap_body is not None else b""},
            )
        if cloudflare is not None:
            self._vm.mock_web(URL_CLOUDFLARE, {"status": 200, "body": cloudflare})
        if google is not None:
            self._vm.mock_web(URL_GOOGLE, {"status": 200, "body": google})

    def proof(self, name: str, values: list[str], **kwargs) -> None:
        """Both resolvers agreeing on `values` at `name`, each in its own format."""
        self.serve(
            cloudflare=doh_txt("cloudflare", name, values),
            google=doh_txt("google", name, values),
            **kwargs,
        )
