#!/bin/bash
# Legacy install: copies the v1.0.2-era plugin into a dsh source checkout.
# The current layout ships as a Profile Bundle instead — prefer:
#   dsh plugin --profile web add github:angelky7/dsh-browser-control#v1.0.3
# Usage: ./install.sh /path/to/deepseek-harness
set -e

DSH_DIR="${1:?Usage: ./install.sh /path/to/deepseek-harness}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$DSH_DIR/packages/web/browser-bridge"

if [ ! -d "$SCRIPT_DIR/plugin" ]; then
  echo "This checkout no longer carries the legacy plugin/ layout."
  echo "For the in-tree install, restore it from the v1.0.2 tag first:"
  echo "  git checkout v1.0.2 -- plugin tsconfig.json"
  echo "Or use the one-line profile install instead:"
  echo "  dsh plugin --profile web add github:angelky7/dsh-browser-control#v1.0.3"
  exit 1
fi

echo "Installing dsh-browser-bridge to $TARGET ..."
mkdir -p "$TARGET"
cp -r "$SCRIPT_DIR/plugin/." "$TARGET/"
echo ""
echo "Done! Now configure dsh:"
echo "  1. cordis.patch.yml — see dsh-config/README.md"
echo "  2. package.json — add dependency"
echo "  3. tsconfig.host.json — add reference"
echo "  4. Restart dsh"
