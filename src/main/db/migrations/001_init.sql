-- 初始迁移：规则版本、运行实例、checkpoint、结果、附件等全部表。
-- 续跑不重复入库的三层保证：run_checkpoints（效率）/ run_items（单 run 幂等）/ results 唯一约束（跨 run 正确性）。

-- 规则元数据
CREATE TABLE rules (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  current_version_id  TEXT,
  archived            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 不可变版本快照：每次保存 INSERT 一行完整快照，不做原地覆盖
CREATE TABLE rule_versions (
  id            TEXT PRIMARY KEY,
  rule_id       TEXT NOT NULL REFERENCES rules(id),
  version_no    INTEGER NOT NULL,
  content_json  TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  change_note   TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (rule_id, version_no)
);

-- 浏览器登录画像（persistent context 的 userDataDir 登记）
CREATE TABLE browser_profiles (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  user_data_dir      TEXT NOT NULL,
  storage_state_enc  BLOB,
  last_used_at       TEXT
);

-- 任务 = 规则 + 运行参数的长期实体，去重以 task 为边界
CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  rule_id          TEXT NOT NULL REFERENCES rules(id),
  rule_version_id  TEXT NOT NULL REFERENCES rule_versions(id),
  profile_id       TEXT REFERENCES browser_profiles(id),
  settings_json    TEXT NOT NULL,
  schedule_json    TEXT,
  status           TEXT NOT NULL DEFAULT 'idle',
  created_at       TEXT NOT NULL
);

-- 一次执行实例；resume 时新建 run 并挂 parent_run_id
CREATE TABLE task_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  rule_version_id  TEXT NOT NULL REFERENCES rule_versions(id),
  parent_run_id    TEXT REFERENCES task_runs(id),
  trigger          TEXT NOT NULL,
  status           TEXT NOT NULL,
  stats_json       TEXT,
  error_summary    TEXT,
  started_at       TEXT,
  ended_at         TEXT
);
CREATE INDEX idx_runs_task ON task_runs(task_id);

-- 第一层：续跑游标，只负责效率
CREATE TABLE run_checkpoints (
  run_id        TEXT PRIMARY KEY REFERENCES task_runs(id),
  phase         TEXT NOT NULL,
  cursor_json   TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 第二层：单次 run 内步骤去重
CREATE TABLE run_items (
  run_id      TEXT NOT NULL REFERENCES task_runs(id),
  item_key    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  updated_at  TEXT NOT NULL,
  UNIQUE (run_id, item_key)
);
CREATE INDEX idx_run_items_status ON run_items(run_id, status);

-- 第三层：跨所有 run 的最终幂等保证
CREATE TABLE results (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id),
  run_id           TEXT NOT NULL REFERENCES task_runs(id),
  rule_version_id  TEXT NOT NULL REFERENCES rule_versions(id),
  row_hash         TEXT NOT NULL,
  dedupe_key       TEXT NOT NULL,
  data_json        TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  collected_at     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (task_id, row_hash)
);
CREATE INDEX idx_results_task ON results(task_id);
CREATE INDEX idx_results_run ON results(run_id);

CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  result_id     TEXT NOT NULL REFERENCES results(id),
  field_id      TEXT NOT NULL,
  url           TEXT NOT NULL,
  local_path    TEXT,
  filename      TEXT NOT NULL,
  mime          TEXT,
  bytes         INTEGER,
  hash_sha256   TEXT,
  status        TEXT NOT NULL,
  downloaded_at TEXT,
  UNIQUE (result_id, url)
);
CREATE INDEX idx_attachments_result ON attachments(result_id);

CREATE TABLE run_logs (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES task_runs(id),
  level      TEXT NOT NULL,
  step       TEXT,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_logs_run ON run_logs(run_id);

CREATE TABLE exports (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id),
  run_id      TEXT REFERENCES task_runs(id),
  format      TEXT NOT NULL,
  path        TEXT,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
