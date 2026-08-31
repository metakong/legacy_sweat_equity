const fs = require('fs');

let content = fs.readFileSync('src/lib/db.js', 'utf8');

content = content.replace(
  "'SELECT pipeline_stage, forecast_ap, forecast_confidence FROM companies WHERE company_id = ? LIMIT 1'",
  "'SELECT pipeline_stage, forecast_ap, forecast_confidence FROM companies WHERE company_id = ? AND agent_email = ? LIMIT 1'"
);

// We need to fix the tests by passing 'sean_deardorff@us.aflac.com' as userEmail to db.js function calls in `test/worker.test.js`.
fs.writeFileSync('src/lib/db.js', content);
