const fs = require('fs');
const out = fs.readFileSync('C:/Users/admin/.gemini/antigravity/brain/a5541663-55d9-4484-9583-83ea21d8d648/.system_generated/tasks/task-84.log', 'utf8');
const match = out.match(/\[\s*\{\s*"results":/);
if (!match) {
  console.log('No match found.');
  process.exit(1);
}
const data = JSON.parse(out.slice(match.index));
const companies = data[0].results;

const normalizeKey = (n, s) => (String(n || '') + '|' + String(s || '')).toLowerCase().replace(/[^a-z0-9]/g, '');

const groups = new Map();
companies.forEach(c => {
  if (!c.company_name || !c.street_1) return;
  const k = normalizeKey(c.company_name, c.street_1);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(c);
});

let duplicates = 0;
groups.forEach(group => {
  if (group.length > 1) {
    duplicates += group.length - 1;
  }
});

console.log('Total duplicates:', duplicates);
