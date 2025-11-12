import { NextRequest } from "next/server";
import { parseFile } from "@/lib/parse";
import { getOrder, getActivity, extractPackages, findByTracking, extractParty } from "@/lib/ot";
import { decide } from "@/lib/decide";

export const runtime = "nodejs";

const SCORE: Record<string, number> = {
  OK: 3,
  MISMATCH: 2,
  NOT_FOUND: 1,
  ERROR: 0,
};

type Mode = "PO" | "SHIP"; // SHIPDOC

type Row = {
  orderNumber?: string;
  partyName?: string;
  trackingNumber?: string;
  assertedDate?: Date | null;
  sourceMode?: "PO" | "SHIP" | "UPS"; // origin of the row
};

// NOTE: we resolve SHIP mode against SO shipment activity in OT
async function reconcileOne(mode: Mode, r: Row) {
  let orderExists = false;
  let packages: { tracking: string; date?: string | null }[] = [];
  let partyOT: string | undefined;

  if (r.orderNumber) {
    // Map SHIP -> SO for order lookup (ShipDoc ties back to SO)
    const lookupMode = mode === "SHIP" ? ("SO" as any) : ("PO" as any);
    const order = await getOrder(lookupMode, r.orderNumber).catch(() => null);
    orderExists = !!order;
    partyOT =
      (order?.partyName as string | undefined) ??
      (order as any)?.vendorName ??
      (order as any)?.customerName;

    const activity = orderExists
      ? await getActivity(lookupMode, r.orderNumber).catch(() => null)
      : null;
    packages = activity ? extractPackages(activity) : [];
  } else if (r.trackingNumber) {
    // Tracking-only: SHIP -> search SO activity; PO -> search PO activity
    const searchMode = mode === "SHIP" ? ("SO" as any) : ("PO" as any);
    const tracking = r.trackingNumber.toUpperCase().replace(/\s|-/g, "");
    const activity = await findByTracking(
      searchMode,
      tracking,
      r.assertedDate ? r.assertedDate.toISOString().slice(0, 10) : undefined
    ).catch(() => null);
    packages = activity ? extractPackages(activity) : [];
    partyOT = extractParty(activity);
    orderExists = packages.length > 0;
  }

    // decide() expects "PO" | "SO". Map our SHIP to SO for decision logic.
  const ver = decide({
    mode: mode === "SHIP" ? "SO" : "PO",
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

    const poFile = form.get("poFile") as File | null;
    const shipFile = form.get("shipFile") as File | null; // SHIPDOC
    const upsFile = form.get("upsFile") as File | null;

    if (!poFile && !shipFile && !upsFile) {
      return new Response("Upload at least one file: 'poFile' and/or 'shipFile' and/or 'upsFile'", { status: 400 });
    }

    const rows: Row[] = [];

    const parseAndTag = async (f: File, tag: "PO" | "SHIP" | "UPS") => {
      const parsed = await parseFile(f);
      for (const r of parsed) rows.push({ ...r, sourceMode: tag });
    };

    if (poFile) await parseAndTag(poFile, "PO");
    if (shipFile) await parseAndTag(shipFile, "SHIP");
    if (upsFile) await parseAndTag(upsFile, "UPS");

    if (!rows.length) return new Response("No data rows found in uploads.", { status: 400 });

    const details: any[] = [];
    const counts: Record<string, number> = {};

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      // prefer by source:
      // PO rows -> PO first
      // SHIP rows -> SHIP first
      // UPS rows -> SHIP first (shipments), then PO
      let prefer: Mode;
      if (r.sourceMode === "PO") prefer = "PO";
      else if (r.sourceMode === "SHIP" || r.sourceMode === "UPS") prefer = "SHIP";
      else prefer = "SHIP";
      const other: Mode = prefer === "PO" ? "SHIP" : "PO";

      try {
        const resPref = await reconcileOne(prefer, r);
        const resOther = await reconcileOne(other, r);

        const pick =
          (SCORE[resOther.verdict] ?? 0) > (SCORE[resPref.verdict] ?? 0) ? resOther : resPref;

        counts[pick.verdict] = (counts[pick.verdict] ?? 0) + 1;

        // per-mode columns
        const poVerd = prefer === "PO" ? resPref.verdict : resOther.verdict;
        const shipVerd = prefer === "SHIP" ? resPref.verdict : resOther.verdict;

        details.push({
          row: i + 1,
          sourceMode: r.sourceMode ?? "",
          chosenMode: pick.mode,
          orderNumber: r.orderNumber ?? "",
          partyUpload: r.partyName ?? "",
          trackingUpload: r.trackingNumber ?? "",
          assertedDate: r.assertedDate?.toISOString()?.slice(0, 10) ?? "",
          verdict: pick.verdict,
          reason: pick.reason,
          dayDelta: pick.dayDelta,
          poVerdict: poVerd,
          shipVerdict: shipVerd,
        });
      } catch (err: any) {
        counts["ERROR"] = (counts["ERROR"] ?? 0) + 1;
        details.push({
          row: i + 1,
          sourceMode: r.sourceMode ?? "",
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
