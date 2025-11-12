import * as XLSX from "xlsx";
import Papa from "papaparse";
 
export type UploadRow = {
  mode: "PO" | "SO";
  orderNumber: string;
  partyName?: string;
  trackingNumber?: string;
  assertedDate?: Date | null;
};

export async function parseFile(file: File, mode: "PO" | "SO") {
  // Expect headers: orderNumber, partyName, trackingNumber, assertedDate
  const buf = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  let rows: any[] = [];

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  } else if (name.endsWith(".csv")) {
    const parsed = Papa.parse(buf.toString("utf8"), { header: true, skipEmptyLines: true });
    rows = parsed.data as any[];
  } else {
    throw new Error("Unsupported file type (use CSV/XLSX)");
  }

  return rows.map((r, idx) => {
    const orderNumber = String(r.orderNumber ?? "").trim();
    if (!orderNumber) throw new Error(`Row ${idx + 1}: missing orderNumber`);
    const assertedRaw = r.assertedDate;
    const assertedDate = assertedRaw ? new Date(assertedRaw) : null;
    return {
      mode,
      orderNumber,
      partyName: String(r.partyName ?? "").trim() || undefined,
      trackingNumber: String(r.trackingNumber ?? "").trim() || undefined,
      assertedDate,
    } satisfies UploadRow;
  });
}
