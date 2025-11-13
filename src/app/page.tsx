// src/app/page.tsx 
"use client";
import { useState } from "react";

type DetailRow = {
  row: number | string;
  sourceMode: "PO-file" | "ShipDocs-file" | "UPS-file";
  chosenMode: "PO" | "ShipDocs" | "UPS";
  orderNumber: string;
  partyUpload?: string | null;
  trackingUpload: string;
  assertedDate: string | null;
  verdict: "MATCH_PO" | "MATCH_SHIPDOCS" | "UNMATCHED_UPS" | string;
  reason: string;
  dayDelta?: number | null;
  poVerdict?: string | null;
  shipVerdict?: string | null;
};

export default function Home() {
  const [poFile, setPoFile] = useState<File | null>(null);
  const [shipFile, setShipFile] = useState<File | null>(null); // ShipDocs
  const [upsFile, setUpsFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ summary: any; details: DetailRow[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!poFile && !shipFile && !upsFile) {
      setErr("Please upload at least one file (PO and/or ShipDocs and/or UPS).");
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);

    const fd = new FormData();
    if (poFile) fd.append("poFile", poFile);
    if (shipFile) fd.append("shipFile", shipFile);
    if (upsFile) fd.append("upsFile", upsFile);

    const r = await fetch("/api/reconcile", { method: "POST", body: fd });
    if (!r.ok) {
      const text = await r.text();
      setErr(`${r.status} ${r.statusText}: ${text}`);
      setBusy(false);
      return;
    }
    const j = await r.json();
    setResult(j);
    setBusy(false);
  }

  return (
    <div
      style={{
        width: "min(1600px, 96vw)",
        margin: "40px auto",
        padding: 20,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
      }}
    >
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>
        Accounting Reconciliation (PO + ShipDocs + UPS)
      </h1>
      <p style={{ marginTop: 6 }}>
        Upload a CSV/XLSX for <b>PO</b>, <b>ShipDocs</b>, and/or <b>UPS</b>. We parse headers like{" "}
        <code>poNumber/shipDoc/invoiceNumber</code>, <code>tracking</code>,{" "}
        <code>transaction date</code>, and <code>vendor/customer</code>. Rows are checked against
        OrderTime; UPS rows usually carry only tracking/date and will be matched to PO/ShipDocs.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 16,
          marginTop: 14,
        }}
      >
        <Uploader label="PO file" onChange={setPoFile} file={poFile} />
        <Uploader label="ShipDocs file" onChange={setShipFile} file={shipFile} />
        <Uploader label="UPS file" onChange={setUpsFile} file={upsFile} />
      </div>

      <button
        onClick={submit}
        disabled={busy || (!poFile && !shipFile && !upsFile)}
        style={{
          marginTop: 16,
          padding: "10px 16px",
          borderRadius: 8,
          border: "1px solid #ddd",
          background: busy ? "#e3e3e3" : "#fff",
          cursor: busy || (!poFile && !shipFile && !upsFile) ? "not-allowed" : "pointer",
        }}
      >
        {busy ? "Reconciling..." : "Reconcile"}
      </button>

      {err && <pre style={{ marginTop: 16, color: "#b00020", whiteSpace: "pre-wrap" }}>{err}</pre>}

      {result && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Summary</h2>
          <pre
            style={{
              background: "#f7f7f7",
              padding: 12,
              borderRadius: 8,
              maxWidth: "100%",
              overflowX: "auto",
            }}
          >
            {JSON.stringify(result.summary, null, 2)}
          </pre>

          {/* Legend */}
          <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 10 }}>
            <LegendSwatch color="#d7f5d0" label="Match PO (Light Green)" />
            <LegendSwatch color="#0b7f2d" label="Match ShipDoc (Dark Green)" dark />
            <LegendSwatch color="#ffd6d6" label="Unmatched (Red)" />
          </div>

          <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 16 }}>Details</h2>

          <div style={{ width: "100%", overflowX: "auto" }}>
            <table
              style={{
                minWidth: 1700,
                borderCollapse: "collapse",
                fontSize: 14,
                tableLayout: "auto",
              }}
            >
              <thead>
                <tr>
                  {[
                    "Row",
                    "Source",
                    "Chosen",
                    "Order",
                    "Party",
                    "Tracking",
                    "AssertedDate",
                    "Verdict",
                    "Reason",
                    "Δdays",
                    "PO",
                    "ShipDoc",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "10px 12px",
                        borderBottom: "1px solid #ddd",
                        whiteSpace: "nowrap",
                        fontWeight: 700,
                        background: "#fcfcfc",
                        position: "sticky",
                        top: 0,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.details.map((r) => {
                  const { bg, fg } = colorForVerdict(r.verdict);
                  return (
                    <tr
                      key={`${r.row}-${r.sourceMode}-${r.orderNumber}-${r.trackingUpload}`}
                      style={{ background: bg, color: fg }}
                    >
                      <td style={cell}>{r.row}</td>
                      <td style={cell}>{r.sourceMode}</td>
                      <td style={cell}>{r.chosenMode}</td>
                      <td style={cell}>{r.orderNumber}</td>
                      <td style={cell}>{r.partyUpload || ""}</td>
                      <td style={cellMono}>{r.trackingUpload}</td>
                      <td style={cell}>{r.assertedDate || ""}</td>
                      <td style={{ ...cell, fontWeight: 700 }}>{r.verdict}</td>
                      <td
                        style={{
                          ...cell,
                          maxWidth: 520,
                          whiteSpace: "normal",
                          wordBreak: "break-word",
                        }}
                      >
                        {r.reason}
                      </td>
                      <td style={{ ...cell, textAlign: "right", width: 60 }}>
                        {r.dayDelta ?? ""}
                      </td>
                      <td style={cell}>{r.poVerdict ?? ""}</td>
                      <td style={cell}>{r.shipVerdict ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function colorForVerdict(verdict: DetailRow["verdict"]): { bg: string; fg: string } {
  switch (verdict) {
    case "MATCH_PO":
      return { bg: "#d7f5d0", fg: "#102a12" }; // light green
    case "MATCH_SHIPDOCS":
      return { bg: "#0b7f2d", fg: "#ffffff" }; // dark green
    case "UNMATCHED_UPS":
    default:
      return { bg: "#ffd6d6", fg: "#5a0000" }; // light red
  }
}

function LegendSwatch({ color, label, dark }: { color: string; label: string; dark?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          display: "inline-block",
          width: 16,
          height: 16,
          borderRadius: 4,
          background: color,
          border: "1px solid rgba(0,0,0,0.15)",
        }}
      />
      <span style={{ fontSize: 12, color: dark ? "#222222" : "#333333" }}>{label}</span>
    </div>
  );
}

function Uploader({
  label,
  onChange,
  file,
}: {
  label: string;
  onChange: (f: File | null) => void;
  file: File | null;
}) {
  return (
    <div
      style={{
        padding: 16,
        border: "1px dashed #bbb",
        borderRadius: 12,
        background: "#fafafa",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <input type="file" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      {file && (
        <div style={{ fontSize: 12, color: "#555", marginTop: 6 }}>
          {file.name}
        </div>
      )}
    </div>
  );
}

const cell: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #eee",
  whiteSpace: "nowrap",
};

const cellMono: React.CSSProperties = {
  ...cell,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};
