#!/bin/bash
# Run this on pandaclaw to rebuild and restart the server
# Usage: bash scripts/deploy-pandaclaw.sh

set -e

PROJECT="$HOME/Library/CloudStorage/Dropbox/ClaudeCode/Whatsapp Events NYC"
cd "$PROJECT"

echo "=== Building ==="
/opt/homebrew/bin/npm run build

echo ""
echo "=== Restarting PM2 ==="
/opt/homebrew/bin/pm2 restart whatsapp-events 2>/dev/null || \
  /opt/homebrew/bin/pm2 start dist/index.js --name whatsapp-events

echo ""
echo "=== Verifying routes ==="
sleep 3

# Check that new endpoints exist (should return 401, not 404)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  https://whatsapp.vonwongdaily.com/api/friends/local-import \
  -H "Content-Type: application/json" -d '{}')

if [ "$STATUS" = "401" ] || [ "$STATUS" = "400" ]; then
  echo "✓ /api/friends/local-import is live (HTTP $STATUS)"
else
  echo "✗ /api/friends/local-import returned HTTP $STATUS — route not registered"
  echo "  Check: grep -c 'local-import' dist/apps/friends/routes.js"
  exit 1
fi

echo ""
echo "=== Done — server is ready ==="
echo "Now run imports from your dev machine:"
echo "  node scripts/local-wa-import.js"
echo "  node scripts/local-imessage-import.js"
