/**
 * Printing a read that did not produce a value.
 *
 * Four outcomes, four different sentences, because in this product they mean four different
 * things and only one of them is "there is nothing here". A view that could not be reached is
 * never rendered as an empty state: an empty state is a claim about the contract's storage,
 * and an unreachable endpoint supports no such claim.
 */

import type { ReadResult } from "@/lib/genlayer/read-result";

export function ReadUnavailable({
  result,
  subject,
}: {
  result: Exclude<ReadResult<unknown>, { kind: "AVAILABLE" }>;
  subject: string;
}) {
  if (result.kind === "NOT_FOUND") {
    return (
      <section className="cv-panel p-6">
        <p className="cv-legend cv-legend-ink">No such record</p>
        <p className="cv-body mt-2 max-w-[68ch]">
          The contract has no {subject} under that identifier. Nothing is missing and nothing
          failed. The register simply does not carry it.
        </p>
      </section>
    );
  }
  const isInvalid = result.kind === "INVALID_RESPONSE";
  return (
    <section className="cv-panel-engraved p-6">
      <p className="cv-legend cv-legend-ink">
        {isInvalid ? "[LLM_ERROR] Answer in an unusable shape" : "[EXTERNAL] Read failed"}
      </p>
      <p className="cv-body mt-2 max-w-[68ch]">
        {isInvalid
          ? `The ${subject} came back in a shape this page will not read, so it was discarded rather than guessed at.`
          : `The ${subject} could not be read. This says nothing about whether it exists, and nothing on this page should be taken as a statement about it.`}
      </p>
      <p className="cv-record-sm mt-3 break-words">{result.error}</p>
    </section>
  );
}

/** The same refusal at row scale, for a panel inside a page that otherwise loaded. */
export function ReadUnavailableRow({
  result,
  subject,
}: {
  result: Exclude<ReadResult<unknown>, { kind: "AVAILABLE" }>;
  subject: string;
}) {
  if (result.kind === "NOT_FOUND") {
    return (
      <p className="cv-aside max-w-[68ch]">
        The contract carries no {subject} for this deal yet.
      </p>
    );
  }
  return (
    <div>
      <p className="cv-legend cv-legend-ink">
        {result.kind === "INVALID_RESPONSE"
          ? "[LLM_ERROR] Answer in an unusable shape"
          : "[EXTERNAL] Read failed"}
      </p>
      <p className="cv-body mt-1.5 max-w-[68ch]">
        The {subject} could not be read, so this panel states nothing about it in either
        direction.
      </p>
      <p className="cv-record-sm mt-2 break-words">{result.error}</p>
    </div>
  );
}
