import PDFDocument from "pdfkit";
import { rupeesInWords, STATES } from "./gst.js";

// A tax invoice as a PDF, laid out from the stored invoice row so it always matches what was paid. The standard
// PDF fonts have no rupee sign, so amounts are written "INR 2,499.00".
const inr = (minor) => `INR ${(Number(minor) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateOf = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : String(v).slice(0, 10));

// The tax rows of an invoice, at the rate it was made at: half each for CGST and SGST, the whole for IGST.
export function taxLines(invoice) {
  const rate = Number(invoice.gst_rate ?? 18);
  const half = `${rate / 2}%`;
  return [
    [`CGST @ ${half}`, invoice.cgst_minor],
    [`SGST @ ${half}`, invoice.sgst_minor],
    [`IGST @ ${rate}%`, invoice.igst_minor],
  ].filter(([, amount]) => Number(amount));
}

export function invoiceFileName(number) {
  return `Scriwo-invoice-${String(number).replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
}

export function renderInvoice(invoice) {
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Tax invoice ${invoice.number}`, Author: invoice.seller.legalName } });
  const W = doc.page.width - 96;
  const seller = invoice.seller,
    buyer = invoice.buyer;
  const grey = "#555555";

  doc.font("Helvetica-Bold").fontSize(20).text("Tax invoice", { continued: false });
  doc.font("Helvetica").fontSize(9).fillColor(grey).text("Original for recipient. Payment received.");
  doc.moveDown(0.8).fillColor("black");

  // Who is who
  const top = doc.y;
  doc.font("Helvetica-Bold").fontSize(10).text(seller.legalName, 48, top, { width: W / 2 - 10 });
  doc.font("Helvetica").fontSize(9).fillColor(grey);
  for (const line of [...seller.addressLines, `${seller.city}, ${seller.state} ${seller.postalCode}`, `GSTIN: ${seller.gstin}`, `State: ${seller.state} (${seller.stateCode})`]) doc.text(line, { width: W / 2 - 10 });
  const leftEnd = doc.y;
  doc.fillColor("black").font("Helvetica-Bold").fontSize(9).text(`Invoice no. ${invoice.number}`, 48 + W / 2, top, { width: W / 2, align: "right" });
  doc.font("Helvetica").text(`Date: ${date(dateOf(invoice.issue_date))}`, { width: W / 2, align: "right" });
  doc.text(`Service: Scriwo ${invoice.plan_name} plan`, { width: W / 2, align: "right" });
  doc.text(`Billing period: ${date(dateOf(invoice.period_start))} to ${date(dateOf(invoice.period_end))}`, { width: W / 2, align: "right" });
  doc.y = Math.max(leftEnd, doc.y) + 14;

  doc.font("Helvetica-Bold").fontSize(9).text("Billed to");
  doc.font("Helvetica").fillColor(grey);
  const state = STATES[buyer.stateCode] || buyer.state || "";
  for (const line of [buyer.legalName, buyer.addressLine1, buyer.addressLine2, `${buyer.city}, ${state} ${buyer.postalCode}`, buyer.gstin ? `GSTIN: ${buyer.gstin}` : "GSTIN: not provided", `Place of supply: ${state} (${buyer.stateCode})`].filter(Boolean)) doc.text(line);
  doc.fillColor("black").moveDown(1);

  // Lines
  const x = [48, 48 + W * 0.52, 48 + W * 0.66, 48 + W * 0.8];
  const headY = doc.y;
  doc.rect(48, headY - 4, W, 18).fill("#eeeeee").fillColor("black");
  doc.font("Helvetica-Bold").fontSize(9);
  doc.text("Description", x[0] + 4, headY, { width: W * 0.5 });
  doc.text("SAC", x[1], headY, { width: W * 0.12 });
  doc.text("Qty", x[2], headY, { width: W * 0.1 });
  doc.text("Amount", x[3], headY, { width: W * 0.2 - 4, align: "right" });
  doc.y = headY + 20;
  doc.font("Helvetica").fontSize(9);
  for (const line of invoice.lines) {
    const y = doc.y;
    doc.text(line.description, x[0] + 4, y, { width: W * 0.5 });
    if (line.detail) doc.fillColor(grey).text(line.detail, x[0] + 4, doc.y, { width: W * 0.5 }).fillColor("black");
    const end = doc.y;
    doc.text(invoice.sac_code, x[1], y, { width: W * 0.12 });
    doc.text("1", x[2], y, { width: W * 0.1 });
    doc.text(inr(line.amountMinor), x[3], y, { width: W * 0.2 - 4, align: "right" });
    doc.y = end + 6;
  }
  doc.moveTo(48, doc.y).lineTo(48 + W, doc.y).strokeColor("#cccccc").stroke();
  doc.moveDown(0.6);

  // Totals
  const row = (label, amount, bold = false) => {
    const y = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9);
    doc.text(label, x[1], y, { width: W * 0.3 });
    doc.text(inr(amount), x[3], y, { width: W * 0.2 - 4, align: "right" });
    doc.y = y + (bold ? 16 : 14);
  };
  row("Taxable value", invoice.taxable_minor);
  for (const [label, amount] of taxLines(invoice)) row(label, amount);
  row("Total", invoice.total_minor, true);
  doc.moveDown(0.6).font("Helvetica-Oblique").fontSize(9).text(rupeesInWords(Number(invoice.total_minor)), 48, doc.y, { width: W });

  doc.moveDown(1.2).font("Helvetica").fontSize(9).fillColor(grey);
  const how = invoice.payment_method === "recorded" ? "Payment received and recorded by Scriwo" : `Paid online through Razorpay${invoice.payment_method ? ` (${invoice.payment_method})` : ""}`;
  doc.text(`${how}${invoice.payment_ref ? `. Reference: ${invoice.payment_ref}` : ""}.`, 48, doc.y, { width: W });
  doc.text("Tax payable on reverse charge: No.", 48, doc.y, { width: W });
  doc.text("This is a computer-generated invoice and needs no signature.", 48, doc.y, { width: W });
  doc.end();
  return doc;
}
