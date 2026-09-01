/**
 * The three-segment conveyance seal.
 *
 * One object with three parts. The ring, the channels the arcs sit in and the arcs themselves
 * are drawn from a single geometry, so at nought of three there is still visibly a seal, and
 * it is visibly an unstruck one. Three separate indicators in a row could not say that: they
 * would say "three things, none of them done", where this says "one instrument, not yet
 * executed". The difference is the product.
 *
 * FIVE TREATMENTS, AND WHY FIVE RATHER THAN THREE.
 *
 *   MET          a solid engraved arc. The line was cut.
 *   BLOCKING     the empty channel with its two end ticks cut. The engraver reached this arc,
 *                set his marks and stopped. The condition was read and does not hold.
 *   NOT_REACHED  guide dots and no cut. An earlier condition stopped the check, so the delivery
 *                decision never rested on this one and no claim was ever engraved.
 *   REVERSED     cut, then severed, with a radial slash across the break. It held once and the
 *                registry took it back.
 *   UNCHECKED    the bare channel. No check has run against this deal at all.
 *
 * Solid, ticked, dotted, severed, absent. Each is a different topology rather than a different
 * shade, so none of the five depends on hue and all five survive a monochrome print. The two
 * that a naive version collapses are BLOCKING and NOT_REACHED, and they are the two that matter
 * most: one says the delegation is wrong, the other says nobody looked at the delegation.
 *
 * How it behaves at the two sizes:
 *
 *   seal, 168px   the full instrument. All five treatments, the count as a numeral in the
 *                 centre, the segment legend beside it, and the gold inner rule at the instant
 *                 all three close.
 *
 *   mark, 22px    the same ring at the same angles, with heavier strokes and a wider gap so
 *                 three segments still read as three. At this size only MET is drawn, because
 *                 ticked, dotted and severed are distinctions 22 pixels cannot carry honestly.
 *                 The rest travels in the row's own words and in the accessible name, which is
 *                 complete at both sizes.
 *
 * Gold appears in this component and nowhere else in the product, on the full seal only, at the
 * moment the third arc closes. A mark is never gold, so a register of forty deals cannot spend
 * the one gold moment forty times over.
 */

import {
  arcLength,
  arcPath,
  segmentAngles,
  sealLabel,
  severedHalves,
  severPath,
  tickPaths,
  type SealSegment,
  type SealState,
} from "@/lib/seal";
import {
  CONDITION_OUTCOME_NOTE,
  CONDITION_OUTCOME_WORD,
  CONDITION_TEXT,
} from "@/lib/contract-types";

const BOX = 120;
const C = BOX / 2;

type Preset = {
  r: number;
  span: number;
  gap: number;
  channel: number;
  arc: number;
};

const FULL: Preset = { r: 46, span: 110, gap: 10, channel: 3, arc: 3 };
const MARK: Preset = { r: 43, span: 104, gap: 16, channel: 10, arc: 10 };

/* -------------------------------------------------------------------------- */
/* Segments                                                                   */
/* -------------------------------------------------------------------------- */

function Channel({ segment, preset }: { segment: SealSegment; preset: Preset }) {
  const { start, end } = segmentAngles(segment.order, preset.span, preset.gap);
  return (
    <path
      d={arcPath(C, C, preset.r, start, end)}
      fill="none"
      stroke="var(--rule)"
      strokeWidth={preset.channel}
      strokeLinecap="butt"
    />
  );
}

function EngravedArc({
  segment,
  preset,
  animate,
}: {
  segment: SealSegment;
  preset: Preset;
  animate: boolean;
}) {
  const { start, end } = segmentAngles(segment.order, preset.span, preset.gap);
  const length = arcLength(preset.r, preset.span);
  return (
    <path
      d={arcPath(C, C, preset.r, start, end)}
      fill="none"
      stroke="var(--document)"
      strokeWidth={preset.arc}
      strokeLinecap="butt"
      className={animate ? "cv-arc-engraved" : undefined}
      style={
        animate
          ? ({
              "--arc-length": length.toFixed(2),
              "--arc-order": segment.order,
            } as React.CSSProperties)
          : undefined
      }
    />
  );
}

/**
 * The engraver's marks with nothing between them.
 *
 * This is the treatment that carries the whole distinction the contract's ordering makes. The
 * marks are set, so the plate was read here; the channel is empty, so the reading was no.
 */
function TickedChannel({ segment, preset }: { segment: SealSegment; preset: Preset }) {
  const [first, second] = tickPaths(C, C, preset.r, segment.order, preset.span, preset.gap);
  return (
    <>
      <path d={first} fill="none" stroke="var(--document)" strokeWidth={2} />
      <path d={second} fill="none" stroke="var(--document)" strokeWidth={2} />
    </>
  );
}

/** Cut, then voided. The radial slash is what stops this reading as a partial engraving. */
function SeveredArc({ segment, preset }: { segment: SealSegment; preset: Preset }) {
  const [left, right] = severedHalves(C, C, preset.r, segment.order, preset.span, preset.gap);
  return (
    <>
      <path d={left} fill="none" stroke="var(--document)" strokeWidth={preset.arc} />
      <path d={right} fill="none" stroke="var(--document)" strokeWidth={preset.arc} />
      <path
        d={severPath(C, C, preset.r, segment.order, preset.span, preset.gap)}
        fill="none"
        stroke="var(--document)"
        strokeWidth={2}
      />
    </>
  );
}

/** The engraver's guide dots. Marked out, never cut, because the plate was never read here. */
function DottedArc({ segment, preset }: { segment: SealSegment; preset: Preset }) {
  const { start, end } = segmentAngles(segment.order, preset.span, preset.gap);
  return (
    <path
      d={arcPath(C, C, preset.r, start, end)}
      fill="none"
      stroke="var(--guilloche)"
      strokeWidth={preset.arc}
      strokeLinecap="round"
      strokeDasharray={`0.1 ${preset.arc * 2.4}`}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The seal                                                                   */
/* -------------------------------------------------------------------------- */

export function ConveyanceSeal({
  state,
  size = "seal",
  animate = true,
}: {
  state: SealState;
  size?: "seal" | "mark";
  animate?: boolean;
}) {
  const preset = size === "mark" ? MARK : FULL;
  const label = sealLabel(state);
  const pixels = size === "mark" ? 22 : 168;

  return (
    <svg
      viewBox={`0 0 ${BOX} ${BOX}`}
      width={pixels}
      height={pixels}
      role="img"
      aria-label={label}
      className="shrink-0"
    >
      {/* The rim. Present at nought of three, which is what makes an unstruck seal a seal. */}
      <circle
        cx={C}
        cy={C}
        r={preset.r + preset.arc / 2 + (size === "mark" ? 5 : 8)}
        fill="none"
        stroke="var(--rule)"
        strokeWidth={1}
      />

      {state.segments.map((segment) => (
        <Channel key={`channel-${segment.key}`} segment={segment} preset={preset} />
      ))}

      {state.segments.map((segment) => {
        if (segment.outcome === "MET") {
          return (
            <EngravedArc key={segment.key} segment={segment} preset={preset} animate={animate} />
          );
        }
        // At the mark size only landed and not-landed are drawn. A ticked channel, a severed arc
        // and a dotted arc are a pixel or two apart at 22px, and a distinction a reader cannot
        // see is a distinction that misleads. The row's words carry them instead.
        if (size === "mark") return null;
        if (segment.outcome === "BLOCKING") {
          return <TickedChannel key={segment.key} segment={segment} preset={preset} />;
        }
        if (segment.outcome === "REVERSED") {
          return <SeveredArc key={segment.key} segment={segment} preset={preset} />;
        }
        if (segment.outcome === "NOT_REACHED") {
          return <DottedArc key={segment.key} segment={segment} preset={preset} />;
        }
        // UNCHECKED. The channel above is the whole drawing, which is the point of it.
        return null;
      })}

      {/* The gold. Once, here, at the instant the third arc closes. */}
      {state.closed && size === "seal" ? (
        <circle
          cx={C}
          cy={C}
          r={preset.r - 12}
          fill="none"
          stroke="var(--gold)"
          strokeWidth={1}
          className={animate ? "cv-seal-closed" : undefined}
        />
      ) : null}

      {size === "seal" ? (
        <text
          x={C}
          y={C + 7}
          textAnchor="middle"
          fill="var(--document)"
          style={{
            fontFamily: "var(--font-record)",
            fontSize: 22,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {state.met}/3
        </text>
      ) : null}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* The legend beside it                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One row per segment, in the contract's order, each naming what it asked and where it read.
 *
 * The mark that precedes each row is the same topology as its arc: a solid rule for engraved, a
 * pair of ticks for read-and-stopped, a dotted rule for guide dots, a broken rule for severed, a
 * plain channel for unstruck. Reading the legend and reading the ring are the same act.
 *
 * The third row carries one extra line when the seal was drawn from a summary. `list_deals`
 * returns seven fields and the recorded proof outcome is not among them, so a register row places
 * that segment from where the check stopped rather than from the reading itself. Saying so is
 * cheap and not saying so would make one drawing two different claims.
 */
export function SealLegend({ state }: { state: SealState }) {
  return (
    <ol className="w-full">
      {state.segments.map((segment) => (
        <li key={segment.key} className="cv-rule py-3 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <SegmentMark outcome={segment.outcome} />
            <span className="cv-legend cv-legend-ink">
              {CONDITION_TEXT[segment.key].ordinal} · {CONDITION_TEXT[segment.key].label}
            </span>
            <span className="cv-legend ml-auto">{CONDITION_OUTCOME_WORD[segment.outcome]}</span>
          </div>
          <p className="cv-body mt-1.5 max-w-[68ch]">{CONDITION_OUTCOME_NOTE[segment.outcome]}</p>
          <p className="cv-aside mt-1 max-w-[68ch]">
            {CONDITION_TEXT[segment.key].asks} Read from {CONDITION_TEXT[segment.key].source}.
          </p>
          {segment.key === "controlled" && !state.proofFromRecord && !state.unchecked ? (
            <p className="cv-aside mt-1 max-w-[68ch]">
              This arc was placed from where the check stopped, not from the recorded reading. The
              register returns seven fields per deal and the proof outcome is not one of them. The
              deal&rsquo;s own page draws this arc from the reading.
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** The legend's mark. The same five topologies as the arcs, drawn flat. */
function SegmentMark({ outcome }: { outcome: SealSegment["outcome"] }) {
  const common = { width: 26, height: 8, viewBox: "0 0 26 8", "aria-hidden": true } as const;
  if (outcome === "MET") {
    return (
      <svg {...common}>
        <line x1="0" y1="4" x2="26" y2="4" stroke="var(--document)" strokeWidth="3" />
      </svg>
    );
  }
  if (outcome === "BLOCKING") {
    return (
      <svg {...common}>
        <line x1="0" y1="4" x2="26" y2="4" stroke="var(--rule)" strokeWidth="3" />
        <line x1="1" y1="0" x2="1" y2="8" stroke="var(--document)" strokeWidth="2" />
        <line x1="25" y1="0" x2="25" y2="8" stroke="var(--document)" strokeWidth="2" />
      </svg>
    );
  }
  if (outcome === "REVERSED") {
    return (
      <svg {...common}>
        <line x1="0" y1="4" x2="10" y2="4" stroke="var(--document)" strokeWidth="3" />
        <line x1="16" y1="4" x2="26" y2="4" stroke="var(--document)" strokeWidth="3" />
        <line x1="13" y1="0" x2="13" y2="8" stroke="var(--document)" strokeWidth="2" />
      </svg>
    );
  }
  if (outcome === "NOT_REACHED") {
    return (
      <svg {...common}>
        <line
          x1="0"
          y1="4"
          x2="26"
          y2="4"
          stroke="var(--guilloche)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="0.1 5"
        />
      </svg>
    );
  }
  // UNCHECKED. The bare channel, which is what the ring shows too.
  return (
    <svg {...common}>
      <line x1="0" y1="4" x2="26" y2="4" stroke="var(--rule)" strokeWidth="3" />
    </svg>
  );
}
