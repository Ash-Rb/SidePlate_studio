#!/bin/bash
# macOS: double-click to start Sideplate Studio.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS version from https://nodejs.org, then try again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi
node server/index.js
