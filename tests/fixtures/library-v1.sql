CREATE TABLE tracks (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    album TEXT,
    duration_seconds REAL CHECK (duration_seconds > 0),
    genres TEXT NOT NULL,
    format TEXT NOT NULL CHECK (format IN ('mp3', 'flac'))
  ) STRICT;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY NOT NULL,
    track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    UNIQUE (provider, provider_id)
  ) STRICT;
  CREATE INDEX sources_by_track ON sources(track_id);
  CREATE TABLE local_files (
    source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(id) ON UPDATE CASCADE ON DELETE CASCADE,
    dev TEXT NOT NULL,
    ino TEXT NOT NULL,
    birthtime_ns TEXT NOT NULL,
    size TEXT NOT NULL,
    mtime_ns TEXT NOT NULL,
    ctime_ns TEXT NOT NULL
  ) STRICT;
  CREATE TABLE imported_folders (
    path TEXT PRIMARY KEY NOT NULL
  ) STRICT;