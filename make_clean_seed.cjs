
const fs = require("fs");
const XLSX = require("xlsx");
const wb = XLSX.readFile("All Open Leads (Editable) 8-28-2026 6-56-18 PM.xlsx");
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws);

let statements = [
  "DELETE FROM activity_logs;",
  "DELETE FROM contacts;",
  "DELETE FROM companies;"
];

rows.forEach((row, idx) => {
  const name = String(row["Business Name"] || "").trim();
  if (!name || name === "nan") return;
  const leadId = String(row["(Do Not Modify) Lead"] || "").trim();
  const checksum = String(row["(Do Not Modify) Row Checksum"] || "").trim();
  const fName = String(row["First Name"] || "").trim();
  const lName = String(row["Last Name"] || "").trim();
  const phone = String(row["Phone Number"] || "").trim();
  const email = String(row["Email Address"] || "").trim();
  const title = String(row["Job Title"] || "").trim();
  const emp = parseInt(row["Employees"] || 0) || 0;
  const ind = String(row["Industry"] || "").trim();
  const s1 = String(row["Street 1"] || "").trim();
  const s2 = String(row["Street 2"] || "").trim();
  const city = String(row["City"] || "Springfield").trim();
  const state = String(row["State"] || "MO").trim();
  const zip = String(row["Zip Code"] || "").trim();
  const esc = s => s.replace(/\x27/g, "\x27\x27");

  statements.push(`INSERT INTO companies (name, address_line1, address_line2, city, state, zip, employee_count, industry, d365_lead_guid, d365_row_checksum, created_at, updated_at) VALUES (\x27${esc(name)}\x27, \x27${esc(s1)}\x27, \x27${esc(s2)}\x27, \x27${esc(city)}\x27, \x27${esc(state)}\x27, \x27${esc(zip)}\x27, ${emp}, \x27${esc(ind)}\x27, \x27${esc(leadId)}\x27, \x27${esc(checksum)}\x27, datetime(\x27now\x27), datetime(\x27now\x27));`);

  if (fName || lName || phone || email || title) {
    statements.push(`INSERT INTO contacts (company_id, first_name, last_name, title, phone, email, created_at, updated_at) VALUES (last_insert_rowid(), \x27${esc(fName)}\x27, \x27${esc(lName)}\x27, \x27${esc(title)}\x27, \x27${esc(phone)}\x27, \x27${esc(email)}\x27, datetime(\x27now\x27), datetime(\x27now\x27));`);
  }
});

fs.writeFileSync("seed-clean.sql", statements.join("\n"));
console.log(`Generated seed-clean.sql with ${statements.length} statements.`);

