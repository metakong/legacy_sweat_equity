#!/usr/bin/env python3
"""
scripts/apply_phase2_migration.py
=================================
Executes Phase 2 Schema Hardening & Architectural Constraints against remote Cloudflare D1 (legacy-db).

1. Adds column `door_key TEXT` to `companies` if not already added.
2. Fetches all companies, computes normalized door_key for each using get_door_key().
3. Updates remote D1 with the door_key values in batches.
4. Verifies no duplicate (agent_email, door_key) exists for physical addresses.
5. Creates the partial unique index:
     CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_unique_door
     ON companies (agent_email, door_key)
     WHERE street_1 IS NOT NULL AND street_1 != '' AND door_key IS NOT NULL;
6. Validates schema and index in remote D1.
"""

import os
import sys
import json
import re
import unicodedata
import subprocess
from collections import defaultdict
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

REPO_DIR = Path(__file__).resolve().parent.parent

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
        raise RuntimeError(f"Wrangler error: {res.stderr.strip() or res.stdout.strip()}")
    return res.stdout

def sql_escape(val):
    if val is None:
        return "NULL"
    escaped = str(val).replace("'", "''")
    return f"'{escaped}'"

def main():
    print("=== Step 1: Adding door_key column if not present ===")
    try:
        run_wrangler_query([
            "d1", "execute", "legacy-db", "--remote",
            "--command", "ALTER TABLE companies ADD COLUMN door_key TEXT;",
            "--yes"
        ])
        print("Successfully added door_key column to companies.")
    except Exception as e:
        if "duplicate column name" in str(e).lower():
            print("Column door_key already exists on companies.")
        else:
            print(f"Notice on ALTER TABLE: {e}")

    print("\n=== Step 2: Fetching all companies from remote D1 ===")
    raw_output = run_wrangler_query([
        "d1", "execute", "legacy-db", "--remote",
        "--command", "SELECT company_id, company_name, street_1, agent_email FROM companies;",
        "--json"
    ])
    data = json.loads(raw_output)
    results = data[0]["results"]
    print(f"Fetched {len(results)} companies from remote D1.")

    print("\n=== Step 3: Computing door_key and checking for collisions ===")
    door_key_map = {}
    key_counts = defaultdict(list)
    update_statements = []

    for r in results:
        cid = r["company_id"]
        cname = r.get("company_name") or ""
        street = r.get("street_1") or ""
        agent = r.get("agent_email") or "sean_deardorff@us.aflac.com"
        
        dk = get_door_key(cname, street)
        door_key_map[cid] = dk
        if dk:
            key_counts[(agent, dk)].append((cid, cname, street))
        
        val_str = sql_escape(dk)
        update_statements.append(f"UPDATE companies SET door_key = {val_str} WHERE company_id = {sql_escape(cid)};")

    # Check collisions
    collisions = {k: v for k, v in key_counts.items() if len(v) > 1}
    if collisions:
        print(f"WARNING: Found {len(collisions)} duplicate door_key collisions:")
        for (agent, dk), rows in collisions.items():
            print(f"  Door: [{dk}] -> {len(rows)} companies: {rows}")
        sys.exit(1)
    else:
        print(f"All {len(key_counts)} non-null door_keys are 100% unique! No collisions.")

    print(f"\n=== Step 4: Executing batch UPDATEs on remote D1 ({len(update_statements)} rows) ===")
    batch_size = 50
    temp_dir = REPO_DIR / "data"
    temp_dir.mkdir(exist_ok=True)
    temp_file = temp_dir / "temp_update_door_keys.sql"

    for i in range(0, len(update_statements), batch_size):
        chunk = update_statements[i:i + batch_size]
        temp_file.write_text("\n".join(chunk), encoding="utf-8")
        run_wrangler_query([
            "d1", "execute", "legacy-db", "--remote",
            "--file", str(temp_file),
            "--yes"
        ])
        print(f"  Updated batch {i + 1} to {min(i + batch_size, len(update_statements))}/{len(update_statements)}")

    if temp_file.exists():
        temp_file.unlink()

    print("\n=== Step 5: Applying idx_companies_unique_door index on remote D1 ===")
    run_wrangler_query([
        "d1", "execute", "legacy-db", "--remote",
        "--command", "CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_unique_door ON companies (agent_email, door_key) WHERE street_1 IS NOT NULL AND street_1 != '' AND door_key IS NOT NULL;",
        "--yes"
    ])
    print("Partial unique index idx_companies_unique_door applied successfully.")

    print("\n=== Step 6: Verifying remote D1 state ===")
    verify_output = run_wrangler_query([
        "d1", "execute", "legacy-db", "--remote",
        "--command", "SELECT count(*) AS total, count(door_key) AS with_door_key FROM companies;",
        "--json"
    ])
    verify_data = json.loads(verify_output)
    print("Verification:", verify_data[0]["results"])

    index_check = run_wrangler_query([
        "d1", "execute", "legacy-db", "--remote",
        "--command", "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_companies_unique_door';",
        "--json"
    ])
    idx_data = json.loads(index_check)
    print("Index verification:", idx_data[0]["results"])
    print("\nPhase 2 Migration Complete!")

if __name__ == "__main__":
    main()
