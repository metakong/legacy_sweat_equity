const fs = require('fs');

let content = fs.readFileSync('src/lib/db.js', 'utf8');

// We want to add `userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';`
// to the beginning of any exported function that takes userEmail as an argument.

content = content.replace(
  /(export async function \w+\([^)]*userEmail[^)]*\)\s*\{)/g,
  "$1\n  userEmail = userEmail ?? 'sean_deardorff@us.aflac.com';"
);

// wait, transitionPipelineStage takes an object: `export async function transitionPipelineStage(db, { ... userEmail }) {`
// Let's make sure it handles that as well. The regex `[^)]*` will match it because it's inside the parentheses.

fs.writeFileSync('src/lib/db.js', content);
