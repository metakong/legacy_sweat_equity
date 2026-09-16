#!/usr/bin/env python3
"""
scripts/dedupe_migration.py
===========================
Executes Phase 1 Data Consolidation & Orphan Rescue against Cloudflare D1 (legacy-db).

1. Queries all companies from remote D1.
2. Clusters records by normalized door key (name + street).
3. Identifies canonical accounts and generates migration SQL for orphan rescue:
   - Migrates contacts & activity logs from duplicates to canonical.
   - Deletes duplicate company records.
4. Converts non-address placeholders ('Springfield, MO', 'Springfield, MO (HQ)') to NULL.
5. Deploys the generated SQL to remote D1.
"""

import os
import sys
import json
import re
import unicodedata
import subprocess
from collections import defaultdict
from pathlib import Path

# Ensure UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

REPO_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_DIR / "data"
OUTPUT_SQL = DATA_DIR / "dedupe_migration.sql"

LEGAL_SUFFIXES = {
    'inc', 'incorporated', 'llc', 'lc', 'ltd', 'limited', 'corp', 'corporation',
    'co', 'company', 'plc', 'lp', 'llp', 'pc', 'pllc', 'group', 'holdings'
}

STREET_TYPES = {
    'street': 'st', 'str': 'st', 'st': 'st',
    'road': 'rd', 'rd': 'rd',
    'avenue': 'ave', 'avenu': 'ave', 'aven': 'ave', 'av': 'ave',
    'boulevard': 'blvd', 'boul': 'blvd', 'blvd': 'blvd',
    'drive': 'dr', 'drv': 'dr', 'dr': 'dr',
    'lane': 'ln', 'ln': 'ln',
    'court': 'ct', 'ct': 'ct',
    'circle': 'cir', 'cir': 'cir',
    'place': 'pl', 'pl': 'pl',
    'parkway': 'pkwy', 'pkwy': 'pkwy', 'pky': 'pkwy',
    'highway': 'hwy', 'hwy': 'hwy',
    'expressway': 'expy', 'expy': 'expy', 'expwy': 'expy',
    'terrace': 'ter', 'ter': 'ter',
    'trail': 'trl', 'trl': 'trl',
    'square': 'sq', 'sq': 'sq',
    'plaza': 'plz', 'plz': 'plz',
    'crossing': 'xing', 'xing': 'xing'
}

DIRECTIONALS = {
    'north': 'n', 'n': 'n',
    'south': 's', 's': 's',
    'east': 'e', 'e': 'e',
    'west': 'w', 'w': 'w',
    'northeast': 'ne', 'ne': 'ne',
    'northwest': 'nw', 'nw': 'nw',
    'southeast': 'se', 'se': 'se',
    'southwest': 'sw', 'sw': 'sw'
}

UNIT_MARKERS = {
    'ste', 'suite', 'unit', 'apt', 'apartment', 'rm', 'room',
    'bldg', 'building', 'fl', 'floor'
}

def base_fold(val):
    if not isinstance(val, str): return ''
    norm = unicodedata.normalize('NFD', val)
    stripped = ''.join(c for c in norm if unicodedata.category(c) != 'Mn')
    lowered = stripped.lower().replace('&', ' and ')
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', lowered).split())

def normalize_name(val):
    folded = base_fold(val)
    if not folded: return ''
    tokens = folded.split()
    if len(tokens) > 1 and tokens[0] == 'the':
        tokens = tokens[1:]
    while len(tokens) > 1 and tokens[-1] in LEGAL_SUFFIXES:
        tokens = tokens[:-1]
    return ' '.join(tokens) or folded

def normalize_street(val):
    folded = base_fold(val)
    if not folded or not re.search(r'\d', folded): return ''
    tokens = folded.split()
    out = []
    for t in tokens:
        if t in UNIT_MARKERS: break
        out.append(STREET_TYPES.get(t) or DIRECTIONALS.get(t) or t)
    canonical_types = set(STREET_TYPES.values())
    while len(out) > 2 and out[-1] in canonical_types:
        out.pop()
    return ' '.join(out)

def get_door_key(name, street):
    nn = normalize_name(name)
    ns = normalize_street(street)
    if not nn or not ns: return None
    return f"{nn} {ns}"

def run_wrangler_query(cmd_args):
    full_cmd = [
        "node", "--max-old-space-size=4096",
        "--require", "./scripts/workerd-win-arm64-shim.cjs",
        "node_modules/wrangler/bin/wrangler.js"
    ] + cmd_args
    env = os.environ.copy()
    env["CI"] = "true"
    res = subprocess.run(
        full_cmd,
        cwd=str(REPO_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        stdin=subprocess.DEVNULL,
        env=env
    )
    if res.returncode != 0:
        raise RuntimeError(f"Wrangler error: {res.stderr.strip()}")
    return res.stdout

def score_record(r):
    score = 0
    if r.get('d365_lead_id'): score += 100
    if r.get('lat') is not None and r.get('long') is not None: score += 50
    if r.get('notes'): score += 20
    if r.get('decision_maker'): score += 10
    if r.get('company_phone'): score += 5
    return score

def main():
    print("=== D1 Data Consolidation & Orphan Rescue Pipeline ===")
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("Step 1: Fetching current companies from remote D1...")
    stdout = run_wrangler_query(["d1", "execute", "legacy-db", "--remote", "--json", "--command=SELECT * FROM companies;"])
    data = json.loads(stdout)
    companies = data[0].get("results", [])
    print(f"  Loaded {len(companies)} companies from remote D1.")

    clusters = defaultdict(list)
    for c in companies:
        dk = get_door_key(c.get('company_name'), c.get('street_1'))
        if dk:
            clusters[dk].append(c)

    multi_clusters = {k: v for k, v in clusters.items() if len(v) > 1}
    print(f"  Identified {len(multi_clusters)} duplicate clusters across {sum(len(v) for v in multi_clusters.values())} records.")

    sql_statements = []
    sql_statements.append("-- D1 Data Consolidation & Orphan Rescue Batch")
    sql_statements.append("PRAGMA foreign_keys = OFF;")

    total_dupes_pruned = 0
    for door_key, records in multi_clusters.items():
        # Sort by score desc, then created_at asc
        sorted_records = sorted(records, key=lambda r: (score_record(r), -(1 if r.get('created_at') else 0)), reverse=True)
        canonical = sorted_records[0]
        duplicates = sorted_records[1:]
        canonical_id = canonical['company_id']

        print(f"\nCluster [{door_key}]:")
        print(f"  Canonical: '{canonical['company_name']}' ({canonical_id})")

        for d in duplicates:
            dupe_id = d['company_id']
            print(f"    Duplicate to merge: '{d['company_name']}' ({dupe_id})")
            # 1. Migrate contacts
            sql_statements.append(f"UPDATE contacts SET company_id = '{canonical_id}' WHERE company_id = '{dupe_id}';")
            # 2. Migrate activity logs
            sql_statements.append(f"UPDATE activity_logs SET company_id = '{canonical_id}' WHERE company_id = '{dupe_id}';")
            # 3. Delete duplicate company
            sql_statements.append(f"DELETE FROM companies WHERE company_id = '{dupe_id}';")
            total_dupes_pruned += 1

    # Step 2: Handle placeholder addresses
    sql_statements.append("-- Convert placeholder addresses to NULL")
    sql_statements.append("UPDATE companies SET street_1 = NULL, lat = NULL, long = NULL, geohash = NULL WHERE street_1 IN ('Springfield, MO', 'Springfield, MO (HQ)');")

    clean_statements = []
    for s in sql_statements:
        s_clean = s.strip()
        if not s_clean: continue
        if s_clean.startswith("--"):
            clean_statements.append(s_clean)
        else:
            clean_statements.append(s_clean.rstrip(";") + ";")

    with open(OUTPUT_SQL, 'w', encoding='utf-8') as f:
        f.write("\n".join(clean_statements) + "\n")

    print(f"\nStep 2: Generated {len(clean_statements)} lines in {OUTPUT_SQL.name}.")
    print(f"  Total duplicate companies targeted for removal: {total_dupes_pruned}")

    print("\nStep 3: Deploying migration batch to remote Cloudflare D1...")
    deploy_output = run_wrangler_query(["d1", "execute", "legacy-db", "--remote", "--yes", f"--file={OUTPUT_SQL.as_posix()}"])
    print("Deployment successful!")
    print(deploy_output[:400])

if __name__ == "__main__":
    main()
