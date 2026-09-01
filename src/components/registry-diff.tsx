/**
 * The registry diff: the baseline frozen when the seller armed, against the last check.
 *
 * Two columns, one row per field, never collapsed into a badge. A verified deal is exactly the
 * case where collapsing is most tempting and least acceptable: the whole reason funds may move is
 * the difference between these two columns, and a reader who cannot see the difference cannot
 * check the reason.
 *
 * WHY THE RIGHT COLUMN IS THE LAST CHECK AND NOT "NOW". There is no now. The contract holds one
 * observation per deal, written by whoever last called `check_transfer`, and its timestamp is
 * printed at the head of the column. A column labelled with the present tense would be claiming
 * a freshness the chain does not have.
 *
 * WHY THERE IS A THIRD SNAPSHOT BELOW. `delivered_registrar_id`, `delivered_transfer_at` and
 * `delivered_digest` are frozen at the check that reached VERIFIED and are never overwritten. A
 * deal that verified and then reversed therefore has two different truthful answers to "what does
 * the registry say", and printing either alone would be a different claim from the other. So the
 * delivered snapshot gets its own small block whenever it exists, and it is compared against the
 * last check rather than against the baseline, because the reversal is the difference between
 * those two.
 *
 * Every changed row carries a Δ and the word "changed". The mark is redundant with the column
 * layout and with the word, so nothing here depends on noticing a hue.
 */

import { Digest, Instant } from "@/components/record";
import type { Deal, RegistrySnapshot } from "@/lib/contract-types";
import { baselineSnapshot, observedSnapshot } from "@/lib/contract-types";
import { displayTime, setAdded, setRemoved, setsAgree, splitSet } from "@/lib/format";

type FieldRow = {
  label: string;
  before: React.ReactNode;
  after: React.ReactNode;
  changed: boolean;
  /** What the buyer required at open, where a requirement exists for this field. */
  required?: string;
  requirementMet?: boolean;
  note?: string;
};

const list = (joined: string) => {
  const values = splitSet(joined);
  return values.length > 0 ? (
    <ul>
      {values.map((value) => (
        <li key={value} className="break-all">
          {value}
        </li>
      ))}
    </ul>
  ) : (
    <span className="cv-unchanged">none recorded</span>
  );
};

function rows(deal: Deal, before: RegistrySnapshot, after: RegistrySnapshot): FieldRow[] {
  const target = deal.target_nameservers;
  return [
    {
      label: "registrar",
      before: before.registrar_id ? (
        <>
          {before.registrar_id}
          {before.registrar_name ? (
            <span className="cv-aside mt-0.5 block">{before.registrar_name}</span>
          ) : null}
        </>
      ) : (
        <span className="cv-unchanged">not recorded</span>
      ),
      after: after.registrar_id || <span className="cv-unchanged">not recorded</span>,
      changed: before.registrar_id !== after.registrar_id,
      required: deal.target_registrar_id || undefined,
      requirementMet: deal.target_registrar_id
        ? deal.target_registrar_id === after.registrar_id
        : undefined,
      note: "IANA registrar ids, which is what the contract compares. A registrar's display name can change without a transfer, and a transfer can happen between two names that look alike, so the number is the fact and the name beside it is for reading.",
    },
    {
      label: "transfer event",
      before: <Instant iso={before.transfer_at} />,
      after: <Instant iso={after.transfer_at} />,
      changed: before.transfer_at !== after.transfer_at,
      note: "The registry's own most recent transfer date. The contract requires one strictly later than the baseline, because a registration already sitting at the target registrar would otherwise satisfy the registrar test without anything having moved.",
    },
    {
      label: "statuses",
      before: list(before.statuses),
      after: list(after.statuses),
      changed: before.statuses !== after.statuses,
      note: "A new status can be the ordinary consequence of a transfer or it can be a suspension, so all of them are printed. Compared as a canonical set: sorted, lowercased, spaces for the RDAP hyphens.",
    },
    {
      label: "nameservers",
      before: list(before.nameservers),
      after: list(after.nameservers),
      changed: before.nameservers !== after.nameservers,
      required: target || undefined,
      requirementMet: target ? setsAgree(target, after.nameservers) : undefined,
      note: "Compared as a set, lowercased, root dot dropped, de-duplicated. Order is not a difference.",
    },
    {
      label: "object digest",
      before: <Digest value={before.digest} label="baseline digest" />,
      after: <Digest value={after.digest} label="last check digest" />,
      changed: before.digest !== after.digest,
      note: "The digest of the canonical form of the whole registry object, computed inside consensus. Two identical digests mean the object did not change in any field, including fields this table does not print.",
    },
  ];
}

export function RegistryDiff({ deal }: { deal: Deal }) {
  const before = baselineSnapshot(deal);
  const after = observedSnapshot(deal);
  const hasBaseline = Boolean(before.digest || before.registrar_id);
  const hasObserved = Boolean(after.when);
  const fields = rows(deal, before, after);
  const changedCount = fields.filter((field) => field.changed).length;

  return (
    <section className="cv-panel p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h3 className="cv-heading">Registry, baseline against last check</h3>
        <p className="cv-legend cv-legend-ink">
          {hasObserved
            ? `${changedCount} of ${fields.length} fields changed`
            : "no check has read the registry yet"}
        </p>
      </div>
      <p className="cv-body mt-2 max-w-[68ch]">
        The left column was frozen inside the transaction where the seller armed. The right column
        was read by whoever last called the check. Every field is printed whether it changed or
        not, because the fields that did not change are half of the reason the escrow may move.
      </p>

      <Authority deal={deal} />

      {!hasBaseline ? (
        <p className="cv-aside mt-5 max-w-[68ch]">
          No baseline has been frozen. The baseline is taken inside the arming transaction, so
          until the seller arms there is nothing on the left to compare against and no check can
          run.
        </p>
      ) : (
        <div className="mt-6">
          <div className="cv-rule-strong grid grid-cols-[7rem_1fr] gap-x-4 pb-2 pt-4 plate:grid-cols-[9rem_1fr_1fr]">
            <p className="cv-legend">field</p>
            <p className="cv-legend">
              baseline
              {before.when ? (
                <span className="cv-aside ml-2">{displayTime(before.when)}</span>
              ) : null}
            </p>
            <p className="cv-legend hidden plate:block">
              last check
              {after.when ? <span className="cv-aside ml-2">{displayTime(after.when)}</span> : null}
            </p>
          </div>
          <dl>
            {fields.map((field) => (
              <DiffRow key={field.label} field={field} hasObserved={hasObserved} />
            ))}
          </dl>
          <SetDetail before={before} after={after} />
        </div>
      )}

      <Delivered deal={deal} after={after} />
    </section>
  );
}

function DiffRow({ field, hasObserved }: { field: FieldRow; hasObserved: boolean }) {
  return (
    <div className="cv-rule grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 py-3 plate:grid-cols-[9rem_1fr_1fr]">
      <dt className="cv-legend">
        {field.label}
        <span className="mt-1 block">
          {!hasObserved ? (
            <span className="cv-unchanged">not read</span>
          ) : field.changed ? (
            <span className="cv-delta">Δ changed</span>
          ) : (
            <span className="cv-unchanged">unchanged</span>
          )}
        </span>
      </dt>
      <dd className="cv-record min-w-0 break-words">
        <span className="cv-legend mb-1 block plate:hidden">baseline</span>
        <span className={field.changed ? "cv-unchanged" : undefined}>{field.before}</span>
      </dd>
      <dd className="cv-record col-start-2 min-w-0 break-words plate:col-start-3">
        <span className="cv-legend mb-1 block plate:hidden">last check</span>
        {hasObserved ? (
          <span className={field.changed ? "cv-delta" : undefined}>{field.after}</span>
        ) : (
          <span className="cv-unchanged">not read yet</span>
        )}
        {field.required ? (
          <p className="cv-aside mt-1.5">
            Required at open: <span className="cv-record-sm">{field.required}</span>
            {field.requirementMet === undefined
              ? null
              : field.requirementMet
                ? ". The observed value matches it."
                : ". The observed value does not match it yet."}
          </p>
        ) : null}
        {field.note ? <p className="cv-aside mt-1.5 max-w-[60ch]">{field.note}</p> : null}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* What moved inside the two sets                                             */
/* -------------------------------------------------------------------------- */

/**
 * Added and removed members, spelled out.
 *
 * Two lists side by side leave the reader to diff them by eye, and a nameserver set differing by
 * one character in one member is the case where an eye diff fails. Printed only when something
 * actually moved, so an unchanged deal does not carry two empty headings.
 */
function SetDetail({ before, after }: { before: RegistrySnapshot; after: RegistrySnapshot }) {
  const groups = [
    {
      label: "nameservers",
      added: setAdded(before.nameservers, after.nameservers),
      removed: setRemoved(before.nameservers, after.nameservers),
    },
    {
      label: "statuses",
      added: setAdded(before.statuses, after.statuses),
      removed: setRemoved(before.statuses, after.statuses),
    },
  ].filter((group) => group.added.length > 0 || group.removed.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="cv-rule mt-5 pt-4">
      <p className="cv-legend cv-legend-ink">What moved, member by member</p>
      <p className="cv-aside mt-1 max-w-[68ch]">
        The same two sets above, with the difference named rather than left to the eye. A set that
        differs by one character in one member reads as identical in two columns.
      </p>
      <dl className="mt-3 grid gap-x-8 gap-y-3 plate:grid-cols-2">
        {groups.map((group) => (
          <div key={group.label}>
            <dt className="cv-legend">{group.label}</dt>
            <dd className="mt-1">
              {group.removed.map((value) => (
                <p key={`out-${value}`} className="cv-record-sm break-all">
                  <span className="cv-legend mr-2">gone</span>
                  <span className="cv-unchanged">{value}</span>
                </p>
              ))}
              {group.added.map((value) => (
                <p key={`in-${value}`} className="cv-record-sm break-all">
                  <span className="cv-legend mr-2">new</span>
                  <span className="cv-delta">{value}</span>
                </p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Where the registry answer came from                                        */
/* -------------------------------------------------------------------------- */

/**
 * The authority, named rather than assumed.
 *
 * The base is stored on the deal because `open_deal` resolved it from the IANA bootstrap
 * document and `_delivery_block` re-derives it from a fresh bootstrap on every check, refusing
 * `[TRANSIENT]` if the map has moved. So this is not a convenience field: it is the thing a
 * reader checks to know that the answers above came from the registry for this TLD and not from
 * a redirector that happened to reply.
 */
function Authority({ deal }: { deal: Deal }) {
  return (
    <div className="cv-rule mt-5 pt-4">
      <p className="cv-legend cv-legend-ink">Registry source</p>
      <dl className="mt-2 grid gap-x-8 gap-y-2 plate:grid-cols-2">
        <Pair label="tld" value={deal.tld || "not recorded"} />
        <Pair
          label="rdap base"
          value={deal.rdap_base || "none published"}
          note="Resolved from data.iana.org/rdap/dns.json when the deal opened, and re-resolved from a fresh copy on every check. A base that moves is refused rather than followed."
        />
      </dl>
      <p className="cv-aside mt-3 max-w-[68ch]">
        Only https bases are fetched. Two live registries publish an http-only base and this
        contract declines them before any request goes out, which is a rule firing rather than a
        source being unreachable.
      </p>
    </div>
  );
}

/**
 * The snapshot frozen at the delivering check.
 *
 * Printed only when one exists, and compared against the last check rather than the baseline.
 * For a deal sitting in VERIFIED the two agree and the block says so in one line. For a reversed
 * deal they do not, and the difference between them is the entire reason the money went back.
 */
function Delivered({ deal, after }: { deal: Deal; after: RegistrySnapshot }) {
  if (!deal.delivered_digest && !deal.delivered_registrar_id) return null;

  const moved =
    deal.delivered_registrar_id !== after.registrar_id ||
    deal.delivered_transfer_at !== after.transfer_at ||
    deal.delivered_digest !== after.digest;

  return (
    <div
      className={moved ? "cv-panel-engraved mt-6 p-5" : "cv-rule mt-6 pt-4"}
      style={moved ? { borderLeftWidth: 3, borderLeftColor: "var(--document)" } : undefined}
    >
      <p className="cv-legend cv-legend-ink">
        {moved
          ? "The registry has moved since the check that delivered"
          : "The delivering check, frozen"}
      </p>
      <p className="cv-body mt-2 max-w-[68ch]">
        {moved
          ? "These three fields were frozen at the check that found all three conditions met, and they are never overwritten. The last check no longer agrees with them, which is what a reversal is: the registration went back and the proof went with it."
          : "These three fields were frozen at the check that found all three conditions met. The last check still agrees with them, so nothing has moved since delivery."}
      </p>
      <dl className="mt-3 grid gap-x-8 gap-y-2 plate:grid-cols-3">
        <Pair
          label="registrar at delivery"
          value={deal.delivered_registrar_id || "not recorded"}
          note={moved ? `Last check reads ${after.registrar_id || "nothing"}.` : undefined}
        />
        <Pair
          label="transfer event at delivery"
          value={deal.delivered_transfer_at ? displayTime(deal.delivered_transfer_at) : "not recorded"}
        />
        <Pair label="object digest at delivery" value={deal.delivered_digest || "not recorded"} />
      </dl>
      {deal.delivered_proof_digest ? (
        <p className="cv-aside mt-3 max-w-[68ch]">
          The corroborated record set at that same check digests to{" "}
          <span className="cv-record-sm break-all">{deal.delivered_proof_digest}</span>. That is a
          digest of the normalised set, never of a resolver&rsquo;s response body, because two
          resolvers never return the same bytes for the same record.
        </p>
      ) : null}
    </div>
  );
}

function Pair({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="cv-legend">{label}</dt>
      <dd className="cv-record-sm break-all">{value}</dd>
      {note ? <p className="cv-aside mt-0.5 max-w-[52ch]">{note}</p> : null}
    </div>
  );
}
