
import pandas as pd, json, uuid
df = pd.read_excel("All Open Leads (Editable) 8-28-2026 6-56-18 PM.xlsx", sheet_name="All Open Leads (Editable)")
stmts = []
for i, r in df.iterrows():
    name = str(r.get("Business Name", "")).strip()
    if not name or name == "nan": continue
    leadId = str(r.get("(Do Not Modify) Lead", "uuid-" + str(i))).strip()
    checksum = str(r.get("(Do Not Modify) Row Checksum", "")).strip()
    modOn = str(r.get("(Do Not Modify) Modified On", "")).strip()
    source = str(r.get("Lead Source", "Cold Call")).strip()
    fName = str(r.get("First Name", "")).strip()
    lName = str(r.get("Last Name", "")).strip()
    rating = str(r.get("Rating", "Cold")).strip()
    phone = str(r.get("Phone Number", "")).strip()
    email = str(r.get("Email Address", "")).strip()
    title = str(r.get("Job Title", "")).strip()
    emp = int(float(r.get("Employees", 0) or 0))
    ind = str(r.get("Industry", "")).strip()
    s1 = str(r.get("Street 1", "")).strip()
    s2 = str(r.get("Street 2", "")).strip()
    city = str(r.get("City", "Springfield")).strip()
    state = str(r.get("State", "MO")).strip()
    zipCode = str(r.get("Zip Code", "")).strip()
    def esc(s): return s.replace("\x27", "\x27\x27").replace("\"", "\"\"")
    coId = f"comp_{i}"
    stmts.append(f"INSERT INTO companies (company_id, d365_lead_id, d365_checksum, d365_modified_on, company_name, street_1, street_2, city, state, zip_code, lead_source, rating, employees, industry, is_d365_synced, created_at) VALUES (\x27{esc(coId)}\x27, \x27{esc(leadId)}\x27, \x27{esc(checksum)}\x27, \x27{esc(modOn)}\x27, \x27{esc(name)}\x27, \x27{esc(s1)}\x27, \x27{esc(s2)}\x27, \x27{esc(city)}\x27, \x27{esc(state)}\x27, \x27{esc(zipCode)}\x27, \x27{esc(source)}\x27, \x27{esc(rating)}\x27, {emp}, \x27{esc(ind)}\x27, 1, datetime(\x27now\x27));")
    if fName or lName or phone or email:
        stmts.append(f"INSERT INTO contacts (contact_id, company_id, first_name, last_name, job_title, phone_number, email_address, is_primary_dm) VALUES (\x27cont_{i}\x27, \x27{esc(coId)}\x27, \x27{esc(fName)}\x27, \x27{esc(lName)}\x27, \x27{esc(title)}\x27, \x27{esc(phone)}\x27, \x27{esc(email)}\x27, 1);")

batches = [stmts[j:j+25] for j in range(0, len(stmts), 25)]
code = "const { execSync } = require(\x27child_process\x27);\nconst fs = require(\x27fs\x27);\nconst batches = " + json.dumps(batches) + ";\nfor (let i = 0; i < batches.length; i++) {\n  fs.writeFileSync(\x27temp_batch.sql\x27, batches[i].join(\x27\\n\x27));\n  console.log(`Executing batch ${i + 1}/${batches.length}...`);\n  execSync(\x27npm run wrangler -- d1 execute legacy-db --remote --file=temp_batch.sql\x27, { stdio: \x27inherit\x27 });\n}\ntry { fs.unlinkSync(\x27temp_batch.sql\x27); } catch(e) {}\nconsole.log(\x27All leads successfully imported!\x27);"
open("import-leads.js", "w", encoding="utf-8").write(code)
print("import-leads.js generated successfully!")

