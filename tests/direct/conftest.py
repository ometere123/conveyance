"""Windows compatibility for genlayer-test's direct loader, the value ledger, and the clock.

WHAT THIS SUITE IS FOR, AND WHY IT IS NOT THE OFFLINE HARNESS AGAIN. `Conveyance` already has
an offline suite that drives the whole escrow lifecycle against a synthetic registry and two
synthetic resolvers. That suite runs the contract under a hand-written `gl` stub, which is what
lets it forge a mid-transfer RDAP document and a resolver disagreement. This suite runs the same
file under the real GenVM SDK, loaded out of the cached tarball, and that is a different claim:
`u256`, `Address`, `TreeMap`, `DynArray` and the `@allow_storage` dataclass behave as the chain
implements them rather than as a stub reimplements them. A contract can be correct against a stub
and wrong about `int(gl.message.value)`, about `Address` equality, or about a storage write that
survives a raise. Those are the failures this suite exists to catch, so it stays close to storage,
value and the guards, and leaves the fixture-driven lifecycle where it already is.

Three pieces of scaffolding, each for a measured property of the harness.

THE UNLINK PATCH. The loader duplicates its temporary message file onto fd 0, then unlinks the
path while that duplicate is still open. POSIX permits that; Windows returns WinError 32.
Deferring only that specific failure to interpreter exit lets the upstream fixture finish, keeps
the tests identical across platforms, and still removes the file rather than leaving it in the
temp directory.

THE VALUE LEDGER. The direct harness has no handler for `EthSend`: a contract can emit a transfer
and the harness will trace "Unknown gl_call request type" and carry on, so a test that does not
watch for the request cannot tell a refunded escrow from a stranded one. It also credits no value
at all, reporting `self.balance` as zero however much a test sends, which is why every escrow
assertion in this suite is computed from stored deals plus this ledger and never from
`ledger()["balance"]`.

THE CLOCK. `direct_vm.warp()` patches `datetime.now()` and the VM's own timestamp, but the
harness only writes the sender and origin addresses back into `gl.message_raw`. Conveyance takes
its clock from `gl.message_raw["datetime"]` deliberately, because a block timestamp is not the
validator's wall clock, so the warp has to be mirrored there or every one of the three deadlines
is computed against real time and the window tests pass for the wrong reason. `_require_now`
reverts on a datetime shorter than 19 characters, so a test that never sets one gets an
`[EXTERNAL]` revert rather than a silent 1970.
"""

import atexit
import os
import re
import sys
from pathlib import Path

import pytest


_real_unlink = os.unlink
_deferred: list[str] = []


def _windows_safe_unlink(path, *args, **kwargs):
    try:
        return _real_unlink(path, *args, **kwargs)
    except PermissionError:
        _deferred.append(path)
        return None


os.unlink = _windows_safe_unlink


@atexit.register
def _cleanup_deferred() -> None:
    for path in _deferred:
        try:
            _real_unlink(path)
        except OSError:
            pass


@pytest.fixture
def contract(direct_deploy):
    return direct_deploy("contracts/Conveyance.py")


def set_block_time(direct_vm, iso: str) -> str:
    """Move the clock the contract actually reads, and return it for use in assertions.

    Both halves are needed. `warp` moves the VM's timestamp, which is what any SDK call that
    asks the host for a time would see. The `message_raw` write is what `_require_now` reads.
    Setting only the first leaves the contract computing deadlines from the real clock, which
    makes an expiry test pass on any day the suite happens to run.
    """
    direct_vm.warp(iso)
    gl = sys.modules.get("genlayer.gl")
    if gl is not None and getattr(gl, "message_raw", None) is not None:
        gl.message_raw["datetime"] = iso
    return iso


_HEX40 = re.compile(r"0x([0-9a-fA-F]{40})")


#: MEASURED, AND A TRAP WORTH NAMING. The SDK's `Address` returns its EIP-55 hex from `str()` and
#: its repr from `format()`, so `str(bob)` is `0x81b6…` while `f"{bob}"` is `Address("0x81b6…")`.
#: Both look right in a diff until the diff is 60 characters wide. Every test in this suite reads
#: `.as_hex` when an address goes into a string it will compare, and never interpolates one.
ADDRESS_IS_NOT_F_STRING_SAFE = True


def address_hex(value) -> str:
    """Normalise whatever an `EthSend` carries as its recipient to lowercase `0x…40`.

    The SDK's `Address` is imported by the loader out of the cached GenVM tarball, so it is
    not importable from the host process and cannot be isinstance-checked here. Hence the
    accessor attempts followed by a repr fallback. The assertion at the end is the part that
    matters: a recipient this function cannot read becomes a failed test, never a transfer
    silently attributed to the wrong account.
    """
    for attr in ("as_hex", "hex"):
        got = getattr(value, attr, None)
        if got is not None:
            text = got() if callable(got) else got
            match = _HEX40.search(str(text) if str(text).startswith("0x") else f"0x{text}")
            if match:
                return "0x" + match.group(1).lower()

    match = _HEX40.search(repr(value))
    assert match, f"could not read an address out of {value!r}"
    return "0x" + match.group(1).lower()


class ValueLedger:
    """Tracks GEN into and out of the contract across a test, to the wei.

    `fund` is the only way a test should attach value to a call. Routing it through here means
    the "paid in" side of the accounting is recorded by the same object that records the "paid
    out" side, so the two cannot drift apart the way they would if each test kept its own
    running total.
    """

    def __init__(self, vm):
        self._vm = vm
        self.transfers: list[tuple[str, int]] = []
        self.funded = 0

    def fund(self, amount: int) -> int:
        """Attach `amount` wei to the next call and remember that it was sent."""
        self._vm.value = int(amount)
        self.funded += int(amount)
        return int(amount)

    def no_value(self) -> None:
        self._vm.value = 0

    def _hook(self, vm, request):
        """Record `EthSend`; leave every other request to the harness.

        Returning `None` for anything else is deliberate: the harness treats a hook that
        returns `None` exactly as it treats no hook at all, so installing this cannot change
        how any other host call behaves.
        """
        send = request.get("EthSend") if isinstance(request, dict) else None
        if send is None:
            return None
        self.transfers.append((address_hex(send["address"]), int(send["value"])))
        return {"ok": None}

    @property
    def paid_out(self) -> int:
        return sum(amount for _, amount in self.transfers)

    @property
    def retained(self) -> int:
        """What the contract is holding, by the ledger's reckoning: in minus out."""
        return self.funded - self.paid_out

    def paid_to(self, account) -> int:
        target = address_hex(account)
        return sum(amount for who, amount in self.transfers if who == target)

    def clear(self) -> None:
        self.transfers.clear()
        self.funded = 0


@pytest.fixture
def value_ledger(direct_vm):
    ledger = ValueLedger(direct_vm)
    direct_vm._gl_call_hook = ledger._hook
    return ledger


CONTRACT_PATH = Path(__file__).resolve().parents[2] / "contracts" / "Conveyance.py"
CONTRACT_SOURCE = CONTRACT_PATH.read_text(encoding="utf-8")


def constant(name: str) -> str:
    """Lift a module-level constant out of the contract source, as written.

    Read rather than restated, for the same reason the frontend tests read it: a limit typed a
    second time in a test proves that the test and the contract were typed by one hand on one
    afternoon, and nothing else. A constant that moves has to break the assertion that depends
    on it, which only happens if the assertion reads the constant.
    """
    match = re.search(rf"^{re.escape(name)} = (.+?)(?:\s+#.*)?$", CONTRACT_SOURCE, re.M)
    assert match, f"the contract no longer declares {name}"
    return match.group(1).strip()


def numeric_constant(name: str) -> int:
    """The same, evaluated, for the constants written as arithmetic like `100 * 10 ** 18`."""
    text = constant(name)
    assert re.fullmatch(r"[0-9_ */+e**]+", text), f"{name} is not plain arithmetic: {text}"
    return int(eval(text, {"__builtins__": {}}, {}))  # noqa: S307 - a digits-only literal


def str_constant(name: str) -> str:
    """The same, unquoted, for the state and outcome names.

    Used so that an assertion on an outcome reads the contract's own spelling of it. Renaming
    `OUT_AWAITING_DELEGATION`'s value would then break the test that depends on it, which is the
    point: the interface switches on these strings, so they are part of the contract's surface and
    not private labels.
    """
    text = constant(name)
    assert re.fullmatch(r"""["'].*["']""", text), f"{name} is not a plain string: {text}"
    return text[1:-1]

