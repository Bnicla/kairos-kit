import Link from "next/link";

const SECTIONS = [
  { href: "/kb", label: "Knowledge base" },
  { href: "/stories", label: "STAR stories" },
  { href: "/deep-dives", label: "Deep dives" },
  { href: "/metrics", label: "Metrics register" },
  { href: "/gaps", label: "Gaps" },
] as const;

/** Section nav shared by every page of the KB space. */
export default function KbNav({ active }: { active: (typeof SECTIONS)[number]["href"] }) {
  return (
    <nav className="print-hide mb-4 flex items-center gap-1 border-b border-[var(--border)] pb-2 text-sm">
      <Link href="/" className="text-muted mr-3 text-xs hover:underline">
        ← Dashboard
      </Link>
      {SECTIONS.map((s) => (
        <Link
          key={s.href}
          href={s.href}
          className={
            s.href === active
              ? "rounded-md bg-[var(--border)] px-2.5 py-1 font-medium"
              : "text-muted rounded-md px-2.5 py-1 hover:bg-[var(--border)] hover:text-[var(--fg)]"
          }
        >
          {s.label}
        </Link>
      ))}
    </nav>
  );
}
