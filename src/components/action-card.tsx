"use client";

/**
 * One control, with everything a person needs before pressing it printed above it.
 *
 * Who may call it, what it will do, what it will cost, and what stops it right now. The
 * `blocked` prop is the honest part: a control that cannot succeed is left enabled only when
 * the reason is somebody else's to fix, and is disabled with the reason stated when the reason
 * is here. Nothing is hidden. A button that vanishes teaches nothing about why.
 *
 * WHY THE CALLER IS A LIST AND NOT A WORD. An earlier version of this component looked the caller
 * up by method name, one caller per method. The contract does not work that way. `refund` is
 * callable by anyone from three different states under three different conditions, and `settle`
 * is the buyer's alone until the inspection window closes and then it is anyone's. A single line
 * saying "Buyer only" would have been wrong for most of that method's life. So the card is given
 * the state it is being drawn in, asks `doorsFrom` for the ways into the method from there, and
 * prints each one with the contract's own reason for it.
 *
 * Every card owns its own runner. Two cards on the same page must not share a phase, because
 * the phase is the answer to "what is happening", and two writes are never at the same point.
 */

import type { CalldataEncodable } from "genlayer-js/types";
import type { DealState } from "@/lib/contract-types";
import { formatGen } from "@/lib/format";
import { CALLER_TEXT, DEADLINE_TEXT, METHODS, doorsFrom, type Door } from "@/lib/lifecycle";
import { WritePanel } from "./write-panel";
import { useWriteRunner } from "./write-runner";

export function ActionCard({
  method,
  state,
  title,
  what,
  buttonLabel,
  args,
  value,
  dealId,
  blocked,
  preflight,
  children,
  tone = "plain",
}: {
  method: string;
  /** The state this control is being drawn in, which is what decides who may press it. */
  state: DealState;
  title: string;
  /** What pressing this will do, in the register a solicitor would use. */
  what: string;
  buttonLabel: string;
  args: CalldataEncodable[] | (() => CalldataEncodable[]);
  value?: bigint;
  dealId?: string;
  /** Why this cannot be pressed now, or null. Printed either way. */
  blocked?: string | null;
  /** Runs in this browser before any signature is asked for. Returns a refusal, or null. */
  preflight?: () => string | null;
  /** Extra fields this call needs, rendered above the button. */
  children?: React.ReactNode;
  tone?: "plain" | "filing";
}) {
  const runner = useWriteRunner();
  const doors = doorsFrom(method, state);
  const spec = METHODS[method];
  const inFlight = runner.state.phase !== "idle" && runner.state.phase !== "settled";

  return (
    <section className={tone === "filing" ? "cv-filing p-6" : "cv-panel p-6"}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="cv-heading">{title}</h3>
        <span className="cv-record-sm">{method}</span>
      </div>
      <p className="cv-body mt-2 max-w-[68ch]">{what}</p>

      {doors.map((door, index) => (
        <DoorNote key={`${door.from}-${door.caller}-${index}`} door={door} />
      ))}

      {spec?.movesValue ? (
        <p className="cv-aside mt-2 max-w-[68ch]">
          <span className="cv-legend cv-legend-ink mr-2">This one moves escrow</span>
          The transfer of value happens inside the same transaction as the state change, so there
          is no second step and nothing to claim afterwards.
        </p>
      ) : null}

      {value !== undefined && value > 0n ? (
        <p className="cv-aside mt-2">
          <span className="cv-legend mr-2">value attached</span>
          <span className="cv-record">{formatGen(value)}</span>
        </p>
      ) : null}

      {children}

      <div className="mt-4 flex flex-wrap items-baseline gap-4">
        <button
          type="button"
          className={tone === "filing" ? "cv-btn-seal" : "cv-btn"}
          disabled={Boolean(blocked) || inFlight}
          onClick={() =>
            void runner.run({
              label: title,
              functionName: method,
              args: typeof args === "function" ? args() : args,
              value,
              dealId,
              preflight,
            })
          }
        >
          {inFlight ? "Working" : buttonLabel}
        </button>
        {blocked ? <p className="cv-aside max-w-[52ch]">{blocked}</p> : null}
      </div>

      <WritePanel
        state={runner.state}
        functionName={method}
        walletGate={blocked ? null : runner.walletGate}
        onReset={runner.reset}
      />
    </section>
  );
}

/**
 * One way into the method from this state: who, from when, and why that rule.
 *
 * The `because` line is printed on the control rather than kept for the documentation page,
 * because the moment somebody wants to know why a button is not theirs is the moment they are
 * looking at the button.
 */
function DoorNote({ door }: { door: Door }) {
  const caller = CALLER_TEXT[door.caller];
  return (
    <div className="cv-rule mt-3 pt-3">
      <p className="cv-aside max-w-[68ch]">
        <span className="cv-legend cv-legend-ink mr-2">{caller.label}</span>
        {caller.note}
      </p>
      {door.after ? (
        <p className="cv-aside mt-1 max-w-[68ch]">
          Shut until {DEADLINE_TEXT[door.after]} has closed. Before then the contract refuses the
          call, and the refusal is a rule firing rather than a fault.
        </p>
      ) : null}
      {door.widensAfter ? (
        <p className="cv-aside mt-1 max-w-[68ch]">
          Once {DEADLINE_TEXT[door.widensAfter]} closes this widens to anyone at all, so a party
          who goes quiet cannot hold the sum indefinitely.
        </p>
      ) : null}
      <p className="cv-aside mt-1 max-w-[68ch]">
        <span className="cv-legend mr-2">why this rule</span>
        {door.because}
      </p>
    </div>
  );
}
