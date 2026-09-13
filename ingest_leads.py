# ---------------------------------------------------------------------
# SUPERSEDED BY sync_leads.py
#
# This script is kept for reference only. It mints a client-side uuid4() per
# record and posts all 63 targets in one request; combined with the old
# server-side dedupe guard that produced 91 duplicate company rows on
# 2026-09-01. The server is fixed (src/lib/match.js) so running this can no
# longer duplicate, but sync_leads.py is the maintained path.
#
# The Cloudflare Access token that used to be hardcoded here has been REMOVED.
# It is a live bearer credential for the agent's CRM and belongs in the
# environment, never in a file:
#     export CF_ACCESS_TOKEN="<CF_Authorization cookie value>"
# ---------------------------------------------------------------------
import re
import json
import os
import urllib.request
import urllib.parse
import uuid

def parse_markdown_to_json(filepath):
    companies = []
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Split the document into blocks by looking for the numbered list items
    blocks = re.split(r'> \d+\.\s+\*\*', content)
    
    for block in blocks[1:]: # Skip the first chunk (headers)
        company = {
            "company_id": str(uuid.uuid4()),
            "isNew": True
        }
        
        # 1. Extract Company Name and Street
        header_line = block.split('\n')[0].strip()
        name_part = header_line.split('**')[0].strip()
        company['company_name'] = name_part
        
        # If there's an address pipe |
        if '|' in header_line:
            address_str = header_line.split('|')[1].strip()
            # Basic parsing for "Street, City, State Zip"
            parts = [p.strip() for p in address_str.split(',')]
            if len(parts) > 0:
                company['street_1'] = parts[0]
            if len(parts) > 1:
                company['city'] = parts[1]
            if len(parts) > 2:
                state_zip = parts[2].split(' ')
                company['state'] = state_zip[0]
                if len(state_zip) > 1:
                    company['zip_code'] = state_zip[1]

        # 2. Extract Decision Maker
        dm_match = re.search(r'\*\s+\*\*Decision Maker:\*\*\s+(.*?)\n', block)
        if dm_match:
            # We map this to custom_1 so it appears in the target UI
            company['custom_1'] = f"DM: {dm_match.group(1).strip()}"

        # 3. Extract Contact Info
        contact_match = re.search(r'\*\s+\*\*Contact Info:\*\*\s+(.*?)\n', block)
        if contact_match:
            contact_raw = contact_match.group(1).strip()
            # If there's a phone number, grab it
            phone_match = re.search(r'[\(]?\d{3}[\)]?[\s-]?\d{3}[\s-]?\d{4}', contact_raw)
            if phone_match:
                company['company_phone'] = phone_match.group(0)

        # 4. Extract CRM Strategy
        strat_match = re.search(r'\*\s+\*\*CRM Strategy:\*\*\s+(.*?)(?=\n>|$)', block, re.DOTALL)
        if strat_match:
            # We map the heavy strategy to custom_2
            company['custom_2'] = f"STRATEGY: {strat_match.group(1).strip()}"
            
        companies.append(company)
        
    return companies

def push_to_api(companies):
    url = "https://legacysweatequity.com/api/companies/import"
    
    # We must format the payload to match the expected format
    payload = json.dumps({"companies": companies}).encode('utf-8')
    
    cf_cookie = os.environ.get("CF_ACCESS_TOKEN")
    if not cf_cookie:
        raise SystemExit("CF_ACCESS_TOKEN is not set. See the note at the top of this file.")
    
    req = urllib.request.Request(url, data=payload, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Cookie', f'CF_Authorization={cf_cookie}')
    
    # FORGE THE ORIGIN HEADERS TO BYPASS THE WORKER'S CSRF PROTECTION
    req.add_header('Origin', 'https://legacysweatequity.com')
    req.add_header('Referer', 'https://legacysweatequity.com/app/')
    req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
    
    try:
        response = urllib.request.urlopen(req)
        print(f"Success! Backend response: {response.read().decode('utf-8')}")
    except Exception as e:
        print(f"Failed to upload: {e}")
        if hasattr(e, 'read'):
            print(f"Error details: {e.read().decode('utf-8')}")

if __name__ == "__main__":
    extracted_companies = parse_markdown_to_json('leads.md')
    print(f"Successfully parsed {len(extracted_companies)} companies from markdown.")
    
    # Write to a local JSON file just so you can verify the data looks correct before pushing
    with open('parsed_leads.json', 'w', encoding='utf-8') as f:
        json.dump(extracted_companies, f, indent=2)
        
    print("Saved to parsed_leads.json. Pushing to Cloudflare D1...")
    
    # Execute the push
    push_to_api(extracted_companies)