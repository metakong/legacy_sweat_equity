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
import uuid

def parse_markdown_notes(filepath):
    updates = []
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    blocks = re.split(r'> \d+\.\s+\*\*', content)
    
    for block in blocks[1:]:
        header_line = block.split('\n')[0].strip()
        name_part = header_line.split('**')[0].strip()
        
        # Extract CRM Strategy / Notes block
        strat_match = re.search(r'\*\s+\*\*CRM Strategy:\*\*\s+(.*?)(?=\n>|$)', block, re.DOTALL)
        strategy_text = strat_match.group(1).strip() if strat_match else ""
        
        # Extract Decision Maker
        dm_match = re.search(r'\*\s+\*\*Decision Maker:\*\*\s+(.*?)\n', block)
        dm_text = dm_match.group(1).strip() if dm_match else ""

        updates.append({
            "company_name": name_part,
            "custom_1": f"DM: {dm_text}" if dm_text else "",
            "custom_2": f"LATEST UPDATE (09/01/2026): {strategy_text}",
            "contacts": [{"first_name": dm_text, "job_title": "Decision Maker", "is_primary_dm": True}] if dm_text else []
        })
        
    return updates

def push_enrichment(companies):
    url = "https://legacysweatequity.com/api/companies/import"
    payload = json.dumps({"companies": companies}).encode('utf-8')
    
    cf_cookie = os.environ.get("CF_ACCESS_TOKEN")
    if not cf_cookie:
        raise SystemExit("CF_ACCESS_TOKEN is not set. See the note at the top of this file.")
    
    req = urllib.request.Request(url, data=payload, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Cookie', f'CF_Authorization={cf_cookie}')
    req.add_header('Origin', 'https://legacysweatequity.com')
    req.add_header('Referer', 'https://legacysweatequity.com/app/')
    req.add_header('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    
    try:
        response = urllib.request.urlopen(req)
        print(f"Enrichment response: {response.read().decode('utf-8')}")
    except Exception as e:
        print(f"Failed to enrich: {e}")
        if hasattr(e, 'read'):
            print(f"Details: {e.read().decode('utf-8')}")

if __name__ == "__main__":
    enrichment_data = parse_markdown_notes('leads.md')
    print(f"Parsed {len(enrichment_data)} company notes for enrichment.")
    
    with open('parsed_enrichment.json', 'w', encoding='utf-8') as f:
        json.dump(enrichment_data, f, indent=2)
        
    print("Pushing updates to Cloudflare D1 via fuzzy matching import...")
    push_enrichment(enrichment_data)