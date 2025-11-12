import { NextRequest } from "next/server";
import { parseFile } from "@/lib/parse";
import { getOrder, getActivity, extractPackages, findByTracking, extractParty } from "@/lib/ot";
import { decide } from "@/lib/decide";

export const runtime = "nodejs";

// score to pick the stronger verdict
const SCORE: Record<string, number> = {
  OK: 3,
  MISMATCH: 2,
  NOT_FOUND: 1,
  ERROR: 0,
};

type Row = {
  orderNumber?: string;
  partyName?: string;
  trackingNumber?: string;
  assertedDate?: Date | null;
  sourceMode?: "PO" | "SO"; // where the row came from
};

async function reconcileOne(
  mode: "PO" | "SO",
  r: Row
) {
  let orderExists = false;
  let packages: { tracking: string; date?: string | null }[] = [];
  let partyOT: string | undefined;

  if (r.orderNumber) {
    const order = await getOrder(mode, r.orderNumber).catch(() => null);
    orderExists = !!order;
    partyOT =
      (order?.partyName as string | undefined) ??
      (order as any)?.vendorName ??
      (order as any)?.customerName;
    const activity = orderExists
      ? await getActivity(mode, r.orderNumber).catch(() => null)
      : null;
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

    // Accept two files: poFile and soFile (either or both)
    const poFile = form.get("poFile") as File | null;
    const soFile = form.get("soFile") as File | null;

    if (!poFile && !soFile) {
      return new Response("Upload at least one file: 'poFile' and/or 'soFile'", { status: 400 });
    }

    // Parse both if present, tag their rows
    const rows: Row[] = [];

    const parseAndTag = async (f: File, tag: "PO" | "SO") => {
      const parsed = await parseFile(f);
      for (const r of parsed) rows.push({ ...r, sourceMode: tag });
    };

    if (poFile) await parseAndTag(poFile, "PO");
    if (soFile) await parseAndTag(soFile, "SO");

    if (!rows.length) return new Response("No data rows found in uploads.", { status: 400 });

    // Reconcile each row
    const details: any[] = [];
    const counts: Record<string, number> = {};

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const prefer: "PO" | "SO" = r.sourceMode ?? "PO";
      const other: "PO" | "SO" = prefer === "PO" ? "SO" : "PO";

      try {
        // try the preferred mode first
        const resPref = await reconcileOne(prefer, r);

        // cross-check the other mode too (keeps behavior consistent with single-file)
        const resOther = await reconcileOne(other, r);

        // choose the stronger verdict
        const pick =
          (SCORE[resOther.verdict] ?? 0) > (SCORE[resPref.verdict] ?? 0)
            ? resOther
            : resPref;

        counts[pick.verdict] = (counts[pick.verdict] ?? 0) + 1;

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
          poVerdict: resPref.mode === "PO" ? resPref.verdict : resOther.verdict,
          soVerdict: resPref.mode === "SO" ? resPref.verdict : resOther.verdict,
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
