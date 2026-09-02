#!/usr/bin/env python3
"""Splice the RDAP and DNS evidence path into the Conveyance contract, and prove the copy behaves.

A GenLayer Intelligent Contract is a single module and cannot import a sibling Python file. So
`_build/conveyance-rdap/rdap.py` is written and unit-tested standalone, then copied verbatim into
`conveyance/contracts/Conveyance.py` between two markers. Copying code is how copies drift, and
the copy is the one that settles real money, so the copy is what this script checks.

    python conveyance/scripts/splice_rdap.py --write     # splice, then verify
    python conveyance/scripts/splice_rdap.py             # verify only, exit 1 on drift

WHY THIS ONE IS NOT A COPY OF holdfast/scripts/splice_archive.py. Five things differ, and each
of them is a place where copying the earlier script would have produced a check that passes
without checking anything.

1. THE REGION IS DELIMITED BY THE SOURCE'S OWN MARKERS. `rdap.py` carries
   `# --- CONVEYANCE-RDAP SPLICE BEGIN ---` and its END counterpart, and its own suite digests
   exactly what lies between them, with exactly the normalization repeated below. The contract
   carries the same two marker lines, so one extraction function serves both files and the number
   the standalone suite prints is the number this script asserts. Holdfast anchored on
   `__all__ = [` instead, which worked but meant the suite and the guard measured slightly
   different text.

2. THE IMPORTS STAY INSIDE THE REGION. Holdfast hoisted its five into the contract head and its
   guard asserted the region declares none. Here the region begins at `import hashlib`, because
   that is where the digested region begins, and hoisting them would break the byte-identity that
   makes those 35 standalone tests tests of the code that ships. So the check is stronger rather
   than absent: the region must import exactly `hashlib` and `json`, and the contract's own head
   and tail must import exactly `genlayer` and `dataclasses`. Import nodes are attributed to one
   side or the other by line number.

3. THERE IS NO check_no_mutable_module_state. It cannot be copied, because three region
   assignments are genuinely mutable containers and the earlier rule would fail all three. They
   are named below with why each is safe, the mutator scan is kept, and a fourth layer is added
   that the earlier script did not have: the three objects are snapshotted before the suite runs
   and compared after. That turns "immutable by inspection" into "not mutated by a full suite's
   worth of execution", which is the claim that actually matters.

4. check_no_raw_deflate IS REPLACED BY THREE CHECKS THAT FIT THIS MODULE. There is no zlib here.
   What there is: a documented SDK bug where the published example reads `.status_code` on a
   response object that only has `.status`; a measured finding that DoH response bodies are not
   byte-stable across resolvers, so hashing a raw body would make agreement impossible; and a
   taxonomy that a broad `except Exception` upstream of `except Refusal` would silently flatten
   from `[EXPECTED]` into `[TRANSIENT]`. Each is one structural check.

5. THE CALLABLE COUNT IS COUNTED, NOT READ OFF `__all__`. `rdap.py` has no `__all__`, so the
   region's top-level `def` and `class` statements are counted and matched against the contract's
   `EMBEDDED_FUNCTION_COUNT`.

Two of the 35 standalone tests read `rdap.py` from disk by absolute path, so re-running them
against the spliced copy passes without looking at it. That is a limit of those tests, not a
failure of them, and closing it is what the structural layer is for. Both are named in the report.

Two more are skips rather than passes, so the suite reports 33 passed and 2 skipped. Both are
waiting on RDAP captures of a domain in mid-transfer, which cannot be fabricated: the fixtures
they read carry `routing: blocked` until a real transfer is captured, and the loader raises
rather than substituting a plausible body. A skip that names what it is waiting for is the
honest report; a synthesised pending-transfer record would make this layer prove nothing.
"""

import ast
import io
import json
import os
import sys
import hashlib
import traceback
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
# The workspace this was developed in also carries a sibling copy of rdap.py one level above
# PROJECT, in a multi-project scratch `_build/`. That copy is not part of this Git repository and
# does not exist in a normal clone or in CI, which only ever checks out `conveyance/` itself. The
# authoritative copy for this script is the one actually committed inside this repository, at
# PROJECT/_build/conveyance-rdap/rdap.py (verified byte-identical to the workspace scratch copy
# at the time this was fixed) — so SOURCE and SUITE_DIR resolve from PROJECT, not from REPO.
# REPO is kept only for the human-readable relpath() labels printed below.
REPO = os.path.dirname(PROJECT)

SOURCE = os.path.join(PROJECT, "_build", "conveyance-rdap", "rdap.py")
SUITE_DIR = os.path.join(PROJECT, "_build", "conveyance-rdap")
CONTRACT = os.path.join(PROJECT, "contracts", "Conveyance.py")

BEGIN = "# --- CONVEYANCE-RDAP SPLICE BEGIN ---"
END = "# --- CONVEYANCE-RDAP SPLICE END ---"

#: The module the suite imports, and the suite itself.
MODULE_NAME = "rdap"
SUITE_NAME = "test_rdap"

#: Exactly what the region may import. Asserted rather than hoisted, because the region's first
#: line is `import hashlib` and the digest starts there.
REGION_IMPORTS = ("hashlib", "json")

#: Exactly what the contract's own head and tail may import, on top of the region's two.
CONTRACT_IMPORTS = ("dataclasses", "genlayer")

#: Mirrored from `test_module_is_stdlib_only_and_has_no_io`, which reads rdap.py from disk and so
#: says nothing about the splice.
BANNED_CALLS = {"open", "input", "eval", "exec", "compile", "__import__", "globals",
                "locals", "print"}
BANNED_ATTRS = {"urlopen", "socket", "system", "popen", "getenv", "environ", "time",
                "now", "utcnow", "monotonic", "random", "urandom", "read_bytes",
                "read_text", "write_bytes"}
BANNED_TOUCHES = ("environ", "argv", "stdin", "stdout", "stderr")

#: The three module-level mutable containers in the region, with why each is safe. Holdfast's
#: blanket "tuple or frozenset" rule would fail all three, and relaxing it into a bare exemption
#: would be a way of not checking. So each is named with its reason here, the mutator scan below
#: covers static mutation, and the behavioural layer covers the rest.
MUTABLE_EXEMPT = {
    "_DOMAIN_LABEL_OK": "read only by `in`, never iterated and never written",
    "DOH_ENDPOINTS": "read only by key, and the two keys are module constants",
    "DOH_HEADERS": "always `dict(DOH_HEADERS)`-copied before it reaches fetch, which is the "
                   "pattern that makes a module-level dict safe to share",
}

#: Names that must never be the argument to a digest call. The DoH capture measurements show the
#: two resolvers formatting identical records four different ways, so the raw body is not stable
#: across validators and hashing it would make agreement impossible rather than unlikely.
UNHASHABLE_NAMES = ("raw", "body", "payload", "response")
DIGEST_CALLS = ("_sha256_hex", "sha256_hex")

#: The two standalone tests that read rdap.py from disk by absolute path.
VACUOUS_AGAINST_SPLICE = (
    "test_module_is_stdlib_only_and_has_no_io",
    "test_splice_region_digest_is_reproducible",
)


def read(path):
    return io.open(path, encoding="utf-8", newline="").read()


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract_region(text, label):
    """The text between the two markers, normalized exactly as the standalone suite does.

    The normalization is copied line for line out of `test_splice_region_digest_is_reproducible`
    rather than reimplemented, because the entire point of anchoring on the source's own markers
    is that the digest the suite prints and the digest this script asserts are one number. A
    normalization that differed by a trailing newline would make them two.
    """
    if text.count(BEGIN) != 1 or text.count(END) != 1:
        raise SystemExit("%s must carry each marker exactly once; found %d BEGIN and %d END"
                         % (label, text.count(BEGIN), text.count(END)))
    start = text.index(BEGIN) + len(BEGIN)
    stop = text.index(END)
    if stop < start:
        raise SystemExit("%s has the END marker before the BEGIN marker" % label)
    region = text[start:stop]
    return "\n".join(region.replace("\r\n", "\n").split("\n")).strip() + "\n"


def marker_lines(text):
    """(line of BEGIN, line of END), 1-based, for attributing an AST node to a side."""
    return (text[:text.index(BEGIN)].count("\n") + 1,
            text[:text.index(END)].count("\n") + 1)


def split_contract(text):
    """The contract as (head, tail), where head ends with the BEGIN line and tail starts at END."""
    begin = text.index(BEGIN)
    head_end = text.index("\n", begin) + 1
    end = text.index(END)
    tail_start = text.rindex("\n", 0, end) + 1
    return text[:head_end], text[tail_start:]


def write_splice():
    region = extract_region(read(SOURCE), os.path.relpath(SOURCE, REPO))
    text = read(CONTRACT)
    current = extract_region(text, os.path.relpath(CONTRACT, REPO))
    if current == region:
        print("region already current; nothing rewritten")
        return
    head, tail = split_contract(text)
    io.open(CONTRACT, "w", encoding="utf-8", newline="\n").write(
        head + "\n" + region + "\n" + tail)
    print("spliced %d lines (%d bytes) of %s into %s"
          % (region.count("\n"), len(region.encode("utf-8")),
             os.path.basename(SOURCE), os.path.relpath(CONTRACT, REPO)))


# ----------------------------------------------------------------------------------
# Layer 1: textual
# ----------------------------------------------------------------------------------

def check_textual(region, current):
    want, got = sha256(region), sha256(current)
    if want != got:
        print("  FAIL region differs from source")
        print("       source  sha256 %s (%d lines, %d bytes)"
              % (want, region.count("\n"), len(region.encode("utf-8"))))
        print("       spliced sha256 %s (%d lines, %d bytes)"
              % (got, current.count("\n"), len(current.encode("utf-8"))))
        want_lines, got_lines = region.splitlines(), current.splitlines()
        for i in range(min(len(want_lines), len(got_lines))):
            if want_lines[i] != got_lines[i]:
                print("       first difference at region line %d:" % (i + 1))
                print("         source:  %r" % want_lines[i][:120])
                print("         spliced: %r" % got_lines[i][:120])
                break
        else:
            print("       identical for %d lines, then the lengths diverge (%d vs %d)"
                  % (min(len(want_lines), len(got_lines)), len(want_lines), len(got_lines)))
        return False
    print("  pass region is byte-identical to source, sha256 %s, %d lines, %d bytes"
          % (want, region.count("\n"), len(region.encode("utf-8"))))
    return True


# ----------------------------------------------------------------------------------
# Layer 2: structural, against the spliced region rather than against rdap.py
# ----------------------------------------------------------------------------------

def _imports_of(tree, keep):
    """Top-level module names imported by nodes `keep(node)` accepts."""
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and keep(node):
            for alias in node.names:
                found.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and keep(node):
            if node.level:
                found.add("<relative>")
            found.add((node.module or "").split(".")[0])
    return found


def check_region_imports(region_tree):
    got = _imports_of(region_tree, lambda node: True)
    want = set(REGION_IMPORTS)
    if got != want:
        print("  FAIL the region imports %s; it must import exactly %s. The region's first line "
              "is `import hashlib` and the standalone suite digests from there, so these cannot "
              "be hoisted into the contract head without breaking the byte-identity that makes "
              "those tests mean anything."
              % (", ".join(sorted(got)) or "nothing", ", ".join(sorted(want))))
        return False
    print("  pass the region imports exactly %s, inside the digested region where the suite "
          "measures them" % ", ".join(sorted(want)))
    return True


def check_contract_imports(contract_tree, begin_line, end_line):
    got = _imports_of(contract_tree,
                      lambda node: not (begin_line < node.lineno < end_line))
    want = set(CONTRACT_IMPORTS)
    if got != want:
        print("  FAIL the contract's own head and tail import %s; expected exactly %s"
              % (", ".join(sorted(got)) or "nothing", ", ".join(sorted(want))))
        return False
    print("  pass the contract's own head and tail import exactly %s, and nothing the region "
          "already provides" % ", ".join(sorted(want)))
    return True


def check_no_status_code(region_tree, contract_tree, skip=None):
    """`.status_code` does not exist on a GenVM web response. It is `.status`.

    The published SDK example reads `.status_code`, and following it produces an
    `AttributeError` inside a consensus block, after the round has been paid for. One check,
    against a mistake that was actually made in this project once.

    Deliberately an attribute scan rather than a substring scan. Both files name the hazard in
    prose, and the region raises a refusal whose message says "not .status_code" so that a
    future reader meets the explanation at the moment it matters. Flagging that text would
    punish documenting the bug, which is the opposite of the intent. `getattr(x, "status_code")`
    is covered too, because it is the one spelling an attribute scan alone would miss.
    """
    bad = []
    for label, tree, filt in (("the region", region_tree, None),
                              ("the contract", contract_tree, skip)):
        for node in ast.walk(tree):
            if filt is not None and filt(node):
                continue
            if isinstance(node, ast.Attribute) and node.attr == "status_code":
                bad.append((label, node.lineno, "reads .status_code"))
            if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                    and node.func.id == "getattr" and len(node.args) >= 2
                    and isinstance(node.args[1], ast.Constant)
                    and node.args[1].value == "status_code"):
                bad.append((label, node.lineno, 'calls getattr(..., "status_code")'))
    if bad:
        for label, lineno, what in bad:
            print("  FAIL %s %s at line %d. A GenVM web response exposes .status; the published "
                  "example is wrong about this." % (label, what, lineno))
        return False
    print("  pass neither the region nor the contract reads .status_code, by attribute or by "
          "getattr; both only name it in prose to warn about it")
    return True


def check_no_digest_over_a_raw_body(region_tree):
    """A digest may never be taken over a raw response body.

    Measured: the two DoH resolvers return the same TXT record with different quoting, a
    different TTL, a Comment naming the answering anycast address, and a different question
    name. Every one of those changes the bytes and none changes the record. Hashing the body
    would make validators disagree on identical evidence.
    """
    bad = []
    for node in ast.walk(region_tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id in DIGEST_CALLS):
            continue
        for arg in node.args:
            name = None
            if isinstance(arg, ast.Name):
                name = arg.id
            elif isinstance(arg, ast.Attribute):
                name = arg.attr
            if name and name.lower() in UNHASHABLE_NAMES:
                bad.append((node.lineno, node.func.id, name))
    if bad:
        for lineno, call, name in bad:
            print("  FAIL region line %d takes %s(%s) over a raw response value. Resolver "
                  "bodies differ on four measured axes for identical records, so a digest of "
                  "one is a digest of formatting." % (lineno, call, name))
        return False
    print("  pass no digest in the region is taken over a raw response body (%s never reaches "
          "%s)" % ("/".join(UNHASHABLE_NAMES), "/".join(DIGEST_CALLS)))
    return True


def check_broad_handlers_are_last(region_tree):
    """A broad `except Exception` must never sit above `except Refusal` in the same try.

    Python matches handlers in order, so `except Exception` first would catch every tagged
    `Refusal` and re-tag it. A refusal that arrives as `[EXPECTED]` and leaves as `[TRANSIENT]`
    tells a caller to retry something that will never succeed, which is worse than either tag
    on its own.
    """
    bad = []
    for node in ast.walk(region_tree):
        if not isinstance(node, ast.Try):
            continue
        names = []
        for handler in node.handlers:
            kinds = []
            if isinstance(handler.type, ast.Name):
                kinds = [handler.type.id]
            elif isinstance(handler.type, ast.Tuple):
                kinds = [e.id for e in handler.type.elts if isinstance(e, ast.Name)]
            elif handler.type is None:
                kinds = ["<bare>"]
            names.append((handler.lineno, kinds))
        broad_at = [ln for ln, kinds in names
                    if "Exception" in kinds or "BaseException" in kinds or "<bare>" in kinds]
        refusal_at = [ln for ln, kinds in names if "Refusal" in kinds]
        if broad_at and refusal_at and min(broad_at) < min(refusal_at):
            bad.append((min(broad_at), min(refusal_at)))
    if bad:
        for broad, refusal in bad:
            print("  FAIL a broad handler at region line %d precedes `except Refusal` at line "
                  "%d, so every tagged refusal in that try would be caught and re-tagged"
                  % (broad, refusal))
        return False
    print("  pass no broad handler in the region precedes an `except Refusal` in the same try, "
          "so no tagged refusal can be flattened on the way out")
    return True


def check_contract_never_swallows_a_refusal(contract_tree, begin_line, end_line):
    """Every `except Refusal` in the contract must re-raise or marshal it. None may absorb it.

    This is the "absence is never success" rule as a static check. `except Refusal: pass` would
    turn an unreachable source into a silent verdict, which is the exact failure this whole
    project is built to avoid, and it is two characters away from correct code.
    """
    bad = []
    for node in ast.walk(contract_tree):
        if not isinstance(node, ast.ExceptHandler):
            continue
        if begin_line < node.lineno < end_line:
            continue
        kinds = []
        if isinstance(node.type, ast.Name):
            kinds = [node.type.id]
        elif isinstance(node.type, ast.Tuple):
            kinds = [e.id for e in node.type.elts if isinstance(e, ast.Name)]
        if "Refusal" not in kinds:
            continue
        raises = any(isinstance(n, ast.Raise) for n in ast.walk(node))
        marshals = False
        for inner in ast.walk(node):
            if isinstance(inner, ast.Return) and isinstance(inner.value, ast.Dict):
                for key in inner.value.keys:
                    if isinstance(key, ast.Constant) and key.value == "error":
                        marshals = True
        if not (raises or marshals):
            bad.append(node.lineno)
    if bad:
        for lineno in bad:
            print("  FAIL the `except Refusal` at contract line %d neither re-raises nor returns "
                  "an {\"error\": ...} dict, so a refused source would read as a verdict"
                  % lineno)
        return False
    print("  pass every `except Refusal` in the contract either re-raises it as a UserError or "
          "marshals it out of a consensus block as {\"error\": ...}")
    return True


def check_no_io(tree, label, skip=None):
    ok = True
    for node in ast.walk(tree):
        if skip is not None and skip(node):
            continue
        if isinstance(node, ast.Call):
            target = node.func
            if isinstance(target, ast.Name) and target.id in BANNED_CALLS:
                print("  FAIL %s calls %s() at line %d" % (label, target.id, node.lineno))
                ok = False
            if isinstance(target, ast.Attribute) and target.attr in BANNED_ATTRS:
                print("  FAIL %s calls .%s() at line %d" % (label, target.attr, node.lineno))
                ok = False
        if isinstance(node, ast.Attribute) and node.attr in BANNED_TOUCHES:
            print("  FAIL %s touches %s at line %d" % (label, node.attr, node.lineno))
            ok = False
    if ok:
        print("  pass %s makes no filesystem, clock, randomness or stream call" % label)
    return ok


def check_module_state(region_tree):
    """Module-level containers, checked against a named exemption list rather than a blanket rule.

    Every module-level assignment must be an immutable literal, or one of the three names in
    MUTABLE_EXEMPT with the reason recorded there. A fourth name appearing as a `set(...)`,
    `dict(...)` or list literal is a failure, because the spliced copy is shared by every
    validator and a mutation would desynchronise them without any of them erring.
    """
    builders = ("set", "list", "dict", "bytearray")
    mutators = ("update", "setdefault", "popitem", "append", "extend", "add", "discard",
                "clear", "pop", "insert", "remove", "sort")
    ok = True
    module_names = set()
    flagged = set()

    for node in region_tree.body:
        if not isinstance(node, ast.Assign):
            continue
        module_names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        for target in node.targets:
            if not isinstance(target, ast.Name):
                continue
            mutable = isinstance(node.value, (ast.List, ast.Dict, ast.Set)) or (
                isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                and node.value.func.id in builders)
            if not mutable:
                continue
            flagged.add(target.id)
            if target.id not in MUTABLE_EXEMPT:
                print("  FAIL module-level mutable container %s at region line %d is not in the "
                      "exemption list. Make it a tuple or a frozenset, or add it with a reason."
                      % (target.id, node.lineno))
                ok = False

    stale = sorted(set(MUTABLE_EXEMPT) - flagged)
    if stale:
        print("  FAIL the exemption list names %s, which no longer exists as a module-level "
              "mutable container. A stale exemption is a check that stopped checking."
              % ", ".join(stale))
        ok = False

    for node in ast.walk(region_tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr in mutators \
                and isinstance(node.func.value, ast.Name) \
                and node.func.value.id in module_names:
            print("  FAIL the region mutates module-level %s with .%s() at line %d"
                  % (node.func.value.id, node.func.attr, node.lineno))
            ok = False

    if ok:
        print("  pass module-level state in the region is immutable except %d named containers, "
              "and none is statically mutated:" % len(MUTABLE_EXEMPT))
        for name in sorted(MUTABLE_EXEMPT):
            print("       %-18s %s" % (name, MUTABLE_EXEMPT[name]))
    return ok


def region_callables(region_tree):
    return ([n.name for n in region_tree.body if isinstance(n, ast.FunctionDef)],
            [n.name for n in region_tree.body if isinstance(n, ast.ClassDef)])


def contract_constant(contract_tree, name):
    """One module-level integer constant from the contract, or None."""
    for node in contract_tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == name:
                if isinstance(node.value, ast.Constant) and isinstance(node.value.value, int):
                    return node.value.value
    return None


def check_callables(module, region_tree, expected):
    """Every top-level def and class in the region resolves, and the count matches the contract.

    `rdap.py` has no `__all__`, so this counts statements rather than reading a list. A splice
    that truncated the file mid-function would otherwise only surface as a `NameError` on a live
    deal, after the escrow was already held.
    """
    funcs, classes = region_callables(region_tree)
    names = funcs + classes
    missing = [n for n in names if not hasattr(module, n)]
    if missing:
        print("  FAIL the spliced region defines but does not expose: %s" % ", ".join(missing))
        return False
    not_callable = [n for n in names if not callable(getattr(module, n))]
    if not_callable:
        print("  FAIL not callable after execution: %s" % ", ".join(not_callable))
        return False
    if expected is None:
        print("  FAIL the contract declares no EMBEDDED_FUNCTION_COUNT to check %d callables "
              "against" % len(names))
        return False
    if len(names) != expected:
        print("  FAIL the region defines %d callables (%d def, %d class); the contract declares "
              "EMBEDDED_FUNCTION_COUNT = %d" % (len(names), len(funcs), len(classes), expected))
        return False
    print("  pass all %d region callables resolve and are callable (%d def, %d class), matching "
          "the contract's EMBEDDED_FUNCTION_COUNT" % (len(names), len(funcs), len(classes)))
    return True


# ----------------------------------------------------------------------------------
# Layer 3: behavioural
# ----------------------------------------------------------------------------------

def load_region_as_module(region):
    """Execute the spliced region as a module named `rdap`.

    No imports are pre-bound, unlike the Holdfast equivalent, because the region imports its own
    two. If that ever stops being true the exec fails here rather than passing quietly.
    """
    import types
    module = types.ModuleType(MODULE_NAME)
    module.__file__ = CONTRACT + " (embedded region)"
    exec(compile(region, "<Conveyance.py embedded rdap path>", "exec"),   # noqa: S102
         module.__dict__)
    return module


def snapshot(obj):
    """A comparable, order-independent rendering of one container."""
    if isinstance(obj, (set, frozenset)):
        return "set:" + json.dumps(sorted(repr(x) for x in obj))
    if isinstance(obj, dict):
        return "dict:" + json.dumps({str(k): repr(v) for k, v in obj.items()}, sort_keys=True)
    if isinstance(obj, (list, tuple)):
        return "seq:" + json.dumps([repr(x) for x in obj])
    return "value:" + repr(obj)


def snapshot_exempt(module):
    return dict((name, snapshot(getattr(module, name))) for name in sorted(MUTABLE_EXEMPT)
                if hasattr(module, name))


def check_exempt_unmutated(module, before):
    """The three exempted containers, compared before and after the full suite run.

    The static scan proves nothing writes to them through their module-level name. This proves
    nothing wrote to them through an alias, a local binding, or a returned reference either,
    across every path 34 tests exercise. It is the difference between reasoning that the shared
    state is safe and observing that it was not touched.
    """
    after = snapshot_exempt(module)
    if sorted(before) != sorted(after):
        print("  FAIL the exempted container set changed during the run: %s became %s"
              % (sorted(before), sorted(after)))
        return False
    changed = [name for name in before if before[name] != after[name]]
    if changed:
        for name in changed:
            print("  FAIL module-level %s was mutated during the suite run" % name)
            print("       before %s" % before[name][:160])
            print("       after  %s" % after[name][:160])
        return False
    print("  pass all %d exempted containers are byte-identical before and after the suite run, "
          "so the shared module state is observed unmutated and not merely argued to be"
          % len(before))
    return True


def run_suite_against(module):
    """Run the standalone suite with `rdap` bound to the spliced copy.

    `unittest.SkipTest` is caught separately, because two tests skip on the real transfer
    captures that have not been taken yet. Counting a skip as a pass would be a lie and counting
    it as a failure would make this script useless until a domain transfer completes.
    """
    if SUITE_DIR not in sys.path:
        sys.path.insert(0, SUITE_DIR)
    sys.modules[MODULE_NAME] = module
    sys.modules.pop(SUITE_NAME, None)
    suite = __import__(SUITE_NAME)

    tests = [(name, obj) for name, obj in sorted(vars(suite).items())
             if name.startswith("test_") and callable(obj)]
    passed, skipped, failed = 0, [], []
    for name, test in tests:
        try:
            test()
        except unittest.SkipTest as exc:
            skipped.append((name, str(exc)))
        except Exception:                                                # noqa: BLE001
            failed.append(name)
            print("  FAIL %s" % name)
            traceback.print_exc()
        else:
            passed += 1
    return passed, skipped, failed, len(tests)


def main(argv):
    write = "--write" in argv[1:]

    if write:
        write_splice()
        print("")

    source = read(SOURCE)
    contract_text = read(CONTRACT)
    region = extract_region(source, os.path.relpath(SOURCE, REPO))
    current = extract_region(contract_text, os.path.relpath(CONTRACT, REPO))
    begin_line, end_line = marker_lines(contract_text)

    print("splice guard: %s -> %s" % (os.path.relpath(SOURCE, REPO),
                                      os.path.relpath(CONTRACT, REPO)))
    print("  source file sha256 %s (%d lines, %d bytes)"
          % (sha256(source), source.count("\n"), len(source.encode("utf-8"))))
    print("  contract markers at lines %d and %d" % (begin_line, end_line))
    print("")

    if current.strip() == "":
        print("  FAIL the region between the markers is empty; run with --write first")
        return 1

    results = []
    print("textual")
    results.append(check_textual(region, current))
    print("")

    print("structural, against the spliced region and not against rdap.py")
    try:
        region_tree = ast.parse(current)
    except SyntaxError as exc:
        print("  FAIL the spliced region does not parse: %s at line %s" % (exc.msg, exc.lineno))
        return 1
    contract_tree = ast.parse(contract_text)
    in_region = lambda node: begin_line < getattr(node, "lineno", 0) < end_line

    results.append(check_region_imports(region_tree))
    results.append(check_contract_imports(contract_tree, begin_line, end_line))
    results.append(check_no_status_code(region_tree, contract_tree, skip=in_region))
    results.append(check_no_digest_over_a_raw_body(region_tree))
    results.append(check_broad_handlers_are_last(region_tree))
    results.append(check_contract_never_swallows_a_refusal(
        contract_tree, begin_line, end_line))
    results.append(check_no_io(region_tree, "the region"))
    results.append(check_no_io(contract_tree, "the contract", skip=in_region))
    results.append(check_module_state(region_tree))
    print("")

    print("behavioural, the standalone suite re-run against the spliced copy")
    try:
        module = load_region_as_module(current)
    except Exception as exc:                                             # noqa: BLE001
        print("  FAIL the region will not execute as a module: %r" % (exc,))
        traceback.print_exc()
        return 1
    results.append(check_callables(
        module, region_tree, contract_constant(contract_tree, "EMBEDDED_FUNCTION_COUNT")))

    before = snapshot_exempt(module)
    passed, skipped, failed, total = run_suite_against(module)
    if failed:
        print("  FAIL %d of %d tests failed against the spliced copy: %s"
              % (len(failed), total, ", ".join(failed)))
        results.append(False)
    else:
        print("  pass %d of %d tests pass against the spliced copy, %d skipped"
              % (passed, total, len(skipped)))
        results.append(True)
    for name, why in skipped:
        print("  skip %s: %s" % (name, why[:150]))
    results.append(check_exempt_unmutated(module, before))
    print("  note %d of those %d read rdap.py from disk by absolute path, so they say nothing "
          "about the splice: %s. Both are re-checked above, against the region."
          % (len(VACUOUS_AGAINST_SPLICE), total, ", ".join(VACUOUS_AGAINST_SPLICE)))
    print("")

    if all(results):
        print("splice verified: %d checks, %d tests (%d passed, %d skipped), region sha256 %s"
              % (len(results), total, passed, len(skipped), sha256(region)))
        return 0
    print("splice NOT verified: %d of %d checks failed"
          % (len([r for r in results if not r]), len(results)))
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
