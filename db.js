'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
function openDatabase(filename = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'cronicas.sqlite')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true });
  if (version > 4) throw new Error('Base de datos más reciente que este servidor');
  if (version === 0) db.transaction(() => {
    db.exec(`
      CREATE TABLE rooms (
        code TEXT PRIMARY KEY CHECK(length(code)=6), story_name TEXT NOT NULL,
        premise TEXT NOT NULL, red_lines TEXT NOT NULL,
        magic_level TEXT NOT NULL CHECK(magic_level IN ('high','low','none')),
        adventure_tone TEXT NOT NULL CHECK(adventure_tone IN ('epic','dark','comic')),
        mortality TEXT NOT NULL CHECK(mortality IN ('story','relentless')),
        phase TEXT NOT NULL DEFAULT 'lobby' CHECK(phase IN ('lobby','playing')),
        turn_index INTEGER NOT NULL DEFAULT 0 CHECK(turn_index>=0),
        turn_version INTEGER NOT NULL DEFAULT 0 CHECK(turn_version>=0), created_at INTEGER NOT NULL
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        name TEXT NOT NULL, is_host INTEGER NOT NULL CHECK(is_host IN (0,1)),
        joined_order INTEGER NOT NULL, socket_id TEXT, disconnected_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0, UNIQUE(room_code,joined_order), UNIQUE(room_code,id)
      );
      CREATE UNIQUE INDEX one_host ON members(room_code) WHERE is_host=1;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE characters (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        name TEXT NOT NULL, history TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','evaluating','approved','rejected')),
        narrative TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE traits (
        member_id TEXT NOT NULL REFERENCES characters(member_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('ventaja','desventaja')), name TEXT NOT NULL,
        PRIMARY KEY(member_id,kind,name)
      );
      CREATE TABLE turn_order (
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position>=0), member_id TEXT NOT NULL,
        PRIMARY KEY(room_code,position), UNIQUE(room_code,member_id),
        FOREIGN KEY(room_code,member_id) REFERENCES members(room_code,id) ON DELETE CASCADE
      );
      CREATE TABLE actions (
        id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        turn_version INTEGER NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','failed','completed')),
        created_at INTEGER NOT NULL, UNIQUE(room_code,turn_version)
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        author_id TEXT REFERENCES members(id) ON DELETE SET NULL, author_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('system','action','ai')), text TEXT NOT NULL,
        action_id TEXT REFERENCES actions(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
        UNIQUE(action_id,kind)
      );
      CREATE INDEX message_room ON messages(room_code,id);
      CREATE TABLE rate_limits (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `);
  })();
  if (db.pragma('user_version', { simple: true }) === 1) db.transaction(() => {
    db.exec(`
      ALTER TABLE actions ADD COLUMN stage TEXT NOT NULL DEFAULT 'evaluation'
        CHECK(stage IN ('evaluation','awaiting_roll','resolution','done'));
      ALTER TABLE actions ADD COLUMN pending_roll TEXT;
      ALTER TABLE actions ADD COLUMN roll_results TEXT;
      UPDATE actions SET stage='done' WHERE status='completed';
      PRAGMA user_version = 2;
    `);
  })();
  if (db.pragma('user_version', { simple: true }) === 2) db.transaction(() => {
    db.exec(`
      ALTER TABLE characters ADD COLUMN appearance TEXT NOT NULL DEFAULT '';
      ALTER TABLE characters ADD COLUMN avatar_url TEXT;
      ALTER TABLE characters ADD COLUMN avatar_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE characters ADD COLUMN public_history TEXT NOT NULL DEFAULT '';
      ALTER TABLE characters ADD COLUMN equipment TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE characters ADD COLUMN inventory TEXT NOT NULL DEFAULT '[]';
      CREATE TABLE character_states (
        member_id TEXT NOT NULL REFERENCES characters(member_id) ON DELETE CASCADE,
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 40),
        PRIMARY KEY(member_id,label)
      );
      CREATE TABLE social_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
        sender_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        recipient_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        sender_name TEXT NOT NULL, recipient_name TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('global','whisper')),
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 1000),
        client_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(room_code,sender_id,client_id)
      );
      CREATE INDEX social_room ON social_messages(room_code,id);
      CREATE INDEX social_private ON social_messages(room_code,recipient_id,id);
      PRAGMA user_version = 3;
    `);
  })();
  if (db.pragma('user_version', { simple: true }) === 3) db.transaction(() => {
    db.exec(`
      ALTER TABLE members ADD COLUMN is_npc INTEGER NOT NULL DEFAULT 0 CHECK(is_npc IN (0,1));
      ALTER TABLE characters ADD COLUMN motivo_rechazo_narrativo TEXT NOT NULL DEFAULT '';
      UPDATE characters SET motivo_rechazo_narrativo=narrative WHERE status='rejected';
      PRAGMA user_version = 4;
    `);
  })();
  return db;
}
function recover(db) {
  db.transaction(() => {
    db.prepare('UPDATE members SET socket_id=NULL, disconnected_at=?').run(Date.now());
    db.exec("DELETE FROM traits WHERE member_id IN (SELECT member_id FROM characters WHERE status='evaluating'); UPDATE characters SET status='draft', narrative='' WHERE status='evaluating'; UPDATE members SET revision=revision+1; UPDATE actions SET status='failed' WHERE status='pending' AND stage!='awaiting_roll';");
  })();
}
module.exports = { openDatabase, recover };

