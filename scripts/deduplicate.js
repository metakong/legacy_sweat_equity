import { execSync } from 'child_process';
import fs from 'fs';

const normalizeKey = (n, s) => (String(n || '') + '|' + String(s || '')).toLowerCase().replace(/[^a-z0-9]/g, '');

function runD1(sql, useFile = false) {
  let execStr;
  if (useFile) {
    fs.writeFileSync('temp_query.sql', sql, 'utf8');
    execStr = 'npm run wrangler -- d1 execute legacy-db --remote --json --file temp_query.sql';
  } else {
    // Escape quotes if using command
    const safeSql = sql.replace(/"/g, '\\"');
    execStr = `npm run wrangler -- d1 execute legacy-db --remote --json --command "${safeSql}"`;
  }
  
  try {
    const output = execSync(execStr, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (useFile && fs.existsSync('temp_query.sql')) fs.unlinkSync('temp_query.sql');
    
    // Use regex to find the outermost array or object that looks like D1 output
    const match = output.match(/\[\s*\{\s*"results":/);
    if (!match) {
      console.warn('No D1 JSON found in output:', output);
      return [];
    }
    
    return JSON.parse(output.slice(match.index));
  } catch (err) {
    if (fs.existsSync('temp_query.sql')) fs.unlinkSync('temp_query.sql');
    console.error('Wrangler execution failed:', err.message);
    if (err.stdout) console.error('stdout:', err.stdout);
    if (err.stderr) console.error('stderr:', err.stderr);
    throw err;
  }
}

async function run() {
  console.log('Fetching companies...');
  const companiesRes = runD1('SELECT company_id, company_name, street_1, created_at FROM companies;');
  const companies = companiesRes[0].results;
  
  // DEBUG
  console.log('companiesRes length:', companiesRes.length);
  console.log('companies:', companies);
  console.log('companies length:', companies.length);
  
  if (!companies || companies.length === 0) {
    console.log('No companies found.');
    return;
  }
  
  console.log(`Fetched ${companies.length} companies.`);
  
  const groups = new Map();
  for (const c of companies) {
    if (!c.company_name || !c.street_1) continue;
    const key = normalizeKey(c.company_name, c.street_1);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  
  let mergedCount = 0;
  
  for (const [key, group] of groups.entries()) {
    if (group.length > 1) {
      // Sort by created_at ascending (oldest first)
      group.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
      const master = group[0];
      const duplicates = group.slice(1);
      
      console.log(`Found duplicate group for "${key}". Master: ${master.company_id}. Duplicates: ${duplicates.map(d => d.company_id).join(', ')}`);
      
      for (const dup of duplicates) {
        console.log(`Merging ${dup.company_id} into ${master.company_id}...`);
        
        const mergeSql = `
          UPDATE activity_logs SET company_id = '${master.company_id}' WHERE company_id = '${dup.company_id}';
          UPDATE pipeline_events SET company_id = '${master.company_id}' WHERE company_id = '${dup.company_id}';
          UPDATE contacts SET company_id = '${master.company_id}' WHERE company_id = '${dup.company_id}';
          DELETE FROM companies WHERE company_id = '${dup.company_id}';
        `;
        
        // As noted in AGENTS.md, multi-statement DDL is rejected by MCP, but `wrangler d1 execute --file` might allow multiple statements.
        // Let's run them one by one just in case.
        const stmts = mergeSql.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of stmts) {
           runD1(stmt + ';');
        }
        
        mergedCount++;
      }
    }
  }
  
  console.log(`\nCleanup complete. Total duplicates merged and deleted: ${mergedCount}`);
}

run().catch(console.error);
