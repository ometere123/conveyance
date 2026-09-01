"use client";

/**
 * A deadline, printed as an instant and then as a distance.
 *
 * The instant is the fact and it is always shown. The distance is a convenience and it needs a
 * clock, so the clock is passed in from the server render and only starts ticking after mount.
 * That ordering is deliberate: a countdown that disagrees with itself across hydration is a
 * countdown nobody trusts, and this one sits next to a sum of money.
 *
 * A passed deadline is not an error. Every time-based transition here is permissionless, so a
 * window that has closed is an invitation for anyone to press the button that acts on it, and
 * the copy says so rather than colouring the row red.
 */

import { useEffect, useState } from "react";
import { countdown, displayTime } from "@/lib/format";
import { IS_LIVE } from "@/lib/genlayer/config";

export function Deadline({
  iso,
  now,
  /** What becomes possible once this passes. Printed only when it has. */
  unlocks,
}: {
  iso: string;
  now: number;
  unlocks?: string;
}) {
  const [clock, setClock] = useState(now);

  useEffect(() => {
    // Fixture mode hands in a frozen instant on purpose, so ticking would undo the freeze and
    // make every countdown on the page drift away from the fixed clock the provenance strip
    // has already told the reader about.
    if (!IS_LIVE) return;
    const id = window.setInterval(() => setClock(Date.now()), 30000);
    return () => window.clearInterval(id);
  }, [now]);

  if (!iso) return <span className="cv-unchanged">not recorded</span>;
  const state = countdown(iso, clock);

  return (
    <span>
      <span className="cv-record">{displayTime(iso)}</span>
      {state.kind === "none" ? null : (
        <span className="cv-aside"> · {state.text}</span>
      )}
      {state.kind === "elapsed" && unlocks ? (
        <span className="cv-aside"> · {unlocks}</span>
      ) : null}
    </span>
  );
}
