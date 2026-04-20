#!/bin/bash
# All-in-one script for pandaclaw.
# Does NOT build — dist/ files are compiled on vonwong and synced via Dropbox.
# Just restarts PM2 and runs both message imports.
#
# Usage: bash scripts/run-all.sh

set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "=== Checking database files ==="
MISSING=0
for f in data/ChatStorage.sqlite data/chat.db; do
  if [ -f "$f" ]; then
    echo "✓ $f ($(du -sh "$f" | cut -f1))"
  else
    echo "✗ $f NOT FOUND — run export-databases.sh on vonwong and wait for Dropbox to sync"
    MISSING=1
  fi
done
if [ "$MISSING" = "1" ]; then exit 1; fi

echo ""
echo "=== Restart server ==="
/opt/homebrew/bin/pm2 restart whatsapp-events 2>/dev/null || \
  /opt/homebrew/bin/pm2 start dist/index.js --name whatsapp-events
sleep 3

echo ""
echo "=== Verify route is live ==="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  http://localhost:3000/api/friends/local-import \
  -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo "000")

if [ "$STATUS" = "401" ] || [ "$STATUS" = "400" ]; then
  echo "✓ Route live (HTTP $STATUS)"
elif [ "$STATUS" = "000" ]; then
  echo "Trying external URL..."
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    https://whatsapp.vonwongdaily.com/api/friends/local-import \
    -H "Content-Type: application/json" -d '{}')
  if [ "$STATUS" = "401" ] || [ "$STATUS" = "400" ]; then
    echo "✓ Route live via external URL (HTTP $STATUS)"
  else
    echo "✗ Route returned HTTP $STATUS — build may not have the new code"
    echo "  Run: grep -c 'local-import' dist/apps/friends/routes.js"
    exit 1
  fi
else
  echo "✗ Route returned HTTP $STATUS"
  exit 1
fi

echo ""
echo "=== WhatsApp import ==="
/opt/homebrew/bin/node scripts/local-wa-import.js --url http://localhost:3000

echo ""
echo "=== iMessage import ==="
/opt/homebrew/bin/node scripts/local-imessage-import.js --url http://localhost:3000

echo ""
echo "=== All done ==="
