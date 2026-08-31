const fs = require('fs');
let txt = fs.readFileSync('src/index.js', 'utf8');
txt = txt.replace("import { extractUserEmail, ALLOWED_USERS } from './lib/security.js';\n\napp.use('/api/*'", "app.use('/api/*'");
txt = txt.replace("import {\n  SECURITY_HEADERS,", "import {\n  SECURITY_HEADERS,\n  extractUserEmail,\n  ALLOWED_USERS,");
fs.writeFileSync('src/index.js', txt);
