#!/usr/bin/env python3
"""
Parse leads.md and sync it into the field prospecting CRM.

Replaces ingest_leads.py + enrich_leads.py, which were two near-identical
parsers pointed at the same endpoint. Running both is what produced 91
duplicate company rows on 2026-09-01:

  * ingest_leads.py minted a client-side uuid4() for every record, which
    guaranteed the server saw a net-new company_id and could never merge;
  * enrich_leads.py sent notes with no street, and the server's dedupe guard
    refused to even look for a match without one;
  * both sent all 63 targets in one request, which the server silently
    truncated to 50 — 13 targets vanished with no error.

The server side is fixed (src/lib/match.js resolves identity across several
tiers, and the batch cap now reports its overflow). This script is the client
half: it sends canonical field names, sends no invented ids, batches under the
cap, and prints what the server actually did with each pass.

Usage:
    export CF_ACCESS_TOKEN="<CF_Authorization cookie value>"
    python sync_leads.py [--dry-run] [--url https://legacysweatequity.com]

The token is read from the environment. It is a bearer credential for the
agent's live CRM and must never be written into a file.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "https://legacysweatequity.com"
BATCH_SIZE = 100          # server cap is 250; smaller batches fail smaller

# Titles that appear where a person's name is expected. These describe a role
# the agent has not yet put a name to, so they become a job_title with no name
# rather than a contact called "HR Director".
ROLE_ONLY = re.compile(
    r"^(hr|human resources|office|general|store|branch|regional)?\s*"
    r"(director|manager|owner|president|administrator|supervisor|staff|receptionist)\b",
    re.I,
)
NON_CONTACT = re.compile(r"needs verification|unknown|tbd|unspecified|in-person", re.I)


def split_people(raw):
    """Split a Decision Maker line into individual people."""
    cleaned = raw.strip().rstrip(".").replace("\\", "")
    if not cleaned or NON_CONTACT.search(cleaned):
        return []
    # "Chad Faught (Sales Consultant), Troy Bacon (Marketing)" -> two people.
    # "Ken / Marcus Burk" and "Derrick and Tina" -> two people. Commas inside
    # "(...)" belong to a job title and are left alone.
    parts = re.split(r",(?![^(]*\))|\s+/\s+|\s+and\s+|\s+&\s+", cleaned)
    return [p.strip() for p in parts if p.strip()]


def parse_person(text):
    """Turn "Theresa Bagwell (President)" into a contact dict."""
    title = None
    m = re.search(r"\(([^)]*)\)", text)
    if m:
        title = m.group(1).strip() or None
        text = text[: m.start()].strip()
    text = text.strip().rstrip(".,").strip()

    if not text:
        return {"job_title": title} if title else None

    if ROLE_ONLY.match(text) and " " not in text.strip().rstrip("."):
        return {"job_title": title or text}
    if ROLE_ONLY.match(text) and not re.search(r"[A-Z][a-z]+\s+[A-Z]", text):
        # "HR Director" / "Office Manager" — a role, not a person.
        return {"job_title": title or text}

    words = text.split()
    first = words[0]
    last = " ".join(words[1:]) if len(words) > 1 else None
    person = {"first_name": first}
    if last:
        person["last_name"] = last
    if title:
        person["job_title"] = title
    return person


def parse_address(address_str):
    """
    Split "636-A N. Miller, Springfield, MO 65802" into components.

    A value with no digits ("Springfield Area", "Ozark Corporate HQ") is a note
    the agent left himself, not an address. It is returned as `locality_note`
    so it lands in `notes` instead of poisoning street_1 and the map pin.
    """
    parts = [p.strip() for p in address_str.split(",") if p.strip()]
    if not parts:
        return {}, None
    if not any(ch.isdigit() for ch in parts[0]):
        return {}, address_str.strip()

    out = {"street_1": parts[0]}
    if len(parts) > 1:
        out["city"] = parts[1]
    if len(parts) > 2:
        bits = parts[2].split()
        if bits:
            out["state"] = bits[0]
        if len(bits) > 1:
            out["zip_code"] = bits[1]
    return out, None


def parse_markdown(path):
    with open(path, encoding="utf-8") as fh:
        content = fh.read()

    companies = []
    for block in re.split(r"> \d+\.\s+\*\*", content)[1:]:
        header = block.split("\n")[0].strip()
        name = header.split("**")[0].strip()
        if not name:
            continue

        # No client-side company_id. The server resolves identity; inventing a
        # uuid here is precisely what forced 41 unnecessary inserts.
        company = {"company_name": name}
        locality_note = None

        if "|" in header:
            fields, locality_note = parse_address(header.split("|", 1)[1].strip())
            company.update(fields)

        dm_match = re.search(r"\*\s+\*\*Decision Maker:\*\*\s+(.*?)\n", block)
        dm_raw = dm_match.group(1).strip() if dm_match else ""
        people = [p for p in (parse_person(t) for t in split_people(dm_raw)) if p]

        contact_match = re.search(r"\*\s+\*\*Contact Info:\*\*\s+(.*?)\n", block)
        emails = []
        if contact_match:
            info = contact_match.group(1).strip()
            phone = re.search(r"[(]?\d{3}[)]?[\s.-]?\d{3}[\s.-]?\d{4}", info)
            if phone:
                company["company_phone"] = phone.group(0)
            # rstrip('.') so a sentence-final period does not become part of
            # the address: "JSNOW@BIGWHISKEYS.COM." is not an email.
            emails = [e.rstrip(".") for e in re.findall(r"[\w.+-]+@[\w-]+\.[\w.]+", info)]

        for person, email in zip(people, emails):
            person["email_address"] = email
        if people:
            people[0]["is_primary_dm"] = True
            company["contacts"] = people
            company["decision_maker"] = dm_raw.rstrip(".")

        strat = re.search(r"\*\s+\*\*CRM Strategy:\*\*\s+(.*?)(?=\n>|$)", block, re.DOTALL)
        note_parts = []
        if locality_note:
            note_parts.append(f"Location: {locality_note}")
        if strat:
            note_parts.append(strat.group(1).strip().replace("\\-", "-"))
        if note_parts:
            company["notes"] = "\n".join(note_parts)

        companies.append(company)
    return companies


def post_batch(url, token, batch):
    payload = json.dumps({"companies": batch}).encode("utf-8")
    req = urllib.request.Request(f"{url}/api/companies/import", data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Cookie", f"CF_Authorization={token}")
    # Same-origin headers: the Worker's CSRF middleware rejects cross-origin writes.
    req.add_header("Origin", url)
    req.add_header("Referer", f"{url}/app/")
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {err.code} from {url}: {detail}")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--file", default="leads.md")
    ap.add_argument("--dry-run", action="store_true", help="parse and write JSON, send nothing")
    args = ap.parse_args()

    companies = parse_markdown(args.file)
    print(f"Parsed {len(companies)} targets from {args.file}.")

    with open("parsed_leads.json", "w", encoding="utf-8") as fh:
        json.dump(companies, fh, indent=2)
    print("Wrote parsed_leads.json for review.")

    if args.dry_run:
        with_street = sum(1 for c in companies if c.get("street_1"))
        with_dm = sum(1 for c in companies if c.get("contacts"))
        print(f"Dry run: {with_street} with a street, {with_dm} with a decision maker. Nothing sent.")
        return

    token = os.environ.get("CF_ACCESS_TOKEN")
    if not token:
        raise SystemExit(
            "CF_ACCESS_TOKEN is not set.\n"
            "  Get it from the CF_Authorization cookie on legacysweatequity.com, then:\n"
            '    export CF_ACCESS_TOKEN="<value>"'
        )

    totals = {"received": 0, "created": 0, "merged": 0, "contacts": 0}
    problems = []
    for i in range(0, len(companies), BATCH_SIZE):
        batch = companies[i : i + BATCH_SIZE]
        result = post_batch(args.url, token, batch)
        for key in totals:
            totals[key] += result.get(key, 0)
        problems.extend(result.get("skipped", []))
        problems.extend(result.get("ambiguous", []))
        if result.get("not_processed"):
            problems.append({"company_name": "(batch overflow)", "reason": result["not_processed"]})
        print(f"  batch {i // BATCH_SIZE + 1}: created={result.get('created')} merged={result.get('merged')}")

    print(
        f"\nDone. received={totals['received']} "
        f"created={totals['created']} merged={totals['merged']} contacts={totals['contacts']}"
    )
    if problems:
        print(f"\n{len(problems)} target(s) need attention:")
        for p in problems:
            print(f"  - {p.get('company_name')}: {p.get('reason')}")
        sys.exit(1)


if __name__ == "__main__":
    main()
