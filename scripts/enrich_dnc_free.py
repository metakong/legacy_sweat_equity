"""
Optimized Autonomous Zero-Trust DNC Enrichment Pipeline (September 2026 - Final Master Edition)
Engineered for Windows ARM64 (Samsung Galaxy Book Go 5G).
Features:
- Primary Engine: Gemini 3.5 Flash / 3.8 Flash via OpenAI compatibility endpoint.
- Secondary Engine: Ungated OpenRouter Free Failover Array (Nemotron-3-Super, Laguna-S-2.1).
- TCP Kill Switch: Strict httpx granular timeouts completely eliminate phantom terminal freezes.
- Null Object Protection: Graceful evaluation prevents 'NoneType' object has no attribute 'strip' crashes.
- Pre-screening Regex Gate: Drops dead search results instantly to conserve API quota and time.
- Automated Cloudflare D1 Synchronization via Wrangler with robust JSON extraction.
"""

import os
import sys
import time
import json
import re
import random
import subprocess
from datetime import datetime
from pathlib import Path

import pandas as pd
from ddgs import DDGS
from openai import OpenAI, APITimeoutError, APIError, RateLimitError
import httpx

# ---------------------------------------------------------------------------
# CONFIGURATION & LOGGING UTILS
# ---------------------------------------------------------------------------
CSV_PATH = Path('data/dnc_export.csv')
SQL_OUTPUT = Path('data/dnc_seed_batch.sql')
WORKSPACE_CSV_OUTPUT = Path('data/Enriched_DNC_Master.csv')
CHECKPOINT_FILE = Path('data/.dnc_checkpoint.txt')

# Approved Springfield City Limit ZIP Codes (Strict Territorial Quarantine)
VALID_ZIPS = {'65802', '65803', '65804', '65806', '65807', '65809', '65810'}

# Redline pacing delay (seconds) between records
BASE_SLEEP = 8  

# Load local gitignored .env if present
def load_env():
    env_path = Path(__file__).resolve().parent.parent / '.env'
    if env_path.exists():
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())

load_env()

# 1. Primary Engine: Google AI Studio (OpenAI Compatibility Layer with Strict HTTPX Kill Switch)
gemini_http = httpx.Client(
    limits=httpx.Limits(max_connections=50, max_keepalive_connections=10, keepalive_expiry=20.0),
    timeout=httpx.Timeout(connect=3.0, read=12.0, write=5.0, pool=5.0)
)
gemini_client = OpenAI(
    api_key=os.getenv("GEMINI_API_KEY") or "mock-gemini-key",
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
    http_client=gemini_http,
    max_retries=0
)

# 2. Secondary Engine: OpenRouter (With Strict HTTPX Kill Switch)
or_http = httpx.Client(
    limits=httpx.Limits(max_connections=50, max_keepalive_connections=10, keepalive_expiry=20.0),
    timeout=httpx.Timeout(connect=3.0, read=8.0, write=5.0, pool=5.0)
)
client = OpenAI(
    api_key=os.getenv("OPENROUTER_API_KEY") or "mock-openrouter-key",
    base_url="https://openrouter.ai/api/v1",
    http_client=or_http,
    max_retries=0
)

# Model Slugs Hierarchy (September 2026 Standards)
GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash"]
OR_MODELS = [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "poolside/laguna-s-2.1:free",
    "openrouter/free"
]

def log_event(action: str, status: str, details: str = ""):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    print(f"[{ts}] [{action.upper()}] {status} | {details}")

# ---------------------------------------------------------------------------
# UTILITIES & NORMALIZATION
# ---------------------------------------------------------------------------
def normalize_name(name: str) -> str:
    if not isinstance(name, str): return ""
    cleaned = name.upper()
    cleaned = re.sub(r'\b(LLC|INC|CORP|CO|COMPANY|THE|L\.L\.C\.|INCORPORATED)\b', '', cleaned)
    return re.sub(r'[^A-Z0-9]', '', cleaned).strip()

def get_last_checkpoint() -> int:
    if CHECKPOINT_FILE.exists():
        try:
            with open(CHECKPOINT_FILE, 'r', encoding='utf-8') as f:
                val = int(f.read().strip())
                log_event("CHECKPOINT", "LOADED", f"Resuming from index {val}")
                return val
        except Exception:
            return 0
    return 0

def save_checkpoint(index: int):
    with open(CHECKPOINT_FILE, 'w', encoding='utf-8') as f:
        f.write(str(index))
    log_event("CHECKPOINT", "SAVED", f"Advanced to index {index}")

def clean_query_string(text: str) -> str:
    return ' '.join(re.sub(r'[^a-zA-Z0-9\s]', '', text).split())

def contains_address_signals(text: str) -> bool:
    """Pre-screening gate: drops dead search results before burning API quota."""
    if re.search(r'\b\d{5}\b', text): return True
    if re.search(r'\b(St|Rd|Ave|Blvd|Ln|Dr|Hwy|Pkwy|Way|Court|Ct|Circle|Cir|Trafficway|Expressway|Square|Sq|Plaza|Pl)\b', text, re.IGNORECASE): return True
    return False

# ---------------------------------------------------------------------------
# NETWORK OPERATIONS & EXCEPTION HANDLING
# ---------------------------------------------------------------------------
def safe_ddg_search(query: str, timeout_sec=8) -> str:
    start_time = time.time()
    log_event("DDG_SEARCH", "STARTED", f"Query: '{query}'")
    try:
        with DDGS(timeout=timeout_sec) as ddgs:
            results = ddgs.text(clean_query_string(query), max_results=3)
            if results:
                res = "\n".join([r.get('body', '') for r in results])
                duration = round(time.time() - start_time, 2)
                log_event("DDG_SEARCH", "SUCCESS", f"Retrieved {len(res)} characters in {duration}s")
                return res
            else:
                log_event("DDG_SEARCH", "EMPTY", "Retrieved 0 results")
                return ""
    except Exception as e:
        log_event("DDG_SEARCH", "ERROR", f"Failed: {e}")
        return ""

def parse_llm_json(raw_text: str) -> dict:
    try:
        start = raw_text.find('{')
        end = raw_text.rfind('}')
        if start != -1 and end != -1:
            return json.loads(raw_text[start:end+1])
        return json.loads(raw_text)
    except Exception:
        return {"address": None, "zip_code": None, "parent": None, "dbas": [], "source_tier": 3}

def extract_umbrella_intel(context: str, company: str) -> dict:
    prompt = f"""
You are an elite B2B data auditor enforcing zero-trust data precision.
Analyze these search results for "{company}" in Springfield, Missouri.
Prioritize Tier 1 sources (Missouri SOS, City of Springfield licensing, verified root domain websites).

Extract strictly in valid JSON matching this schema:
{{
  "address": "Primary commercial street address in Springfield MO, or null",
  "zip_code": "5-digit ZIP code if verified in Springfield MO, or null",
  "parent": "Parent holding company or umbrella corporation, or null",
  "dbas": ["List of operating trade names, DBAs, or subsidiaries"],
  "source_tier": 1
}}
Source tier grading: 1 for government/official site, 2 for aggregator/LinkedIn, 3 for unverified/directories.

Search Context:
{context}
"""
    # 1. PRIMARY ENGINE: Google AI Studio (Gemini Models)
    for model_id in GEMINI_MODELS:
        start_time = time.time()
        log_event("GEMINI_QUERY", "ATTEMPT", f"Model: {model_id}")
        try:
            res = gemini_client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
                response_format={"type": "json_object"}
            )
            # Safe null-guard pattern to prevent NoneType attribute errors
            content = res.choices[0].message.content
            raw = (content or "").strip()
            if not raw:
                raise ValueError("Empty or null response payload received")
            
            duration = round(time.time() - start_time, 2)
            log_event("GEMINI_QUERY", "SUCCESS", f"{model_id} responded in {duration}s")
            return parse_llm_json(raw)
        except APITimeoutError:
            log_event("GEMINI_QUERY", "TIMEOUT", f"{model_id} hit HTTPX read timeout limit. Cycling...")
        except RateLimitError as e:
            log_event("GEMINI_QUERY", "RATELIMIT", f"{model_id} hit rate limit (429). Cycling...")
        except Exception as e:
            log_event("GEMINI_QUERY", "FAIL", f"{model_id} error: {str(e)[:100]}. Cycling...")

    # 2. SECONDARY ENGINE: OpenRouter Fallback Array
    for model_id in OR_MODELS:
        start_time = time.time()
        log_event("OR_QUERY", "ATTEMPT", f"Fallback Model: {model_id}")
        try:
            res = client.chat.completions.create(
                model=model_id,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1
            )
            content = res.choices[0].message.content
            raw = (content or "").strip()
            if not raw:
                raise ValueError("Empty or null response payload received")

            duration = round(time.time() - start_time, 2)
            log_event("OR_QUERY", "SUCCESS", f"{model_id} responded in {duration}s")
            return parse_llm_json(raw)
        except APITimeoutError:
            log_event("OR_QUERY", "TIMEOUT", f"{model_id} hit HTTPX read timeout limit. Cycling...")
        except Exception as e:
            log_event("OR_QUERY", "FAIL", f"{model_id} error: {str(e)[:100]}. Cycling...")
            
    log_event("LLM_QUERY", "FALLBACK", "All arrays failed. Returning default empty structure.")
    return {"address": None, "zip_code": None, "parent": None, "dbas": [], "source_tier": 3}

# ---------------------------------------------------------------------------
# MAIN EXECUTION
# ---------------------------------------------------------------------------
def main():
    if not CSV_PATH.exists():
        log_event("FATAL", "ERROR", f"CSV not found at {CSV_PATH}")
        sys.exit(1)

    df = pd.read_csv(CSV_PATH)
    total_rows = len(df)
    start_idx = get_last_checkpoint()

    master_records = []
    if start_idx > 0 and WORKSPACE_CSV_OUTPUT.exists():
        master_records = pd.read_csv(WORKSPACE_CSV_OUTPUT).to_dict('records')
        log_event("CSV_SYNC", "LOADED", f"Loaded {len(master_records)} records from master CSV")
    elif start_idx == 0:
        with open(SQL_OUTPUT, 'w', encoding='utf-8') as f:
            f.write("-- Zero-Trust DNC Seed Batch\n")
        log_event("SQL_INIT", "CREATED", f"Initialized fresh SQL file at {SQL_OUTPUT}")

    log_event("PIPELINE", "RUNNING", f"Total Records: {total_rows} | Starting at index: {start_idx + 1}")

    for idx in range(start_idx, total_rows):
        row = df.iloc[idx]
        company = str(row['Company']).strip()
        csv_zip = str(row['Zip Code']).strip() if pd.notna(row['Zip Code']) else ""

        log_event("RECORD", "PROCESSING", f"[{idx + 1}/{total_rows}] Auditing: '{company}'")

        query = f'"{company}" Springfield Missouri address street building suite'
        context = safe_ddg_search(query)
        
        if not context.strip():
            log_event("DDG_SEARCH", "FALLBACK", "Primary search empty. Trying broad fallback.")
            query = f'{company} Springfield MO'
            context = safe_ddg_search(query)

        if not context.strip() or not contains_address_signals(context):
            log_event("PRE_SCREEN", "SKIPPED", f"No address signals found for '{company}'. Skipping LLMs.")
            extracted = {"address": None, "zip_code": None, "parent": None, "dbas": [], "source_tier": 3}
        else:
            extracted = extract_umbrella_intel(context, company)

        resolved_zip = str(extracted.get('zip_code') or csv_zip).strip()
        # Zero-Trust Gate 1: Absolute Territorial Quarantine (Springfield City Limits Only)
        if not resolved_zip or resolved_zip not in VALID_ZIPS:
            log_event("QUARANTINE", "DROPPED", f"Company '{company}' dropped: ZIP '{resolved_zip}' missing or outside Springfield limits.")
            save_checkpoint(idx + 1)
            continue

        # Zero-Trust Gate 2: Physical Street Address Verification (Eliminate phantoms & residential noise)
        address_val = extracted.get('address')
        if not address_val or address_val == "null" or not contains_address_signals(address_val):
            log_event("QUARANTINE", "DROPPED", f"Company '{company}' dropped: lacks verified physical street address signals.")
            save_checkpoint(idx + 1)
            continue

        name_variations = {company}
        if extracted.get('parent'): name_variations.add(str(extracted['parent']).strip())
        if extracted.get('dbas'):
            for dba in extracted['dbas']:
                if isinstance(dba, str) and dba.strip(): name_variations.add(dba.strip())

        safe_addr = address_val.replace("'", "''")
        sql_address = f"'{safe_addr}'"
        sql_zip = f"'{resolved_zip}'"

        with open(SQL_OUTPUT, 'a', encoding='utf-8') as f:
            for name in name_variations:
                norm = normalize_name(name)
                if not norm: continue
                safe_name = name.replace("'", "''")
                f.write(
                    f"INSERT INTO do_not_contact (company_name, normalized_name, street_address, zip_code, exclusion_reason) "
                    f"VALUES ('{safe_name}', '{norm}', {sql_address}, {sql_zip}, 'ZERO_TRUST_DNC_IMPORT');\n"
                )
                
                master_records.append({
                    "Original_Company": company,
                    "Normalized_DBA_or_Parent": norm,
                    "Street_Address": address_val,
                    "Zip_Code": resolved_zip,
                    "Source_Tier": extracted.get('source_tier', 3),
                    "Exclusion_Reason": "ZERO_TRUST_DNC_IMPORT"
                })

        log_event("RECORD", "VERIFIED", f"Generated {len(name_variations)} DBA(s). Address: {address_val} | Tier: {extracted.get('source_tier', 3)}")

        save_checkpoint(idx + 1)
        pd.DataFrame(master_records).drop_duplicates().to_csv(WORKSPACE_CSV_OUTPUT, index=False)
        log_event("CSV_SYNC", "UPDATED", f"Saved master CSV checkpoint at index {idx + 1}")

        if idx + 1 < total_rows:
            sleep_time = BASE_SLEEP + random.uniform(0, 2)
            log_event("PACEMAKER", "SLEEPING", f"Pausing for {round(sleep_time, 2)}s before next record.")
            time.sleep(sleep_time)

    log_event("PIPELINE", "COMPLETE", "All records audited. Preparing chunked SQL deployment for Cloudflare D1...")
    deploy_chunked_sql(SQL_OUTPUT)

def deploy_chunked_sql(sql_file: Path):
    """Enforces strict statement chunking under the Cloudflare D1 100KB limit."""
    if not sql_file.exists():
        log_event("DEPLOY", "SKIPPED", f"No SQL file found at {sql_file}")
        return

    with open(sql_file, 'r', encoding='utf-8') as f:
        full_sql = f.read()

    # Split into clean statements
    raw_statements = [s.strip() for s in full_sql.split(';\n') if s.strip() and not s.strip().startswith('--')]
    if not raw_statements:
        log_event("DEPLOY", "EMPTY", "No SQL statements found to deploy.")
        return

    # Chunk into <= 25 statements and <= 80KB per batch to enforce D1 100KB payload limit
    batches = []
    current_batch = []
    current_bytes = 0
    MAX_BATCH_SIZE = 25
    MAX_BATCH_BYTES = 80000

    for stmt in raw_statements:
        stmt_sql = stmt + ';\n'
        stmt_len = len(stmt_sql.encode('utf-8'))
        if current_batch and (len(current_batch) >= MAX_BATCH_SIZE or (current_bytes + stmt_len) > MAX_BATCH_BYTES):
            batches.append(current_batch)
            current_batch = [stmt_sql]
            current_bytes = stmt_len
        else:
            current_batch.append(stmt_sql)
            current_bytes += stmt_len

    if current_batch:
        batches.append(current_batch)

    log_event("DEPLOY", "CHUNKING", f"Prepared {len(raw_statements)} statements across {len(batches)} sub-100KB batches.")

    repo_dir = Path(__file__).resolve().parent.parent
    env = os.environ.copy()
    env["CI"] = "true"
    env["WRANGLER_LOG"] = "error"

    for b_idx, batch in enumerate(batches, start=1):
        temp_batch_file = repo_dir / f"data/.temp_dnc_batch_{b_idx}.sql"
        try:
            with open(temp_batch_file, 'w', encoding='utf-8') as f:
                f.writelines(batch)

            batch_bytes = temp_batch_file.stat().st_size
            log_event("DEPLOY", "EXECUTING", f"Batch {b_idx}/{len(batches)} ({len(batch)} statements, {batch_bytes} bytes)...")

            deploy_cmd = [
                "node", "--max-old-space-size=4096",
                "--require", "./scripts/workerd-win-arm64-shim.cjs",
                "node_modules/wrangler/bin/wrangler.js",
                "d1", "execute", "legacy-db",
                "--remote", f"--file={temp_batch_file.as_posix()}",
                "--yes", "--json"
            ]
            result = subprocess.run(
                deploy_cmd,
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
                stdin=subprocess.DEVNULL,
                env=env,
                cwd=str(repo_dir)
            )
            log_event("DEPLOY", "SUCCESS", f"Batch {b_idx}/{len(batches)} successfully deployed to D1.")
        except subprocess.CalledProcessError as e:
            err_msg = e.stderr.strip() if e.stderr else str(e)
            log_event("DEPLOY", "ERROR", f"Batch {b_idx} failed: {err_msg[:120]}")
            break
        finally:
            if temp_batch_file.exists():
                try:
                    temp_batch_file.unlink()
                except Exception:
                    pass

if __name__ == "__main__":
    main()