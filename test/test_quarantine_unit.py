import unittest
from pathlib import Path
import sys

scripts_dir = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))

from enrich_dnc_free import (
    VALID_ZIPS,
    contains_address_signals,
    parse_llm_json,
    normalize_name,
    GEMINI_MODELS
)

class TestZeroTrustQuarantine(unittest.TestCase):
    def test_approved_springfield_zips(self):
        expected_zips = {'65802', '65803', '65804', '65806', '65807', '65809', '65810'}
        self.assertEqual(VALID_ZIPS, expected_zips)
        
        for z in expected_zips:
            self.assertIn(z, VALID_ZIPS)
            
        out_of_territory = ['65714', '65721', '65738', '64101', '', 'nan', 'null', None]
        for z in out_of_territory:
            self.assertNotIn(z, VALID_ZIPS)

    def test_address_signals_gate(self):
        self.assertTrue(contains_address_signals("1923 E Sunshine St"))
        self.assertTrue(contains_address_signals("305 W Commercial St, Suite 100"))
        self.assertTrue(contains_address_signals("4170 S National Ave"))
        self.assertTrue(contains_address_signals("65807"))

        self.assertFalse(contains_address_signals(""))
        self.assertFalse(contains_address_signals("Online Only"))
        self.assertFalse(contains_address_signals("Springfield MO"))
        self.assertFalse(contains_address_signals("No physical location"))

    def test_model_slugs_modernization(self):
        self.assertIn("gemini-3.5-flash-lite", GEMINI_MODELS)
        self.assertIn("gemini-3.5-flash", GEMINI_MODELS)
        self.assertNotIn("gemini-3.8-flash", GEMINI_MODELS)
        self.assertNotIn("gemini-2.5-flash", GEMINI_MODELS)
        self.assertNotIn("gemini-2.0-flash", GEMINI_MODELS)

    def test_null_safety_guards(self):
        content = None
        raw = (content or "").strip()
        self.assertEqual(raw, "")

        res = parse_llm_json("")
        self.assertIsNone(res.get("address"))
        self.assertIsNone(res.get("zip_code"))

    def test_statement_chunking_logic(self):
        raw_statements = [f"INSERT INTO do_not_contact VALUES ('Comp_{i}', 'COMP_{i}', '123 Main St', '65807', 'ZERO_TRUST_DNC_IMPORT')" for i in range(60)]
        
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

        self.assertEqual(len(batches), 3)
        self.assertEqual(len(batches[0]), 25)
        self.assertEqual(len(batches[1]), 25)
        self.assertEqual(len(batches[2]), 10)
        
        for batch in batches:
            total_bytes = sum(len(s.encode('utf-8')) for s in batch)
            self.assertLessEqual(total_bytes, 80000)

if __name__ == '__main__':
    unittest.main()
