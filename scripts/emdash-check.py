"""Fail if an em dash appears anywhere a reader will see it.

    python _build/emdash-check.py holdfast conveyance quorum-clean
    python _build/emdash-check.py --list holdfast          # show every hit, not just counts

The rule this enforces is about audience, not file extension. An em dash in a README, in a
release note, in a page heading or in a button label is visible writing and fails. An em dash
in a code comment is not, and passes. So the check strips comments first and flags whatever
survives, which is exactly the set of characters a reader can end up looking at.

`_build/md-emdash.py` is the ancestor of this file, and is kept as the record of one specific
cleanup: it holds 90-odd hand-verified replacements for four reviewer-facing documents, each
asserted to match exactly once. That made it a good migration and a bad checker. This is the
checker.

Exempt by design:

  * fenced code blocks and inline code spans in markdown, because they quote verbatim CLI
    output, transaction hashes and JSON that must not be edited for style;
  * `.py` contracts, which are code plus comments, and are hash locked: `verify-deployment-
    source.mjs` compares the deployed bytes to the file, so a cosmetic edit after deployment
    would report a source mismatch;
  * `node_modules`, `.next`, `package-lock.json` and other generated or vendored trees.
"""

import io
import os
import re
import sys

# Windows consoles default to cp1252, which cannot encode an em dash, let alone the emoji and
# box-drawing characters that share a line with one in these documents. Without this the check
# finds the fault and then dies printing it, reporting a UnicodeEncodeError where a filename and
# a line number were the entire point.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

DASH = "—"

TEXT_EXT = {".md", ".mdx", ".txt"}
CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".json"}

SKIP_DIRS = {
    "node_modules",
    ".next",
    ".git",
    "__pycache__",
    ".pytest_cache",
    "artifacts",
    "out",
    "build",
    "dist",
    "test-results",
    "playwright-report",
    ".vercel",
}

SKIP_FILES = {"package-lock.json", "tsconfig.tsbuildinfo"}


def markdown_visible(text):
    """Yield `(line_number, column, line)` for lines whose em dashes are prose.

    Fenced blocks are dropped whole; inline code spans are blanked in place, so a line that
    mixes prose and a hash keeps only the prose under inspection. The column is reported from
    the original line, because that is the one an editor will open.
    """
    fenced = False
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("```") or line.lstrip().startswith("~~~"):
            fenced = not fenced
            continue
        if fenced:
            continue
        stripped = re.sub(r"`[^`]*`", "", line)
        if DASH in stripped:
            yield number, line.index(DASH) + 1, line


def strip_code_comments(text):
    """Blank `//` and `/* */` comments while leaving every other character in place.

    Position preserving so line numbers stay honest. String state is tracked, because
    `"https://example.com"` is not the start of a comment and a naive strip would delete the
    rest of a line that may well contain the visible text this check exists to find.
    """
    out = list(text)
    index = 0
    length = len(text)
    quote = None
    while index < length:
        char = text[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in "\"'`":
            quote = char
            index += 1
            continue
        if char == "/" and index + 1 < length:
            nxt = text[index + 1]
            if nxt == "/":
                while index < length and text[index] != "\n":
                    out[index] = " "
                    index += 1
                continue
            if nxt == "*":
                while index < length and not (
                    text[index] == "*" and index + 1 < length and text[index + 1] == "/"
                ):
                    if text[index] != "\n":
                        out[index] = " "
                    index += 1
                for _ in range(2):
                    if index < length:
                        out[index] = " "
                        index += 1
                continue
        index += 1
    return "".join(out)


def code_visible(text):
    """Yield `(line_number, column, line)` for em dashes surviving comment removal."""
    stripped = strip_code_comments(text)
    original = text.splitlines()
    for number, line in enumerate(stripped.splitlines(), 1):
        if DASH in line:
            shown = original[number - 1] if number <= len(original) else line
            yield number, line.index(DASH) + 1, shown


def walk(target):
    if os.path.isfile(target):
        yield target
        return
    for base, dirs, files in os.walk(target):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in sorted(files):
            if name in SKIP_FILES:
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext in TEXT_EXT or ext in CODE_EXT:
                yield os.path.join(base, name)


def check(target):
    hits = []
    scanned = 0
    for path in walk(target):
        ext = os.path.splitext(path)[1].lower()
        try:
            with io.open(path, encoding="utf-8") as handle:
                text = handle.read()
        except (UnicodeDecodeError, OSError):
            continue
        scanned += 1
        if DASH not in text:
            continue
        finder = markdown_visible if ext in TEXT_EXT else code_visible
        for number, column, line in finder(text):
            hits.append((path, number, column, line.strip()))
    return scanned, hits


def main(argv):
    show = "--list" in argv
    targets = [a for a in argv if not a.startswith("-")] or ["."]
    failed = False
    for target in targets:
        # A missing path used to scan zero files and print "ok", so a typo in a CI step or a
        # package.json script would report a clean check on nothing at all. The whole value of
        # this script is that green means something, so a bad target is an error.
        if not os.path.exists(target):
            print("ERROR %s: no such file or directory" % target)
            failed = True
            continue
        scanned, hits = check(target)
        label = os.path.relpath(target)
        if hits:
            failed = True
            print("FAIL  %s: %d em dash(es) in visible writing, across %d file(s)"
                  % (label, len(hits), len({h[0] for h in hits})))
            shown = hits if show else hits[:12]
            for path, number, column, line in shown:
                print("      %s:%d:%d  %s" % (os.path.relpath(path), number, column, line[:110]))
            if len(hits) > len(shown):
                print("      ... and %d more, re-run with --list" % (len(hits) - len(shown)))
        elif not scanned:
            print("ERROR %s: matched 0 checkable files, so green would mean nothing" % label)
            failed = True
        else:
            print("ok    %s: %d file(s) scanned, 0 em dashes in visible writing" % (label, scanned))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
