const fs = require('fs');
let txt = fs.readFileSync('test/worker.test.js', 'utf8');
txt = txt.replace(
  "const [companyId, fn, ln] = args;",
  "const [companyId, userEmail, fn, ln] = args;"
);
fs.writeFileSync('test/worker.test.js', txt);
