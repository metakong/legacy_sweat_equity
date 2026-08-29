-- =====================================================================
-- ARCHIVE — Legacy Sweat Equity (B2C roofing) production D1
-- Captured 2026-08-29 immediately before the B2B pivot migration.
--
-- Source: Cloudflare D1 `legacy-db` (847928be-c56f-4de4-bff4-083e08db9140)
-- Contents: 6 canvassers, 17 properties, 3 leads, 38 insights.
--
-- This exists so `schema.sql`'s DROP statements are reversible. To restore,
-- run this against an EMPTY database — it recreates the retired roofing
-- schema and every row that was live at capture time.
--
-- Notes on what is actually here:
--   * Most rows are the demo dataset seeded 2026-07-21 (ids prefixed `demo-`).
--   * Two properties are genuine field entries logged by rep103 on Sarah Ct,
--     Willard MO — the only non-demo prospect records.
--   * 37 of the 38 insights rows are empty-day cron output ("No properties
--     logged today"); only 2026-07-21 has real numbers.
-- =====================================================================

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS canvassers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS properties (
  id TEXT PRIMARY KEY,
  address TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  lat REAL,
  lng REAL,
  canvasser_id TEXT,
  photo_key TEXT,
  voice_transcript TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (canvasser_id) REFERENCES canvassers(id)
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  preferred_time TEXT NOT NULL,
  status TEXT DEFAULT 'Pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (property_id) REFERENCES properties(id)
);

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  date TEXT UNIQUE NOT NULL,
  extracted_actions TEXT,
  golden_hour_stats TEXT,
  dopamine_summary TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- canvassers (6)
-- ---------------------------------------------------------------------
INSERT INTO canvassers (id, name, phone, created_at) VALUES
('rep101','John Doe','5550101','2026-07-21 13:01:14'),
('rep102','Sarah Smith','5550102','2026-07-21 13:01:14'),
('rep103','Mike Springfield','5550103','2026-07-21 13:01:14'),
('demo-sean-dogfood-001','Sean Dogfood','(417) 555-0101','2026-07-01 12:00:00'),
('demo-jay-dogfood-002','Jay Dogfood','(417) 555-0102','2026-07-01 12:00:00'),
('demo-ben-dogfood-003','Ben Dogfood','(417) 555-0103','2026-07-01 12:00:00');

-- ---------------------------------------------------------------------
-- properties (17)
-- ---------------------------------------------------------------------
INSERT INTO properties (id, address, status, lat, lng, canvasser_id, photo_key, voice_transcript, created_at, updated_at) VALUES
('demo-prop-013','819 W Commercial St, Springfield, MO 65803','Not Home',37.2162,-93.3089,'demo-sean-dogfood-001',NULL,NULL,'2026-07-21 15:30:00','2026-07-21 15:30:00'),
('demo-prop-006','2816 W Republic Rd, Springfield, MO 65807','Not Home',37.1931,-93.3289,'demo-sean-dogfood-001',NULL,NULL,'2026-07-21 16:20:00','2026-07-21 16:20:00'),
('42dc7fc6-09a4-4cbf-8497-bcec9a576e9e','606 Sarah Ct., Willard, MO','Not Home',37.2955337,-93.4211112,'rep103',NULL,'No answer','2026-07-21 18:28:54','2026-07-21 18:28:54'),
('ee3a49d9-2c6a-4e6e-aef5-91a52991686f','619 Sarah Ct, Willard, MO 65781','Not Home',37.2955337,-93.4211112,'rep103',NULL,NULL,'2026-07-21 18:31:50','2026-07-21 18:31:50'),
('demo-prop-010','567 S Fort Ave, Springfield, MO 65806','Not Home',37.2109,-93.3012,'demo-ben-dogfood-003',NULL,NULL,'2026-07-21 18:45:00','2026-07-21 18:45:00'),
('demo-prop-003','742 W Battlefield Rd, Springfield, MO 65807','Not Home',37.1908,-93.3195,'demo-ben-dogfood-003',NULL,NULL,'2026-07-21 19:10:00','2026-07-21 19:10:00'),
('demo-prop-014','1523 S Jefferson Ave, Springfield, MO 65806','Competitor Active',37.2072,-93.2921,'demo-jay-dogfood-002',NULL,'HomeAdvisor sign posted out front. Neighbor said the Hendersons just got their estimate done last week. Roof clearly needs work but they''re mid-process. Check back in 30 days if deal falls through.','2026-07-21 19:30:00','2026-07-21 19:30:00'),
('demo-prop-007','938 E Walnut St, Springfield, MO 65806','Competitor Active',37.2174,-93.2762,'demo-ben-dogfood-003',NULL,'Storm Guard sign in the yard, they''ve already been here. Lady at the door said they''re waiting on an insurance adjuster next week. Noted for follow-up — if Storm Guard lowballs them we have a shot. Nice neighborhood, lots of mature trees.','2026-07-21 20:15:00','2026-07-21 20:15:00'),
('demo-prop-005','4521 S Glenstone Ave, Springfield, MO 65804','Obvious Damage',37.1812,-93.2534,'demo-jay-dogfood-002',NULL,'Two layers of shingles already on this roof, dipping in the middle section, looks like decking issues underneath. Fence blown over in the backyard. Guy named Rick answered, says he''s been meaning to get it checked. Left business card.','2026-07-21 20:45:00','2026-07-21 20:45:00'),
('demo-prop-012','4102 E Division St, Springfield, MO 65809','Obvious Damage',37.2207,-93.2401,'demo-jay-dogfood-002',NULL,'Rental property, looks like it hasn''t been touched in 15 years. Called number on the lockbox, left voicemail for property owner. Address listed to a Greg Patterson. Strong candidate for full replacement.','2026-07-21 21:00:00','2026-07-21 21:00:00'),
('demo-prop-002','3219 S National Ave, Springfield, MO 65807','Obvious Damage',37.1889,-93.2982,'demo-jay-dogfood-002',NULL,'Massive granule loss on the back slope, visible missing shingles near the ridge. Nobody home but left door hanger. Fascia is rotting on the east side too. This one''s going to need a full replacement easy.','2026-07-21 21:30:00','2026-07-21 21:30:00'),
('demo-prop-015','3677 W Battlefield Rd, Springfield, MO 65807','Appointment Set',37.1908,-93.3421,'demo-ben-dogfood-003',NULL,'Robert and Linda Marsh, both in their 60s. Storm damage from the June hailstorm, clearly visible dents on ridge cap and metal vents. Insurance claim already filed and approved for $18,400. They just need a contractor — THIS IS A HAND-OFF. Set for Friday 11am.','2026-07-21 22:00:00','2026-07-21 22:00:00'),
('demo-prop-001','1847 E Sunshine St, Springfield, MO 65804','Appointment Set',37.1976,-93.2645,'demo-sean-dogfood-001',NULL,'Homeowner Mark Johnson, mid-50s, definitely interested. Hail damage visible on the north face from the May storm. His neighbor Dave already signed with us. Callback preferred Tuesday morning, wife works from home.','2026-07-21 22:15:00','2026-07-21 22:15:00'),
('demo-prop-008','1650 N Kansas Expy, Springfield, MO 65803','Appointment Set',37.2381,-93.3142,'demo-jay-dogfood-002',NULL,'Apartment complex property manager, Tony Reyes. Said they manage six units here and two on Cherry. Has been unhappy with their current vendor. Wants a bid for all three properties — THIS COULD BE HUGE. Set for Wednesday 2pm at his office.','2026-07-21 22:30:00','2026-07-21 22:30:00'),
('demo-prop-004','1124 N Campbell Ave, Springfield, MO 65651','Appointment Set',37.2248,-93.2927,'demo-sean-dogfood-001',NULL,'Patricia Williams, retired school teacher. Very warm, offered coffee. Her roof is 18 years old and she''s been putting off replacement. Insurance already told her she needs to act by end of August or they''re dropping her. SET FOR THURSDAY 10AM — huge opportunity.','2026-07-21 22:45:00','2026-07-21 22:45:00'),
('demo-prop-009','3305 W Chestnut Expy, Springfield, MO 65802','Obvious Damage',37.2153,-93.3341,'demo-sean-dogfood-001',NULL,'Corner lot, roof is completely toast. Missing shingles, visible black spots, downspout hanging off the east wall. Elderly gentleman James, said he''s been getting leaks in his living room for two months. Daughter handles his finances, got her number 417-555-0288.','2026-07-21 23:10:00','2026-07-21 23:10:00'),
('demo-prop-011','2234 W Grand St, Springfield, MO 65802','Appointment Set',37.2198,-93.3178,'demo-ben-dogfood-003',NULL,'Young couple, first-time homeowners — Alex and Megan Torres. Super engaged, took our brochure, asked smart questions about the GAF warranty. Their realtor told them the roof was fine at closing but they see granules in the gutters. Set for Saturday 9am — they both have the day off.','2026-07-21 23:45:00','2026-07-21 23:45:00');

-- ---------------------------------------------------------------------
-- leads (3)
-- ---------------------------------------------------------------------
INSERT INTO leads (id, property_id, owner_name, owner_phone, preferred_time, status, created_at) VALUES
('demo-lead-001','demo-prop-001','Sarah Johnson','(417) 555-0234','Morning','Pending','2026-07-21 23:32:00'),
('demo-lead-002','demo-prop-015','Linda Marsh','(417) 555-0187','Morning','Pending','2026-07-21 23:58:00'),
('demo-lead-003','demo-prop-004','Patricia Williams','(417) 555-0312','Morning','Pending','2026-07-22 00:11:00');

-- ---------------------------------------------------------------------
-- insights (38) — the only row with real numbers is 2026-07-21.
-- ---------------------------------------------------------------------
INSERT INTO insights (id, date, extracted_actions, golden_hour_stats, dopamine_summary, created_at) VALUES
('a423976d-a78e-4acb-847a-66bfb01b4ecd','2026-07-21','[]','{"total_doors":17,"dispositions":{"Not Home":6,"Competitor Active":2,"Obvious Damage":4,"Appointment Set":5},"golden_hour":"16:00","success_ratio":"1.00","timezone":"America/Chicago"}','Great work hitting 17 doors today! Every knock brings us closer to a win. Keep pushing.','2026-07-22 02:00:10');

-- The remaining 37 rows are identical empty-day cron output. Reconstructed
-- from their (id, date, created_at) triples; the three payload columns were
-- byte-identical across all of them.
INSERT INTO insights (id, date, extracted_actions, golden_hour_stats, dopamine_summary, created_at) VALUES
('eb69440b-c3ce-4bcf-8749-850dccc38e3f','2026-07-22','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-23 02:00:02'),
('b415b2cd-407d-4d0d-ab14-83cf2397f109','2026-07-23','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-24 02:00:02'),
('2b32efb1-4b9f-4345-a1df-88c435300e8f','2026-07-24','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-25 02:00:02'),
('b7230c5f-6f32-4fc7-a8c9-590cd2ff11f1','2026-07-25','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-26 02:00:01'),
('ac163343-e89a-41e7-8919-002782b735f6','2026-07-26','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-27 02:00:59'),
('ab9e9d33-3e1d-4d21-aa1d-ab99e13a0576','2026-07-27','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-28 02:01:00'),
('6f0e6d72-966e-4cd1-b6a9-9b5189d3c51e','2026-07-28','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-29 02:00:59'),
('eed970a6-a873-4bab-aeb3-d5e02a222d36','2026-07-29','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-30 02:00:59'),
('0946f9ae-c653-4195-9e0e-d16c0d0bd52e','2026-07-30','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-07-31 02:00:59'),
('513e8ded-0e78-42a0-bc3c-1fe259530646','2026-07-31','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-01 02:00:47'),
('58a3599e-bff1-4cda-af38-de2504c6e31d','2026-08-01','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-02 02:00:47'),
('72cac722-7826-4b2b-8be5-f2f89a853871','2026-08-02','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-03 02:00:56'),
('6ce8f2ed-0b94-41a3-be42-bc9fdae47df6','2026-08-03','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-04 02:00:56'),
('d564a878-c546-498a-86e4-53165c7d49de','2026-08-04','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-05 02:00:52'),
('6e25ac98-d2e3-4c24-8902-83737c28135f','2026-08-06','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-07 02:00:15'),
('e182a038-0ac2-46af-8662-e9274e7908d8','2026-08-07','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-08 02:00:21'),
('5e3cddd7-61f9-44ed-bc82-5dc1d6b12403','2026-08-08','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-09 02:00:16'),
('28d42965-5d9e-41c5-b0d9-6d9b422c2d0e','2026-08-09','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-10 02:00:16'),
('c78e6d02-1a19-4c10-9369-ccb45af814b3','2026-08-10','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-11 02:00:11'),
('950248dc-be99-40db-9e40-a9958155c215','2026-08-11','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-12 02:00:09'),
('b270b278-c8d0-4a09-8a97-0943a855f5ee','2026-08-12','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-13 02:01:07'),
('d211b45f-c3d0-4389-9ad6-33ffa848b773','2026-08-13','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-14 02:00:56'),
('adbac3d2-53ba-4f80-9db6-73151baaef4e','2026-08-14','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-15 02:00:57'),
('419605ee-08dc-402f-a9e9-4b9f9d659528','2026-08-15','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-16 02:00:56'),
('7fde89c1-6750-4bdc-a8cc-d479618589cd','2026-08-16','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-17 02:00:56'),
('be693516-f596-48da-b9af-3183d98691a7','2026-08-17','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-18 02:00:54'),
('8392d493-a7b9-4afb-a961-80650e235f91','2026-08-18','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-19 02:00:54'),
('16e13cf7-48b9-4f80-8021-98a28aa9cdcf','2026-08-19','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-20 02:00:55'),
('cf540667-3638-4f36-b000-9058da2150c5','2026-08-20','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-21 02:00:30'),
('9466ca26-7c84-4194-86c3-1c373568391b','2026-08-21','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-22 02:00:28'),
('47645fac-312d-4908-87ca-0a41dd7c3be7','2026-08-22','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-23 02:00:28'),
('ae4fdcfe-1fcf-4f1a-ba22-e0e5fbe45f79','2026-08-23','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-24 02:00:27'),
('7dad69aa-cf50-4c4d-88ee-b4d26e9cc6d5','2026-08-24','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-25 02:00:28'),
('e553f63d-9df3-4e3e-bf2c-c874f2e9ef7d','2026-08-25','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-26 02:00:27'),
('517cd22a-b693-4e4c-b46d-623af59dffa8','2026-08-26','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-27 02:00:16'),
('8898d901-26b1-447c-a866-0052e64599f0','2026-08-27','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-28 02:00:30'),
('d0362e53-c756-4024-a265-913b36e3d53d','2026-08-28','[]','{"total_doors":0,"dispositions":{},"golden_hour":"N/A","success_ratio":"0.00"}','No properties logged today. Take rest, ready up for tomorrow!','2026-08-29 02:01:00');

CREATE INDEX IF NOT EXISTS idx_properties_created_at ON properties(created_at);
CREATE INDEX IF NOT EXISTS idx_properties_updated_at ON properties(updated_at);
CREATE INDEX IF NOT EXISTS idx_properties_canvasser_id ON properties(canvasser_id);
CREATE INDEX IF NOT EXISTS idx_leads_property_id ON leads(property_id);
CREATE INDEX IF NOT EXISTS idx_leads_status_created ON leads(status, created_at);

PRAGMA foreign_keys = ON;
