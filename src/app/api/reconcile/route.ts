// src/app/api/reconcile/route.ts
// Next.js App Router API endpoint for Accounting Reconciliation
// - Accepts multipart/form-data with fields: poFile, shipFile, upsFile
// - Parses CSV/XLSX using 'xlsx' (ensure it's in dependencies)
// - Normalizes headers and reconciles by tracking number
// - ONE ROW PER TRACKING, with PO precedence over ShipDocs over UPS
// - If a PO exists for a tracking, show PO# and PO date (fallback to ShipDocs/UPS date)

import * as XLSX from "xlsx";

export const runtime = "nodejs"; // we need Node APIs for xlsx
export const dynamic = "force-dynamic";

// ----------------------------- Types ---------------------------------

type SourceMode = "PO" | "ShipDocs" | "UPS";
type SourceModeFile = "PO-file" | "ShipDocs-file" | "UPS-file";

type UploadRow = {
  row: number; // original row number (1-based in the uploaded file)
  tracking?: string | null;
  poNumber?: string | null;
  shipDocNumber?: string | null;
  vendor?: string | null;
  customer?: string | null;
  date?: string | null; // normalized yyyy-mm-dd when possible, else original string
  sourceMode: SourceMode;
};

type DetailRow = {
  row: string | number;
  sourceMode: SourceModeFile; // which file "won" for this tracking
  chosenMode: SourceMode;
  orderNumber: string; // PO number OR ShipDoc number, or "" for pure UPS
  partyUpload?: string | null; // vendor/customer display
  trackingUpload: string; // normalized tracking (no spaces/dashes)
  assertedDate: string | null; // the chosen display date
  verdict: string; // e.g., MATCH_PO, MATCH_SHIPDOCS, UNMATCHED_UPS
  reason: string; // brief explanation
  dayDelta?: number | null; // optional if you choose to compute
  poVerdict?: string | null; // simple result channel for your UI
  shipVerdict?: string | null;
};

// --------------------------- Utils -----------------------------------

function normTracking(s: string | null | undefined) {
  if (!s) return "";
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function isDateLike(v: any): boolean {
  if (v instanceof Date && !isNaN(v.getTime())) return true;
  if (typeof v === "string") {
    // very loose check: contains digits and separators
    return /\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v);
  }
  return false;
}

function toISODateOrNull(v: any): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (typeof v === "number") {
    // Excel serial number dates
    const date = XLSX.SSF.parse_date_code(v);
    if (date) {
      const y = date.y;
      const m = String(date.m).padStart(2, "0");
      const d = String(date.d).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  if (typeof v === "string") {
    // Try native Date parse as last resort
    const parsed = new Date(v);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  return null;
}

function sheetToJson(buf: Buffer): any[] {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return Array.isArray(rows) ? rows : [];
}

function lcKeyed(obj: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of Object.keys(obj)) {
    out[k.trim().toLowerCase()] = obj[k];
  }
  return out;
}

// Header alias buckets (expand as needed)
const trackingAliases = [
  "tracking", "tracking#", "tracking number", "trackingnumber", "ups tracking", "ups", "trk", "awb",
];
const poAliases = [
  "po", "po#", "po number", "ponumber", "purchase order", "purchase order number",
];
const shipDocAliases = [
  "shipdoc", "ship doc", "ship doc#", "shipment doc", "so", "so#", "sales order", "sales order number",
];
const vendorAliases = ["vendor", "supplier", "from", "vendor name"];
const customerAliases = ["customer", "bill to", "sold to", "ship to", "client"];
const dateAliases = ["date", "transaction date", "post date", "posted date", "shipment date", "ship date", "invoice date"];

// Extract first non-empty match from aliases
function pickFirst(obj: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

// ---------------------- Core Reconcile (PO-preferred) -----------------

function reconcileByTrackingPreferPO(
  poRows: UploadRow[],
  shipRows: UploadRow[],
  upsRows: UploadRow[]
): DetailRow[] {
  const byTracking = new Map<
    string,
    { po?: UploadRow[]; ship?: UploadRow[]; ups?: UploadRow[] }
  >();

  const add = (r: UploadRow) => {
    const k = normTracking(r.tracking || "");
    if (!k) return;
    const slot = byTracking.get(k) || {};
    if (r.sourceMode === "PO") slot.po = [...(slot.po || []), r];
    else if (r.sourceMode === "ShipDocs") slot.ship = [...(slot.ship || []), r];
    else slot.ups = [...(slot.ups || []), r];
    byTracking.set(k, slot);
  };

  poRows.forEach(add);
  shipRows.forEach(add);
  upsRows.forEach(add);

  const out: DetailRow[] = [];

  for (const [k, bucket] of byTracking.entries()) {
    // Prefer PO if present
    if (bucket.po && bucket.po.length > 0) {
      // Tie-breaker: choose the earliest PO date, otherwise first
      const pick = [...bucket.po].sort((a, b) => {
        const da = a.date || "";
        const db = b.date || "";
        return da.localeCompare(db);
      })[0];

      const fallbackDate =
        bucket.ups?.find(u => !!u.date)?.date ||
        bucket.ship?.find(s => !!s.date)?.date ||
        null;

      out.push({
        row: `trk:${k}`,
        sourceMode: "PO-file",
        chosenMode: "PO",
        orderNumber: pick.poNumber || "(missing PO#)",
        partyUpload: pick.vendor || pick.customer || null,
        trackingUpload: k,
        assertedDate: pick.date || fallbackDate,
        verdict: "MATCH_PO",
        reason: "Tracking appears on PO; ShipDocs/UPS duplicates suppressed",
        dayDelta: null,
        poVerdict: "match",
        shipVerdict: null,
      });
      continue;
    }

    // Else, prefer ShipDocs
    if (bucket.ship && bucket.ship.length > 0) {
      const pick = [...bucket.ship].sort((a, b) => {
        const da = a.date || "";
        const db = b.date || "";
        return da.localeCompare(db);
      })[0];

      const fallbackDate =
        bucket.ups?.find(u => !!u.date)?.date || null;

      out.push({
        row: `trk:${k}`,
        sourceMode: "ShipDocs-file",
        chosenMode: "ShipDocs",
        orderNumber: pick.shipDocNumber || "(missing ShipDoc#)",
        partyUpload: pick.customer || pick.vendor || null,
        trackingUpload: k,
        assertedDate: pick.date || fallbackDate,
        verdict: "MATCH_SHIPDOCS",
        reason: "Tracking appears on ShipDocs; no PO found for this tracking",
        dayDelta: null,
        poVerdict: null,
        shipVerdict: "match",
      });
      continue;
    }

    // Else, UPS-only row (unmatched)
    if (bucket.ups && bucket.ups.length > 0) {
      const u = [...bucket.ups].sort((a, b) => {
        const da = a.date || "";
        const db = b.date || "";
        return da.localeCompare(db);
      })[0];

      out.push({
        row: `trk:${k}`,
        sourceMode: "UPS-file",
        chosenMode: "UPS",
        orderNumber: "",
        partyUpload: u.customer || u.vendor || null,
        trackingUpload: k,
        assertedDate: u.date || null,
        verdict: "UNMATCHED_UPS",
        reason: "Tracking not found on PO or ShipDocs",
        dayDelta: null,
        poVerdict: null,
        shipVerdict: null,
      });
    }
  }

  return out;
}

// ----------------------- Parsing & Mapping ----------------------------

async function parseUploadToRows(
  file: File,
  sourceMode: SourceMode
): Promise<UploadRow[]> {
  const ab = await file.arrayBuffer();
  const buf = Buffer.from(ab);

  const rows = sheetToJson(buf); // [{header:value, ...}, ...]
  const out: UploadRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const raw = lcKeyed(rows[i] || {});

    const trackingRaw = pickFirst(raw, trackingAliases);
    const poRaw = pickFirst(raw, poAliases);
    const shipDocRaw = pickFirst(raw, shipDocAliases);
    const vendorRaw = pickFirst(raw, vendorAliases);
    const customerRaw = pickFirst(raw, customerAliases);
    const dateRaw = pickFirst(raw, dateAliases);

    const tracking = trackingRaw != null ? String(trackingRaw).trim() : null;

    // Normalize date to yyyy-mm-dd when feasible
    let date: string | null = null;
    if (dateRaw != null && dateRaw !== "") {
      // xlsx may have converted date cells to JS Date already; still normalize
      date = toISODateOrNull(dateRaw);
      if (!date && isDateLike(dateRaw)) {
        // very last fallback, try new Date on string
        const parsed = new Date(dateRaw as any);
        if (!isNaN(parsed.getTime())) {
          const y = parsed.getFullYear();
          const m = String(parsed.getMonth() + 1).padStart(2, "0");
          const d = String(parsed.getDate()).padStart(2, "0");
          date = `${y}-${m}-${d}`;
        }
      }
    }

    out.push({
      row: i + 1,
      tracking,
      poNumber: poRaw != null ? String(poRaw).trim() : null,
      shipDocNumber: shipDocRaw != null ? String(shipDocRaw).trim() : null,
      vendor: vendorRaw != null ? String(vendorRaw).trim() : null,
      customer: customerRaw != null ? String(customerRaw).trim() : null,
      date: date,
      sourceMode,
    });
  }

  return out;
}

// --------------------------- Summary ---------------------------------

function buildSummary(details: DetailRow[]) {
  const total = details.length;

  let matchPO = 0;
  let matchShip = 0;
  let unmatchedUPS = 0;

  for (const d of details) {
    if (d.verdict === "MATCH_PO") matchPO++;
    else if (d.verdict === "MATCH_SHIPDOCS") matchShip++;
    else if (d.verdict === "UNMATCHED_UPS") unmatchedUPS++;
  }

  return {
    totalRowsReturned: total,
    counts: {
      MATCH_PO: matchPO,
      MATCH_SHIPDOCS: matchShip,
      UNMATCHED_UPS: unmatchedUPS,
    },
  };
}

// ----------------------------- Handler --------------------------------

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const poFile = form.get("poFile");
    const shipFile = form.get("shipFile");
    const upsFile = form.get("upsFile");

    if (!(poFile instanceof File) && !(shipFile instanceof File) && !(upsFile instanceof File)) {
      return new Response("Please upload at least one file (PO and/or ShipDocs and/or UPS).", {
        status: 400,
      });
    }

    // Parse each present file into UploadRow[]
    const [poRows, shipRows, upsRows] = await Promise.all([
      poFile instanceof File ? parseUploadToRows(poFile, "PO") : Promise.resolve<UploadRow[]>([]),
      shipFile instanceof File ? parseUploadToRows(shipFile, "ShipDocs") : Promise.resolve<UploadRow[]>([]),
      upsFile instanceof File ? parseUploadToRows(upsFile, "UPS") : Promise.resolve<UploadRow[]>([]),
    ]);

    // Reconcile with PO precedence and "one row per tracking"
    const details = reconcileByTrackingPreferPO(poRows, shipRows, upsRows);

    // Simple summary
    const summary = buildSummary(details);

    return Response.json({ summary, details }, { status: 200 });
  } catch (err: any) {
    console.error("Reconcile error:", err);
    return new Response(
      typeof err?.message === "string" ? err.message : "Internal Server Error",
      { status: 500 }
    );
    }
}
