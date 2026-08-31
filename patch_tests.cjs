const fs = require('fs');
let txt = fs.readFileSync('test/worker.test.js', 'utf8');

txt = txt.replace(/headers: \{/g, "headers: { 'x-api-key': 'LEGACY_EDGE_KEY_2026',");
// fix duplicates
txt = txt.replace(/'x-api-key': 'LEGACY_EDGE_KEY_2026',\s*'x-api-key': 'LEGACY_EDGE_KEY_2026'/g, "'x-api-key': 'LEGACY_EDGE_KEY_2026'");

fs.writeFileSync('test/worker.test.js', txt);
