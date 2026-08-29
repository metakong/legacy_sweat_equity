
const fs = require("fs");
const XLSX = require("xlsx");
const wb = XLSX.readFile("All Open Leads (Editable) 8-28-2026 6-56-18 PM.xlsx");
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws);
let statements = [];

rows.forEach((row, idx) => {
  const name = String(row["Business Name"] || "").trim();
  if (!name || name === "nan") return;
  const leadId = String(row["(Do Not Modify) Lead"] || "uuid-" + idx).trim();
  const checksum = String(row["(Do Not Modify) Row Checksum"] || "").trim();
  const modOn = String(row["(Do Not Modify) Modified On"] || "").trim();
  const source = String(row["Lead Source"] || "Cold Call").trim();
  const fName = String(row["First Name"] || "").trim();
  const lName = String(row["Last Name"] || "").trim();
  const rating = String(row["Rating"] || "Cold").trim();
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
  const coId = "comp_" + idx;

  statements.push(`INSERT INTO companies (company_id, d365_lead_id, d365_checksum, d365_modified_on, company_name, street_1, street_2, city, state, zip_code, lead_source, rating, employees, industry, is_d365_synced, created_at) VALUES (\x27${esc(coId)}\x27, \x27${esc(leadId)}\x27, \x27${esc(checksum)}\x27, \x27${esc(modOn)}\x27, \x27${esc(name)}\x27, \x27${esc(s1)}\x27, \x27${esc(s2)}\x27, \x27${esc(city)}\x27, \x27${esc(state)}\x27, \x27${esc(zip)}\x27, \x27${esc(source)}\x27, \x27${esc(rating)}\x27, ${emp}, \x27${esc(ind)}\x27, 1, datetime(\x27now\x27));`);
  
  if (fName || lName || phone || email) {
    statements.push(`INSERT INTO contacts (contact_id, company_id, first_name, last_name, job_title, phone_number, email_address, is_primary_dm) VALUES (\x27cont_${idx}\x27, \x27${esc(coId)}\x27, \x27${esc(fName)}\x27, \x27${esc(lName)}\x27, \x27${esc(title)}\x27, \x27${esc(phone)}\x27, \x27${esc(email)}\x27, 1);`);
  }
});

const batchSize = 25;
const batches = statements.reduce((acc, curr, i) => {
  const batchIdx = Math.floor(i / batchSize);
  acc[batchIdx] = acc[batchIdx] || [];
  acc[batchIdx].push(curr);
  return acc;
}, []);

console.log(`Prepared ${statements.length} SQL statements in ${batches.length} batches.`);

const { execSync } = require("child_process");
for (let i = 0; i < batches.length; i++) {
  fs.writeFileSync("temp_batch.sql", batches[i].join("\n"));
  console.log(`Executing batch ${i + 1}/${batches.length}...`);
  execSync("npm run wrangler -- d1 execute legacy-db --remote --yes --file=temp_batch.sql", { stdio: "inherit" });
}
try { fs.unlinkSync("temp_batch.sql"); } catch(e) {}
console.log("All leads successfully imported!");

