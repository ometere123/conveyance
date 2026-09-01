"use client";

/**
 * What a write is doing, while it does it, and what it meant when it stopped.
 *
 * Three things are always on screen and none of them is a spinner. The client phases say
 * where the request is and which single phase costs a signature. The program says what the
 * validators will actually fetch, by source name, before they fetch it. The outcome, when
 * there is one, says which of the four classes it belongs to and whether pressing the button
 * again is sensible.
 *
 * The last part is the one that matters. `[TRANSIENT]` and `[EXPECTED]` look identical if you
 * render both as red text, and they are opposites: one means try again, the other means the
 * contract has already answered and the answer will not change.
 */

import { CLIENT_PHASES, OUTCOMES, PROGRAMS, type PhaseKey } from "@/lib/lifecycle";
import type { WriteState } from "./write-runner";

const PHASE_ORDER: PhaseKey[] = CLIENT_PHASES.map((phase) => phase.key);

export function WritePanel({
  state,
  functionName,
  walletGate,
  onReset,
}: {
  state: WriteState;
  functionName: string;
  walletGate: string | null;
  onReset: () => void;
}) {
  const program = PROGRAMS[functionName];
  const reached = PHASE_ORDER.indexOf(state.phase);
  const running = state.phase !== "idle" && state.phase !== "settled";
  const outcome = state.outcome && state.outcome !== "verdict" ? OUTCOMES[state.outcome] : null;

  return (
    <div className="mt-4">
      {walletGate ? <p className="cv-aside max-w-[68ch]">{walletGate}</p> : null}

      {program ? (
        <div className="mt-3">
          <p className="cv-legend">what the validators fetch</p>
          <ol className="mt-1 list-none p-0">
            {program.map((step, index) => (
              <li key={step.label} className="cv-aside flex flex-wrap gap-x-3">
                <span className="cv-record-sm w-6 shrink-0">{index + 1}.</span>
                <span className="max-w-[62ch]">
                  {step.label}
                  <span className="cv-unchanged"> · {step.source}</span>
                  {step.resolvers ? (
                    <span className="cv-unchanged">
                      {" "}
                      · both of {step.resolvers.join(" and ")}, compared
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {running || state.phase === "settled" ? (
        <ol className="mt-4 list-none p-0">
          {CLIENT_PHASES.map((phase) => {
            const at = PHASE_ORDER.indexOf(phase.key);
            const done = reached > at;
            const now = state.phase === phase.key;
            return (
              <li
                key={phase.key}
                className={`cv-rule flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 first:border-t-0 ${
                  done || now ? "" : "cv-unchanged"
                }`}
              >
                <span className={`cv-legend w-full shrink-0 plate:w-56 ${now ? "cv-legend-ink cv-stage-active" : ""}`}>
                  {phase.label}
                </span>
                <span className="cv-aside max-w-[62ch]">
                  {phase.note}
                  {phase.costsSignature ? (
                    <span className="cv-record-sm"> This is the only phase that asks the wallet to sign.</span>
                  ) : null}
                </span>
                <span className="cv-record-sm ml-auto">
                  {now ? "now" : done ? "done" : "not yet"}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {state.hash ? (
        <p className="cv-record-sm mt-3 break-all">transaction {state.hash}</p>
      ) : null}

      {outcome && state.message ? (
        <div className="cv-panel-engraved mt-4 p-5">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className={`cv-tag ${state.outcome === "expected" ? "cv-tag-verdict" : ""}`}>
              {outcome.tag}
            </span>
            <h4 className="cv-body">{outcome.headline}</h4>
            <span className="cv-legend ml-auto">{outcome.register}</span>
          </div>
          <p className="cv-aside mt-2 max-w-[68ch]">{outcome.body}</p>
          <p className="cv-record mt-3 max-w-[76ch] break-words">{state.message}</p>
          <div className="mt-4 flex flex-wrap items-baseline gap-4">
            <button type="button" className="cv-btn-quiet" onClick={onReset}>
              Clear this
            </button>
            <p className="cv-aside max-w-[52ch]">
              {outcome.retry
                ? "Sending the same call again is a reasonable next step."
                : "Sending the same call again unchanged reaches the same answer."}
            </p>
          </div>
        </div>
      ) : null}

      {state.phase === "settled" ? (
        <p className="cv-aside mt-4 max-w-[68ch]">
          Finalized, and the returned value was re-read and inspected. Reload the page to see the
          record the contract now holds.
        </p>
      ) : null}
    </div>
  );
}
