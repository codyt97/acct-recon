import axios from "axios";

const base = process.env.OT_BASE as string;

async function authHeader() {
  const token = process.env.OT_TOKEN;
  if (!token) throw new Error("Missing OT_TOKEN");
  return { Authorization: `Bearer ${token}` };
}

export async function getOrder(mode: "PO" | "SO", orderNumber: string) {
  const url = mode === "PO" ? `${base}/purchase-orders` : `${base}/sales-orders`;
  const { data } = await axios.get(url, { params: { orderNumber }, headers: await authHeader() });
  return data; // Make sure this includes partyName/vendorName/customerName
}

export async function getActivity(mode: "PO" | "SO", orderNumber: string) {
  const url = mode === "PO" ? `${base}/receipts` : `${base}/shipments`;
  const { data } = await axios.get(url, { params: { orderNumber }, headers: await authHeader() });
  return data;
}

/** Map your OT response into packages [{tracking, date}] */
export function extractPackages(activity: any): { tracking: string; date?: string | null }[] {
  if (!activity) return [];
  const pkgs: { tracking: string; date?: string | null }[] = [];
  for (const doc of activity.docs ?? []) {
    const date = doc.date ?? doc.shipDate ?? doc.receiptDate ?? null;
    for (const p of doc.packages ?? []) {
      const t = (p.trackingNumber ?? p.tracking ?? "").toString().toUpperCase().replace(/\s|-/g, "");
      if (t) pkgs.push({ tracking: t, date });
    }
  }
  return pkgs;
}
