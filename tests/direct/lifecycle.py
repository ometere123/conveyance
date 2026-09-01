"""One deal's lifecycle, written once, so three test files agree on what a deal is.

The terms below are the same terms in every file in this suite. Held in one place because the
alternative is three copies that drift: a nameserver changed in one file and not another produces
a delivery that verifies in one test and stalls at AWAITING_DELEGATION in the next, and the
difference reads like a contract bug for as long as it takes to notice.

The stage helpers each drive one real state transition against real fetched bytes, and each
returns the contract's own return string, because that string is what a caller reads and several
tests assert on it. They deliberately do not assert anything themselves: a helper that checked
the state it produced would make every test that uses it also a test of the helper, and a failure
would point at the wrong line.
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone

import evidence
from conftest import set_block_time

DOMAIN = "example.com"
DEAL_ID = "deal-1"

#: The registrar the buyer wants the domain moved to. Not 376, which is where the capture says it
#: is, because a deal to move a domain to where it already sits is refused at creation.
TARGET_REGISTRAR = "1910"
TARGET_NAMESERVERS = ["ns1.buyer.example", "ns2.buyer.example"]
TARGET_JOINED = "ns1.buyer.example,ns2.buyer.example"

ESCROW = 5 * 10 ** 18

#: The buyer's token and its digest. The token carries a secret because a seller who could guess
#: it could publish the buyer's record and forge the buyer's side of DNS control, which is the
#: reason the contract takes a commitment at creation and the token itself only later.
BUYER_TOKEN = "conveyance-buyer-v1;secret=8e1d4f2a9c"
COMMITMENT = hashlib.sha256(BUYER_TOKEN.encode("utf-8")).hexdigest()

SELLER_PROOF_NAME = f"_conveyance-seller.{DOMAIN}"
BUYER_PROOF_NAME = f"_conveyance-buyer.{DOMAIN}"

#: The clock, laid out once. Each instant is inside the window the stage before it opened, and
#: the two deadlines are what `ACCEPT_WINDOW_SECONDS`, `TRANSFER_WINDOW_SECONDS` and
#: `INSPECTION_WINDOW_SECONDS` come to from these instants.
OPENED_AT = "2026-03-01T00:00:00Z"
ACCEPT_DEADLINE = "2026-03-03T00:00:00Z"
ARMED_AT = "2026-03-01T06:00:00Z"
TRANSFER_DEADLINE = "2026-03-11T06:00:00Z"
DELIVERED_AT = "2026-03-02T06:00:00Z"
INSPECTION_DEADLINE = "2026-03-05T06:00:00Z"
TRANSFER_EVENT_AT = "2026-03-02T05:00:00Z"


def plus_seconds(iso: str, seconds: int) -> str:
    """The same instant, later, in the format the contract's own arithmetic produces.

    Written with `datetime` on purpose. The contract computes deadlines by hand because GenVM has
    no date library, and a test that reused that arithmetic would agree with a bug in it. This is
    the independent second opinion, and it is only used to sit either side of a boundary the
    contract chose.
    """
    moment = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (moment + timedelta(seconds=int(seconds))).strftime("%Y-%m-%dT%H:%M:%SZ")


def open_args(**overrides) -> list:
    """The six arguments to `open_deal` in order, so each test names only the one it is about."""
    args = {
        "deal_id": DEAL_ID,
        "domain": DOMAIN,
        "seller": None,
        "target_registrar_id": TARGET_REGISTRAR,
        "target_nameservers": json.dumps(TARGET_NAMESERVERS),
        "buyer_proof_commitment": COMMITMENT,
    }
    args.update(overrides)
    return [
        args["deal_id"],
        args["domain"],
        args["seller"],
        args["target_registrar_id"],
        args["target_nameservers"],
        args["buyer_proof_commitment"],
    ]


def open_deal(contract, vm, ledger, sources, buyer, seller, *, now=OPENED_AT,
              escrow=ESCROW, rdap_body=None, **overrides) -> str:
    """OFFERED. The registry answers with the capture, so the baseline is the real one."""
    set_block_time(vm, now)
    sources.serve(rdap_body=evidence.rdap() if rdap_body is None else rdap_body)
    vm.sender = buyer
    ledger.fund(escrow)
    return contract.open_deal(*open_args(seller=str(seller), **overrides))


def arm(contract, vm, sources, seller, *, deal_id=DEAL_ID, now=ARMED_AT, token=None,
        proof_name=SELLER_PROOF_NAME) -> str:
    """LOCKED. Both resolvers publish the seller's token, which is the acceptance.

    `token` defaults to reading the token off the deal rather than rebuilding it, because the
    token embeds the seller's EIP-55 address and a rebuilt one would differ from the stored one
    in case alone. That difference is invisible in a diff and fatal to a TXT comparison.
    """
    if token is None:
        token = contract.get_deal(deal_id)["seller_proof_token"]
    set_block_time(vm, now)
    sources.proof(proof_name, [token])
    vm.sender = seller
    return contract.arm(deal_id)


def check(contract, vm, sources, caller, *, deal_id=DEAL_ID, now=DELIVERED_AT,
          token=BUYER_TOKEN, rdap_body=None, registrar_id=TARGET_REGISTRAR,
          nameservers=None, transfer_at=TRANSFER_EVENT_AT, proof_values=None,
          proof_name=BUYER_PROOF_NAME, nxdomain=False) -> str:
    """One `check_transfer`, with the registry and both resolvers answering in one round.

    The defaults describe a completed transfer: the domain is at the target registrar, delegated
    to the buyer's nameservers, carrying a transfer event later than the deal's baseline, and the
    buyer's proof is corroborated. Each of those is a keyword so a test can spoil exactly one and
    leave the other three intact, which is the only way to attribute an outcome to a cause.
    """
    body = rdap_body if rdap_body is not None else evidence.delivered(
        registrar_id=registrar_id,
        nameservers=TARGET_NAMESERVERS if nameservers is None else nameservers,
        transfer_at=transfer_at,
    )
    set_block_time(vm, now)
    if nxdomain:
        sources.serve(
            rdap_body=body,
            cloudflare=evidence.doh_nxdomain("cloudflare", proof_name),
            google=evidence.doh_nxdomain("google", proof_name),
        )
    else:
        sources.proof(
            proof_name,
            [token] if proof_values is None else proof_values,
            rdap_body=body,
        )
    vm.sender = caller
    return contract.check_transfer(deal_id, token)


def settle(contract, vm, sources, caller, *, deal_id=DEAL_ID, now=DELIVERED_AT,
           token=BUYER_TOKEN, registrar_id=TARGET_REGISTRAR, nameservers=None,
           transfer_at=TRANSFER_EVENT_AT, proof_values=None,
           proof_name=BUYER_PROOF_NAME) -> str:
    """RELEASED. `settle` re-fetches everything, so the round has to be served again.

    Serving it again is not a convenience of the harness. The contract re-verifies delivery here
    against the registry and both resolvers rather than trusting the row it wrote at
    `check_transfer`, and a test that could settle without answering the network would not be
    exercising that.
    """
    set_block_time(vm, now)
    sources.proof(
        proof_name,
        [token] if proof_values is None else proof_values,
        rdap_body=evidence.delivered(
            registrar_id=registrar_id,
            nameservers=TARGET_NAMESERVERS if nameservers is None else nameservers,
            transfer_at=transfer_at,
        ),
    )
    vm.sender = caller
    return contract.settle(deal_id)


def to_verified(contract, vm, ledger, sources, buyer, seller, **kwargs) -> None:
    """Open, arm and check, leaving one deal at VERIFIED with its escrow held."""
    open_deal(contract, vm, ledger, sources, buyer, seller,
              escrow=kwargs.pop("escrow", ESCROW))
    arm(contract, vm, sources, seller)
    check(contract, vm, sources, buyer, **kwargs)
