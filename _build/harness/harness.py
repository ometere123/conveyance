"""Load any GenLayer contract off-chain and serve it saved live bytes.

    python _build/harness/run.py holdfast
    python _build/harness/run.py conveyance
    python _build/harness/run.py quorum-clean

This is the project-agnostic successor to `_build/intent-guard-harness/harness.py`, which
hardcoded one contract path, one fixture directory, and one proposal id. The stub SDK in
`genlayer.py` beside this file is a byte-identical copy of the one that found four real
Intent Guard bugs before any deploy; nothing about it needed to change.

Two things it does that a mock does not:

  * It serves **bytes verbatim** off disk. For Holdfast that is load bearing, because four
    of its nine fixtures are gzip payloads and a fixture layer that helpfully decoded them
    on the way through would test a contract that cannot work on chain.
  * It refuses unknown URLs. A contract reaching a URL with no fixture raises, so a test
    can never silently reach the internet, and can never pass because a source was absent.

Fixtures live in `_build/fixtures/<project>/` with a `manifest.json` beside them. The
manifest is the whole routing table; see `FixtureNetwork` for the entry shape.
"""

import io
import json
import os
import re
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FIXTURE_ROOT = os.path.join(ROOT, "_build", "fixtures")

#: Where each project's contract lives, relative to the repo root. Keyed by the name
#: passed on the command line so `run.py <project>` needs no other configuration.
PROJECTS = {
    "holdfast": ("holdfast", "contracts/Holdfast.py", "Holdfast"),
    "conveyance": ("conveyance", "contracts/Conveyance.py", "Conveyance"),
    "quorum-clean": ("quorum-clean", "contracts/QuorumClean.py", "QuorumClean"),
    "intent-guard": ("intent-guard", "contracts/IntentGuard.py", "IntentGuard"),
    "recourse": ("recourse", "contracts/Recourse.py", "Recourse"),
}


#: The stub SDK module, bound on the first `load_contract()`. Everything that patches the
#: fake network must patch *this* object, not a fresh import.
sdk = None


def contract_path(project):
    """Absolute path to a project's contract, from the `PROJECTS` table."""
    if project not in PROJECTS:
        raise KeyError("unknown project %r, expected one of %s"
                       % (project, ", ".join(sorted(PROJECTS))))
    folder, rel, _ = PROJECTS[project]
    return os.path.join(ROOT, folder, *rel.split("/"))


def module_name_for(project):
    return PROJECTS[project][2]


def load_sdk():
    """Bind the stub SDK and return it, without needing a contract to exist.

    Split out of `load_contract()` because the fixture-integrity checks need it. Those checks ask
    whether the manifest routes correctly and whether the declared byte counts are real, and they
    have to be answerable before any contract is written: they are the checks that catch a fixture
    table which silently shadows one of its own routes, and that class of defect is cheapest to
    find on the day the fixtures land rather than on the day the contract reads them.

    Serving a fixture needs `sdk.Response`, so without this a routing check had to load a contract
    it did not use, and in a project whose contract is not written yet that meant the check could
    not run at all. It reported `load_contract() must run before serving a fixture`, which is a
    true statement about the harness and a misleading one about the fixtures.

    Imported exactly once per process and never reloaded, for the reason `load_contract()` gives.
    """
    global sdk
    if sdk is None:
        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        import genlayer  # the stub, from HERE

        sdk = genlayer
    return sdk


def load_contract(path, module_name=None):
    """Import a spliced contract against the stub SDK, returning the module.

    `path` may be a project name from `PROJECTS` or a filesystem path, so a test can say
    `load_contract("holdfast")` and a one-off script can point at a scratch file.

    `sys.path` is prepended, not appended: a `genlayer` package installed in the
    environment would otherwise win, and the harness would be running against a real SDK
    it cannot satisfy, failing in a way that looks like a contract bug.

    The stub is imported exactly once per process and deliberately never reloaded.
    Reloading it produces a second `u256`, a second `Address` and a second `_Web`, and then
    a fixture installed on one copy is invisible to a contract holding the other, which
    presents as "the network fixture did nothing" and costs an hour. Only the contract
    module is re-executed; per-test state is cleared through `sdk.reset()`.
    """
    global sdk
    if path in PROJECTS:
        module_name = module_name or module_name_for(path)
        path = contract_path(path)
    if module_name is None:
        module_name = os.path.splitext(os.path.basename(path))[0]

    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    load_sdk()
    sys.modules.pop(module_name, None)

    source = io.open(path, encoding="utf-8").read()
    module = types.ModuleType(module_name)
    module.__file__ = path
    code = compile(source, path, "exec")
    exec(code, module.__dict__)
    sys.modules[module_name] = module
    return module


def instantiate(module, class_name=None, deposited=0):
    """Build the contract instance with its declared storage materialised.

    Finds the single `gl.Contract` subclass in the module when `class_name` is omitted, so
    a test does not have to repeat a name the contract already states.
    """
    if sdk is None:
        raise RuntimeError("load_contract() must run before instantiate()")
    if class_name is not None:
        cls = getattr(module, class_name)
    else:
        found = [
            value
            for value in vars(module).values()
            if isinstance(value, type)
            and issubclass(value, sdk.gl.Contract)
            and value is not sdk.gl.Contract
        ]
        if len(found) != 1:
            raise RuntimeError(
                "expected exactly one gl.Contract subclass, found %d" % len(found)
            )
        cls = found[0]
    return sdk.instantiate(cls, deposited=deposited)


# ======================================================================================
# Fixture-backed network
# ======================================================================================


class FixtureNotCaptured(Exception):
    """A test needs a fixture that has not been captured yet, and refuses to guess.

    A distinct state from both pass and fail, and the runner prints it as `wait`. It means a
    test is written, is wired to a named route, and is waiting on bytes that can only come
    from an event in the world: a real cross-registrar transfer, a real archive crawl. The
    test body is unreachable until they land.

    Raised rather than skipped silently, and never converted to a pass. A suite that reported
    "ok" for a route whose fixture is a placeholder would be claiming the contract had been
    run against evidence nobody has collected, which is the most expensive lie a harness of
    this shape can tell. When the capture does land, the body runs and fails until it is
    written, which is the intended trigger rather than an accident.
    """


class FixtureMiss(Exception):
    """A contract reached a URL with no fixture. Never converted to a 404 or an empty body.

    The distinction matters more here than anywhere else in the test rig. Absence is never
    success: if an unmatched URL quietly became `404`, a contract bug that fetched the
    wrong URL would surface as "the source says nothing changed", which is exactly the
    conclusion the whole design refuses to draw.
    """


class FixtureNetwork:
    """Answers a contract's HTTP calls from disk, and records every one of them.

    The recording is half the value. A contract that publishes on chain how much
    nondeterminism a check cost is making a claim, and `calls` is how that claim gets
    checked rather than believed.

    Manifest entries, in `_build/fixtures/<project>/manifest.json`, are matched in order:

        {
          "url":     "https://exact/url",      exact match, preferred
          "pattern": "^https://re\\\\.gex/",     regex fallback when the URL varies
          "method":  "GET",                    optional, defaults to any
          "status":  200,
          "body":    "some-capture.bin",       served byte for byte, no decoding
          "headers": {"content-type": "application/json"},
          "note":    "captured 2026-08-25"
        }

    `body` may instead be `"inline"` with a `"text"` key, for the small responses where a
    separate file is more indirection than it is worth. A never-archived Wayback URL
    returning a 3-byte `[]` is the motivating case.

    `prefer` exists because some fixtures are the same URL at a different moment. Conveyance's
    pending-transfer and transfer-complete records are the baseline domain mid-transfer and
    after it, and its disagreement fixture is the same Google query with one TXT value changed.
    A URL-keyed table cannot express "later", so a test names the route it wants and matching
    tries those first. It is distinct from `only`, which starves a matched route into a 503 to
    simulate an unreachable source, and from `fail`, which forces a status code.
    """

    def __init__(self, project, *, only=None, fail=None, prefer=None):
        self.project = project
        self.dir = os.path.join(FIXTURE_ROOT, project)
        self.calls = []
        self.served = []
        #: Route names to serve; None means all. Lets a test starve one source.
        self.only = set(only) if only else None
        #: Route name to status code, forcing a failure for that route.
        self.fail = dict(fail or {})
        self.entries = self._load_manifest()
        #: Route names to try before manifest order, for same-URL-different-moment fixtures.
        self.prefer = list(prefer or [])
        self._check_prefer()

    def _check_prefer(self):
        """A name in `prefer` that no route carries raises now, not at request time.

        Falling through to the baseline would let a test claim it exercised the
        pending-transfer path while reading the pre-transfer record, and it would pass. That is
        the same shape as every bug this project exists to catch, so a typo has to be loud.
        """
        if not self.prefer:
            return
        known = {entry.get("name") for entry in self.entries if entry.get("name")}
        unknown = [name for name in self.prefer if name not in known]
        if unknown:
            raise FixtureMiss(
                "prefer names no such route: %s. Known routes in _build/fixtures/%s/"
                "manifest.json are: %s"
                % (", ".join(unknown), self.project, ", ".join(sorted(known)))
            )

    def _load_manifest(self):
        path = os.path.join(self.dir, "manifest.json")
        if not os.path.exists(path):
            raise FixtureMiss("no manifest at %s" % path)
        data = json.load(io.open(path, encoding="utf-8"))
        entries = data["routes"] if isinstance(data, dict) else data
        for entry in entries:
            if "pattern" in entry:
                entry["_re"] = re.compile(entry["pattern"])
        return entries

    # -- installation ------------------------------------------------------------------

    def install(self):
        """Take over `gl.nondet.web` for the stub SDK. Call `load_contract()` first."""
        if sdk is None:
            raise RuntimeError("load_contract() must run before install()")
        sdk._Web.handler = self.handle
        return self

    @staticmethod
    def _response(status, body, headers=None):
        """Resolved from the module, not cached on the instance at `install()` time.

        Caching it there meant a test that called a route directly to inspect what one
        source would return, a reasonable thing to do when the point of the test is that
        two sources differ, crashed on a missing attribute instead of answering.

        It binds the stub through `load_sdk()` rather than demanding a prior `load_contract()`,
        so a fixture-integrity check can serve a route in a project whose contract does not exist
        yet. Refusing to serve there produced an error about the harness in a check that was
        asking a question about the manifest.
        """
        return load_sdk().Response(status, body, headers or {})

    # -- dispatch ----------------------------------------------------------------------

    def handle(self, url, method, body, headers, sign):
        self.calls.append((method, url))
        entry = self._match(url, method)
        name = entry.get("name") or entry.get("body") or url

        if entry.get("requires_header"):
            # Reproducing a source's real header requirement here means a future edit that
            # drops the header fails on a laptop rather than in a consensus round. ORCID
            # returns XML without `Accept: application/json`; Cloudflare DoH 400s without
            # `Accept: application/dns-json`; 4byte 403s without a User-Agent.
            #
            # `missing_header_body` exists for the ORCID case specifically, and it is the more
            # dangerous of the two shapes. Cloudflare's 400 is loud. ORCID answers 200 with
            # 44 KB of XML, so a check that only asks whether the request succeeded sees
            # success and then finds no employment overlap in bytes it never parsed. Serving
            # the real XML here is the only way a test can tell those apart.
            wanted = entry["requires_header"]
            for key, value in wanted.items():
                got = headers.get(key)
                missing = got is None or (value and str(value) not in str(got))
                if not missing:
                    continue
                status = entry.get("missing_header_status", 400)
                alternate = entry.get("missing_header_body")
                if alternate:
                    return self._response(
                        status,
                        self.fixture_bytes(alternate),
                        entry.get("missing_header_headers"),
                    )
                detail = b'{"detail":"fixture: required header absent or mismatched"}'
                return self._response(status, detail)

        if name in self.fail:
            return self._response(self.fail[name], b'{"detail":"fixture: forced failure"}')
        if self.only is not None and name not in self.only:
            return self._response(503, b'{"detail":"fixture: route disabled"}')

        self.served.append(name)
        status = int(entry.get("status", 200))
        payload = self._body_of(entry)
        return self._response(status, payload, entry.get("headers"))

    def _match(self, url, method):
        for entry in self._candidates():
            if entry.get("method") and entry["method"] != method:
                continue
            if entry.get("url") == url:
                return entry
            compiled = entry.get("_re")
            if compiled is not None and compiled.search(url):
                return entry
        raise FixtureMiss(
            "the contract called %s %r and no fixture matches it. Add a route to "
            "_build/fixtures/%s/manifest.json rather than letting this become a 404."
            % (method, url, self.project)
        )

    def _candidates(self):
        """Preferred routes in the order named, then everything else in manifest order.

        Preferred routes are not removed from the tail, so `prefer` narrows nothing: a URL that
        no preferred route matches still resolves normally. That keeps a phase test honest in
        the other direction too, since a contract fetching an unrelated source during the
        pending-transfer phase still gets its own fixture rather than a confusing miss.
        """
        if not self.prefer:
            return self.entries
        by_name = {entry.get("name"): entry for entry in self.entries if entry.get("name")}
        head = [by_name[name] for name in self.prefer if name in by_name]
        return head + [entry for entry in self.entries if entry not in head]

    def _body_of(self, entry):
        """Bytes, verbatim. Never decoded, never re-encoded, never parsed.

        Holdfast's whole point is that a gzip payload replayed by Wayback is indistinguishable
        from a page whose clauses were deleted, so a fixture layer that decoded on the way
        through would be testing the one thing that cannot happen on chain.
        """
        if "text" in entry:
            return entry["text"].encode("utf-8")
        if "json" in entry:
            return json.dumps(entry["json"]).encode("utf-8")
        if not entry.get("body"):
            return b""
        path = os.path.join(self.dir, entry["body"])
        if not os.path.exists(path):
            raise FixtureMiss("manifest points at a missing file: %s" % path)
        with io.open(path, "rb") as handle:
            return handle.read()

    # -- inspection --------------------------------------------------------------------

    def fixture_bytes(self, filename):
        """Read one fixture off disk without going through the contract.

        Used to assert on lengths and digests. Note it returns bytes and callers print
        counts: a 2 MB fixture must never be rendered into a test log or an agent context.
        """
        with io.open(os.path.join(self.dir, filename), "rb") as handle:
            return handle.read()


# ======================================================================================
# Prompt stubs
# ======================================================================================


def context(sender=None, value=0, datetime=None):
    """Set the message context for the next call, leaving installed fixtures alone.

    `sdk.reset()` does two jobs: it clears the fake network and it sets `gl.message`. The runner
    wants the first, once per test. A test wants the second, repeatedly, because a bond is created
    by one sender and then checked, contested, adjudicated and settled by others at four different
    clock readings, against one archive that has to survive all of them.

    Calling `reset()` for the second job silently does the first, which leaves the contract
    reaching a network with no handler. That raises `_NoNetwork` rather than `UserError`, so a
    `reverts("[EXTERNAL]", ...)` assertion fails with a message about the harness, and every test
    that legitimately expects a fetch to succeed errors instead. Splitting the two verbs is the fix;
    the runner keeps calling `reset()` between tests, so per-test hygiene is unchanged.

    The transfer ledger is still cleared, because a payout assertion reads it after a single call
    and has to see that call's transfers rather than the whole test's.
    """
    if sdk is None:
        raise RuntimeError("load_contract() must run before context()")
    del sdk._Evm.transfers[:]
    sdk.gl.message.value = int(value)
    if sender is not None:
        sdk.gl.message.sender_address = sdk.Address(sender)
    if datetime is not None:
        sdk.gl.message_raw["datetime"] = str(datetime)


def install_prompt(handler):
    """Bind a prompt stub, mirroring `FixtureNetwork.install()` for the model side.

    Exists so a suite never reaches into `sdk._Nondet` directly. The two sides of the
    nondeterminism boundary are then installed the same way, which matters because a suite
    that forgets one of them does not fail: it raises `_NoNetwork` from wherever the contract
    happens to touch the missing side first, and that reads as a contract bug.
    """
    if sdk is None:
        raise RuntimeError("load_contract() must run before install_prompt()")
    sdk._Nondet.prompt_handler = handler
    return handler


def fixed_prompt(**answer):
    """A stub model that returns one dict and records the prompts it was shown.

    The prompt text is kept because a contract's real defence against injection is what it
    puts *in* the prompt, and an assertion on that text is a test of the defence. A stub
    that only returned a verdict would leave the guard untested.
    """
    seen = []

    def handler(prompt, response_format):
        seen.append(prompt)
        return dict(answer)

    handler.prompts = seen
    return handler


def scripted_prompt(*answers):
    """A stub model that returns a different answer per call, for multi-round paths.

    Holdfast needs two consecutive qualified change points before it will move value, so a
    single-answer stub cannot reach a breach at all. Raises when it runs dry rather than
    repeating the last answer, because a silent repeat would make an under-called path look
    like a passing one.
    """
    queue = list(answers)
    seen = []

    def handler(prompt, response_format):
        seen.append(prompt)
        if not queue:
            raise AssertionError(
                "scripted_prompt exhausted after %d call(s): the contract asked the model "
                "more times than the test scripted" % len(seen)
            )
        return dict(queue.pop(0))

    handler.prompts = seen
    handler.remaining = queue
    return handler


def refusing_prompt(message="fixture: no prompt scripted"):
    """A stub model that fails if it is called at all.

    Installed on every deterministic test. The determinism boundary is a claim about which
    paths reach a model, and this is how the claim is enforced instead of documented.
    """

    def handler(prompt, response_format):
        raise AssertionError(message)

    handler.prompts = []
    return handler
