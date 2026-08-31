const fs = require('fs');
let sql = fs.readFileSync('schema.sql', 'utf8');

sql = sql.replace('company_id TEXT PRIMARY KEY,', 'company_id TEXT,');
sql = sql.replace("created_at TEXT DEFAULT (datetime('now'))\n);", `created_at TEXT DEFAULT (datetime('now')),\n    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',\n    PRIMARY KEY (company_id, agent_email)\n);`);

sql = sql.replace('contact_id TEXT PRIMARY KEY,', 'contact_id TEXT,');
sql = sql.replace("FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE\n);", `agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',\n    PRIMARY KEY (contact_id, agent_email),\n    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email) ON DELETE CASCADE\n);`);

sql = sql.replace('log_id TEXT PRIMARY KEY,', 'log_id TEXT,');
sql = sql.replace("FOREIGN KEY (company_id) REFERENCES companies(company_id)\n);\nCREATE INDEX", `agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',\n    PRIMARY KEY (log_id, agent_email),\n    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email)\n);\nCREATE INDEX`);

sql = sql.replace('event_id TEXT PRIMARY KEY,', 'event_id TEXT,');
sql = sql.replace("reason TEXT,\n    FOREIGN KEY (company_id) REFERENCES companies(company_id)\n);", `reason TEXT,\n    agent_email TEXT NOT NULL DEFAULT 'sean_deardorff@us.aflac.com',\n    PRIMARY KEY (event_id, agent_email),\n    FOREIGN KEY (company_id, agent_email) REFERENCES companies(company_id, agent_email)\n);`);

fs.writeFileSync('schema.sql', sql);
