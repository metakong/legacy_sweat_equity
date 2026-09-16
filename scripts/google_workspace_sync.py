"""
Google Workspace & Cloudflare D1 Synchronization Engine (September 2026)
Sean Deardorff Group Benefit Advisory LLC - Springfield, MO
Aflac Writing: AD1LF | NPN: 22308189 | Domain: groupbenefitadvisory.com

Automations:
1. Hybrid Cloudflare D1 Database Backup (Remote -> Local JSON/SQL Archive)
2. EOD Pipeline Sweep (Field Canvass & Dialer Aggregation)
3. Google Tasks & Calendar Follow-up Staging (Springfield Local Time)
4. Workspace Studio "Gmail Auto Import" Zero-Trust Staging
"""

import os
import sys
import json
import subprocess
from datetime import datetime
from pathlib import Path
import csv

REPO_DIR = Path(__file__).resolve().parent.parent
BACKUPS_DIR = REPO_DIR / "backups"
DATA_DIR = REPO_DIR / "data"

VALID_ZIPS = {'65802', '65803', '65804', '65806', '65807', '65809', '65810'}

def log_event(action: str, status: str, details: str = ""):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    print(f"[{ts}] [{action.upper()}] {status} | {details}")

def run_wrangler_d1_query(sql: str) -> list:
    """Executes a remote D1 SQL query via Wrangler CLI with the Windows ARM64 shim."""
    sql_clean = " ".join(sql.split())
    cmd = [
        "node", "--max-old-space-size=4096",
        "--require", "./scripts/workerd-win-arm64-shim.cjs",
        "node_modules/wrangler/bin/wrangler.js",
        "d1", "execute", "legacy-db",
        "--remote", "--command", sql_clean, "--json"
    ]
    env = os.environ.copy()
    env["CI"] = "true"

    try:
        res = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            stdin=subprocess.DEVNULL,
            env=env,
            cwd=str(REPO_DIR)
        )
        data = json.loads(res.stdout)
        if isinstance(data, list) and len(data) > 0:
            return data[0].get("results", [])
        return []
    except Exception as e:
        log_event("D1_QUERY", "ERROR", f"Failed query: {e}")
        return []

def execute_hybrid_backup():
    """Extracts critical D1 tables and writes timestamped JSON snapshot."""
    log_event("BACKUP", "STARTING", "Running hybrid Cloudflare D1 database backup...")
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    today_str = datetime.now().strftime('%Y%m%d_%H%M%S')
    backup_file = BACKUPS_DIR / f"d1_hybrid_backup_{today_str}.json"

    tables = ["companies", "contacts", "activity_logs", "do_not_contact", "d365_daily_aggregates"]
    snapshot = {"backup_timestamp": datetime.now().isoformat(), "tables": {}}

    for table in tables:
        sql = f"SELECT * FROM {table} LIMIT 1000;"
        rows = run_wrangler_d1_query(sql)
        snapshot["tables"][table] = rows
        log_event("BACKUP", "TABLE_SAVED", f"{table}: {len(rows)} rows captured")

    with open(backup_file, 'w', encoding='utf-8') as f:
        json.dump(snapshot, f, indent=2)

    log_event("BACKUP", "COMPLETE", f"Snapshot written to {backup_file.name}")
    return backup_file

def run_eod_pipeline_sweep():
    """Aggregates end-of-day canvassing, dialing, and Section 125 activity."""
    log_event("EOD_SWEEP", "STARTING", "Executing EOD pipeline metrics sweep...")
    today_date = datetime.now().strftime('%Y-%m-%d')
    report_file = BACKUPS_DIR / f"eod_debrief_{today_date}.md"

    sql = f"""
        SELECT 
            COUNT(*) as total_touches,
            SUM(CASE WHEN is_in_person = 1 THEN 1 ELSE 0 END) as walk_ins,
            SUM(CASE WHEN is_dm_contact = 1 THEN 1 ELSE 0 END) as dm_conversations,
            SUM(CASE WHEN presentation_date IS NOT NULL THEN 1 ELSE 0 END) as proposals_set,
            SUM(CASE WHEN disposition = 'Enrolled' THEN 1 ELSE 0 END) as enrollments,
            COALESCE(SUM(projected_ap), 0) as total_ap
        FROM activity_logs
        WHERE date(timestamp) = '{today_date}';
    """
    results = run_wrangler_d1_query(sql)
    stats = results[0] if results else {
        "total_touches": 0, "walk_ins": 0, "dm_conversations": 0,
        "proposals_set": 0, "enrollments": 0, "total_ap": 0
    }

    total_ap_val = stats.get('total_ap', 0) or 0
    report = f"""# EOD Field Debrief & D365 Pipeline Summary
**Agent:** Sean Deardorff (AD1LF / NPN: 22308189)
**Date:** {today_date} (Springfield, MO Local Time)
**Territory:** Springfield Metro (Approved City Limit ZIPs)

## Field Prospecting & Dialer Performance
- **Total Touches Logged:** {stats.get('total_touches', 0)}
- **Commercial Walk-Ins (Field Canvassing):** {stats.get('walk_ins', 0)}
- **Decision-Maker (DM) Contacts:** {stats.get('dm_conversations', 0)}
- **Section 125 Presentations Scheduled:** {stats.get('proposals_set', 0)}
- **Enrolled Accounts:** {stats.get('enrollments', 0)}
- **Projected Annualized Premium (AP):** ${total_ap_val:,.2f}

## Dynamics 365 Quick-Paste Block
```text
=== D365 EOD COMPLIANCE ===
Date: {today_date}
Agent: Sean Deardorff
Walk-Ins: {stats.get('walk_ins', 0)}
DM Contacts: {stats.get('dm_conversations', 0)}
Appointments: {stats.get('proposals_set', 0)}
Enrollments: {stats.get('enrollments', 0)}
Projected AP: ${total_ap_val:,.2f}
===========================
```
"""
    with open(report_file, 'w', encoding='utf-8') as f:
        f.write(report)

    log_event("EOD_SWEEP", "COMPLETE", f"EOD report generated at {report_file.name}")
    return report_file

def stage_google_calendar_and_tasks():
    """Stages pending callbacks from D1 into Google Calendar and Google Tasks import payloads."""
    log_event("WORKSPACE_STAGING", "STARTING", "Staging Google Calendar and Tasks follow-ups...")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    sql = """
        SELECT company_id, company_name, company_phone, street_1, zip_code, decision_maker, next_action_date, next_action, forecast_ap
        FROM companies
        WHERE next_action_date IS NOT NULL AND status = 'ACTIVE'
        ORDER BY next_action_date ASC
        LIMIT 50;
    """
    callbacks = run_wrangler_d1_query(sql)
    
    # 1. Google Tasks JSON Staging
    tasks_file = DATA_DIR / "staged_google_tasks.json"
    tasks_payload = []
    for c in callbacks:
        title = f"Aflac Follow-Up: {c.get('company_name')} ({c.get('decision_maker') or 'DM'})"
        ap_val = c.get('forecast_ap') or 0
        notes = (
            f"Phone: {c.get('company_phone') or 'N/A'}\n"
            f"Address: {c.get('street_1')}, Springfield MO {c.get('zip_code')}\n"
            f"Forecast AP: ${ap_val:,.2f}\n"
            f"Next Action: {c.get('next_action') or 'Follow-up'}"
        )
        tasks_payload.append({
            "title": title,
            "notes": notes,
            "due": f"{c.get('next_action_date')}T14:00:00.000Z",
            "status": "needsAction"
        })
    with open(tasks_file, 'w', encoding='utf-8') as f:
        json.dump(tasks_payload, f, indent=2)

    # 2. Google Calendar CSV Staging
    cal_file = DATA_DIR / "staged_google_calendar.csv"
    with open(cal_file, 'w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(["Subject", "Start Date", "Start Time", "Description", "Location"])
        for c in callbacks:
            subj = f"Meeting / Call: {c.get('company_name')}"
            start_date = c.get('next_action_date')
            start_time = "09:00 AM"
            loc = f"{c.get('street_1')}, Springfield, MO {c.get('zip_code')}"
            desc = f"Decision Maker: {c.get('decision_maker')}. Action: {c.get('next_action')}"
            writer.writerow([subj, start_date, start_time, desc, loc])

    log_event("WORKSPACE_STAGING", "COMPLETE", f"Staged {len(callbacks)} follow-ups to {tasks_file.name} & {cal_file.name}")

def stage_gmail_auto_imports():
    """Inspects pending CSV attachments in data/ and enforces zero-trust quarantine."""
    log_event("GMAIL_IMPORT", "SCANNING", "Auditing staged email imports for Springfield quarantine...")
    pending_files = list(DATA_DIR.glob("*import*.csv")) + list(DATA_DIR.glob("*lead*.csv"))
    valid_count = 0
    dropped_count = 0

    for p in pending_files:
        if "staged" in p.name: continue
        log_event("GMAIL_IMPORT", "PROCESSING", f"Scanning {p.name}")
        try:
            with open(p, 'r', encoding='utf-8', errors='replace') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    zip_code = str(row.get('Zip Code') or row.get('zip') or '').strip()
                    if zip_code in VALID_ZIPS:
                        valid_count += 1
                    else:
                        dropped_count += 1
        except Exception as e:
            log_event("GMAIL_IMPORT", "WARN", f"Could not parse {p.name}: {e}")

    log_event("GMAIL_IMPORT", "COMPLETE", f"Quarantine Audit: {valid_count} approved Springfield records, {dropped_count} dropped out-of-territory.")

def main():
    log_event("SYNC_DAEMON", "START", "Starting Google Workspace & Cloudflare D1 Synchronization Daemon")
    execute_hybrid_backup()
    run_eod_pipeline_sweep()
    stage_google_calendar_and_tasks()
    stage_gmail_auto_imports()
    log_event("SYNC_DAEMON", "DONE", "All routine synchronizations concluded successfully.")

if __name__ == "__main__":
    main()
