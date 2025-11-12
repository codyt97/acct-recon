"use client";
import { useState } from "react";

export default function Home() {
  const [mode, setMode] = useState<"PO" | "SO">("PO");
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    const fd = new FormData();
    fd.append("mode", mode);
    fd.append("file", file);
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
    <div style={{ maxWidth: 900, margin: "40px auto", padding: 20, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Accounting Reconciliation (Minimal)</h1>
      <p>CSV/XLSX headers can be flexible. We’ll detect things like <code>poNumber/invoiceNumber</code>, <code>vendor/customer</code>, <code>tracking</code>, and <code>shipDate/invoiceDate</code>.</p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
        <label>Mode:</label>
        <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
          <option value="PO">PO (Receiving)</option>
          <option value="SO">SO (Shipping)</option>
        </select>
      </div>

      <div style={{ marginTop: 12, padding: 20, border: "1px dashed #bbb", borderRadius: 12 }}>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>

      <button onClick={submit} disabled={!file || busy} style={{ marginTop: 12, padding: "8px 14px" }}>
        {busy ? "Reconciling..." : "Reconcile"}
      </button>

      {err && (
        <pre style={{ marginTop: 16, color: "#b00020", whiteSpace: "pre-wrap" }}>{err}</pre>
      )}

      {result && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Summary</h2>
          <pre style={{ background: "#f7f7f7", padding: 12, borderRadius: 8 }}>
            {JSON.stringify(result.summary, null, 2)}
          </pre>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginTop: 16 }}>Details</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  {["Row","Order","Party","Tracking","AssertedDate","Verdict","Reason","Δdays"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ddd" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.details.map((r: any) => (
                  <tr key={r.row}>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.row}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.orderNumber}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.partyUpload}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.trackingUpload}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.assertedDate}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee", fontWeight: 600 }}>{r.verdict}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.reason}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.dayDelta ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
