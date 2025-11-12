// src/lib/parse.ts
//
// Flexible CSV/XLSX parser for PO + ShipDocs + UPS files.
// - Accepts many header variants (Order/ShipDoc/Invoice number, Tracking, Party, Dates).
// - Extracts first plausible tracking from "Tracking Details/Status/NO" if needed.
// - Parses dates from multiple columns (handles "Estimated Delivery Window" ranges).
// - Returns rows even if only order OR tracking is present (skips empty rows).
//
// Dependencies (already in package.json in our repo):
//   papaparse, xlsx
//
// If you see a TS type error for papaparse, add:  npm i -D @types/papaparse

import Papa from "papaparse";
import * as XLSX from "xlsx";

export type UploadRow = {
  orderNumber?: string;       // PO / ShipDoc / SO / Invoice / generic order id
  partyName?: string;         // vendor / customer
  trackingNumber?: string;    // UPS/FedEx/USPS/etc
  assertedDate?: Date | null; // best-effort date
  _raw?: Record<string, any>; // original row for debugging
};

// ----------------------------
// Config: header synonyms
// ----------------------------

/** Lower-cased, space-collapsed keys we try to match against */
const H = {
  // ORDER / DOCUMENT NUMBER (PO, SO, ShipDoc, Invoice, generic)
  ORDER: [
    "po number",
    "po #",
    "po no",
    "po no.",
    "so number",
    "so #",
    "so no",
    "so no.",
    "order number",
    "order #",
    "order no",
    "order no.",
    "order",
    "no.",               // OrderTime export
    "no",                // sometimes shows without dot
    "document number",
    "document no",
    "document no.",
    "vendor invoice/so",
    "associated so",
    "invoice number",
    "invoice #",
    "invoice no",
    "invoice no.",
    // ShipDocs variants
    "ship doc",
    "ship doc #",
    "ship doc no",
    "ship doc no.",
    "shipdoc",
    "shipment number",
    "shipment #",
    "shipment no",
    "shipment no.",
  ],

  // TRACKING
  TRACKING: [
    "tracking",
    "tracking number",
    "tracking #",
    "tracking no",
    "tracking no.",
    "tracking id",
    "tracking code",
    "tracking details",
    "tracking status",
    "shipment tracking",
    "ups tracking",
    "carrier tracking",
  ],

  // PARTY (vendor / customer / account)
  PARTY: [
    "vendor",
    "vendor name",
    "supplier",
    "supplier name",
    "customer",
    "customer name",
    "party",
    "sold to",
    "bill to",
    "account name",
  ],

  // DATES
  DATE: [
    "date",
    "transaction date",
    "po promise date",
    "promise date",
    "ship date",
    "shipment date",
    "invoice date",
    "asserted date",
    "estimated delivery window", // range "2025-10-31 – 2025-11-03"
    "delivery window",
  ],
} as const;

// ----------------------------
// Utilities
// ----------------------------

function norm(v: unknown): string {
  return (v ?? "").toString().trim();
}

function keyify(s: string): string {
  return s.toLowerCase().replace(/[\s_]+/g, " ").trim();
}

function pickHeaders(headers: string[], candidates: readonly string[]): string[] {
  const map = new Map(headers.map((h) => [keyify(h), h]));
  const out: string[] = [];
  for (const c of candidates) {
    const real = map.get(c);
    if (real) out.push(real);
  }
  return out;
}

function parseDateLike(v: unknown): Date | null {
  if (v == null || v === "") return null;

  // Excel serial numbers
  if (typeof v === "number" && v > 60 && v < 60000) {
    try {
      const ms = Math.round((v - 25569) * 86400 * 1000);
      return new Date(ms);
    } catch {
      /* ignore */
    }
  }

  const s = norm(v);
  if (!s) return null;

  // Ranges like "2025-10-31 – 2025-11-03" or "10/31/2025 - 11/03/2025"
  const m = s.match(
    /(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*(?:–|-|to)\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i
  );
  if (m) {
    const d = Date.parse(m[1]);
    return isNaN(d) ? null : new Date(d);
  }

  const d = Date.parse(s);
  return isNaN(d) ? null : new Date(d);
}

/** Extract the first plausible tracking token from a mixture of fields */
function extractFirstTracking(raw: Record<string, any>): string | undefined {
  const pool = [
    "Tracking",
    "Tracking Number",
    "Tracking No",
    "Tracking NO",
    "Tracking No.",
    "Tracking #",
    "Tracking Details",
    "Tracking Status",
    "UPS Tracking",
    "Carrier Tracking",
    "Shipment Tracking",
  ]
    .map((k) => norm(raw[k]))
    .filter(Boolean)
    .join(" ");

  if (!pool) return undefined;

  // Lenient: alphanumeric 10+ chars
  const m = pool.match(/[A-Z0-9]{10,}/i);
  return m ? m[0].toUpperCase() : undefined;
}

// ----------------------------
// Readers
// ----------------------------

async function readAsText(file: File): Promise<string> {
  return await file.text();
}

async function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return await file.arrayBuffer();
}

function csvToRows(text: string): Record<string, any>[] {
  const { data } = Papa.parse<Record<string, any>>(text, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: true,
  });
  // Papa returns an array with possible empty objects; filter those out.
  return (data as any[]).filter((r) => r && Object.values(r).some((v) => v !== ""));
}

function xlsxToRows(buf: ArrayBuffer): Record<string, any>[] {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" }) as any[];
}

// ----------------------------
// Public API
// ----------------------------

export async function parseFile(file: File): Promise<UploadRow[]> {
  const name = file.name.toLowerCase();
  const rows: Record<string, any>[] = name.endsWith(".csv")
    ? csvToRows(await readAsText(file))
    : xlsxToRows(await readAsArrayBuffer(file));

  if (!rows.length) return [];

  const headers = Object.keys(rows[0]);

  const orderHeaders = pickHeaders(headers, H.ORDER);
  const trackingHeaders = pickHeaders(headers, H.TRACKING);
  const partyHeaders = pickHeaders(headers, H.PARTY);
  const dateHeaders = pickHeaders(headers, H.DATE);

  const out: UploadRow[] = [];

  for (const r of rows) {
    const raw = { ...r };

    // ----- ORDER / DOC NUMBER -----
    let orderNumber: string | undefined =
      orderHeaders.map((h) => norm(raw[h])).find(Boolean) || undefined;

    // explicit common fallbacks
    if (!orderNumber && raw["No."]) orderNumber = norm(raw["No."]);
    if (!orderNumber && raw["No"]) orderNumber = norm(raw["No"]);
    if (!orderNumber && raw["Associated SO"]) orderNumber = norm(raw["Associated SO"]);
    if (!orderNumber && raw["Vendor Invoice/SO"]) orderNumber = norm(raw["Vendor Invoice/SO"]);
    if (!orderNumber && raw["Ship Doc No"]) orderNumber = norm(raw["Ship Doc No"]);
    if (!orderNumber && raw["Ship Doc No."]) orderNumber = norm(raw["Ship Doc No."]);
    if (!orderNumber && raw["ShipDoc"]) orderNumber = norm(raw["ShipDoc"]);
    if (!orderNumber && raw["Shipment Number"]) orderNumber = norm(raw["Shipment Number"]);
    if (!orderNumber && raw["Shipment No"]) orderNumber = norm(raw["Shipment No"]);
    if (!orderNumber && raw["Shipment No."]) orderNumber = norm(raw["Shipment No."]);

    if (orderNumber) orderNumber = orderNumber.replace(/\s+/g, " ").trim();

    // ----- TRACKING -----
    let trackingNumber: string | undefined =
      trackingHeaders.map((h) => norm(raw[h])).find(Boolean) || undefined;

    if (!trackingNumber) trackingNumber = extractFirstTracking(raw);
    if (trackingNumber) trackingNumber = trackingNumber.toUpperCase();

    // ----- PARTY -----
    let partyName: string | undefined =
      partyHeaders.map((h) => norm(raw[h])).find(Boolean) || undefined;

    // ----- DATE -----
    let assertedDate: Date | null = null;
    for (const h of dateHeaders) {
      const d = parseDateLike(raw[h]);
      if (d) {
        assertedDate = d;
        break;
      }
    }
    if (!assertedDate) {
      // extra explicit fallbacks
      assertedDate =
        parseDateLike(raw["PO Promise date"]) ||
        parseDateLike(raw["Promise Date"]) ||
        parseDateLike(raw["Ship Date"]) ||
        parseDateLike(raw["Shipment Date"]) ||
        parseDateLike(raw["Date"]) ||
        parseDateLike(raw["Estimated Delivery Window"]) ||
        null;
    }

    // Skip rows with no actionable identifiers
    if (!orderNumber && !trackingNumber) {
      const hasAnyValue = Object.values(raw).some((v) => norm(v));
      if (!hasAnyValue) continue;
      // tolerate: do not throw, just skip
      continue;
    }

    out.push({
      orderNumber,
      partyName,
      trackingNumber,
      assertedDate,
      _raw: raw,
    });
  }

  if (!out.length) {
    // Only hard-fail if nothing usable was produced
    const found = headers.join(" | ");
    throw new Error(
      `Missing required column(s): orderNumber or trackingNumber. Found headers: ${found}`
    );
  }

  return out;
}
