import type { StaffName } from "@kairos/engine/staff";

/**
 * The staff byline: a dot and the name of the specialist whose work a piece is
 * ("Assessor"), after the piece's heading. A name on the work, never a voice:
 * the six names are the same in every form of Kairos (packages/engine/staff.ts).
 */
export default function Byline({ name }: { name: StaffName }) {
  return (
    <span className="text-muted ml-2 inline-flex items-center gap-1 align-middle text-[10px] font-normal normal-case tracking-normal" title={`${name}'s work`}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      {name}
    </span>
  );
}
