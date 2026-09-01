/**
 * The three-segment conveyance seal, as data.
 *
 * The seal is one object with three parts, not three indicators arranged in a row. Its
 * segments are arcs of a single ring, they engrave in the order the checks happen, and the
 * ring is visibly open until all three have landed. The escrow cannot move while it is open,
 * so "open" is not a decoration: it is the same fact as "the money is still held".
 *
 * WHERE THE THREE SEGMENTS COME FROM. The contract's `_classify_delivery` is ordered and
 * total. It asks six questions in a fixed order and returns the first one that did not hold,
 * which means a recorded outcome late in that order *implies* every earlier condition held at
 * that check. This file reads a position in a known order. It does not re-run consensus logic
 * in the browser, and it never recomputes a comparison the contract already made.
 *
 * THE THIRD SEGMENT IS READ, NOT PLACED, AND THAT MATTERS. `check_transfer` calls
 * `_delivery_block`, which fetches the bootstrap, the RDAP object and both resolvers inside one
 * consensus block, and `_raise_if_error` reverts the whole call if any of them failed. So every
 * recorded check has asked the resolvers, whatever the classifier then decided to stop at, and
 * `_record_observation` files the answer in `last_proof_outcome` every time. Placing the third
 * segment from the classifier's position alone would therefore draw "nothing was read about
 * this" over a reading the chain is holding. Where that field is available the third segment
 * comes from it; where it is not, the position is used and `proofFromRecord` says so.
 *
 * `list_deals` returns seven fields and `last_proof_outcome` is not among them, which is why
 * that field is optional here rather than required. A register row draws the third arc from the
 * check's position and the deal page draws it from the recorded reading, and the register says
 * which of the two it did rather than letting the two drawings differ silently.
 *
 * The five segment treatments, and why each looks the way it does:
 *
 *   MET          a solid engraved arc. The line was cut.
 *   BLOCKING     the empty channel with its two end ticks cut. The engraver reached this
 *                segment, set his marks, and stopped. The condition was read and does not hold.
 *   NOT_REACHED  the guide dots and no cut. The check stopped at an earlier condition, so
 *                nothing was read about this one and no claim was ever engraved.
 *   REVERSED     the arc is cut and then severed, with a radial slash across the break. It
 *                held once, and the registry took it back.
 *   UNCHECKED    a blank plate. No check has run against this deal at all.
 *
 * Solid, ticked, dotted, severed, absent. None of the five depends on hue, and each is a
 * different topology rather than a different shade, which is what makes them survive a small
 * size, a monochrome print and a colour-vision difference alike.
 */

import type {
  CheckOutcome,
  ConditionKey,
  ConditionOutcome,
  DealState,
  ProofOutcome,
} from "@/lib/contract-types";
import {
  CHECK_OUTCOME_TEXT,
  CONDITION_KEYS,
  CONDITION_OUTCOME_WORD,
  CONDITION_TEXT,
} from "@/lib/contract-types";

export type SealSegment = {
  key: ConditionKey;
  outcome: ConditionOutcome;
  /** 0, 1, 2. Drives the engraving delay and the arc's place on the ring. */
  order: number;
};

export type SealState = {
  /** Always exactly three, always in the contract's order. */
  segments: SealSegment[];
  met: number;
  closed: boolean;
  /** The recorded outcome this state was read from, so the legend can print its own note. */
  outcome: CheckOutcome;
  /** True when a condition held and was taken back. The one backwards-looking case. */
  reversed: boolean;
  /** True when no check has ever run. Distinct from every condition failing. */
  unchecked: boolean;
  /**
   * True when the third segment came from the chain's own `last_proof_outcome`, false when it
   * was placed from the check's position because the caller had only a summary row.
   *
   * The legend prints this. A drawing that is sometimes read from one field and sometimes
   * inferred from another has to say which it did, or the two become one claim of unknown
   * provenance.
   */
  proofFromRecord: boolean;
};

/* -------------------------------------------------------------------------- */
/* The ladder                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One recorded outcome, placed against the three segments.
 *
 * Read this table as the contract's classification order collapsed onto three groups. The
 * first `BLOCKING` in a row is where the check stopped, and everything before it is `MET`
 * because the ordering guarantees it was passed to get there.
 *
 * The `controlled` column here is the fallback only. It says where the classifier's decision
 * rested, which is not the same question as what the resolvers said: the resolvers were asked
 * in every one of these rows. `sealState` replaces this column with the recorded proof outcome
 * whenever it has one, and the two never contradict each other on the rows where both are
 * decided, because AWAITING_DNS can only have been reached with a failing proof and VERIFIED
 * can only have been reached with a passing one.
 *
 * `AWAITING_TRANSFER` and `AWAITING_DELEGATION` share a row, which is the one place the
 * grouping loses detail. The legend recovers it by printing the contract's own note.
 */
const LADDER: Record<Exclude<CheckOutcome, "">, Record<ConditionKey, ConditionOutcome>> = {
  SUSPENDED: {
    deliverable: "BLOCKING",
    transferred: "NOT_REACHED",
    controlled: "NOT_REACHED",
  },
  PENDING_TRANSFER: {
    deliverable: "BLOCKING",
    transferred: "NOT_REACHED",
    controlled: "NOT_REACHED",
  },
  AWAITING_TRANSFER: {
    deliverable: "MET",
    transferred: "BLOCKING",
    controlled: "NOT_REACHED",
  },
  AWAITING_DELEGATION: {
    deliverable: "MET",
    transferred: "BLOCKING",
    controlled: "NOT_REACHED",
  },
  AWAITING_DNS: {
    deliverable: "MET",
    transferred: "MET",
    controlled: "BLOCKING",
  },
  VERIFIED: {
    deliverable: "MET",
    transferred: "MET",
    controlled: "MET",
  },
  // Both of the last two segments are severed, and `_check_from_verified` is why. A reversal is
  // recorded only when the registration has gone back to the registrar the seller held it at
  // AND the buyer's control proof is gone. Both conditions held at the delivering check and
  // both were taken back at this one, so drawing only one of them severed would understate it.
  REVERSED: {
    deliverable: "MET",
    transferred: "REVERSED",
    controlled: "REVERSED",
  },
};

/**
 * A recorded proof outcome, as the third segment.
 *
 * `PROOF_ABSENT` and `PROOF_NAME_MISSING` are both `BLOCKING` and the distinction between them
 * is not in the drawing, because a segment cannot carry it. The proof panel below the seal
 * carries it, from the same field, so nothing is lost by leaving it out here.
 */
const FROM_PROOF: Record<Exclude<ProofOutcome, "">, ConditionOutcome> = {
  PROOF_FOUND: "MET",
  PROOF_ABSENT: "BLOCKING",
  PROOF_NAME_MISSING: "BLOCKING",
};

const ALL_UNCHECKED: Record<ConditionKey, ConditionOutcome> = {
  deliverable: "UNCHECKED",
  transferred: "UNCHECKED",
  controlled: "UNCHECKED",
};

/**
 * The fields the ladder reads.
 *
 * Structural rather than `Deal`, because `list_deals` returns a summary and the register has to
 * draw the same seal from it. A function that demanded a whole deal here would force the
 * register to fetch fifty fields to draw three arcs.
 *
 * `last_proof_outcome` is optional for exactly that reason and for no other: the summary does
 * not carry it. It is not optional because the field is sometimes meaningless.
 */
export type Sealable = {
  state: DealState;
  last_check_outcome: CheckOutcome;
  last_proof_outcome?: ProofOutcome;
};

/**
 * The seal for one deal.
 *
 * An unrecognised outcome is UNCHECKED, never MET. The same rule as everywhere else in this
 * app: a value this build does not recognise is a gap in what it knows, and a gap must never
 * be printed as a finding.
 */
export function sealState(deal: Sealable): SealState {
  // The state wins over the recorded outcome in exactly one case. REVERSED is the state that
  // decides where the money goes, and a deal sitting in it must draw a severed seal even if
  // some later write left the check fields saying something softer.
  const outcome: CheckOutcome = deal.state === "REVERSED" ? "REVERSED" : deal.last_check_outcome;
  const row =
    outcome && outcome in LADDER ? LADDER[outcome as Exclude<CheckOutcome, "">] : ALL_UNCHECKED;
  const unchecked = row === ALL_UNCHECKED;

  // Three conditions have to hold before the recorded proof outcome may replace the placed one:
  // a check has run at all, the caller has the field, and the field holds a value this build
  // recognises. A reversal is left alone because the state has already decided both segments.
  const proof = deal.last_proof_outcome;
  const fromProof =
    !unchecked && outcome !== "REVERSED" && proof && proof in FROM_PROOF
      ? FROM_PROOF[proof as Exclude<ProofOutcome, "">]
      : null;

  const segments = CONDITION_KEYS.map(
    (key, order): SealSegment => ({
      key,
      order,
      outcome: key === "controlled" && fromProof !== null ? fromProof : row[key],
    }),
  );
  const met = segments.filter((segment) => segment.outcome === "MET").length;

  return {
    segments,
    met,
    closed: met === 3,
    outcome,
    reversed: segments.some((segment) => segment.outcome === "REVERSED"),
    unchecked,
    proofFromRecord: fromProof !== null,
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Degrees of ring each segment owns, and the gap between neighbours.
 *
 * Both are parameters rather than constants because the mark size needs a wider gap: a
 * stroke heavy enough to be visible at 22 pixels would otherwise close the gaps and turn
 * three segments into one continuous ring, which is the one thing the drawing must never do
 * before all three have landed.
 */
export const SPAN = 110;
export const GAP = 10;

export function segmentAngles(
  order: number,
  span = SPAN,
  gap = GAP,
): { start: number; end: number; mid: number } {
  const start = -90 + gap / 2 + order * (span + gap);
  const end = start + span;
  return { start, end, mid: start + span / 2 };
}

const point = (cx: number, cy: number, r: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + r * Math.cos(radians), y: cy + r * Math.sin(radians) };
};

/** One arc as an SVG path. Always the minor sweep, because every span here is under 180. */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const from = point(cx, cy, r, start);
  const to = point(cx, cy, r, end);
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${r} ${r} 0 0 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

/** Path length, so `stroke-dasharray` can be set from the geometry rather than guessed. */
export function arcLength(r: number, span = SPAN): number {
  return (r * span * Math.PI) / 180;
}

/** The radial slash that voids a severed arc. Crosses the ring at the segment's midpoint. */
export function severPath(
  cx: number,
  cy: number,
  r: number,
  order: number,
  span = SPAN,
  gap = GAP,
): string {
  const { mid } = segmentAngles(order, span, gap);
  const inner = point(cx, cy, r * 0.72, mid);
  const outer = point(cx, cy, r * 1.28, mid);
  return `M ${inner.x.toFixed(2)} ${inner.y.toFixed(2)} L ${outer.x.toFixed(2)} ${outer.y.toFixed(2)}`;
}

/**
 * The two halves of a severed arc: cut, then broken in the middle.
 *
 * A severed arc is not a shorter arc. It occupies the full span with a visible void at its
 * centre, so it cannot be misread as an arc that is partly engraved.
 */
export function severedHalves(
  cx: number,
  cy: number,
  r: number,
  order: number,
  span = SPAN,
  gap = GAP,
): [string, string] {
  const { start, end, mid } = segmentAngles(order, span, gap);
  const voided = Math.min(span / 3, 16);
  return [
    arcPath(cx, cy, r, start, mid - voided / 2),
    arcPath(cx, cy, r, mid + voided / 2, end),
  ];
}

/**
 * The two end ticks that mark a blocking segment.
 *
 * Short radial cuts at the segment's boundaries and nothing between them. They say the
 * engraver reached this arc and set his marks, which is exactly the difference between a
 * condition that was read and failed and one that was never read at all.
 */
export function tickPaths(
  cx: number,
  cy: number,
  r: number,
  order: number,
  span = SPAN,
  gap = GAP,
): [string, string] {
  const { start, end } = segmentAngles(order, span, gap);
  const tick = (degrees: number) => {
    const inner = point(cx, cy, r * 0.88, degrees);
    const outer = point(cx, cy, r * 1.12, degrees);
    return `M ${inner.x.toFixed(2)} ${inner.y.toFixed(2)} L ${outer.x.toFixed(2)} ${outer.y.toFixed(2)}`;
  };
  return [tick(start), tick(end)];
}

/* -------------------------------------------------------------------------- */
/* Words                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The seal's accessible name. The whole state in one sentence, because at the mark size the
 * drawing carries only landed-or-not and the label has to carry the rest.
 */
export function sealLabel(state: SealState): string {
  if (state.unchecked) {
    return "Seal unstruck. No check has been run against this deal, so none of the three conditions has been read.";
  }
  const head = state.closed
    ? "Seal closed. All three conditions are engraved."
    : `Seal open at ${state.met} of 3.`;
  const rest = state.segments
    .map(
      (segment) => `${CONDITION_TEXT[segment.key].label}: ${CONDITION_OUTCOME_WORD[segment.outcome]}`,
    )
    .join(". ");
  // Said out loud on the register, where the row this was drawn from does not carry the proof
  // reading. Left off the deal page, where it does, because a provenance note on a figure that
  // came straight from the field it describes is noise.
  const placed = state.proofFromRecord
    ? ""
    : " The third condition is drawn from where the check stopped, not from the recorded reading, which this row does not carry.";
  return `${head} ${rest}.${placed}`;
}

/**
 * The line under the seal. Never "verified"; always what is holding and why.
 *
 * The second sentence is the contract's own note for the recorded outcome, verbatim, which is
 * what recovers the detail the three-segment grouping cannot carry.
 */
export function sealSentence(state: SealState): string {
  if (state.unchecked) {
    return "No check has run. Anyone at all may run one, and until somebody does, nothing is claimed about this domain in either direction.";
  }
  if (state.closed) {
    return `All three conditions are engraved and the seal is closed. ${CHECK_OUTCOME_TEXT.VERIFIED.means}`;
  }
  if (state.reversed) {
    return `The seal is severed. ${CHECK_OUTCOME_TEXT.REVERSED.means}`;
  }
  const note = CHECK_OUTCOME_TEXT[state.outcome]?.means ?? "";
  return `The seal is open at ${state.met} of 3, and the escrow cannot move while it is open. ${note}`;
}
