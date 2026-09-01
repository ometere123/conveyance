"use client";

/**
 * A value with a copy control, for the strings that must be published byte for byte.
 *
 * The TXT record the buyer publishes has to be exact. Retyping it from the screen is the most
 * likely way for a transfer to fail verification while everything else is correct, so the
 * value is always shown in full, always selectable, and always copyable in one press.
 *
 * The clipboard write can be refused by the browser. When it is, the value stays on screen and
 * the control says what happened rather than reporting a success it did not achieve.
 */

import { useState } from "react";

export function CopyLine({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  const [outcome, setOutcome] = useState<"idle" | "copied" | "refused">("idle");

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("This browser exposes no clipboard to write to.");
      }
      await navigator.clipboard.writeText(value);
      setOutcome("copied");
    } catch {
      setOutcome("refused");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="cv-legend cv-legend-ink">{label}</p>
        <button type="button" className="cv-btn-quiet" onClick={copy}>
          {outcome === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="cv-record mt-2 break-all select-all">{value}</p>
      {note ? <p className="cv-aside mt-1.5 max-w-[68ch]">{note}</p> : null}
      {outcome === "refused" ? (
        <p className="cv-aside mt-1.5 max-w-[68ch]">
          The browser refused the clipboard. Select the line above and copy it by hand. Nothing
          was lost.
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {outcome === "copied" ? `${label} copied to the clipboard.` : ""}
      </p>
    </div>
  );
}
