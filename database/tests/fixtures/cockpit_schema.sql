-- The cockpit.db schema as it stood on 2026-09-25 (sqlite_master of ~/fund-data/cockpit.db, read-only),
-- including the runtime columns app/server added (conversations.model/effort/indexed, law_loads.source).
-- The importer tests build a SQLite database from this file; it is a frozen copy, not the live law.

CREATE TABLE _migrations (n INTEGER PRIMARY KEY, file TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE alert_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  rule       TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  value      REAL,
  bar        INTEGER NOT NULL,
  delivered  TEXT    NOT NULL,
  channel    TEXT    NOT NULL,
  detail     TEXT
);
CREATE TABLE alert_passes (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  bar    INTEGER NOT NULL,
  bars   TEXT    NOT NULL,
  rules  INTEGER NOT NULL,
  rows   INTEGER NOT NULL,
  error  TEXT,
  forced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE alert_rules (
  id          TEXT    PRIMARY KEY,
  condition   TEXT    NOT NULL,
  params_json TEXT    NOT NULL DEFAULT '{}',
  subject     TEXT    NOT NULL,
  mode        TEXT    NOT NULL,
  bar         TEXT    NOT NULL,
  expiry      INTEGER,
  rate_cap    INTEGER,
  file_board  INTEGER NOT NULL DEFAULT 0,
  desk        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  armed       INTEGER NOT NULL DEFAULT 1,
  created     INTEGER NOT NULL,
  last_fired  INTEGER
);
CREATE TABLE board_attest (
  id   TEXT PRIMARY KEY,
  fp   TEXT NOT NULL,
  ts   INTEGER NOT NULL,
  via  TEXT NOT NULL
);
CREATE TABLE board_scan (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  ts           INTEGER NOT NULL,
  files        INTEGER NOT NULL,
  visited      INTEGER NOT NULL,
  capped       INTEGER NOT NULL,
  errors_json  TEXT NOT NULL,
  ms           INTEGER NOT NULL,
  found        INTEGER NOT NULL
);
CREATE TABLE board_suggested (
  fp          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  path        TEXT NOT NULL,
  line        INTEGER,
  ref         TEXT NOT NULL,
  quote       TEXT NOT NULL,
  title       TEXT NOT NULL,
  owner       TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE TABLE board_suggested_done (
  fp     TEXT PRIMARY KEY,
  state  TEXT NOT NULL,
  item   TEXT,
  title  TEXT,
  ts     INTEGER NOT NULL
);
CREATE TABLE book_marks (
  path             TEXT PRIMARY KEY,
  state            TEXT NOT NULL DEFAULT 'cold',
  n                INTEGER NOT NULL DEFAULT 0,
  ts               INTEGER NOT NULL,
  note             TEXT,
  boot_json        TEXT
);
CREATE TABLE chat_prompts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  title    TEXT NOT NULL DEFAULT '',
  body     TEXT NOT NULL,
  tags     TEXT NOT NULL DEFAULT '[]',
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE TABLE chat_verify (
  repo         TEXT PRIMARY KEY,
  code         INTEGER,
  last         TEXT NOT NULL DEFAULT '',
  ms           INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  timed_out    INTEGER NOT NULL DEFAULT 0,
  fingerprint  TEXT NOT NULL
);
CREATE TABLE commits (
  repo             TEXT NOT NULL,
  sha              TEXT NOT NULL,
  ts               INTEGER NOT NULL,
  author           TEXT,
  agent_id         TEXT,
  conversation_id  TEXT,
  subject          TEXT NOT NULL,
  files_json       TEXT,
  change_id        TEXT,
  loop_change      TEXT, shrink_json TEXT,
  PRIMARY KEY (repo, sha)
);
CREATE TABLE comparator_snapshots (
  seq              INTEGER PRIMARY KEY,
  id               TEXT NOT NULL,             -- comparator: tbill | btc | hlp
  ts               INTEGER NOT NULL,          -- when fundd pulled it (ms)
  status           TEXT NOT NULL,             -- ok | unknown | failed
  series           TEXT NOT NULL,             -- JSON: {points [[t_ms, v]], unit, facts, reason, tag, label}
  src              TEXT NOT NULL,             -- the api.data call that produced it
  read_at          TEXT                       -- ISO date of the newest published point (null when none)
);
CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,          -- stable forever
  agent_id         TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  transcript_uuid  TEXT,                      -- Claude Code session id; moves on compaction
  state            TEXT NOT NULL DEFAULT 'idle', -- live | waiting | idle | closed
  cwd              TEXT,
  started_at       INTEGER NOT NULL,
  last_at          INTEGER NOT NULL,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL    NOT NULL DEFAULT 0,
  forgotten        INTEGER NOT NULL DEFAULT 0
, model TEXT, effort TEXT, indexed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE events (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER NOT NULL,
  kind             TEXT NOT NULL,             -- turn | tool | edit | commit | ask | error | job | health | process | board
  summary          TEXT NOT NULL,
  agent_id         TEXT,
  conversation_id  TEXT,
  payload_json     TEXT
);
CREATE TABLE health_readings (
  ts               INTEGER NOT NULL,
  probe_id         TEXT NOT NULL,             -- e.g. dash:trade/port, venue:exchange_a, system:selftest
  target           TEXT NOT NULL,             -- dashboard | venue | system | job
  status           TEXT NOT NULL,             -- ok | warn | fail | unknown
  reading          TEXT,
  detail_json      TEXT
);
CREATE TABLE job_runs (
  id               INTEGER PRIMARY KEY,
  job_id           TEXT NOT NULL,
  due_at           INTEGER,
  started_at       INTEGER,
  ended_at         INTEGER,
  status           TEXT NOT NULL,             -- ok | fail | missed | skipped | running
  exit_code        INTEGER,
  log_path         TEXT,
  conversation_id  TEXT
, detail TEXT, trigger TEXT NOT NULL DEFAULT 'schedule', pid INTEGER);
CREATE TABLE law_loads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    TEXT NOT NULL,
  agent_id           TEXT NOT NULL,
  ts                 INTEGER NOT NULL,
  file_path          TEXT NOT NULL,
  memory_type        TEXT,
  load_reason        TEXT NOT NULL,
  trigger_file_path  TEXT,
  sha                TEXT,
  tokens             INTEGER
, source TEXT);
CREATE TABLE library_draft_scans (
  conv             TEXT PRIMARY KEY,
  last_at          INTEGER NOT NULL,
  ts               INTEGER NOT NULL,
  found            INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  note             TEXT
);
CREATE TABLE library_drafts (
  id               INTEGER PRIMARY KEY,
  conv             TEXT NOT NULL,             -- conversations.id the correction came from
  agent            TEXT NOT NULL,             -- the agent that conversation held
  shelf            TEXT NOT NULL,             -- spine shelf id it is filed on
  level            TEXT NOT NULL DEFAULT 'agent', -- agent | role | fund: how deep the lesson holds
  path             TEXT NOT NULL,             -- fund-relative path of the new book
  title            TEXT NOT NULL DEFAULT '',
  book             TEXT NOT NULL,             -- the whole book text
  series_row       TEXT NOT NULL,             -- the one `| file | read when |` row for _series.md
  quote            TEXT NOT NULL,             -- the owner's own words it was drafted from
  key              TEXT NOT NULL,             -- conv + hash of the quote: one draft per correction
  state            TEXT NOT NULL DEFAULT 'open', -- open | saved | dismissed
  sha              TEXT,                      -- the commit that landed it
  lesson_id        INTEGER,                   -- its mirror row in loop_lessons
  error            TEXT,
  ts               INTEGER NOT NULL,
  updated          INTEGER
);
CREATE TABLE loop_lessons (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER NOT NULL,
  agent_id         TEXT NOT NULL,
  conversation_id  TEXT,
  text             TEXT NOT NULL,
  scope            TEXT NOT NULL DEFAULT 'agent',  -- agent | role | fund | a fund-relative path
  read_when        TEXT,                           -- the moment it should fire, when the filer named one
  state            TEXT NOT NULL DEFAULT 'open',   -- open | promoted | dismissed
  proposal         TEXT                            -- L-NNN that carried it, when promoted
);
CREATE TABLE loop_metrics (
  day              TEXT NOT NULL,             -- YYYY-MM-DD
  agent_id         TEXT NOT NULL,
  metric           TEXT NOT NULL,
  value            REAL NOT NULL,
  PRIMARY KEY (day, agent_id, metric)
);
CREATE TABLE loop_passes (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER NOT NULL,
  trigger          TEXT NOT NULL,                  -- schedule | owner | manual
  ok               INTEGER NOT NULL,
  summary          TEXT NOT NULL,
  detail_json      TEXT
);
CREATE VIRTUAL TABLE messages_fts USING fts5(conversation_id UNINDEXED, role UNINDEXED, ts UNINDEXED, text);
CREATE TABLE presence (
  hand_id          TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  conversation_id  TEXT,
  doing            TEXT,
  since            INTEGER NOT NULL,
  heartbeat_at     INTEGER NOT NULL,
  pid              INTEGER
);
CREATE TABLE processes (
  id               INTEGER PRIMARY KEY,
  dashboard_id     TEXT NOT NULL,
  mode             TEXT NOT NULL,             -- prod | dev
  pid              INTEGER,
  port             INTEGER,
  cmd              TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  stopped_at       INTEGER,
  exit_code        INTEGER,
  log_path         TEXT
);
CREATE TABLE reads (
  ts               INTEGER NOT NULL,
  agent_id         TEXT NOT NULL,
  conversation_id  TEXT,
  book_path        TEXT NOT NULL,
  at_boot          INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE review_queue (
  conversation_id  TEXT NOT NULL,
  turn_ix          INTEGER NOT NULL,
  reason           TEXT NOT NULL,                  -- failed | ledger | sample
  state            TEXT NOT NULL DEFAULT 'open',   -- open | done
  ts               INTEGER NOT NULL DEFAULT 0,     -- the turn's time
  agent_id         TEXT,
  excerpt          TEXT,                           -- the turn's assistant text, clipped
  spans_json       TEXT,                           -- failed spans inside the excerpt [{check, start, end}]
  detail           TEXT,                           -- ledger: the paths written; failed: the checks
  PRIMARY KEY (conversation_id, turn_ix, reason)
);
CREATE TABLE spend_alerts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  agent     TEXT    NOT NULL,
  billable  INTEGER NOT NULL,
  median    REAL    NOT NULL,
  multiple  REAL
);
CREATE TABLE turn_grades (
  conversation_id  TEXT NOT NULL,
  turn_ix          INTEGER NOT NULL,               -- 0-based index of the turn's 'turn done' event in its conversation
  ts               INTEGER NOT NULL,               -- the turn's own time (the 'turn done' event), so a late grade lands on the day the work happened
  agent_id         TEXT,
  source           TEXT NOT NULL,                  -- owner | check
  key              TEXT NOT NULL,                  -- owner: 'owner'; check: nodash | tagged | windowed
  value            REAL NOT NULL,                  -- 1 good / pass, 0 bad / fail
  label            TEXT,                           -- owner: invented number | no window | off scope | style; check: the failed spans (json)
  graded_at        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, turn_ix, source, key)
);
CREATE TABLE usage (
  ts               INTEGER NOT NULL,
  agent_id         TEXT NOT NULL,
  conversation_id  TEXT,
  model            TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cache_read       INTEGER NOT NULL DEFAULT 0,
  cache_write      INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL    NOT NULL DEFAULT 0
);
CREATE INDEX alert_log_at ON alert_log(at);
CREATE UNIQUE INDEX alert_log_once ON alert_log(rule, subject, bar);
CREATE INDEX alert_passes_at ON alert_passes(at);
CREATE INDEX chat_prompts_updated ON chat_prompts(updated DESC);
CREATE INDEX commits_conv ON commits(conversation_id);
CREATE INDEX commits_ts ON commits(ts DESC);
CREATE INDEX comparator_snapshots_id_ts ON comparator_snapshots(id, ts DESC);
CREATE INDEX conversations_agent ON conversations(agent_id, last_at DESC);
CREATE INDEX events_agent ON events(agent_id, ts DESC);
CREATE INDEX events_ts ON events(ts DESC);
CREATE INDEX health_probe ON health_readings(probe_id, ts DESC);
CREATE INDEX job_runs_due ON job_runs(job_id, due_at);
CREATE INDEX job_runs_job ON job_runs(job_id, started_at DESC);
CREATE INDEX law_loads_conv ON law_loads(conversation_id, ts);
CREATE UNIQUE INDEX library_drafts_key ON library_drafts(key);
CREATE INDEX library_drafts_state ON library_drafts(state, ts DESC);
CREATE INDEX loop_lessons_agent ON loop_lessons(agent_id, ts DESC);
CREATE INDEX loop_lessons_ts ON loop_lessons(ts DESC);
CREATE INDEX loop_passes_ts ON loop_passes(ts DESC);
CREATE INDEX processes_dash ON processes(dashboard_id, started_at DESC);
CREATE INDEX reads_agent ON reads(agent_id, ts DESC);
CREATE INDEX reads_book ON reads(book_path, ts DESC);
CREATE INDEX reads_pull ON reads(at_boot, ts DESC);
CREATE INDEX review_queue_state ON review_queue(state, ts DESC);
CREATE INDEX spend_alerts_agent ON spend_alerts(agent, ts);
CREATE INDEX turn_grades_src ON turn_grades(source, ts);
CREATE INDEX turn_grades_ts ON turn_grades(ts);
CREATE INDEX usage_ts ON usage(ts);
