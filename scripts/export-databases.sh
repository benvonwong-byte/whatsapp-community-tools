#!/bin/bash
# Run this on vonwong to copy local databases into the Dropbox project folder.
# After this, pandaclaw can run the imports without needing this machine.
#
# Usage: bash scripts/export-databases.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"
mkdir -p "$DATA_DIR"

echo "=== Exporting databases to Dropbox ==="

# WhatsApp Mac app
WA_SRC="$HOME/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"
if [ -f "$WA_SRC" ]; then
  cp "$WA_SRC" "$DATA_DIR/ChatStorage.sqlite"
  echo "✓ WhatsApp: $(du -sh "$DATA_DIR/ChatStorage.sqlite" | cut -f1)"
else
  echo "✗ WhatsApp database not found at: $WA_SRC"
fi

# iMessage
IMSG_SRC="$HOME/Library/Messages/chat.db"
if [ -f "$IMSG_SRC" ]; then
  cp "$IMSG_SRC" "$DATA_DIR/chat.db"
  echo "✓ iMessage: $(du -sh "$DATA_DIR/chat.db" | cut -f1)"
else
  echo "✗ iMessage database not found at: $IMSG_SRC"
fi

# macOS Contacts — only copy the .abcddb files needed for phone→name lookup
AB_SRC="$HOME/Library/Application Support/AddressBook/Sources"
COUNT=0
if [ -d "$AB_SRC" ]; then
  mkdir -p "$DATA_DIR/AddressBook/Sources"
  for SRC_DIR in "$AB_SRC"/*/; do
    DB="$SRC_DIR/AddressBook-v22.abcddb"
    if [ -f "$DB" ]; then
      DEST="$DATA_DIR/AddressBook/Sources/$(basename "$SRC_DIR")"
      mkdir -p "$DEST"
      cp "$DB" "$DEST/AddressBook-v22.abcddb"
      COUNT=$((COUNT + 1))
    fi
  done
  echo "✓ Contacts: $COUNT AddressBook-v22.abcddb file(s)"
else
  echo "✗ AddressBook not found"
fi

echo ""
echo "=== Done ==="
echo "Dropbox will now sync data/ to pandaclaw."
echo "Once synced, run on pandaclaw:"
echo "  bash scripts/run-all.sh"
