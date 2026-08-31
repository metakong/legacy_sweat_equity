const fs = require('fs');

let content = fs.readFileSync('src/lib/db.js', 'utf8');

// 1. upsertCompany
content = content.replace('export async function upsertCompany(db, company) {', 'export async function upsertCompany(db, company, userEmail) {');
content = content.replace('is_d365_synced\n    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'is_d365_synced, agent_email\n    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
content = content.replace('ON CONFLICT(company_id) DO UPDATE SET', 'ON CONFLICT(company_id, agent_email) DO UPDATE SET');
content = content.replace('company.is_d365_synced ?? 0\n  ).run();', 'company.is_d365_synced ?? 0,\n    userEmail\n  ).run();');

// 2. setCompanyRating
content = content.replace('export async function setCompanyRating(db, companyId, rating) {', 'export async function setCompanyRating(db, companyId, rating, userEmail) {');
content = content.replace('UPDATE companies SET rating = ? WHERE company_id = ?', 'UPDATE companies SET rating = ? WHERE company_id = ? AND agent_email = ?');
content = content.replace(').bind(rating, companyId).run();', ').bind(rating, companyId, userEmail).run();');

// 3. setCompanyRenewalDate
content = content.replace('export async function setCompanyRenewalDate(db, companyId, renewalDate) {', 'export async function setCompanyRenewalDate(db, companyId, renewalDate, userEmail) {');
content = content.replace('UPDATE companies SET renewal_date = ? WHERE company_id = ?', 'UPDATE companies SET renewal_date = ? WHERE company_id = ? AND agent_email = ?');
content = content.replace(').bind(renewalDate, companyId).run();', ').bind(renewalDate, companyId, userEmail).run();');

// 4. autoAdvancePipelineStage
content = content.replace("export async function autoAdvancePipelineStage(db, companyId, targetStage, logId = null, reason = 'Auto-inferred from field touch') {", "export async function autoAdvancePipelineStage(db, companyId, targetStage, userEmail, logId = null, reason = 'Auto-inferred from field touch') {");
content = content.replace('SELECT pipeline_stage FROM companies WHERE company_id = ?', 'SELECT pipeline_stage FROM companies WHERE company_id = ? AND agent_email = ?');
content = content.replace(').bind(companyId).first();', ').bind(companyId, userEmail).first();');
content = content.replace('await transitionPipelineStage(db, { companyId, toStage: targetStage, reason, triggerLogId: logId });', 'await transitionPipelineStage(db, { companyId, toStage: targetStage, reason, triggerLogId: logId, userEmail });');

// 5. transitionPipelineStage
content = content.replace('export async function transitionPipelineStage(db, { companyId, toStage, reason = null, forecastAp = null, forecastConfidence = null, triggerLogId = null }) {', 'export async function transitionPipelineStage(db, { companyId, toStage, reason = null, forecastAp = null, forecastConfidence = null, triggerLogId = null, userEmail }) {');
content = content.replace('SELECT pipeline_stage FROM companies WHERE company_id = ?', 'SELECT pipeline_stage FROM companies WHERE company_id = ? AND agent_email = ?');
content = content.replace(').bind(companyId).first();', ').bind(companyId, userEmail).first();');
content = content.replace('UPDATE companies SET\n        pipeline_stage = ?,\n        stage_entered_at = ?\n      WHERE company_id = ?', 'UPDATE companies SET\n        pipeline_stage = ?,\n        stage_entered_at = ?\n      WHERE company_id = ? AND agent_email = ?');
content = content.replace(").bind(toStage, now, companyId).run();", ").bind(toStage, now, companyId, userEmail).run();");
content = content.replace('UPDATE companies SET\n        pipeline_stage = ?,\n        stage_entered_at = ?,\n        forecast_ap = COALESCE(?, forecast_ap),\n        forecast_confidence = COALESCE(?, forecast_confidence)\n      WHERE company_id = ?', 'UPDATE companies SET\n        pipeline_stage = ?,\n        stage_entered_at = ?,\n        forecast_ap = COALESCE(?, forecast_ap),\n        forecast_confidence = COALESCE(?, forecast_confidence)\n      WHERE company_id = ? AND agent_email = ?');
content = content.replace(').bind(toStage, now, forecastAp, forecastConfidence, companyId).run();', ').bind(toStage, now, forecastAp, forecastConfidence, companyId, userEmail).run();');

content = content.replace('INSERT INTO pipeline_events (\n        event_id, company_id, from_stage, to_stage, changed_at, trigger_log_id, reason\n      ) VALUES (?, ?, ?, ?, ?, ?, ?)', 'INSERT INTO pipeline_events (\n        event_id, company_id, from_stage, to_stage, changed_at, trigger_log_id, reason, agent_email\n      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
content = content.replace(').bind(eventId, companyId, currentStage, toStage, now, triggerLogId, reason).run();', ').bind(eventId, companyId, currentStage, toStage, now, triggerLogId, reason, userEmail).run();');

// 6. snoozeCompany
content = content.replace('export async function snoozeCompany(db, companyId, untilDate) {', 'export async function snoozeCompany(db, companyId, untilDate, userEmail) {');
content = content.replace('UPDATE companies SET snoozed_until = ? WHERE company_id = ?', 'UPDATE companies SET snoozed_until = ? WHERE company_id = ? AND agent_email = ?');
content = content.replace(').bind(untilDate, companyId).run();', ').bind(untilDate, companyId, userEmail).run();');

// 7. findExistingContact
content = content.replace('export async function findExistingContact(db, companyId, firstName, lastName) {', 'export async function findExistingContact(db, companyId, firstName, lastName, userEmail) {');
content = content.replace('WHERE company_id = ? AND LOWER(TRIM(first_name)) = ? AND LOWER(TRIM(last_name)) = ?', 'WHERE company_id = ? AND agent_email = ? AND LOWER(TRIM(first_name)) = ? AND LOWER(TRIM(last_name)) = ?');
content = content.replace(').bind(companyId, fn, ln).first();', ').bind(companyId, userEmail, fn, ln).first();');
content = content.replace("WHERE company_id = ? AND LOWER(TRIM(first_name)) = ? AND (last_name IS NULL OR TRIM(last_name) = '')", "WHERE company_id = ? AND agent_email = ? AND LOWER(TRIM(first_name)) = ? AND (last_name IS NULL OR TRIM(last_name) = '')");
content = content.replace(').bind(companyId, fn).first();', ').bind(companyId, userEmail, fn).first();');
content = content.replace("WHERE company_id = ? AND (first_name IS NULL OR TRIM(first_name) = '') AND LOWER(TRIM(last_name)) = ?", "WHERE company_id = ? AND agent_email = ? AND (first_name IS NULL OR TRIM(first_name) = '') AND LOWER(TRIM(last_name)) = ?");
content = content.replace(').bind(companyId, ln).first();', ').bind(companyId, userEmail, ln).first();');

// 8. upsertContact
content = content.replace('export async function upsertContact(db, contact) {', 'export async function upsertContact(db, contact, userEmail) {');
content = content.replace('const existingId = await findExistingContact(db, contact.company_id, contact.first_name, contact.last_name);', 'const existingId = await findExistingContact(db, contact.company_id, contact.first_name, contact.last_name, userEmail);');
content = content.replace('phone_number, email_address, is_primary_dm\n    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 'phone_number, email_address, is_primary_dm, agent_email\n    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
content = content.replace('ON CONFLICT(contact_id) DO UPDATE SET', 'ON CONFLICT(contact_id, agent_email) DO UPDATE SET');
content = content.replace('contact.is_primary_dm ?? 0\n  ).run();', 'contact.is_primary_dm ?? 0,\n    userEmail\n  ).run();');

// 9. upsertActivityLog
content = content.replace('export async function upsertActivityLog(db, log) {', 'export async function upsertActivityLog(db, log, userEmail) {');
content = content.replace('next_action_date, next_action_text\n    ) VALUES (?, ?, ?, COALESCE(?, datetime(\'now\')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 'next_action_date, next_action_text, agent_email\n    ) VALUES (?, ?, ?, COALESCE(?, datetime(\'now\')), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
content = content.replace('ON CONFLICT(log_id) DO UPDATE SET', 'ON CONFLICT(log_id, agent_email) DO UPDATE SET');
content = content.replace("log.sync_tier_status || 'PENDING',\n    log.next_action_date ?? null,\n    log.next_action_text ?? null\n  ).run();", "log.sync_tier_status || 'PENDING',\n    log.next_action_date ?? null,\n    log.next_action_text ?? null,\n    userEmail\n  ).run();");

// 10. companyExists
content = content.replace('export async function companyExists(db, companyId) {', 'export async function companyExists(db, companyId, userEmail) {');
content = content.replace("SELECT 1 AS ok FROM companies WHERE company_id = ? LIMIT 1", "SELECT 1 AS ok FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1");
content = content.replace(').bind(companyId).first();', ').bind(companyId, userEmail).first();');

fs.writeFileSync('src/lib/db.js', content);
