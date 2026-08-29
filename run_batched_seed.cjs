
const { execSync } = require("child_process");
const fs = require("fs");

const sql = fs.readFileSync("seed-clean.sql", "utf8");
const statements = sql.split(";\n").map(s => s.trim()).filter(s => s.length > 0);

console.log(`Loaded ${statements.length} statements from seed-clean.sql.`);

const batchSize = 25;
for (let i = 0; i < statements.length; i += batchSize) {
  const batch = statements.slice(i, i + batchSize).map(s => s + ";");
  fs.writeFileSync("temp_batch.sql", batch.join("\n"));
  console.log(`Executing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(statements.length/batchSize)} (${batch.length} statements)...`);
  try {
    execSync("npm run wrangler -- d1 execute legacy-db --remote --yes --file=temp_batch.sql", { stdio: "inherit" });
  } catch (err) {
    console.error(`Batch failed at index ${i}:`, err.message);
    process.exit(1);
  }
}

try { fs.unlinkSync("temp_batch.sql"); } catch(e) {}
console.log("All batches executed successfully!");

