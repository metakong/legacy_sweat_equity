const fs = require('fs');
let txt = fs.readFileSync('test/worker.test.js', 'utf8');

txt = txt.replace(/upsertContact\(([^,]+),\s*([^)]+)\)/g, "upsertContact($1, $2, 'sean_deardorff@us.aflac.com')");
txt = txt.replace(/upsertCompany\(([^,]+),\s*([^)]+)\)/g, "upsertCompany($1, $2, 'sean_deardorff@us.aflac.com')");
txt = txt.replace(/findExistingContact\(([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/g, "findExistingContact($1, $2, $3, $4, 'sean_deardorff@us.aflac.com')");
txt = txt.replace(/autoAdvancePipelineStage\(([^,]+),\s*([^,]+),\s*([^),]+)\)/g, "autoAdvancePipelineStage($1, $2, $3, 'sean_deardorff@us.aflac.com')");
txt = txt.replace(/transitionPipelineStage\(([^,]+),\s*\{([^}]+)\}\)/g, "transitionPipelineStage($1, { $2, userEmail: 'sean_deardorff@us.aflac.com' })");
txt = txt.replace(/snoozeCompany\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, "snoozeCompany($1, $2, $3, 'sean_deardorff@us.aflac.com')");

fs.writeFileSync('test/worker.test.js', txt);
