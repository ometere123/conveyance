"""Byte-pin the captured evidence, and refuse to let a placeholder pass as a capture.

    python scripts/verify_fixtures.py          # from the conveyance root
    npm run verify:fixtures

WHY THIS EXISTS. `tests/direct/fixtures/manifest.json` records, for every captured body, the URL
it came from, the byte count that arrived, and a sha256. Nothing read any of it. The manifest was
prose: eleven routes describing an integrity property that no code checked, so a capture could be
reformatted, re-serialized, truncated or replaced and every test would still pass, because the
tests read the bodies and the manifest describes them. An assertion nobody executes is a comment.

It was written after a sweep found three defects in that file, and two of them are exactly the
class a checker catches and a reader does not:

  * `doh-disagreement` declared `"capture"` twice. JSON last-wins, so the first block was dead.
    Both blocks happened to agree on their three shared fields, so nothing was wrong in effect,
    and an edit to the dead one would have silently done nothing. `json.load` accepts duplicate
    keys without a word, which is why the loader below installs a pairs hook that refuses them.
  * Five of the nine present captures recorded a 32-character sha256, which is half a digest, and
    four recorded none at all. Measured: every recorded prefix does match its file, so the
    truncation was truncation and not a wrong value. All nine now carry the full 64.

WHAT THIS CHECKS AND WHAT IT DOES NOT. The division is stated rather than implied, because a
verifier that quietly covers less than a reader assumes is worse than no verifier.

  Checked here     duplicate keys in the manifest; every route has exactly one body source; the
                   body exists; its byte count is the recorded one; its sha256 is the recorded
                   one; the two uncaptured transfer routes still declare themselves uncaptured;
                   this tree's captures are byte-identical to the offline harness's copy; every
                   recorded captured_url is matched by one of `tests/direct/evidence.py`'s URL
                   patterns; no capture on disk is unreferenced.

  Checked upstream Reachability, which is whether a route can be selected at all. That needs the
                   real matcher in `_build/harness/harness.py`, and reimplementing it here would
                   put a second copy of the matching rule in the one place whose job is to notice
                   drift. It is proven by `python _build/harness/verify_fixtures.py conveyance`,
                   which routes each route's own representative URL through `FixtureNetwork._match`
                   and fails when another route answers first. That tool found five unreachable
                   routes in this manifest, all now recorded as `superseded_route` entries.

THE TWO BLOCKED ROUTES ARE THE POINT OF THE WHOLE FILE. `rdap-pending-transfer` and
`rdap-transfer-complete` are one real domain's registry record before and after a real
cross-registrar transfer. They are not captured yet, they carry `TO FILL` where the URL goes, and
`require_capture` in the offline suite raises `FixtureNotCaptured` naming them rather than passing.
The check below inverts the usual direction and asserts they are STILL uncaptured, so the day a
body appears next to a placeholder URL this fails instead of quietly reporting nine captures where
it used to report nine. A green tick on the flagship artefact before the artefact exists is the one
failure mode this evidence set cannot survive.

Sizes and digests are printed. Bodies never are: one of these is 71,095 bytes.
"""

import hashlib
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
FIXTURES = os.path.join(PROJECT, "tests", "direct", "fixtures")
MANIFEST = os.path.join(FIXTURES, "manifest.json")
EVIDENCE = os.path.join(PROJECT, "tests", "direct", "evidence.py")

#: The offline harness's own copy, which `tests/direct/evidence.py` claims in its header to be
#: byte-identical to this one. Absent from a standalone checkout, which is reported as a skip.
SHARED = os.path.join(PROJECT, "_build", "fixtures", "conveyance")

#: A route whose representative URL is not knowable until something outside the build happens.
#: Never a pass and never a failure: reported as `wait` and counted apart.
BLOCKED = "blocked"

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


class DuplicateKey(ValueError):
    """A JSON object declared the same key twice, so one of the two was never read."""


def _no_duplicate_keys(pairs):
    """`object_pairs_hook` that refuses a repeated key instead of silently keeping the last.

    This is the whole reason the manifest is loaded through a hook rather than `json.load`. The
    stdlib decoder is specified to let the last value win, so a doubled key is not an error and not
    a warning: it is a line of the file that has no effect and looks like it does.
    """
    seen = {}
    for key, value in pairs:
        if key in seen:
            raise DuplicateKey(
                "the key %r is declared twice in the same object, so the first one is dead. "
                "JSON keeps the last value, so editing the first would change nothing." % key
            )
        seen[key] = value
    return seen


def load_manifest():
    with io.open(MANIFEST, encoding="utf-8") as handle:
        return json.load(handle, object_pairs_hook=_no_duplicate_keys)


def recorded_size(capture):
    """The byte count the manifest claims, under whichever of the two names it used.

    `bytes_received` means the bytes came off the wire and were written down unaltered.
    `bytes_on_disk` means only that the file is that long. The distinction is load bearing in this
    manifest, where three bodies are marked `verbatim: "not re-verified"`, and it is preserved here
    rather than collapsed: both are checked identically, because either way a file that changed
    length has changed.
    """
    for key in ("bytes_received", "bytes_on_disk"):
        if key in capture:
            return capture[key], key
    return None, None


def url_patterns():
    """The URL families `tests/direct/evidence.py` answers, read from it rather than restated.

    Restating them here would prove that two files were typed by one hand on one afternoon and
    nothing else. Read, a URL family that moves breaks the check that depends on it.
    """
    with io.open(EVIDENCE, encoding="utf-8") as handle:
        source = handle.read()
    found = re.findall(r'^(URL_[A-Z_]+) = r"([^"]+)"', source, re.M)
    return [(name, re.compile(pattern)) for name, pattern in found]


def main():
    problems = 0
    waiting = 0
    checked = 0

    print("=== conveyance captured evidence ===")
    print("  manifest  %s" % os.path.relpath(MANIFEST, PROJECT).replace(os.sep, "/"))

    try:
        manifest = load_manifest()
    except DuplicateKey as error:
        print("  DUPKEY  %s" % error)
        return 1
    except ValueError as error:
        print("  INVALID JSON: %s" % error)
        return 1

    routes = manifest["routes"]
    names = {}
    referenced = set()
    patterns = url_patterns()
    if not patterns:
        print("  PATTERN no URL_* pattern could be read out of tests/direct/evidence.py, so the "
              "captured URLs cannot be checked against what the suite answers")
        problems += 1

    print("")
    for index, route in enumerate(routes):
        name = route.get("name") or "route[%d]" % index
        capture = route.get("capture") or {}
        mode = route.get("routing", "url")

        if name in names:
            print("  DUP     %-26s also defined at index %d" % (name, names[name]))
            problems += 1
        names[name] = index

        sources = [key for key in ("body", "text", "json") if key in route]
        if len(sources) != 1:
            print("  BODY    %-26s declares %d body sources (%s), expected exactly one"
                  % (name, len(sources), ", ".join(sources) or "none"))
            problems += 1
            continue

        body = route.get("body")
        path = os.path.join(FIXTURES, body) if body else None
        exists = bool(path) and os.path.exists(path)

        # ------------------------------------------------------------------ #
        # The uncaptured pair, asserted still uncaptured                      #
        # ------------------------------------------------------------------ #
        if mode == BLOCKED:
            placeholder = "TO FILL" in json.dumps(capture)
            if not placeholder and not exists:
                print("  BLOCKED %-26s no longer declares itself uncaptured and has no body "
                      "either. Restore the TO FILL marker or capture the record." % name)
                problems += 1
            elif exists and placeholder:
                print("  BLOCKED %-26s has a body on disk while its capture block still says "
                      "TO FILL. A body beside a placeholder URL is a fixture whose provenance "
                      "nobody can state; fill in capture.captured_url and capture.when, then "
                      "change routing to prefer." % name)
                problems += 1
            elif exists:
                print("  BLOCKED %-26s is captured but still marked routing blocked. Change it "
                      "to prefer so the reachability check starts covering it." % name)
                problems += 1
            else:
                print("  wait    %-26s uncaptured, as declared: %s"
                      % (name, capture.get("captured_url", "no captured_url")))
                waiting += 1
            if body:
                referenced.add(body)
            continue

        if not exists:
            print("  MISSING %-26s capture -> %s" % (name, body))
            problems += 1
            continue

        referenced.add(body)
        raw = io.open(path, "rb").read()
        digest = hashlib.sha256(raw).hexdigest()
        notes = []

        want_size, size_key = recorded_size(capture)
        if want_size is None:
            notes.append("no byte count recorded")
        elif want_size != len(raw):
            notes.append("SIZE %s says %d, disk says %d" % (size_key, want_size, len(raw)))
            problems += 1

        want_digest = capture.get("sha256")
        if not want_digest:
            notes.append("no sha256 recorded")
        elif not digest.startswith(want_digest):
            notes.append("DIGEST recorded %s, computed %s"
                         % (want_digest, digest[: len(want_digest)]))
            problems += 1
        elif len(want_digest) < 64:
            # A prefix still catches drift, and saying so keeps the claim the size it is.
            notes.append("sha256 recorded to %d of 64 hex" % len(want_digest))

        captured_url = capture.get("captured_url") or capture.get("example")
        if captured_url and patterns:
            matched = [key for key, pattern in patterns if pattern.match(captured_url)]
            if not matched:
                notes.append("no URL_* pattern in evidence.py matches its captured_url")
                problems += 1

        failed = any(note.startswith(("SIZE", "DIGEST", "no URL_")) for note in notes)
        print("  %s  %-26s %7d B  %s%s"
              % ("FAIL  " if failed else "ok    ", name, len(raw), digest[:16],
                 ("  [" + "; ".join(notes) + "]") if notes else ""))
        checked += 1

    # ---------------------------------------------------------------------- #
    # Nothing on disk is unaccounted for                                     #
    # ---------------------------------------------------------------------- #
    on_disk = set(
        entry for entry in os.listdir(FIXTURES)
        if entry != "manifest.json" and not entry.startswith(".")
        and os.path.isfile(os.path.join(FIXTURES, entry))
    )
    orphans = sorted(on_disk - referenced)
    if orphans:
        print("\n  ORPHAN  %d capture(s) no route references: %s" % (len(orphans), ", ".join(orphans)))
        problems += 1

    # ---------------------------------------------------------------------- #
    # The two trees hold the same bytes, which evidence.py's header claims    #
    # ---------------------------------------------------------------------- #
    print("")
    if not os.path.isdir(SHARED):
        print("  SKIP    the offline harness's fixture copy is not in this checkout, so the "
              "byte-identity claim in tests/direct/evidence.py is unverified here. It is "
              "checked when _build/fixtures/conveyance/ is present.")
    else:
        drift = 0
        for entry in sorted(referenced):
            mine = os.path.join(FIXTURES, entry)
            theirs = os.path.join(SHARED, entry)
            if not os.path.exists(mine):
                continue
            if not os.path.exists(theirs):
                print("  TREE    %-26s is not in the offline harness's copy" % entry)
                drift += 1
                continue
            a = hashlib.sha256(io.open(mine, "rb").read()).hexdigest()
            b = hashlib.sha256(io.open(theirs, "rb").read()).hexdigest()
            if a != b:
                print("  TREE    %-26s differs from the offline harness's copy (%s vs %s)"
                      % (entry, a[:12], b[:12]))
                drift += 1
        problems += drift
        if not drift:
            print("  ok      every capture is byte-identical to the offline harness's copy, "
                  "which is what tests/direct/evidence.py's header claims")

    print("\n  reachability is not checked here. Run:")
    print("    python _build/harness/verify_fixtures.py conveyance")

    tail = "" if not waiting else ", %d waiting on a real transfer" % waiting
    print("\n  %d/%d capture(s) pinned%s, %d problem(s)"
          % (checked, len(routes), tail, problems))
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
