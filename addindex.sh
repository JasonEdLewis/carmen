#!/usr/bin/env bash

# Usage:
#
# $ addindex.sh [mbtiles]

MBTILES=$1

if [ -z "$MBTILES" ]; then
    echo "Usage: addindex.sh [mbtiles]"
    exit 1
fi

if [ ! -f $MBTILES ]; then
    echo "File '$MBTILES' does not exist."
    exit 1
fi

INDEXED=`sqlite3 "$MBTILES" "SELECT '1' FROM sqlite_master WHERE name = 'carmen';"`
if [ -z $INDEXED ]; then
  # Create search table. Inserts id, text, zxy into `carmen` table.
  echo "Indexing $MBTILES..."
  echo "CREATE INDEX IF NOT EXISTS map_grid_id ON map (grid_id);" > carmen-index.sql
  echo "CREATE VIRTUAL TABLE carmen USING fts4(id,text,zxy,tokenize=simple);" >> carmen-index.sql
  echo "BEGIN TRANSACTION;" >> carmen-index.sql

  sqlite3 "$MBTILES" "SELECT k.key_name, k.key_json, zoom_level||'/'||tile_column ||'/'||tile_row AS zxy FROM keymap k JOIN grid_key g ON k.key_name = g.key_name JOIN map m ON g.grid_id = m.grid_id WHERE k.key_json LIKE '%search%'" \
    | sed "s/\([^|]*\)|.*\"search\":\"\([^\"]*\)\"[^|]*|\(.*\)/INSERT INTO carmen VALUES(\"\1\",\"\2\",\"\3\");/" \
    >> carmen-index.sql

  echo "COMMIT;" >> carmen-index.sql

  sqlite3 "$MBTILES" < carmen-index.sql
  rm carmen-index.sql
else
  echo "$MBTILES is already indexed."
fi
