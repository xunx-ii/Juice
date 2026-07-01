#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
APP_USER="${APP_USER:-appuser}"
APP_GROUP="${APP_GROUP:-appuser}"
DATABASE_FILE="${DATABASE_URL:-$DATA_DIR/notes.sqlite}"

mkdir -p "$DATA_DIR"

can_appuser_write_database() {
  gosu "$APP_USER" test -w "$DATA_DIR" || return 1

  for file in "$DATABASE_FILE" "$DATABASE_FILE-wal" "$DATABASE_FILE-shm"; do
    if [ -e "$file" ] && ! gosu "$APP_USER" test -w "$file"; then
      return 1
    fi
  done
}

if [ "$(id -u)" = "0" ]; then
  if chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR" 2>/dev/null && chmod -R u+rwX,g+rwX "$DATA_DIR" 2>/dev/null && can_appuser_write_database 2>/dev/null; then
    exec gosu "$APP_USER" /usr/local/bin/orange-notes-server "$@"
  fi

  if can_appuser_write_database 2>/dev/null; then
    exec gosu "$APP_USER" /usr/local/bin/orange-notes-server "$@"
  fi

  echo "warning: unable to chown $DATA_DIR; running as root so the bind-mounted SQLite database remains writable" >&2
  exec /usr/local/bin/orange-notes-server "$@"
fi

exec /usr/local/bin/orange-notes-server "$@"
