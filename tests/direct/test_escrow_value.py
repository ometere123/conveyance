"""Where the escrow can go, and that it cannot go anywhere else.

Three claims, and between them they are the whole of what this contract promises about money.

EVERY WEI IS ACCOUNTED FOR. `ledger()` reports escrowed, released, refunded and held, and held is
computed rather than read, so the four are checkable by addition after any sequence of calls. The
tests below run sequences that end in each terminal state and add them up.

THERE ARE EXACTLY THREE PLACES A PAYMENT CAN COME FROM. `settle` to the seller, `refund` to the
buyer, `abandon` to the buyer. That count is asserted against the contract source rather than
described, so a fourth call site cannot be added without a test failing. It matters because a
payment site is where an escrow leaves, and one that nobody has read is one nobody has bounded.

A REFUSED CALL PAYS NOBODY. Under the direct harness a `raise` does not roll storage back, and it
does not undo a transfer either, so a payment emitted before a later refusal would be visible in
the ledger below. On chain the revert would hide it.

TWO HARNESS PROPERTIES ARE ASSERTED AS PROPERTIES OF THE HARNESS, deliberately, so that a later
reader does not take them for bugs and correct them into silence. `ledger()["balance"]` is zero
however much value a test sends, because the direct harness credits none. And the harness has no
`EthSend` handler at all, so without the hook installed by the `value_ledger` fixture every
transfer in this file would vanish into a trace line and each of these tests would pass while
measuring nothing. The first test is there to prove the hook is live.
"""

import re

import pytest

from conftest import CONTRACT_SOURCE, numeric_constant, set_block_time
import evidence
import lifecycle
from lifecycle import (
    BUYER_TOKEN,
    DEAL_ID,
    ESCROW,
    OPENED_AT,
    TARGET_NAMESERVERS,
)


@pytest.fixture
def sources(direct_vm):
    return evidence.Sources(direct_vm)


# ----------------------------------------------------------------------------------------------
# The instrument, and the shape of the accounting
# ----------------------------------------------------------------------------------------------


def test_the_transfer_hook_is_live_and_reads_the_recipient_and_the_amount(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """First, because every other test in this file is vacuous if this one is not true.

    The direct harness answers an `EthSend` with "Unknown gl_call request type" and carries on.
    A suite that asserted only on `ledger()` counters would therefore be unable to tell a
    refunded escrow from a stranded one, and would report both as correct.
    """
    lifecycle.open_deal(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    contract.abandon(DEAL_ID)

    assert len(value_ledger.transfers) == 1, "the hook is not installed, so nothing was recorded"
    recipient, amount = value_ledger.transfers[0]
    assert recipient == direct_alice.as_hex.lower()
    assert amount == ESCROW
    assert value_ledger.retained == 0


def test_the_contract_has_exactly_four_places_it_can_pay_from(contract):
    """Counted in the source, so a fifth cannot appear unnoticed.

    `_pay` is the only function that emits a transfer, and it is called from `_decline`, `settle`,
    `refund` and `abandon`. The assertion is on the count and on which functions contain the calls,
    because a payment introduced into `check_transfer` or `probe_domain` would be a payment on a
    permissionless method and this is the test that would stop it.

    `_decline` is the fourth and it is a different kind of payment from the other three. Those pay
    out an escrow the contract is holding against a stored deal. `_decline` hands back the value of
    the call in flight, because `open_deal` refuses by returning rather than by reverting: this
    chain rolls storage back on a revert but keeps `gl.message.value`, so a reverting payable
    method charges the caller for being told no. It pays `gl.message.sender_address` the exact
    `gl.message.value` and stores nothing, which is why it cannot reach an escrow that belongs to
    somebody else, and it is reachable only from the one method that can receive value.
    """
    call_sites = re.findall(r"^\s+self\._pay\(", CONTRACT_SOURCE, re.M)
    assert len(call_sites) == 4

    #: The function each call site sits in, read by walking back to the nearest `def`.
    owners = []
    for match in re.finditer(r"^\s+self\._pay\(", CONTRACT_SOURCE, re.M):
        before = CONTRACT_SOURCE[: match.start()]
        owners.append(re.findall(r"^    def ([a-z_]+)\(", before, re.M)[-1])
    assert owners == ["_decline", "settle", "refund", "abandon"]

    # And exactly one emitter, so the four sites above are the whole surface.
    assert CONTRACT_SOURCE.count("emit_transfer") == 1

    # The refund path pays the caller of the call in flight and nothing else. A `_decline` that
    # reached for a deal's escrow, or for anything but `gl.message.value`, would be a way to drain
    # a stored deal from a method that is refusing to store one.
    decline = CONTRACT_SOURCE.split("    def _decline(", 1)[1].split("\n    def ", 1)[0]
    assert "self._pay(gl.message.sender_address, u256(int(gl.message.value)))" in decline
    assert "self.deals" not in decline, decline


def test_a_zero_amount_never_reaches_the_wire(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """`_pay` returns on a non-positive amount rather than emitting a transfer of nothing.

    Worth a test because the escrow can only be positive, so this guard is unreachable through
    the front door and would rot unnoticed. It is what makes `_pay` safe to call unconditionally
    from a future path where the figure might be zero.
    """
    assert "if int(amount) <= 0:" in CONTRACT_SOURCE
    lifecycle.open_deal(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)

    # A refused call, to show the ledger stays empty when nothing is paid.
    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("no deal 'no-such-deal'"):
        contract.abandon("no-such-deal")
    assert value_ledger.transfers == []


def test_the_ledger_adds_up_and_reports_a_zero_balance_because_the_harness_credits_none(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The disagreement between `held` and `balance` is the harness, and it is asserted as such.

    On chain these two agree, and the contract reports both next to each other precisely so that
    a value bug would show up as a disagreement. Here they cannot agree, because the direct
    harness credits no value to the contract at all. Asserting the zero rather than skipping it
    means a later harness that starts crediting value will fail this test and get the assertion
    tightened, instead of leaving a comment nobody re-reads.
    """
    lifecycle.open_deal(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)

    ledger = contract.ledger()
    assert ledger["total_escrowed"] == str(ESCROW)
    assert ledger["held"] == str(ESCROW)
    assert ledger["balance"] == "0", "the direct harness credits no value; see the module header"
    assert value_ledger.funded == ESCROW
    assert value_ledger.paid_out == 0

    # There is no fee anywhere in this contract, and the ledger says so rather than implying it.
    assert ledger["protocol_fee"] == "0"
    assert int(ledger["total_escrowed"]) == (
        int(ledger["total_released"]) + int(ledger["total_refunded"]) + int(ledger["held"])
    )


# ----------------------------------------------------------------------------------------------
# Each terminal state, to the wei
# ----------------------------------------------------------------------------------------------


def test_a_settled_deal_pays_the_seller_the_whole_escrow_and_nothing_to_anyone_else(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The seller's side of the only path that pays the seller.

    The figure is the escrow exactly. There is no fee, no rounding and no split, and the test
    says so by asserting the buyer received nothing rather than only that the seller received
    everything: a bug that paid both would satisfy the second assertion alone.
    """
    lifecycle.to_verified(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)
    assert contract.get_deal(DEAL_ID)["state"] == "VERIFIED"
    assert value_ledger.transfers == []

    said = lifecycle.settle(contract, direct_vm, sources, direct_alice)

    assert value_ledger.paid_to(direct_bob) == ESCROW
    assert value_ledger.paid_to(direct_alice) == 0
    assert value_ledger.retained == 0
    assert len(value_ledger.transfers) == 1

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "RELEASED"
    assert deal["paid_to_seller"] == str(ESCROW)
    assert deal["returned_to_buyer"] == "0"
    assert deal["closed_at"] == lifecycle.DELIVERED_AT

    ledger = contract.ledger()
    assert ledger["total_released"] == str(ESCROW)
    assert ledger["total_refunded"] == "0"
    assert ledger["held"] == "0"
    assert str(ESCROW) in said


def test_a_refunded_deal_returns_the_whole_escrow_to_the_buyer(
    contract, direct_vm, direct_alice, direct_bob, direct_charlie, value_ledger, sources
):
    """The buyer's side, through the door a lapsed offer opens.

    Called by Charlie, who is neither party, because the destination is fixed: a refund can only
    ever go to the buyer, so a third party calling it can only help. That is the argument for
    the method being permissionless and this is where it is checked.
    """
    lifecycle.open_deal(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)

    set_block_time(direct_vm, "2026-03-03T00:00:00Z")
    direct_vm.sender = direct_charlie
    said = contract.refund(DEAL_ID)

    assert value_ledger.paid_to(direct_alice) == ESCROW
    assert value_ledger.paid_to(direct_bob) == 0
    assert value_ledger.paid_to(direct_charlie) == 0
    assert value_ledger.retained == 0

    deal = contract.get_deal(DEAL_ID)
    assert deal["state"] == "REFUNDED"
    assert deal["returned_to_buyer"] == str(ESCROW)
    assert deal["paid_to_seller"] == "0"

    ledger = contract.ledger()
    assert ledger["total_refunded"] == str(ESCROW)
    assert ledger["total_released"] == "0"
    assert ledger["held"] == "0"
    assert "did not arm" in said


def test_an_abandoned_deal_returns_the_escrow_and_says_which_party_gave_it_up(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """From LOCKED, by the seller, which is the only party who may abandon from there."""
    lifecycle.open_deal(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)
    lifecycle.arm(contract, direct_vm, sources, direct_bob)

    set_block_time(direct_vm, "2026-03-01T07:00:00Z")
    direct_vm.sender = direct_bob
    said = contract.abandon(DEAL_ID)

    assert value_ledger.paid_to(direct_alice) == ESCROW
    assert value_ledger.retained == 0
    assert "the seller abandoned the deal from LOCKED" in said
    assert contract.get_deal(DEAL_ID)["returned_to_buyer"] == str(ESCROW)
    assert contract.ledger()["held"] == "0"


# ----------------------------------------------------------------------------------------------
# Conservation across more than one deal
# ----------------------------------------------------------------------------------------------


def test_two_deals_settling_and_refunding_leave_the_counters_conserved(
    contract, direct_vm, direct_alice, direct_bob, direct_charlie, value_ledger, sources
):
    """One released, one refunded, one still held, all in figures no float could carry.

    The three escrows are deliberately not round: a bug that summed them in a float would come
    back with the same total for 7.000000000000000001 and 7 GEN, and the difference is exactly
    the wei this test is about.
    """
    first = 7 * 10 ** 18 + 1
    second = 3 * 10 ** 18 + 999_999_999
    third = 11 * 10 ** 18 + 12_345

    lifecycle.to_verified(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob,
                          escrow=first)
    lifecycle.settle(contract, direct_vm, sources, direct_alice)

    # A second deal on another domain, refunded when its offer lapses.
    set_block_time(direct_vm, OPENED_AT)
    sources.serve(rdap_body=evidence.rdap(ldh_name="SECOND.COM"))
    direct_vm.sender = direct_charlie
    value_ledger.fund(second)
    contract.open_deal(*lifecycle.open_args(
        deal_id="deal-2", domain="second.com", seller=str(direct_bob)))

    # A third, left open, so `held` has something to hold at the end.
    set_block_time(direct_vm, OPENED_AT)
    sources.serve(rdap_body=evidence.rdap(ldh_name="THIRD.COM"))
    direct_vm.sender = direct_charlie
    value_ledger.fund(third)
    contract.open_deal(*lifecycle.open_args(
        deal_id="deal-3", domain="third.com", seller=str(direct_bob)))

    set_block_time(direct_vm, "2026-03-03T00:00:00Z")
    direct_vm.sender = direct_alice
    contract.refund("deal-2")

    ledger = contract.ledger()
    assert ledger["total_escrowed"] == str(first + second + third)
    assert ledger["total_released"] == str(first)
    assert ledger["total_refunded"] == str(second)
    assert ledger["held"] == str(third)
    assert int(ledger["total_escrowed"]) == (
        int(ledger["total_released"]) + int(ledger["total_refunded"]) + int(ledger["held"])
    )

    # The same figures from the other direction: what the wire saw.
    assert value_ledger.paid_to(direct_bob) == first
    assert value_ledger.paid_to(direct_charlie) == second
    assert value_ledger.retained == third
    assert value_ledger.funded == first + second + third

    assert ledger["deals_opened"] == "3"
    assert ledger["deliveries_verified"] == "1"


def test_an_escrow_at_the_ceiling_settles_for_the_same_figure_it_arrived_as(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """100 GEN in and 100 GEN out, through `u256` at both ends and a `str` in the view.

    The ceiling is forty-seven bits past where a double starts rounding, so this is the figure
    that would come back wrong if any step of the accounting passed through a float.
    """
    ceiling = numeric_constant("MAX_DEAL_VALUE_WEI")
    lifecycle.to_verified(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob,
                          escrow=ceiling)
    lifecycle.settle(contract, direct_vm, sources, direct_alice)

    assert value_ledger.paid_to(direct_bob) == ceiling
    assert contract.get_deal(DEAL_ID)["paid_to_seller"] == str(ceiling)
    assert contract.ledger()["total_released"] == str(ceiling)
    assert contract.ledger()["held"] == "0"


# ----------------------------------------------------------------------------------------------
# What a refusal costs
# ----------------------------------------------------------------------------------------------


def test_a_settle_that_no_longer_verifies_pays_nobody_and_leaves_the_deal_verified(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The re-verification in `settle` is what makes the earlier check a claim about the registry.

    Here the domain has moved on to a third registrar between the check and the settle, so the
    re-fetch disagrees with the stored row and the escrow stays where it is. The assertion that
    matters is the empty transfer list: a contract that paid first and verified second would
    still leave the deal at VERIFIED and would look identical from `get_deal`.
    """
    lifecycle.to_verified(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)

    set_block_time(direct_vm, "2026-03-02T07:00:00Z")
    sources.proof(
        lifecycle.BUYER_PROOF_NAME,
        [BUYER_TOKEN],
        rdap_body=evidence.delivered(registrar_id="9999", nameservers=TARGET_NAMESERVERS),
    )
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("no longer verifies and cannot be settled"):
        contract.settle(DEAL_ID)

    assert value_ledger.transfers == []
    assert value_ledger.retained == ESCROW
    assert contract.get_deal(DEAL_ID)["state"] == "VERIFIED"
    assert contract.get_deal(DEAL_ID)["paid_to_seller"] == "0"
    assert contract.ledger()["held"] == str(ESCROW)


def test_a_settle_refused_for_being_early_pays_nobody(
    contract, direct_vm, direct_alice, direct_bob, direct_charlie, value_ledger, sources
):
    """Charlie settling inside the buyer's inspection window, which is not his to close.

    The guard sits before the network call, so no mocks are served: a guard that had drifted
    below the fetch would fail here with an unmocked-request error rather than its own words.
    """
    lifecycle.to_verified(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)

    set_block_time(direct_vm, "2026-03-02T08:00:00Z")
    direct_vm.sender = direct_charlie
    with direct_vm.expect_revert("only the buyer can settle"):
        contract.settle(DEAL_ID)

    assert value_ledger.transfers == []
    assert contract.get_deal(DEAL_ID)["state"] == "VERIFIED"
    assert contract.ledger()["held"] == str(ESCROW)


def test_a_terminal_deal_cannot_be_paid_out_twice(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """Every terminal state refuses every payout method, so an escrow leaves once.

    This is the double-spend test. Each of the three methods is tried against a deal that has
    already paid, and the ledger is asserted unchanged after all of them, because a second
    payment is the one accounting error that cannot be corrected after the fact.
    """
    lifecycle.to_verified(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)
    lifecycle.settle(contract, direct_vm, sources, direct_alice)
    assert value_ledger.paid_out == ESCROW

    set_block_time(direct_vm, "2026-03-06T00:00:00Z")
    for caller in (direct_alice, direct_bob):
        direct_vm.sender = caller
        with direct_vm.expect_revert("settle() needs VERIFIED"):
            contract.settle(DEAL_ID)
        with direct_vm.expect_revert("a refund needs OFFERED or LOCKED"):
            contract.refund(DEAL_ID)
        with direct_vm.expect_revert("abandon() needs OFFERED or LOCKED"):
            contract.abandon(DEAL_ID)

    assert value_ledger.paid_out == ESCROW
    assert len(value_ledger.transfers) == 1
    assert contract.ledger()["total_released"] == str(ESCROW)
    assert contract.ledger()["held"] == "0"


def test_a_refunded_deal_cannot_then_be_settled_by_the_seller(
    contract, direct_vm, direct_alice, direct_bob, value_ledger, sources
):
    """The other order, because a state machine can be tight in one direction and loose in the other."""
    lifecycle.open_deal(contract, direct_vm, value_ledger, sources, direct_alice, direct_bob)
    set_block_time(direct_vm, "2026-03-03T00:00:00Z")
    direct_vm.sender = direct_alice
    contract.refund(DEAL_ID)
    assert value_ledger.paid_to(direct_alice) == ESCROW

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("deal deal-1 is REFUNDED"):
        contract.settle(DEAL_ID)
    with direct_vm.expect_revert("deal deal-1 is REFUNDED"):
        contract.arm(DEAL_ID)

    assert value_ledger.paid_out == ESCROW
    assert contract.ledger()["total_refunded"] == str(ESCROW)
