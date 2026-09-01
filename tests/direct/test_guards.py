"""Who may move a deal, when, and on what evidence.

Every guard in this contract answers one of two questions, and the tests are grouped that way.

WHOSE CALL IS IT. Three restrictions and three deliberate absences, and the split is an argument
rather than a convention. `arm` is the seller's alone, because arming starts a ten-day clock
against the buyer. `abandon` from LOCKED is the seller's alone, because a buyer who could cancel
at will could let a real transfer complete and then walk off with the price. `settle` inside the
inspection window is the buyer's alone, because the window is the buyer's to close. Everything
else, `check_transfer` and `refund` included, is callable by anyone: delivery is a fact about
public records, and a refund can only ever go to the buyer.

WHAT COUNTS AS EVIDENCE. Arming is not a signature. A seller proves DNS control by publishing a
TXT record that two independent resolvers agree on, and a seller who cannot do that has no
operational relationship with the domain. Delivery is not the buyer's word either. The incomplete
outcomes are recorded rather than reverted, because a third party who ran a check has produced
information the deal should carry, and the transfer deadline keeps running through all of them.

The reversal tests at the end are the narrowest part of the contract and the part with a stated
residual risk. Each of the three conditions is spoiled on its own, because a reversal that fired
on any two of them would hand the buyer a way to keep the domain and take back the price.
"""

import pytest

from conftest import numeric_constant, set_block_time, str_constant
import evidence
import lifecycle
from evidence import BASELINE_NAMESERVERS, BASELINE_REGISTRAR_ID
from lifecycle import (
    ACCEPT_DEADLINE,
    ARMED_AT,
    BUYER_TOKEN,
    DEAL_ID,
    DELIVERED_AT,
    ESCROW,
    INSPECTION_DEADLINE,
    SELLER_PROOF_NAME,
    TARGET_NAMESERVERS,
    TARGET_REGISTRAR,
    TRANSFER_DEADLINE,
    TRANSFER_EVENT_AT,
)

#: Read out of the contract rather than restated here. The interface switches on these strings,
#: which makes them part of the contract's surface rather than private labels.
OUT_AWAITING_TRANSFER = str_constant("OUT_AWAITING_TRANSFER")
OUT_AWAITING_DELEGATION = str_constant("OUT_AWAITING_DELEGATION")
OUT_AWAITING_DNS = str_constant("OUT_AWAITING_DNS")
OUT_SUSPENDED = str_constant("OUT_SUSPENDED")
OUT_VERIFIED = str_constant("OUT_VERIFIED")
OUT_REVERSED = str_constant("OUT_REVERSED")
PROOF_FOUND = str_constant("PROOF_FOUND")
CHECK_INTERVAL = numeric_constant("CHECK_INTERVAL_SECONDS")


@pytest.fixture
def sources(direct_vm):
    return evidence.Sources(direct_vm)


@pytest.fixture
def offered(contract, direct_vm, direct_alice, direct_bob, value_ledger, sources):
    """One deal at OFFERED: Alice buying, Bob selling, 5 GEN in escrow."""
    lifecycle.open_deal(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)
    return contract.get_deal(DEAL_ID)


@pytest.fixture
def locked(contract, direct_vm, direct_bob, sources, offered):
    """The same deal armed, so the ten-day transfer window is running."""
    lifecycle.arm(contract, direct_vm, sources, direct_bob)
    return contract.get_deal(DEAL_ID)


@pytest.fixture
def verified(contract, direct_vm, direct_alice, sources, locked):
    """And delivered, so the buyer's three-day inspection window is running."""
    lifecycle.check(contract, direct_vm, sources, direct_alice)
    return contract.get_deal(DEAL_ID)


# ----------------------------------------------------------------------------------------------
# arm: the seller, in time, with a corroborated proof
# ----------------------------------------------------------------------------------------------


def test_arming_records_the_proof_and_starts_the_transfer_window(
    contract, direct_vm, direct_bob, sources, offered
):
    """The happy path first, so every refusal below is a refusal of something that otherwise works."""
    said = lifecycle.arm(contract, direct_vm, sources, direct_bob)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "LOCKED"
    assert deal["armed_at"] == ARMED_AT
    assert deal["transfer_deadline"] == TRANSFER_DEADLINE
    assert deal["last_proof_outcome"] == PROOF_FOUND
    assert deal["last_proof_values"] == deal["seller_proof_token"]

    # The return string names the deadline, the target and the record, because those are the
    # three things the seller acts on next.
    assert TRANSFER_DEADLINE in said
    assert TARGET_REGISTRAR in said
    assert SELLER_PROOF_NAME in said


def test_only_the_named_seller_can_arm(
    contract, direct_vm, direct_alice, direct_charlie, sources, offered
):
    """Not the buyer, and not a third party, however good the proof is.

    The proof is served in both attempts, so what refuses them is the caller and not the evidence.
    A buyer who could arm on the seller's behalf could start the transfer clock against a seller
    who never accepted, and a stranger who could arm could do it to both of them.
    """
    token = offered["seller_proof_token"]
    for caller in (direct_alice, direct_charlie):
        set_block_time(direct_vm, ARMED_AT)
        sources.proof(SELLER_PROOF_NAME, [token])
        direct_vm.sender = caller
        with direct_vm.expect_revert("only the named seller can arm deal deal-1"):
            contract.arm(DEAL_ID)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "OFFERED"
    assert deal["armed_at"] == ""


def test_arming_after_the_offer_lapsed_is_refused_and_the_refund_door_is_open_instead(
    contract, direct_vm, direct_bob, sources, offered
):
    """At the deadline instant itself, because that is when the buyer's refund door opens.

    Both halves are asserted in one test on purpose. These two must not be open at the same
    moment: a seller who could still arm at an instant when anyone could refund would make the
    outcome of the deal depend on transaction ordering.
    """
    set_block_time(direct_vm, ACCEPT_DEADLINE)
    sources.proof(SELLER_PROOF_NAME, [offered["seller_proof_token"]])
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("lapsed at %s" % ACCEPT_DEADLINE):
        contract.arm(DEAL_ID)
    assert contract.get_deal(DEAL_ID)["state"] == "OFFERED"

    direct_vm.sender = direct_bob
    said = contract.refund(DEAL_ID)
    assert "the seller did not arm by %s" % ACCEPT_DEADLINE in said
    assert contract.get_deal(DEAL_ID)["state"] == "REFUNDED"


def test_a_seller_with_no_published_proof_cannot_arm(
    contract, direct_vm, direct_bob, sources, offered
):
    """Both resolvers return the captured NXDOMAIN body, complete with its Authority SOA section.

    Nothing is written: the seller whose record has not propagated yet retries, and a failed
    attempt by the party who caused it is not a fact any third party needs on chain.
    """
    set_block_time(direct_vm, ARMED_AT)
    sources.serve(
        cloudflare=evidence.doh_nxdomain("cloudflare", SELLER_PROOF_NAME),
        google=evidence.doh_nxdomain("google", SELLER_PROOF_NAME),
    )
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("the seller's control proof is not corroborated"):
        contract.arm(DEAL_ID)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "OFFERED"
    assert deal["last_proof_outcome"] == ""
    assert deal["transfer_deadline"] == ""


def test_a_proof_only_one_resolver_can_see_is_not_a_proof(
    contract, direct_vm, direct_bob, sources, offered
):
    """Cloudflare sees the token and Google sees nothing, which is what mid-propagation looks like.

    Corroboration by two independent resolvers is the whole basis of the DNS half of this
    contract, so this is the case that makes it mean something. One resolver agreeing with itself
    is a single point of failure with a second fetch attached.
    """
    token = offered["seller_proof_token"]
    set_block_time(direct_vm, ARMED_AT)
    sources.serve(
        cloudflare=evidence.doh_txt("cloudflare", SELLER_PROOF_NAME, [token]),
        google=evidence.doh_nxdomain("google", SELLER_PROOF_NAME),
    )
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("not corroborated"):
        contract.arm(DEAL_ID)
    assert contract.get_deal(DEAL_ID)["state"] == "OFFERED"


def test_resolvers_answering_about_different_names_are_not_corroboration(
    contract, direct_vm, direct_bob, sources, offered
):
    """The query name is one of the three compared axes, and this is where that is checked.

    Cloudflare answers about the proof name and Google about another name entirely, with the
    correct token under both. Without the name in the comparison, two resolvers could agree on a
    value while disagreeing about what it was a value for.

    What this does NOT claim: the contract does not compare either answer against the name it
    asked about, because it built both URLs itself. Two resolvers answering identically about the
    wrong name would corroborate, and that is a property of the two-independent-resolver
    assumption rather than a hole underneath it.
    """
    token = offered["seller_proof_token"]
    set_block_time(direct_vm, ARMED_AT)
    sources.serve(
        cloudflare=evidence.doh_txt("cloudflare", SELLER_PROOF_NAME, [token]),
        google=evidence.doh_txt("google", "_conveyance-seller.someone-else.example", [token]),
    )
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("resolvers answered different query names"):
        contract.arm(DEAL_ID)
    assert contract.get_deal(DEAL_ID)["state"] == "OFFERED"


def test_an_armed_deal_cannot_be_armed_again(contract, direct_vm, direct_bob, sources, locked):
    """The state gate, which is what makes `armed_at` and the transfer deadline immovable.

    A second arm would reset a clock the buyer is relying on, so this gate is what stops a seller
    from extending their own deadline for as long as they like.
    """
    set_block_time(direct_vm, "2026-03-05T00:00:00Z")
    sources.proof(SELLER_PROOF_NAME, [locked["seller_proof_token"]])
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("arm() needs OFFERED"):
        contract.arm(DEAL_ID)

    assert contract.get_deal(DEAL_ID)["transfer_deadline"] == TRANSFER_DEADLINE


# ----------------------------------------------------------------------------------------------
# check_transfer: anyone, rate limited, against the committed token
# ----------------------------------------------------------------------------------------------


def test_a_stranger_can_run_a_check_and_the_deal_carries_what_they_found(
    contract, direct_vm, direct_charlie, sources, locked
):
    """Permissionless, and this test is the reason it has to be.

    If only the parties could check, a buyer could withhold every check and run the seller into
    the transfer deadline while the completed transfer sat in public records the whole time.
    Charlie is neither party, and his check is what advances the deal to VERIFIED.
    """
    said = lifecycle.check(contract, direct_vm, sources, direct_charlie)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "VERIFIED"
    assert deal["verified_at"] == DELIVERED_AT
    assert deal["inspection_deadline"] == INSPECTION_DEADLINE
    assert deal["checks"] == "1"
    assert deal["last_check_outcome"] == OUT_VERIFIED
    assert deal["last_check_registrar_id"] == TARGET_REGISTRAR
    assert deal["delivered_registrar_id"] == TARGET_REGISTRAR
    assert deal["delivered_transfer_at"] == TRANSFER_EVENT_AT
    assert len(deal["delivered_digest"]) == 64
    assert len(deal["delivered_proof_digest"]) == 64
    assert deal["buyer_proof_revealed"] == "True"
    assert INSPECTION_DEADLINE in said


@pytest.mark.parametrize(
    "spoil, outcome, in_note",
    [
        # The domain has not moved: still at the registrar the deal recorded when it opened.
        ({"registrar_id": BASELINE_REGISTRAR_ID}, OUT_AWAITING_TRANSFER, BASELINE_REGISTRAR_ID),
        # It moved, but the delegation is still the seller's.
        ({"nameservers": BASELINE_NAMESERVERS}, OUT_AWAITING_DELEGATION, "delegates to"),
        # It moved and is delegated, but the buyer's proof is not in DNS.
        ({"nxdomain": True}, OUT_AWAITING_DNS, "NXDOMAIN"),
    ],
)
def test_an_incomplete_transfer_is_recorded_rather_than_reverted(
    contract, direct_vm, direct_charlie, sources, locked, spoil, outcome, in_note
):
    """Three ways a transfer can be underway, each written onto the deal and none of them fatal.

    This is the line the contract draws, and the reason the error taxonomy exists. A source that
    did not answer reverts, because nothing was observed. An observation showing an incomplete
    transfer returns, because something was, and the third party who ran the check has produced a
    fact the deal should carry. The transfer deadline runs through all three of these.
    """
    said = lifecycle.check(contract, direct_vm, sources, direct_charlie, **spoil)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "LOCKED", "an incomplete transfer never advances the state"
    assert deal["last_check_outcome"] == outcome
    assert in_note in deal["last_check_note"]
    assert deal["last_check_at"] == DELIVERED_AT
    assert deal["checks"] == "1"
    assert deal["verified_at"] == ""
    assert deal["inspection_deadline"] == ""
    assert outcome in said
    assert TRANSFER_DEADLINE in said
    assert contract.ledger()["checks_run"] == "1"
    assert contract.ledger()["deliveries_verified"] == "0"


def test_a_held_domain_is_recorded_as_suspended_and_not_as_delivered(
    contract, direct_vm, direct_charlie, sources, locked
):
    """A transfer that completed to a name the registry has pulled out of DNS is not a delivery.

    Suspension is tested first in `_classify_delivery`, ahead of the registrar comparison, so a
    domain that is at the target registrar and delegated correctly and held still reads as
    SUSPENDED. A buyer who receives a held name has not received the thing they bought.
    """
    body = evidence.rdap(
        registrar_id=TARGET_REGISTRAR,
        statuses=["client hold"],
        nameservers=TARGET_NAMESERVERS,
        transfer_at=TRANSFER_EVENT_AT,
    )
    lifecycle.check(contract, direct_vm, sources, direct_charlie, rdap_body=body)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "LOCKED"
    assert deal["last_check_outcome"] == OUT_SUSPENDED
    assert "hold" in deal["last_check_note"]
    assert "removes the domain from DNS" in deal["last_check_note"]


def test_a_registrar_change_with_no_transfer_event_is_not_a_transfer(
    contract, direct_vm, direct_charlie, sources, locked
):
    """The registrar entity says the target and the delegation matches, but the events say nothing.

    Without this condition, a document whose registrar entity had been edited and whose event
    history showed no transfer would settle a deal. The `.com` capture publishes no transfer event
    at all, which is why this case is that capture with only the registrar and the nameservers
    substituted.
    """
    body = evidence.rdap(registrar_id=TARGET_REGISTRAR, nameservers=TARGET_NAMESERVERS)
    lifecycle.check(contract, direct_vm, sources, direct_charlie, rdap_body=body)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "LOCKED"
    assert deal["last_check_outcome"] == OUT_AWAITING_TRANSFER
    assert deal["last_check_transfer_at"] == ""
    assert "no transfer event later than" in deal["last_check_note"]


def test_checks_are_rate_limited_and_the_refusal_says_when_the_next_one_is_due(
    contract, direct_vm, direct_charlie, sources, locked
):
    """Every validator fetches independently, and RDAP and both resolvers rate limit per source.

    The interval is read from the contract, so the second call below is exactly one second short
    of the boundary rather than an arbitrary distance from it, and the third is exactly on it.
    """
    lifecycle.check(contract, direct_vm, sources, direct_charlie,
                    registrar_id=BASELINE_REGISTRAR_ID)
    assert contract.get_deal(DEAL_ID)["checks"] == "1"

    set_block_time(direct_vm, lifecycle.plus_seconds(DELIVERED_AT, CHECK_INTERVAL - 1))
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("the next check is due at"):
        contract.check_transfer(DEAL_ID, BUYER_TOKEN)
    assert contract.get_deal(DEAL_ID)["checks"] == "1"

    due = lifecycle.plus_seconds(DELIVERED_AT, CHECK_INTERVAL)
    lifecycle.check(contract, direct_vm, sources, direct_charlie, now=due)
    assert contract.get_deal(DEAL_ID)["checks"] == "2"
    assert contract.get_deal(DEAL_ID)["state"] == "VERIFIED"


@pytest.mark.parametrize(
    "token, expected",
    [
        ("", "buyer_proof_token is required"),
        ("   ", "buyer_proof_token is required"),
        ("conveyance-buyer-v1;secret=wrong", "hashes to"),
        ("conveyance buyer v1", "ambiguous across resolver presentation formats"),
        ('conveyance-buyer-v1;secret="8e1d"', "ambiguous across resolver presentation formats"),
    ],
)
def test_a_check_needs_the_token_the_deal_committed_to(
    contract, direct_vm, direct_charlie, locked, token, expected
):
    """The commitment is checked before anything is fetched, which is why no mocks are served.

    A guard that had drifted below the fetch would fail here with an unmocked-request error
    rather than with its own words, so the absent mock table is part of the assertion.

    The last two cases are the shape rule rather than the digest rule, and they are the reason it
    exists: a token containing a space or a quote could not be told apart from a multi-chunk TXT
    value that one resolver joined and another did not, so it is refused before it can become an
    ambiguous comparison at settlement.
    """
    set_block_time(direct_vm, DELIVERED_AT)
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert(expected):
        contract.check_transfer(DEAL_ID, token)

    deal = contract.get_deal(DEAL_ID)
    assert deal["checks"] == "0"
    assert deal["buyer_proof_revealed"] == "False"


def test_a_verified_deal_cannot_be_moved_onto_a_second_token(
    contract, direct_vm, direct_charlie, sources, verified
):
    """The committed token has to match on every later call, not only on the one that verified.

    The reachable guard is the digest: any token that satisfies the commitment IS the committed
    token, short of a sha256 collision, so the stored-token comparison behind it is defence in
    depth rather than a second door. What this test pins is that a verified deal keeps checking,
    so a later call cannot quietly re-verify it against something else.
    """
    set_block_time(direct_vm, "2026-03-02T07:00:00Z")
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("hashes to"):
        contract.check_transfer(DEAL_ID, BUYER_TOKEN + "x")

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "VERIFIED"
    assert deal["checks"] == "1", "the refused call recorded no observation"


def test_a_check_is_refused_from_every_state_that_is_not_locked_or_verified(
    contract, direct_vm, direct_alice, direct_charlie, sources, offered
):
    """OFFERED has no transfer to check, and a terminal state is terminal."""
    set_block_time(direct_vm, "2026-03-01T01:00:00Z")
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("check_transfer() needs LOCKED or VERIFIED"):
        contract.check_transfer(DEAL_ID, BUYER_TOKEN)

    set_block_time(direct_vm, ACCEPT_DEADLINE)
    direct_vm.sender = direct_alice
    contract.refund(DEAL_ID)

    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("check_transfer() needs LOCKED or VERIFIED"):
        contract.check_transfer(DEAL_ID, BUYER_TOKEN)


# ----------------------------------------------------------------------------------------------
# settle and refund: whose window is it
# ----------------------------------------------------------------------------------------------


def test_the_buyer_can_close_their_own_inspection_window_early(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources, verified
):
    """The window exists for the buyer, so the buyer may end it whenever they like."""
    said = lifecycle.settle(contract, direct_vm, sources, direct_alice,
                            now="2026-03-02T07:00:00Z")

    assert contract.get_deal(DEAL_ID)["state"] == "RELEASED"
    assert value_ledger.paid_to(direct_bob) == ESCROW
    assert "released to the seller" in said

    # The scope disclaimer travels with the payout rather than living only in the documents.
    assert "did not prove legal title" in said


def test_anyone_can_settle_once_the_inspection_window_has_closed(
    contract, direct_vm, direct_bob, direct_charlie, value_ledger, sources, verified
):
    """At the deadline instant itself, by someone who is neither party.

    This is the boundary that matters. An inspection period nobody but the buyer could ever close
    would leave a seller who delivered dependent on the buyer's goodwill for the price, so the
    window expires rather than blocking.
    """
    lifecycle.settle(contract, direct_vm, sources, direct_charlie, now=INSPECTION_DEADLINE)

    assert contract.get_deal(DEAL_ID)["state"] == "RELEASED"
    assert value_ledger.paid_to(direct_bob) == ESCROW
    assert value_ledger.paid_to(direct_charlie) == 0, "settling pays the seller, never the caller"


def test_a_refund_is_refused_from_verified_because_the_seller_delivered(
    contract, direct_vm, direct_alice, direct_charlie, value_ledger, sources, verified
):
    """The buyer's remedy after delivery is `check_transfer`, not a refund.

    A refund door open at VERIFIED would let a buyer take delivery and then take the escrow back,
    which is the one hole an escrow contract cannot have. Tried by the buyer and by a stranger, at
    a moment well past the inspection deadline, so neither timing nor standing is what refuses it.
    """
    set_block_time(direct_vm, "2026-03-09T00:00:00Z")
    for caller in (direct_alice, direct_charlie):
        direct_vm.sender = caller
        with direct_vm.expect_revert("a refund needs OFFERED, LOCKED or REVERSED"):
            contract.refund(DEAL_ID)

    assert contract.get_deal(DEAL_ID)["state"] == "VERIFIED"
    assert value_ledger.transfers == []
    assert contract.ledger()["held"] == str(ESCROW)


def test_a_refund_from_locked_waits_for_the_transfer_deadline_and_quotes_the_last_check(
    contract, direct_vm, direct_alice, direct_charlie, value_ledger, sources, locked
):
    """The refusal carries the last observation, because that is what a buyer is waiting on.

    A refund attempt is the moment a buyer most wants to know what the registry currently says,
    and this message is the only place they can be told without paying for another check.
    """
    lifecycle.check(contract, direct_vm, sources, direct_charlie,
                    registrar_id=BASELINE_REGISTRAR_ID)

    set_block_time(direct_vm, "2026-03-02T07:00:00Z")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("has until %s to complete" % TRANSFER_DEADLINE):
        contract.refund(DEAL_ID)
    assert value_ledger.transfers == []

    # Past the deadline the door opens, and the reason names what was last observed.
    set_block_time(direct_vm, TRANSFER_DEADLINE)
    direct_vm.sender = direct_charlie
    said = contract.refund(DEAL_ID)
    assert OUT_AWAITING_TRANSFER in said
    assert value_ledger.paid_to(direct_alice) == ESCROW
    assert contract.ledger()["held"] == "0"


def test_a_refund_from_locked_before_any_check_says_that_no_check_has_run(
    contract, direct_vm, direct_alice, sources, locked
):
    """The empty case of that message, and a real state: a deal can be armed and never checked."""
    set_block_time(direct_vm, "2026-03-02T00:00:00Z")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("no check has run yet"):
        contract.refund(DEAL_ID)


def test_only_the_seller_can_abandon_a_locked_deal(
    contract, direct_vm, direct_alice, direct_charlie, value_ledger, sources, locked
):
    """The buyer's exit from LOCKED is the transfer deadline, and the refusal says so.

    A buyer who could abandon at will could let a real inter-registrar transfer complete, cancel
    the deal, and keep the price. By this point the seller has proven DNS control and may have
    that transfer in flight, so this is the guard that protects the party who has done the work.
    """
    for caller in (direct_alice, direct_charlie):
        direct_vm.sender = caller
        with direct_vm.expect_revert("only the seller can abandon it from there"):
            contract.abandon(DEAL_ID)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "LOCKED"
    assert deal["transfer_deadline"] == TRANSFER_DEADLINE
    assert value_ledger.transfers == []


@pytest.mark.parametrize("who", ["buyer", "seller"])
def test_either_party_can_abandon_while_the_deal_is_only_an_offer(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources, offered, who
):
    """Nobody has committed anything yet, so shortening a 48-hour wait costs neither side."""
    set_block_time(direct_vm, "2026-03-01T02:00:00Z")
    direct_vm.sender = direct_alice if who == "buyer" else direct_bob
    said = contract.abandon(DEAL_ID)

    assert "the %s abandoned the deal from OFFERED" % who in said
    assert contract.get_deal(DEAL_ID)["state"] == "REFUNDED"
    assert value_ledger.paid_to(direct_alice) == ESCROW, "an abandoned escrow goes to the buyer"


def test_a_stranger_cannot_abandon_an_offer(
    contract, direct_vm, direct_charlie, value_ledger, sources, offered
):
    """Unlike a refund, this has no deadline behind it, so standing is the only protection."""
    set_block_time(direct_vm, "2026-03-01T02:00:00Z")
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("only the buyer or the named seller can abandon"):
        contract.abandon(DEAL_ID)

    assert contract.get_deal(DEAL_ID)["state"] == "OFFERED"
    assert value_ledger.transfers == []


# ----------------------------------------------------------------------------------------------
# The reversal, which needs all three of its conditions
# ----------------------------------------------------------------------------------------------


def test_a_delivery_that_still_stands_is_recorded_and_changes_nothing(
    contract, direct_vm, direct_charlie, sources, verified
):
    """A check from VERIFIED that finds everything intact leaves the deal exactly where it is."""
    said = lifecycle.check(contract, direct_vm, sources, direct_charlie,
                           now="2026-03-02T07:00:00Z")

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "VERIFIED"
    assert deal["checks"] == "2"
    assert deal["inspection_deadline"] == INSPECTION_DEADLINE
    assert "delivery still stands" in said
    assert contract.ledger()["reversals_recorded"] == "0"


def test_a_domain_back_at_the_sellers_registrar_with_the_proof_gone_is_a_reversal(
    contract, direct_vm, direct_alice, direct_charlie, value_ledger, sources, verified
):
    """All three conditions met, which is the only combination that reaches REVERSED.

    And then the refund, because REVERSED exists to open that door: the fact is already on chain,
    so the refund needs no deadline, no further evidence and neither party's cooperation.
    """
    said = lifecycle.check(
        contract, direct_vm, sources, direct_charlie,
        now="2026-03-02T07:00:00Z",
        registrar_id=BASELINE_REGISTRAR_ID,
        nameservers=BASELINE_NAMESERVERS,
        nxdomain=True,
    )

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "REVERSED"
    assert deal["last_check_outcome"] == OUT_REVERSED
    assert BASELINE_REGISTRAR_ID in deal["last_check_note"]
    assert "the buyer's control proof is gone" in deal["last_check_note"]
    assert contract.ledger()["reversals_recorded"] == "1"
    assert "refundable to the buyer" in said

    direct_vm.sender = direct_charlie
    contract.refund(DEAL_ID)
    assert value_ledger.paid_to(direct_alice) == ESCROW
    assert contract.ledger()["held"] == "0"


@pytest.mark.parametrize(
    "spoil, now, why",
    [
        # The domain moved on to a third registrar. That is the buyer using the control they
        # bought, not the seller taking the domain back.
        ({"registrar_id": "9999", "nxdomain": True}, "2026-03-02T07:00:00Z",
         "not a reversal to the seller's registrar"),
        # Back at the seller's registrar, but the buyer's proof is still published, so the buyer
        # still demonstrably controls the name.
        ({"registrar_id": BASELINE_REGISTRAR_ID, "nameservers": BASELINE_NAMESERVERS},
         "2026-03-02T07:00:00Z", "the buyer's control proof is still corroborated"),
        # Everything a reversal needs, one instant too late.
        ({"registrar_id": BASELINE_REGISTRAR_ID, "nameservers": BASELINE_NAMESERVERS,
          "nxdomain": True}, INSPECTION_DEADLINE, "outside the inspection window"),
    ],
)
def test_a_reversal_missing_any_one_of_its_three_conditions_is_recorded_and_not_acted_on(
    contract, direct_vm, direct_charlie, value_ledger, sources, verified, spoil, now, why
):
    """Each condition spoiled on its own, with the other two intact.

    This is the narrowest guard in the contract and the one with a stated residual risk, so the
    conditions are tested separately rather than together. A reversal that fired on any two of
    them would hand the buyer a way to keep the domain and take the price back: they control the
    name after delivery, so they can move it and delete the proof record whenever they like.

    The deal stays VERIFIED and the observation is still written, which is the right pair of
    outcomes. The seller keeps the claim they earned, and the buyer keeps a public record of what
    they saw.
    """
    said = lifecycle.check(contract, direct_vm, sources, direct_charlie, now=now, **spoil)

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "VERIFIED"
    assert why in said
    assert "not treated as a reversal" in said
    assert deal["checks"] == "2"
    assert contract.ledger()["reversals_recorded"] == "0"
    assert value_ledger.transfers == []

    # And the escrow is still the seller's to collect, which is the consequence of not reversing.
    assert contract.ledger()["held"] == str(ESCROW)
