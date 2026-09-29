-- Secret code uses tracking table.
CREATE TABLE IF NOT EXISTS secret_code_uses (
    code TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER NOT NULL
);
