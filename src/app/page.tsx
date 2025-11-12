"use client";
import { useState } from "react";

export default function Home() {
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
      <h1 style={{ fontSize: 22, fontWeight: 700 }}>Accounting Reconciliation (PO/SO Auto)</h1>
      <p>Upload a CSV/XLSX with headers like <code>tracking</code>, <code>transaction date</code>, <code>vendor/customer</code>, or <code>poNumber/invoiceNumber/soNumber</code>. We’ll check <b>both</b> PO and SO automatically.</p>

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
                  {["Row","Chosen Mode","Order","Party","Tracking","AssertedDate","Verdict","Reason","Δdays","PO","SO"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #ddd" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.details.map((r: any) => (
                  <tr key={r.row}>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.row}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.chosenMode}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.orderNumber}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.partyUpload}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.trackingUpload}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.assertedDate}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee", fontWeight: 600 }}>{r.verdict}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.reason}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.dayDelta ?? ""}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.poVerdict ?? ""}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.soVerdict ?? ""}</td>
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
