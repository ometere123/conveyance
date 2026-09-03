import Link from "next/link";
import { DealRow, DealRowHead } from "@/components/deal-row";
import { ReadUnavailable } from "@/components/read-unavailable";
import { getLedger, listDeals } from "@/lib/data-source";
import { formatCount, formatGen } from "@/lib/format";

export const dynamic = "force-dynamic";

const CONDITIONS = [
  ["01", "Registry transfer", "RDAP records a later transfer of this exact domain."],
  ["02", "Registrar / delegation", "The sponsoring registrar and nameserver set match the deal."],
  ["03", "Buyer DNS control", "Two independent resolvers agree on the buyer's deal-bound TXT proof."],
] as const;

export default async function HomePage() {
  const [ledger, deals] = await Promise.all([getLedger(), listDeals()]);
  const recent = deals.kind === "AVAILABLE" ? deals.value.slice().reverse().slice(0, 4) : [];

  return (
    <div className="space-y-14">
      <section className="cv-hero">
        <div className="cv-hero-main">
          <p className="cv-legend">deed of conveyance · domain escrow</p>
          <h1 className="cv-asset mt-3 max-w-[22ch]">Domain escrow that settles when public registry and DNS evidence prove delivery.</h1>
          <p className="cv-body mt-5 max-w-[60ch]">Conveyance holds the buyer&apos;s money while the seller transfers a domain. Anyone can trigger the contract&apos;s public evidence checks; the deterministic escrow then releases or refunds the funds.</p>
          <div className="mt-7 flex flex-wrap items-center gap-5">
            <Link href="/deals/new" className="cv-btn no-underline">Lodge an offer</Link>
            <Link href="/deals" className="cv-legend cv-legend-ink underline underline-offset-4">View register</Link>
            <Link href="/docs" className="cv-legend underline underline-offset-4">How verification works</Link>
          </div>
        </div>
        <svg viewBox="0 0 160 160" className="cv-hero-mark" aria-hidden="true" role="presentation">
          <circle cx="80" cy="80" r="58" fill="none" className="cv-hero-rim" />
          {[0, 1, 2].map((segment) => {
            const start = -90 + segment * 120 + 6;
            const end = start + 108;
            const toXY = (deg: number) => {
              const rad = (deg * Math.PI) / 180;
              return [80 + Math.cos(rad) * 42, 80 + Math.sin(rad) * 42] as const;
            };
            const [x1, y1] = toXY(start);
            const [x2, y2] = toXY(end);
            return (
              <path
                key={segment}
                d={`M ${x1} ${y1} A 42 42 0 0 1 ${x2} ${y2}`}
                fill="none"
                className="cv-hero-arc"
              />
            );
          })}
          <circle cx="80" cy="80" r="20" fill="none" className="cv-hero-rim" />
        </svg>
      </section>

      <section className="cv-panel p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3"><h2 className="cv-heading">Live status</h2><span className="cv-legend cv-legend-ink">StudioNet · LIVE</span></div>
        <p className="cv-aside mt-2">Canonical contract <span className="cv-record-sm">0x7C2f…82d1</span></p>
        {ledger.kind === "AVAILABLE" ? <div className="mt-5 grid gap-5 sm:grid-cols-4">
          <div><p className="cv-legend">open deals</p><p className="cv-heading mt-1">{formatCount(ledger.value.deals_opened)}</p></div>
          <div><p className="cv-legend">escrow held</p><p className="cv-heading mt-1">{formatGen(ledger.value.held)} GEN</p></div>
          <div><p className="cv-legend">deliveries verified</p><p className="cv-heading mt-1">{formatCount(ledger.value.deliveries_verified)}</p></div>
          <div><p className="cv-legend">contract balance</p><p className="cv-heading mt-1">{formatGen(ledger.value.balance)} GEN</p></div>
        </div> : <ReadUnavailable result={ledger} subject="live escrow status" />}
      </section>

      <section><h2 className="cv-heading">Three delivery conditions</h2><ol className="mt-3 list-none p-0">{CONDITIONS.map(([number, title, text]) => <li key={number} className="cv-rule flex gap-4 py-4 first:border-t-0"><span className="cv-legend cv-legend-ink">{number}</span><div><h3 className="cv-body">{title}</h3><p className="cv-aside mt-1">{text}</p></div></li>)}</ol></section>

      <section><div className="flex flex-wrap items-baseline justify-between gap-4"><h2 className="cv-heading">Recent deals</h2><Link href="/deals" className="cv-legend cv-legend-ink underline underline-offset-4">View full register</Link></div>{deals.kind === "AVAILABLE" ? recent.length ? <div className="cv-panel mt-4 p-2 sm:p-4"><DealRowHead />{recent.map((deal) => <DealRow key={deal.deal_id} deal={deal} />)}</div> : <p className="cv-body mt-4">No deals are stored on the canonical contract yet.</p> : <div className="mt-4"><ReadUnavailable result={deals} subject="recent deals" /></div>}</section>

      <section className="cv-panel-engraved p-6 sm:p-8"><h2 className="cv-heading">How it works</h2><div className="mt-5 grid gap-4 sm:grid-cols-4">{["Buyer funds", "Seller arms", "Anyone checks", "Contract settles or refunds"].map((step, index) => <div key={step} className="cv-rule border-t pt-3"><span className="cv-legend">0{index + 1}</span><p className="cv-body mt-2">{step}</p></div>)}</div><p className="cv-aside mt-6 max-w-[65ch]">Registry, registrar and DNS methodology, legal boundaries, and the strict equivalence-principle design are documented in the <Link href="/docs" className="underline underline-offset-4">instrument notes</Link>.</p></section>
    </div>
  );
}
