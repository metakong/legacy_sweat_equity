const { execSync } = require('child_process');
const fs = require('fs');

const stmts = fs.readFileSync('./migrations/0002_multi_tenant.sql', 'utf8')
  .split(';')
  .map(s => s.trim())
  .filter(Boolean);

for (let i = 0; i < stmts.length; i++) {
  console.log(`Executing ${i+1}/${stmts.length}...`);
  fs.writeFileSync('temp_stmt.sql', stmts[i] + ';');
  try {
    execSync(`npm run wrangler -- d1 execute legacy-db --remote --file=temp_stmt.sql`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`Failed statement ${i+1}`);
    process.exit(1);
  }
}
fs.unlinkSync('temp_stmt.sql');
console.log("Done");
