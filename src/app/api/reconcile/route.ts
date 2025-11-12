// src/app/api/reconcile/route.ts
import * as XLSX from "xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SourceMode = "PO" | "ShipDocs" | "UPS";
type SourceModeFile = "PO-file" | "ShipDocs-file" | "UPS-file";

type UploadRow = {
  row: number;
  tracking?: string | null;
  poNumber?: string | null;
  shipDocNumber?: string | null;
  vendor?: string | null;
  customer?: string | null;
  date?: string | null;
  sourceMode: SourceMode;
};

type DetailRow = {
  row: string | number;
  sourceMode: SourceModeFile;
  chosenMode: SourceMode;
  orderNumber: string;
  partyUpload?: string | null;
  trackingUpload: string;
  assertedDate: string | null;
  verdict: string;
  reason: string;
  dayDelta?: number | null;
  poVerdict?: string | null;
  shipVerdict?: string | null;
};

// --------------------------- utils ---------------------------

function normTracking(s: string | null | undefined) {
  if (!s) return "";
  return s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function isDateLike(v: any): boolean {
  if (v instanceof Date && !isNaN(v.getTime())) return true;
  if (typeof v === "string") {
    return (
      /\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}/.test(v) ||
      /^\d{4}-\d{2}-\d{2}/.test(v)
    );
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
    const date = XLSX.SSF.parse_date_code(v);
    if (date) {
      const y = date.y;
      const m = String(date.m).padStart(2, "0");
      const d = String(date.d).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  if (typeof v === "string") {
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
  // XLSX auto-detects CSV vs XLSX from the buffer
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

// ---------------------- robust field detection ----------------------

// Expanded aliases (add more if your exports use other labels)
const trackingAliases = [
  "tracking","tracking#","tracking number","trackingnumber","ups tracking","ups",
  "trk","awb","carrier tracking","carrier tracking number","package tracking number",
  "shipment tracking","shipment tracking number","tracking no.","tracking id",
];

const poAliases = [
  "po","po#","po number","ponumber","purchase order","purchase order number",
  "purchase order #","purchaseorder","purchase order id","po id",
];

const shipDocAliases = [
  "shipdoc","ship doc","ship doc#","shipment doc","shipdoc number",
  "ship doc number","shipdoc#","ship document","shipment document",
  "so","so#","sales order","sales order number","sales order #","salesorder",
  "document number","doc number","doc#", "document#", "shipdoc id", "ship doc id",
];

const vendorAliases = ["vendor","supplier","from","vendor name"];
const customerAliases = ["customer","bill to","sold to","ship to","client","customer name"];
const dateAliases = [
  "date","transaction date","post date","posted date","shipment date","ship date","invoice date"
];

// pick first header match
function pickFirst(obj: Record<string, any>, keys: string[]): any {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

// UPS pattern finder: scans a value for any 1Z tracking (with or without spaces/dashes)
function findUpsInString(s: string): string | null {
  if (!s) return null;
  // quick direct match
  const direct = s.match(/1Z[0-9A-Z]{16,}/i);
  if (direct) return normTracking(direct[0]);

  // remove non-alnum and try again to catch spaced/hyphenated forms
  const squeezed = s.replace(/[^0-9A-Za-z]/g, "");
  if (/^1Z[0-9A-Z]{16,}$/i.test(squeezed)) return squeezed.toUpperCase();

  // scan for embedded after squeeze (rare)
  const embedded = squeezed.match(/1Z[0-9A-Z]{16,}/i);
  if (embedded) return embedded[0].toUpperCase();

  return null;
}

// fallbacks: scan every cell in the row if header-based tracking wasn't found
function fallbackTrackingFromAnyCell(rawLower: Record<string, any>): string | null {
  for (const v of Object.values(rawLower)) {
    if (v == null) continue;
    const s = String(v);
    const hit = findUpsInString(s);
    if (hit) return hit;
  }
  return null;
}

// ---------------------- reconcile core (PO preferred) ----------------------

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
    if (bucket.po && bucket.po.length > 0) {
      const pick = [...bucket.po].sort((a, b) => (a.date || "").localeCompare(b.date || ""))[0];
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

    if (bucket.ship && bucket.ship.length > 0) {
      const pick = [...bucket.ship].sort((a, b) => (a.date || "").localeCompare(b.date || ""))[0];
      const fallbackDate = bucket.ups?.find(u => !!u.date)?.date || null;

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

    if (bucket.ups && bucket.ups.length > 0) {
      const u = [...bucket.ups].sort((a, b) => (a.date || "").localeCompare(b.date || ""))[0];

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

// ---------------------- parsing: CSV/XLSX + robust tracking  ----------------------

async function parseUploadToRows(
  file: File,
  sourceMode: SourceMode
): Promise<UploadRow[]> {
  const ab = await file.arrayBuffer();
  const buf = Buffer.from(ab);

  const rows = sheetToJson(buf);
  const out: UploadRow[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rawLower = lcKeyed(rows[i] || {});

    // primary extraction via headers
    let trackingRaw = pickFirst(rawLower, trackingAliases);
    let tracking = trackingRaw != null ? String(trackingRaw).trim() : null;

    // fallback: scan every cell for any UPS 1Z
    if (!tracking) {
      tracking = fallbackTrackingFromAnyCell(rawLower);
    }
    if (tracking) tracking = normTracking(tracking);

    const poRaw = pickFirst(rawLower, poAliases);
    const shipDocRaw = pickFirst(rawLower, shipDocAliases);
    const vendorRaw = pickFirst(rawLower, vendorAliases);
    const customerRaw = pickFirst(rawLower, customerAliases);
    const dateRaw = pickFirst(rawLower, dateAliases);

    let date: string | null = null;
    if (dateRaw != null && dateRaw !== "") {
      date = toISODateOrNull(dateRaw);
      if (!date && isDateLike(dateRaw)) {
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
      date,
      sourceMode,
    });
  }

  return out;
}

// --------------------------- summary ---------------------------

function buildSummary(details: DetailRow[]) {
  const total = details.length;
  let matchPO = 0, matchShip = 0, unmatchedUPS = 0;

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

// --------------------------- handler ---------------------------

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const poFile = form.get("poFile");
    const shipFile = form.get("shipFile");
    const upsFile = form.get("upsFile");

    if (!(poFile instanceof File) && !(shipFile instanceof File) && !(upsFile instanceof File)) {
      return new Response("Please upload at least one file (PO and/or ShipDocs and/or UPS).", { status: 400 });
    }

    const [poRows, shipRows, upsRows] = await Promise.all([
      poFile instanceof File ? parseUploadToRows(poFile, "PO") : Promise.resolve<UploadRow[]>([]),
      shipFile instanceof File ? parseUploadToRows(shipFile, "ShipDocs") : Promise.resolve<UploadRow[]>([]),
      upsFile instanceof File ? parseUploadToRows(upsFile, "UPS") : Promise.resolve<UploadRow[]>([]),
    ]);

    const details = reconcileByTrackingPreferPO(poRows, shipRows, upsRows);
    const summary = buildSummary(details);

    return Response.json({ summary, details }, { status: 200 });
  } catch (err: any) {
    console.error("Reconcile error:", err);
    return new Response(typeof err?.message === "string" ? err.message : "Internal Server Error", { status: 500 });
  }
}
