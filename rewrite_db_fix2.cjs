const fs = require('fs');

let content = fs.readFileSync('src/lib/db.js', 'utf8');

content = content.replace(
  'export async function transitionPipelineStage(db, { companyId, toStage, reason = null, forecastAp = null, forecastConfidence = null }) {',
  'export async function transitionPipelineStage(db, { companyId, toStage, reason = null, forecastAp = null, forecastConfidence = null, triggerLogId = null, userEmail }) {'
);

content = content.replace(
  ').bind(toStage, now, forecastAp, forecastConfidence, companyId).run();',
  ').bind(toStage, now, forecastAp, forecastConfidence, companyId, userEmail).run();'
);

content = content.replace(
  ').bind(eventId, companyId, currentStage, toStage, now, triggerLogId, reason).run();',
  ').bind(eventId, companyId, currentStage, toStage, now, triggerLogId, reason, userEmail).run();'
);

content = content.replace(
  'INSERT INTO pipeline_events (\n        event_id, company_id, from_stage, to_stage, changed_at, trigger_log_id, reason\n      ) VALUES (?, ?, ?, ?, ?, ?, ?)',
  'INSERT INTO pipeline_events (\n        event_id, company_id, from_stage, to_stage, changed_at, trigger_log_id, reason, agent_email\n      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

fs.writeFileSync('src/lib/db.js', content);
