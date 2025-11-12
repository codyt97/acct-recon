import { NextRequest } from "next/server";
import { parseFile } from "@/lib/parse";
import { getOrder, getActivity, extractPackages, findByTracking, extractParty } from "@/lib/ot";
import { decide } from "@/lib/decide";

export const runtime = "nodejs";

// simple ranking so we can pick the "better" verdict across modes
const SCORE: Record<string, number> = {
  OK: 3,
  MISMATCH: 2,
  NOT_FOUND: 1,
  ERROR: 0
};

async function reconcileOne(
  mode: "PO" | "SO",
  r: { orderNumber?: string; trackingNumber?: string; assertedDate?: Date | null; partyName?: string }
) {
  let orderExists = false;
  let packages: { tracking: string; date?: string | null }[] = [];
  let partyOT: string | undefined;

  if (r.orderNumber) {
    const order = await getOrder(mode, r.orderNumber).catch(() => null);
    orderExists = !!order;
    partyOT = (order?.partyName ?? (order as any)?.vendorName ?? (order as any)?.customerName) as string | undefined;
    const activity = orderExists ? await getActivity(mode, r.orderNumber).catch(() => null) : null;
    packages = activity ? extractPackages(activity) : [];
  } else if (r.trackingNumber) {
    const tracking = r.trackingNumber.toUpperCase().replace(/\s|-/g, "");
    const activity = await findByTracking(
      mode,
      tracking,
      r.assertedDate ? r.assertedDate.toISOString().slice(0, 10) : undefined
    ).catch(() => null);
    packages = activity ? extractPackages(activity) : [];
    partyOT = extractParty(activity);
    orderExists = packages.length > 0;
  }

  const ver = decide({
    mode,
    partyUpload: r.partyName,
    trackingUpload: r.trackingNumber,
    assertedDate: r.assertedDate ?? null,
    orderExists,
    packages,
    partyOT,
  });

  return { mode, verdict: ver.verdict, reason: ver.reason ?? "", dayDelta: ver.dayDelta ?? null };
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return new Response("Missing file (form field 'file')", { status: 400 });

    let rows;
    try {
      rows = await parseFile(file);
      // DEBUG: show a tiny preview + counts (without leaking file contents)
const preview = rows.slice(0, 3).map((r: any) => ({
  orderNumber: r.orderNumber ?? "",
  trackingNumber: r.trackingNumber ?? "",
  assertedDate: r.assertedDate?.toISOString?.()?.slice(0,10) ?? "",
  partyName: r.partyName ?? ""
}));
const numWithOrder = rows.filter((r: any) => r.orderNumber).length;
const numWithTracking = rows.filter((r: any) => r.trackingNumber).length;
console.log(`[RECON DEBUG] rows=${rows.length} withOrder=${numWithOrder} withTracking=${numWithTracking} preview=`, preview);

    } catch (e: any) {
      console.error("[parseFile] error:", e?.message || e);
      return new Response(`Parse error: ${e?.message || e}`, { status: 400 });
    }

    const details: any[] = [];
    const counts: Record<string, number> = {};

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const resPO = await reconcileOne("PO", r);
        const resSO = await reconcileOne("SO", r);

        // choose better verdict; tie-breaker prefers OK> MISMATCH > NOT_FOUND > ERROR, else PO first
        const pick = (SCORE[resSO.verdict] ?? 0) > (SCORE[resPO.verdict] ?? 0) ? resSO : resPO;

        counts[pick.verdict] = (counts[pick.verdict] ?? 0) + 1;

        details.push({
          row: i + 1,
          chosenMode: pick.mode,
          orderNumber: r.orderNumber ?? "",
          partyUpload: r.partyName ?? "",
          trackingUpload: r.trackingNumber ?? "",
          assertedDate: r.assertedDate?.toISOString()?.slice(0, 10) ?? "",
          verdict: pick.verdict,
          reason: pick.reason,
          dayDelta: pick.dayDelta,
          // optional: include both mode verdicts for transparency
          poVerdict: resPO.verdict,
          soVerdict: resSO.verdict,
        });
      } catch (err: any) {
        console.error(`[row ${i + 1}] error:`, err?.message || err);
        counts["ERROR"] = (counts["ERROR"] ?? 0) + 1;
        details.push({
          row: i + 1,
          chosenMode: "",
          orderNumber: r.orderNumber ?? "",
          partyUpload: r.partyName ?? "",
          trackingUpload: r.trackingNumber ?? "",
          assertedDate: r.assertedDate?.toISOString()?.slice(0, 10) ?? "",
          verdict: "ERROR",
          reason: err?.message ?? "Unknown error",
        });
      }
    }

    return Response.json({ summary: counts, details });
  } catch (e: any) {
    console.error("[reconcile] fatal error:", e?.message || e);
    return new Response(`Fatal error: ${e?.message || e}`, { status: 500 });
  }
}
