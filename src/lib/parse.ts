import * as XLSX from "xlsx";
import * as Papa from "papaparse";

export type UploadRow = {
  mode: "PO" | "SO";
  orderNumber: string;
  partyName?: string;
  trackingNumber?: string;
  assertedDate?: Date | null;
};

const HEADER_MAP: Record<string, "orderNumber" | "partyName" | "trackingNumber" | "assertedDate"> = {
  // order number variants
  "ordernumber": "orderNumber",
  "order #": "orderNumber",
  "order": "orderNumber",
  "po": "orderNumber",
  "ponumber": "orderNumber",
  "po number": "orderNumber",
  "so": "orderNumber",
  "sonumber": "orderNumber",
  "so number": "orderNumber",
  "invoice": "orderNumber",
  "invoicenumber": "orderNumber",
  "invoice number": "orderNumber",
  "document": "orderNumber",
  "documentnumber": "orderNumber",

  // party/vendor/customer variants
  "party": "partyName",
  "partyname": "partyName",
  "vendor": "partyName",
  "vendorname": "partyName",
  "customer": "partyName",
  "customername": "partyName",

  // tracking
  "tracking": "trackingNumber",
  "trackingnumber": "trackingNumber",
  "tracking number": "trackingNumber",
  "trk": "trackingNumber",

  // date variants (we treat as assertedDate)
  "date": "assertedDate",
  "shipdate": "assertedDate",
  "ship date": "assertedDate",
  "invoicedate": "assertedDate",
  "invoice date": "assertedDate",
  "receiveddate": "assertedDate",
  "receiptdate": "assertedDate",
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mapHeaders(rawHeaders: string[]) {
  const mapping: Record<string, string> = {};
  for (const h of rawHeaders) {
    const key = normalizeHeader(h);
    const std = HEADER_MAP[key];
    if (std) mapping[std] = h; // map standardKey -> originalHeader
  }
  return mapping;
}

export async function parseFile(file: File, mode: "PO" | "SO") {
  // We handle CSV/XLSX; we allow flexible header names via HEADER_MAP.
  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  let rows: any[] = [];
  let headers: string[] = [];

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    // best-effort header capture
    const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1 })[0] as string[] | undefined;
    headers = (headerRow ?? []).map((s) => String(s ?? ""));
  } else if (name.endsWith(".csv")) {
    const parsed = Papa.parse<string>(buf.toString("utf8"), {
      header: true,
      skipEmptyLines: true
    });
    rows = parsed.data as any[];
    headers = parsed.meta.fields ?? [];
  } else {
    throw new Error("Unsupported file type (use CSV or XLSX)");
  }

  if (!rows.length) {
    throw new Error("No data rows found.");
  }

  const map = mapHeaders(headers);
  const missing: string[] = [];
  if (!map.orderNumber) missing.push("orderNumber (poNumber/soNumber/invoiceNumber also OK)");
  // partyName, trackingNumber, assertedDate are optional by design

  if (missing.length) {
    throw new Error(
      `Missing required column(s): ${missing.join(", ")}. ` +
      `Found headers: ${headers.join(" | ")}`
    );
  }

  return rows.map((r, idx) => {
    const orderNumber = String(r[map.orderNumber] ?? r.orderNumber ?? "").trim();
    if (!orderNumber) throw new Error(`Row ${idx + 1}: missing orderNumber`);

    const partyName =
      String(r[map.partyName as any] ?? r.partyName ?? "").trim() || undefined;

    const trackingNumber =
      String(r[map.trackingNumber as any] ?? r.trackingNumber ?? "").trim() || undefined;

    const rawDate = r[map.assertedDate as any] ?? r.assertedDate;
    const assertedDate = rawDate ? new Date(rawDate) : null;

    return {
      mode,
      orderNumber,
      partyName,
      trackingNumber,
      assertedDate
    } as UploadRow;
  });
}
