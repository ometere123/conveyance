"""`open_deal` under the real GenVM SDK: what it stores, what it refuses, and what it never writes.

This is the only payable entry point in the contract, so it carries more weight than the rest of
the file put together. Three properties are worth the real SDK rather than a stub.

THE DETERMINISTIC PREFIX. Every check before the first network call has to be reachable without a
network, because the interface's rehearsal depends on it: it runs this exact call with no value
attached and reads the refusal back before a wallet is ever opened. The tests for those refusals
install no mocks at all. That is the assertion, not an omission. A check that had drifted below the
first fetch would fail with an unmocked-request error instead of its own refusal.

THE ESCROW STRING. `"a deal needs an escrow; this call carried no value"` is matched verbatim by
the offer form's rehearsal, which is how the interface tells a caller "your inputs are fine, now
attach the escrow". Asserted here character for character, because a reworded refusal would leave
the form silently unable to recognise the one refusal it must recognise.

WHERE THE MONEY GOES WHEN THE ANSWER IS NO. `open_deal` refunds and returns rather than reverting.
That is not a stylistic choice: this chain rolls storage back on a revert but keeps
`gl.message.value`, which was measured on a live deployment and not assumed, so a reverting payable
method charges the caller for being told no. Every refusal below therefore has two halves, and
`declined` checks both: the tagged reason reached the caller, and the wei that came in went back
out to the caller who sent it. A contract that kept the money and explained why would pass the
first half on its own.

WHAT A REFUSAL LEAVES BEHIND. The direct harness performs no rollback, so a write that happened
before the contract finished deciding stays visible instead of being undone. That is a limitation
for most purposes and exactly the instrument needed here: a refused deal that had already appended
to `deal_ids` or bumped a counter would be caught, and on this contract it matters more than usual
because a refusal now returns normally rather than unwinding.
"""

import json

import pytest

from conftest import address_hex, numeric_constant, set_block_time
import evidence
import lifecycle
from evidence import BASELINE_NAMESERVERS, BASELINE_REGISTRAR_ID, BASELINE_STATUSES
from lifecycle import (
    ACCEPT_DEADLINE,
    COMMITMENT,
    DOMAIN,
    ESCROW,
    OPENED_AT as START,
    TARGET_JOINED,
    TARGET_NAMESERVERS,
    TARGET_REGISTRAR,
    open_args,
)


@pytest.fixture
def sources(direct_vm):
    return evidence.Sources(direct_vm)


def opened(contract, direct_vm, value_ledger, sources, seller, **overrides):
    """A deal at OFFERED against the real `.com` capture, with the escrow recorded as sent.

    The buyer is whoever `direct_vm.sender` already is, because several tests below set it to
    someone other than Alice and a helper that reset it would quietly undo them.
    """
    return lifecycle.open_deal(
        contract, direct_vm, value_ledger, sources, direct_vm.sender, seller, **overrides
    )


def declined(contract, direct_vm, value_ledger, expected, **overrides):
    """Call `open_deal` expecting a refusal, and assert the escrow came straight back.

    The return value carries the reason. A successful `open_deal` returns a sentence starting
    with the deal id, so the leading `[` is the contract's own marker for "declined, nothing
    stored", and it is asserted separately from the wording: a refusal that lost its tag would
    still contain the expected phrase, and a caller deciding whether to retry needs the tag.

    The refund is asserted to the wei and to the recipient, against the exact amount this test
    attached. Anything looser would pass on a contract that refunded a different sum, or the
    right sum to the wrong address.
    """
    sender = direct_vm.sender
    attached = int(direct_vm.value)
    before = len(value_ledger.transfers)

    said = contract.open_deal(*open_args(**overrides))

    assert said.startswith("["), f"a refusal has to arrive tagged, got {said[:90]!r}"
    assert expected in said, f"expected {expected!r} in the refusal, got {said!r}"

    moved = value_ledger.transfers[before:]
    if attached > 0:
        assert moved == [(address_hex(sender), attached)], (
            f"{attached} wei came in and this is what went out: {moved}"
        )
    else:
        assert moved == [], f"no value was attached, so nothing should move: {moved}"
    return said


# ----------------------------------------------------------------------------------------------
# What it stores
# ----------------------------------------------------------------------------------------------


def test_a_deal_records_what_the_registry_said_and_not_what_the_caller_claimed(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The 48-field dataclass round trips through real storage, with the baseline from the bytes.

    Every baseline field below is read out of the captured Verisign document rather than supplied
    by the caller, which is the property that makes the deal a record of the registry's opinion.
    A stub could store the caller's own claim and look identical from the return string.
    """
    direct_vm.sender = direct_alice
    said = opened(contract, direct_vm, value_ledger, sources, direct_bob)

    deal = contract.get_deal("deal-1")
    assert deal["state"] == "OFFERED"
    assert deal["buyer"] == str(direct_alice)
    assert deal["seller"] == str(direct_bob)
    assert deal["domain"] == DOMAIN
    assert deal["tld"] == "com"
    assert deal["rdap_base"] == "https://rdap.verisign.com/com/v1/"
    assert deal["escrow"] == str(ESCROW)
    assert deal["target_registrar_id"] == TARGET_REGISTRAR
    assert deal["target_nameservers"] == TARGET_JOINED

    assert deal["baseline_registrar_id"] == BASELINE_REGISTRAR_ID
    assert deal["baseline_registrar_name"] == "RESERVED-Internet Assigned Numbers Authority"
    assert deal["baseline_nameservers"] == ",".join(
        sorted(host.lower() for host in BASELINE_NAMESERVERS)
    )
    assert deal["baseline_statuses"] == ",".join(BASELINE_STATUSES)
    assert deal["baseline_last_changed_at"] == "2026-08-14T08:01:43Z"
    assert len(deal["baseline_digest"]) == 64
    assert deal["baseline_digest"] == deal["baseline_digest"].lower()

    # The capture has no transfer event, and an absent one is stored absent rather than as a
    # date. `_transfer_is_newer` reads "" as "any transfer is newer", so inventing one here
    # would be inventing the fact that decides delivery.
    assert deal["baseline_transfer_at"] == ""

    assert deal["opened_at"] == START
    assert deal["accept_deadline"] == ACCEPT_DEADLINE
    for field in ("armed_at", "transfer_deadline", "verified_at", "inspection_deadline",
                  "closed_at", "last_check_at", "last_proof_outcome", "buyer_proof_token"):
        assert deal.get(field, "") == "", field
    assert deal["paid_to_seller"] == "0"
    assert deal["returned_to_buyer"] == "0"
    assert deal["checks"] == "0"

    assert deal["seller_proof_name"] == f"_conveyance-seller.{DOMAIN}"
    assert deal["buyer_proof_name"] == f"_conveyance-buyer.{DOMAIN}"
    # `.as_hex` and not `{direct_bob}`. See the note in conftest: the SDK's `Address` formats as
    # its repr inside an f-string, so an interpolated address would compare a token against
    # `Address("0x…")` and fail for a reason that has nothing to do with the contract.
    assert deal["seller_proof_token"] == "v1;deal=deal-1;seller=" + direct_bob.as_hex.lower()
    assert deal["buyer_proof_commitment"] == COMMITMENT

    # The token has to be all lower case, and this is the layer that can prove it. `as_hex` returns
    # the EIP-55 checksummed form, so `_proof_token` lowercases it explicitly rather than trusting
    # the SDK to hand back a canonical case.
    #
    # WHY THIS IS AN ASSERTION AND NOT A COMMENT. The token is compared to a TXT value byte for
    # byte: `classify_proof` asks `expected_token in corroboration.values`, and
    # `canonical_control_proof` normalizes the query name but never the values. So the case the
    # contract picks here is the case the seller has to publish. On a live deployment this token
    # was stored as `seller=0xac3AC69dC0Bde389256dD6748C75817ead9286D9` while the offer form
    # displayed the same line lowercased, which meant a seller who copied the line the interface
    # gave them could not arm the deal at all. The failure was worse than a refusal: an absent
    # proof is tagged `[TRANSIENT]` and reads as "may be incomplete propagation", so it would have
    # told the seller to wait for a propagation that was never going to help.
    #
    # Lower case is also the safer thing to ask a human to put in a zone file, and it is what the
    # buyer's side already used, so both proof tokens now carry one convention instead of two.
    # `tests/frontend/proof-records.test.ts` asserts the browser half produces no upper case, and
    # the two assertions together are what keep the ends from drifting apart again.
    assert deal["seller_proof_token"] == deal["seller_proof_token"].lower()
    assert direct_bob.as_hex.lower() in deal["seller_proof_token"]

    # The return string is what a caller reads, so it has to carry the two figures a caller
    # cannot otherwise see: the registrar the domain is at today and the deadline.
    assert "OFFERED" in said
    assert BASELINE_REGISTRAR_ID in said
    assert ACCEPT_DEADLINE in said
    assert deal["seller_proof_token"] in said


def test_a_client_transfer_lock_is_recorded_and_named_rather_than_refused(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The captured document carries `clientTransferProhibited`, and the deal opens anyway.

    This is the distinction the contract exists to draw. A client lock is the losing registrar's
    to lift on the registrant's instruction, so it is a thing the seller has to do and not a
    reason the deal cannot be made. A server lock is the registry's and is refused; that case is
    below. Reading them as one would refuse most well-run domains.
    """
    direct_vm.sender = direct_alice
    said = opened(contract, direct_vm, value_ledger, sources, direct_bob)

    assert contract.get_deal("deal-1")["baseline_client_transfer_locked"] == "True"
    assert "client transfer prohibition" in said
    assert "can lift" in said


def test_two_deals_accumulate_in_the_counters_and_keep_their_order(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """`u256` sums, `DynArray.append` order, and both `TreeMap` writes, over two deals.

    The second deal is served an RDAP document whose `ldhName` is the second domain, because the
    contract compares the answer's name to the name it asked about and a registry answering about
    someone else is a `[TRANSIENT]` revert rather than a record.
    """
    direct_vm.sender = direct_alice
    opened(contract, direct_vm, value_ledger, sources, direct_bob)

    set_block_time(direct_vm, "2026-03-01T06:00:00Z")
    sources.serve(rdap_body=evidence.rdap(ldh_name="SECOND.COM"))
    value_ledger.fund(2 * 10 ** 18)
    contract.open_deal(*open_args(deal_id="deal-2", domain="second.com", seller=str(direct_bob)))

    ledger = contract.ledger()
    assert ledger["deals_opened"] == "2"
    assert ledger["total_escrowed"] == str(ESCROW + 2 * 10 ** 18)
    assert ledger["held"] == str(ESCROW + 2 * 10 ** 18)
    assert ledger["total_released"] == "0"
    assert ledger["total_refunded"] == "0"

    listed = contract.list_deals()
    assert [row["deal_id"] for row in listed] == ["deal-1", "deal-2"]
    assert [row["domain"] for row in listed] == [DOMAIN, "second.com"]
    assert [row["escrow"] for row in listed] == [str(ESCROW), str(2 * 10 ** 18)]

    # The domain index is the second TreeMap, and it is what makes a deal findable by name.
    assert contract.delivery_status("second.com")["deal_id"] == "deal-2"
    assert contract.delivery_status("SECOND.COM.")["deal_id"] == "deal-2"
    assert contract.delivery_status("never-opened.com") == {}


def test_an_escrow_at_the_ceiling_is_held_exactly_and_a_wei_over_it_is_refused(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The boundary, at a figure no float could carry.

    The ceiling is 100 GEN, which is 10^20 wei and forty-seven bits past where a double starts
    rounding. Under a stub that stored a Python int this proves little; under the real SDK the
    field is a `u256` and the stored figure has to come back to the wei.
    """
    ceiling = numeric_constant("MAX_DEAL_VALUE_WEI")
    assert ceiling > 2 ** 53

    direct_vm.sender = direct_alice
    opened(contract, direct_vm, value_ledger, sources, direct_bob, escrow=ceiling)
    assert contract.get_deal("deal-1")["escrow"] == str(ceiling)
    assert contract.ledger()["total_escrowed"] == str(ceiling)

    set_block_time(direct_vm, START)
    sources.serve(rdap_body=evidence.rdap(ldh_name="OVER.COM"))
    value_ledger.fund(ceiling + 1)
    declined(contract, direct_vm, value_ledger, "over this deployment's",
             deal_id="over", domain="over.com", seller=str(direct_bob))


# ----------------------------------------------------------------------------------------------
# The escrow refusal the interface rehearses against
# ----------------------------------------------------------------------------------------------


def test_a_call_carrying_no_value_is_refused_in_the_words_the_offer_form_matches(
    contract, direct_vm, direct_alice, direct_bob, value_ledger
):
    """Verbatim, because the interface matches on this string.

    The offer form runs this exact call with no value attached and treats this refusal as
    "your inputs are fine, now attach the escrow". Any other wording and the form cannot tell
    that refusal apart from a real problem with the arguments, so it would either block a valid
    offer or wave through an invalid one.

    No mocks are installed: the refusal has to fire before the first fetch, which is what makes
    the rehearsal free of network flakiness as well as free of a signature.
    """
    set_block_time(direct_vm, START)
    direct_vm.sender = direct_alice
    value_ledger.no_value()

    declined(contract, direct_vm, value_ledger,
             "[EXPECTED] a deal needs an escrow; this call carried no value",
             seller=str(direct_bob))


def test_a_refused_deal_leaves_no_trace_of_itself_in_storage(
    contract, direct_vm, direct_alice, direct_bob, value_ledger
):
    """The harness keeps writes that preceded a refusal, so this can be checked rather than assumed.

    A premature `deal_ids.append` or counter bump would be undone by a revert on chain, and this
    method no longer reverts: it returns normally, so a write made before the contract had
    finished deciding would survive on chain exactly as it survives here. That makes this test
    load-bearing rather than belt-and-braces. If it ever fails, a refused offer is leaving a deal
    behind it in the register.
    """
    set_block_time(direct_vm, START)
    direct_vm.sender = direct_alice
    value_ledger.no_value()

    declined(contract, direct_vm, value_ledger, "a deal needs an escrow", seller=str(direct_bob))

    assert contract.list_deals() == []
    assert contract.get_deal("deal-1") == {}
    assert contract.delivery_status(DOMAIN) == {}
    ledger = contract.ledger()
    assert ledger["deals_opened"] == "0"
    assert ledger["total_escrowed"] == "0"
    assert ledger["held"] == "0"
    assert value_ledger.transfers == []


# ----------------------------------------------------------------------------------------------
# The deterministic refusals, none of which may reach the network
# ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides, expected",
    [
        ({"deal_id": ""}, "deal_id must be 1 to"),
        ({"deal_id": "a" * 65}, "deal_id must be 1 to"),
        ({"deal_id": "deal 1"}, "deal_id may hold letters, digits, dot, dash and underscore"),
        ({"deal_id": "deal/1"}, "is not one of those"),
        ({"domain": ""}, "[EXPECTED]"),
        ({"domain": "no-dot"}, "[EXPECTED]"),
        ({"domain": "bücher.example"}, "[EXPECTED]"),
        ({"target_registrar_id": ""}, "target_registrar_id must be 1 to"),
        ({"target_registrar_id": "GoDaddy"}, "The registrar's name is not accepted"),
        ({"target_registrar_id": "1234567890123"}, "target_registrar_id must be 1 to"),
        ({"target_nameservers": ""}, "must be a JSON array of at least"),
        ({"target_nameservers": "ns1.a.example,ns2.a.example"}, "must be valid JSON"),
        ({"target_nameservers": '{"a": 1}'}, "must be a JSON array, got dict"),
        ({"target_nameservers": '["ns1.a.example"]'}, "needs at least 2 distinct names, got 1"),
        (
            {"target_nameservers": '["ns1.a.example", "NS1.A.EXAMPLE."]'},
            "needs at least 2 distinct names, got 1",
        ),
        ({"target_nameservers": '["ns1.a.example", "localhost"]'}, "is not a dotted host name"),
        ({"target_nameservers": '["ns1.a.example", "ns2 a.example"]'}, "disallowed character"),
        ({"target_nameservers": '["ns1.a.example", ""]'}, "must be a non-empty string"),
        (
            {"target_nameservers": json.dumps([f"ns{n}.a.example" for n in range(9)])},
            "over the 8 cap",
        ),
        ({"buyer_proof_commitment": ""}, "must be 64 lowercase hex characters, got 0"),
        ({"buyer_proof_commitment": "a" * 63}, "must be 64 lowercase hex characters, got 63"),
        ({"buyer_proof_commitment": "z" * 64}, "must be hex"),
        ({"seller": ""}, "seller is required"),
        ({"seller": "0x" + "00" * 20}, "seller must not be the zero address"),
        ({"seller": "0xnot-an-address"}, "[EXPECTED]"),
    ],
)
def test_every_deterministic_refusal_fires_before_the_first_fetch(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, overrides, expected
):
    """One case per rule, with no network available to any of them.

    The escrow is attached here, so each case reaches its own rule rather than stopping at the
    value check, and no mock is installed, so a rule that had drifted below the first fetch would
    fail with an unmocked-request error rather than its own words. That ordering is what lets the
    interface rehearse the whole prefix with no value attached, and this is where it is checked.

    Each case also proves its escrow came back, which matters most here: these are the refusals a
    caller trips over by mistyping an argument, and they are the ones that would have cost a real
    buyer the price of the domain.
    """
    set_block_time(direct_vm, START)
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    if "seller" not in overrides:
        overrides = {**overrides, "seller": str(direct_bob)}

    declined(contract, direct_vm, value_ledger, expected, **overrides)

    assert contract.list_deals() == []


def test_the_seller_may_not_also_be_the_buyer(
    contract, direct_vm, direct_alice, value_ledger
):
    """`Address` equality, which is the thing a stub is most likely to get right by accident.

    The comparison is `seller_address == buyer`, between an `Address` built from a caller's
    string and the one the SDK put in `gl.message.sender_address`. Under the real SDK those are
    two separately constructed objects, so the equality has to be by value.
    """
    set_block_time(direct_vm, START)
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)
    declined(contract, direct_vm, value_ledger, "seller must not be the buyer",
             seller=str(direct_alice))

    # Lowercase, so the check cannot be passing on string identity of the checksummed form.
    value_ledger.fund(ESCROW)
    declined(contract, direct_vm, value_ledger, "seller must not be the buyer",
             seller=str(direct_alice).lower())


def test_a_second_deal_cannot_take_an_id_or_a_domain_that_is_already_live(
    contract, direct_vm, direct_alice, direct_bob, direct_charlie, value_ledger, sources
):
    """Both `TreeMap` membership tests, and the domain one names the deal already holding it."""
    direct_vm.sender = direct_alice
    opened(contract, direct_vm, value_ledger, sources, direct_bob)

    set_block_time(direct_vm, START)
    value_ledger.fund(ESCROW)
    declined(contract, direct_vm, value_ledger, "deal 'deal-1' already exists",
             domain="other.com", seller=str(direct_bob))

    # A different buyer and a different id, on the domain that is already in escrow. The reason
    # is the one that matters: one transfer must not be able to settle two deals.
    direct_vm.sender = direct_charlie
    value_ledger.fund(ESCROW)
    declined(contract, direct_vm, value_ledger, "already covers example.com",
             deal_id="deal-2", seller=str(direct_bob))

    assert [row["deal_id"] for row in contract.list_deals()] == ["deal-1"]
    assert contract.ledger()["deals_opened"] == "1"


def test_a_closed_deal_does_not_brick_the_domain_for_ever(
    contract, direct_vm, direct_alice, direct_bob, direct_charlie, value_ledger, sources
):
    """A domain whose sale fell through has to be sellable again.

    The index that stops two live escrows on one name is never cleared, so for a while this
    contract refused a domain permanently once any deal on it existed. That was found by
    exercising the deployment rather than by reading it: a real deal was opened on StudioNet,
    abandoned, and then could not be reopened, which would mean one failed sale retires a
    domain from the register for the life of the deployment.

    The guard's own wording was always "a second *live* escrow", and this is that word made
    true. What must still be refused is the case the index exists for, so both halves are
    asserted here: live predecessor refused, closed predecessor superseded.
    """
    direct_vm.sender = direct_alice
    opened(contract, direct_vm, value_ledger, sources, direct_bob)

    # Still live, so still refused, and the refusal now names the state it is refusing on.
    set_block_time(direct_vm, START)
    direct_vm.sender = direct_charlie
    value_ledger.fund(ESCROW)
    declined(contract, direct_vm, value_ledger, "already covers example.com and is OFFERED",
             deal_id="deal-2", seller=str(direct_bob))

    # The buyer walks away. The escrow goes back and the deal reaches a terminal state.
    direct_vm.sender = direct_alice
    contract.abandon("deal-1")
    assert contract.get_deal("deal-1")["state"] == "REFUNDED"

    # Now the same domain accepts a new deal, from a different buyer and under a new id.
    lifecycle.open_deal(
        contract, direct_vm, value_ledger, sources, direct_charlie, direct_bob, deal_id="deal-2"
    )

    # Both deals are on the record, in the order they were opened, and neither overwrote the
    # other. The domain index points at the newer one, which is what `delivery_status` reads.
    assert [row["deal_id"] for row in contract.list_deals()] == ["deal-1", "deal-2"]
    assert contract.ledger()["deals_opened"] == "2"
    assert contract.delivery_status(DOMAIN)["deal_id"] == "deal-2"
    assert contract.get_deal("deal-1")["state"] == "REFUNDED"
    assert contract.get_deal("deal-2")["state"] == "OFFERED"


def test_an_unusable_block_datetime_stops_the_deal_rather_than_dating_it_to_the_epoch(
    contract, direct_vm, direct_alice, direct_bob, value_ledger
):
    """`_require_now` refuses a clock it cannot read, and says so as `[EXTERNAL]`.

    Every deadline in this contract is derived from this one string, so a missing block datetime
    that fell back to zero would produce a deal whose accept deadline passed in 1970 and whose
    escrow was refundable on the block it was created. It is `[EXTERNAL]` and not `[EXPECTED]`
    because nothing about the caller's request was wrong.
    """
    set_block_time(direct_vm, "")
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    declined(contract, direct_vm, value_ledger, "[EXTERNAL] the block datetime is unusable",
             seller=str(direct_bob))

    assert contract.list_deals() == []


@pytest.mark.parametrize(
    "opened_at, deadline",
    [
        # 48 hours across a leap day that exists, so the 29th has to be counted.
        ("2028-02-28T23:00:00Z", "2028-03-01T23:00:00Z"),
        # And across one that does not: 2100 is divisible by 100 and not by 400.
        ("2100-02-28T23:00:00Z", "2100-03-02T23:00:00Z"),
        # A month rollover, and a year rollover carrying the day and hour with it.
        ("2026-01-30T12:00:00Z", "2026-02-01T12:00:00Z"),
        ("2026-12-31T12:00:00Z", "2027-01-02T12:00:00Z"),
        # A leap second is not a thing RDAP publishes, but a 23:59:59 open is, and it rolls twice.
        ("2026-06-29T23:59:59Z", "2026-07-01T23:59:59Z"),
    ],
)
def test_the_deadline_arithmetic_survives_the_dates_a_date_library_would_have_handled(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources, opened_at, deadline
):
    """`_add_seconds` is hand-written, and it decides who gets the money.

    GenVM offers no date library inside a deterministic block, so the contract counts days and
    rolls months itself. That code is 40 lines of arithmetic standing between a seller and a
    refund, and the branches worth testing are exactly the ones a person gets wrong: a leap day
    that exists, a century year that is not a leap year, and a rollover at both ends.
    """
    direct_vm.sender = direct_alice
    opened(contract, direct_vm, value_ledger, sources, direct_bob, now=opened_at)

    deal = contract.get_deal("deal-1")
    assert deal["opened_at"] == opened_at
    assert deal["accept_deadline"] == deadline


# ----------------------------------------------------------------------------------------------
# The refusals that need the registry to have answered
# ----------------------------------------------------------------------------------------------


def test_a_domain_already_at_the_target_registrar_has_nothing_to_deliver(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """A deal for a transfer to where the domain already is would settle on no work at all."""
    set_block_time(direct_vm, START)
    sources.serve(rdap_body=evidence.rdap())
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    declined(contract, direct_vm, value_ledger, BASELINE_REGISTRAR_ID,
             seller=str(direct_bob), target_registrar_id=BASELINE_REGISTRAR_ID)
    assert contract.list_deals() == []


def test_a_transfer_already_in_flight_is_refused_rather_than_escrowed(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """`pendingTransfer` at deal creation means the work this escrow would pay for is underway.

    This is one of the refusals that sit after the network call, so no rehearsal can rule it out
    in advance. That is exactly why the refund matters: the caller did nothing wrong and the
    registry's answer changed under them between the rehearsal and the call.
    """
    set_block_time(direct_vm, START)
    sources.serve(rdap_body=evidence.rdap(statuses=["pending transfer"]))
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    declined(contract, direct_vm, value_ledger, "transfer already in flight",
             seller=str(direct_bob))
    assert contract.list_deals() == []


def test_a_server_lock_is_refused_because_only_the_registry_can_lift_it(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The other side of the client-versus-server distinction, and the reason it is drawn."""
    set_block_time(direct_vm, START)
    sources.serve(rdap_body=evidence.rdap(statuses=["server transfer prohibited"]))
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    declined(contract, direct_vm, value_ledger, "only the registry can lift",
             seller=str(direct_bob))
    assert contract.list_deals() == []


@pytest.mark.parametrize("status", ["client hold", "server hold", "pending delete"])
def test_a_domain_out_of_the_root_zone_or_on_its_way_out_is_refused(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources, status
):
    """The three statuses that mean the domain is not deliverable whoever sponsors it.

    A hold pulls the name out of DNS, so the buyer's control proof could never be published and
    the deal could not complete. `pending delete` is the registry saying the name is leaving.
    Delete and update prohibitions are deliberately not in this list, and the deal that opens
    above with `clientDeleteProhibited` set is what shows the difference is intended.
    """
    set_block_time(direct_vm, START)
    sources.serve(rdap_body=evidence.rdap(statuses=[status]))
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    declined(contract, direct_vm, value_ledger, "[EXPECTED]", seller=str(direct_bob))
    assert contract.list_deals() == []


def test_a_registry_answering_about_another_domain_is_transient_and_decides_nothing(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """An `ldhName` that is not the name asked about is a mismatch, never a record.

    `[TRANSIENT]` rather than `[EXPECTED]`, because nothing was observed about the domain in
    question and the right thing for a caller to do is retry. The tag surviving the refund is the
    point: a refusal flattened to one word would tell this caller to give up.
    """
    set_block_time(direct_vm, START)
    sources.serve(rdap_body=evidence.rdap(ldh_name="SOMEONE-ELSE.COM"))
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    declined(contract, direct_vm, value_ledger, "[TRANSIENT]", seller=str(direct_bob))
    assert contract.list_deals() == []


def test_a_registry_that_did_not_answer_is_external_and_writes_nothing(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The 404 capture is zero bytes, which is what Verisign actually returns for an unknown name.

    Tagged `[EXTERNAL]` rather than `[EXPECTED]`, and the distinction is deliberate rather than a
    slip. A 404 reads like a verdict, but it is not a verdict any registry publishes consistently:
    some return it for a name outside the service's scope and some for a throttled client, so
    treating it as "this domain does not exist" would turn a rate limit into a fact about
    somebody's registration. `[EXTERNAL]` says only that the source did not give an answer this
    contract can act on, which is all a 404 supports.

    This is the case that decided the refund. A registry being unreachable is nobody's fault and
    retrying is the correct response, so a version of this method that reverted would have taken
    the buyer's escrow for an outage, and taken it again on every retry.
    """
    set_block_time(direct_vm, START)
    sources.serve(rdap_status=404, rdap_body=evidence.raw("rdap-not-found"))
    direct_vm.sender = direct_alice
    value_ledger.fund(ESCROW)

    declined(contract, direct_vm, value_ledger, "[EXTERNAL] RDAP returned 404",
             seller=str(direct_bob))
    assert contract.list_deals() == []
    assert contract.ledger()["total_escrowed"] == "0"
