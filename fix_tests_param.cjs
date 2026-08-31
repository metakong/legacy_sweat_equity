const fs = require('fs');
let txt = fs.readFileSync('test/worker.test.js', 'utf8');
txt = txt.replace(
  "await autoAdvancePipelineStage(mockDb, 'comp-101', 'ENGAGED', 'log-999', 'First contact');",
  "await autoAdvancePipelineStage(mockDb, 'comp-101', 'ENGAGED', 'sean_deardorff@us.aflac.com', 'log-999', 'First contact');"
);
fs.writeFileSync('test/worker.test.js', txt);
