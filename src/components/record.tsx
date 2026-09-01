/**
 * The register's own row types.
 *
 * A conveyancing register puts a field name in one column and its value in the other, and
 * never abbreviates the value to fit. These do the same: the label is engraved lettering, the
 * value is monospaced and tabular, and a value that is absent says so in words rather than
 * being printed as a dash that could be mistaken for a zero.
 */

import { displayTime, formatGen, shortenHex } from "@/lib/format";
import { explorerAddressUrl } from "@/lib/genlayer/config";

export function Row({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="cv-rule flex flex-wrap items-baseline gap-x-6 gap-y-1 py-2.5 first:border-t-0">
      <dt className="cv-legend w-full shrink-0 plate:w-56">{label}</dt>
      <dd className="min-w-0 flex-1">
        <div className="cv-record break-words">{children}</div>
        {note ? <p className="cv-aside mt-0.5 max-w-[68ch]">{note}</p> : null}
      </dd>
    </div>
  );
}

/** An address, shortened for reading and linked to the explorer for checking. */
export function Address({ value, full = false }: { value: string; full?: boolean }) {
  if (!value) return <span className="cv-unchanged">not recorded</span>;
  return (
    <a
      href={explorerAddressUrl(value)}
      target="_blank"
      rel="noreferrer noopener"
      className="underline decoration-[var(--rule-strong)] underline-offset-2"
      title={value}
    >
      {full ? value : shortenHex(value, 12, 8)}
    </a>
  );
}

/** A sum. Never truncated, never rounded, and an unreported sum is not zero. */
export function Sum({ wei }: { wei: string }) {
  return <span>{formatGen(wei)}</span>;
}

/** An instant, printed in UTC so two readers in two places read the same deadline. */
export function Instant({ iso }: { iso: string }) {
  if (!iso) return <span className="cv-unchanged">not recorded</span>;
  return <time dateTime={iso}>{displayTime(iso)}</time>;
}

/**
 * A digest, whole.
 *
 * Shortened in the line for reading, with the full value inside a disclosure, because the
 * point of a digest is that somebody can recompute it and the shortened form cannot be
 * recomputed against anything.
 */
export function Digest({ value, label = "digest" }: { value: string; label?: string }) {
  if (!value) return <span className="cv-unchanged">not recorded</span>;
  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <span className="cv-record">{shortenHex(value, 12, 8)}</span>
        <span className="cv-legend ml-2">show full {label}</span>
      </summary>
      <p className="cv-record-sm mt-1.5 break-all">{value}</p>
    </details>
  );
}

/** A list of values in the register's hand. An empty list is stated, not left blank. */
export function ValueList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <span className="cv-unchanged">{empty}</span>;
  return (
    <ul>
      {values.map((value) => (
        <li key={value} className="break-all">
          {value}
        </li>
      ))}
    </ul>
  );
}

/** A field name and a word, for the places a `<dl>` would be too much apparatus. */
export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="cv-legend">{label}</p>
      <p className="cv-record mt-1 break-words">{value}</p>
    </div>
  );
}
