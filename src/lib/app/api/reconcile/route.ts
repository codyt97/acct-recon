import { NextRequest } from "next/server";
import { parseFile } from "@/lib/parse";
import { getOrder, getActivity, extractPackages } from "@/lib/ot";
import { decide } from "@/lib/decide";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const mode = (form.get("mode") as "PO" | "SO") ?? "PO";
  const file = form.get("file") as File | null;
  if (!file) return new Response("Missing file", { status: 400 });

  let rows;
  try {
    rows = await parseFile(file, mode);
  } catch (e: any) {
    return new Response(`Parse error: ${e.message || e}`, { status: 400 });
  }

  const details: any[] = [];
  const counts: Record<string, number> = {};

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const order = await getOrder(mode, r.orderNumber).catch(() => null);
      const orderExists = !!order;
      const partyOT = order?.partyName ?? order?.vendorName ?? order?.customerName;

      const activity = orderExists ? await getActivity(mode, r.orderNumber).catch(() => null) : null;
      const packages = activity ? extractPackages(activity) : [];

      const ver = decide({
        mode,
        partyUpload: r.partyName,
        trackingUpload: r.trackingNumber,
        assertedDate: r.assertedDate ?? null,
        orderExists,
        packages,
        partyOT,
      });

      counts[ver.verdict] = (counts[ver.verdict] ?? 0) + 1;

      details.push({
        row: i + 1,
        mode,
        orderNumber: r.orderNumber,
        partyUpload: r.partyName ?? "",
        trackingUpload: r.trackingNumber ?? "",
        assertedDate: r.assertedDate?.toISOString()?.slice(0, 10) ?? "",
        verdict: ver.verdict,
        reason: ver.reason ?? "",
        dayDelta: ver.dayDelta ?? null,
      });
    } catch (err: any) {
      counts["ERROR"] = (counts["ERROR"] ?? 0) + 1;
      details.push({
        row: i + 1,
        mode,
        orderNumber: r.orderNumber,
        partyUpload: r.partyName ?? "",
        trackingUpload: r.trackingNumber ?? "",
        assertedDate: r.assertedDate?.toISOString()?.slice(0, 10) ?? "",
        verdict: "ERROR",
        reason: err?.message ?? "Unknown error"
      });
    }
  }

  return Response.json({ summary: counts, details });
}
