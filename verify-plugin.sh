#!/bin/bash
# verify-plugin.sh - Verify ArmorIQ plugin is working

set -e

echo "🔍 ArmorIQ OpenClaw Plugin Verification"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check 1: Plugin installed
echo "1️⃣  Checking if plugin is installed..."
if openclaw plugins list 2>/dev/null | grep -q "armoriq"; then
    echo -e "${GREEN}✅ Plugin is installed${NC}"
else
    echo -e "${RED}❌ Plugin NOT installed${NC}"
    echo "   Run: openclaw plugins install ."
    exit 1
fi

# Check 2: Plugin enabled
echo ""
echo "2️⃣  Checking if plugin is enabled..."
if openclaw config get plugins.entries.armoriq.enabled 2>/dev/null | grep -q "true"; then
    echo -e "${GREEN}✅ Plugin is enabled${NC}"
else
    echo -e "${RED}❌ Plugin NOT enabled${NC}"
    echo "   Run: openclaw config set plugins.entries.armoriq.enabled true"
    exit 1
fi

# Check 3: Plugin files exist
echo ""
echo "3️⃣  Checking plugin files..."
PLUGIN_DIR="$HOME/.openclaw/extensions/armoriq"
if [ -f "$PLUGIN_DIR/dist/index.js" ]; then
    echo -e "${GREEN}✅ Plugin files found at $PLUGIN_DIR${NC}"
else
    echo -e "${RED}❌ Plugin files NOT found${NC}"
    echo "   Expected: $PLUGIN_DIR/dist/index.js"
    exit 1
fi

# Check 4: Configuration
echo ""
echo "4️⃣  Checking configuration..."
API_KEY=$(openclaw config get plugins.entries.armoriq.apiKey 2>/dev/null || echo "")
if [ -n "$API_KEY" ] && [ "$API_KEY" != "undefined" ]; then
    echo -e "${GREEN}✅ API key configured${NC}"
else
    echo -e "${YELLOW}⚠️  API key not configured${NC}"
    echo "   Run: openclaw config set plugins.entries.armoriq.apiKey 'ak_live_xxx'"
fi

USER_ID=$(openclaw config get plugins.entries.armoriq.userId 2>/dev/null || echo "")
if [ -n "$USER_ID" ] && [ "$USER_ID" != "undefined" ]; then
    echo -e "${GREEN}✅ User ID configured${NC}"
else
    echo -e "${YELLOW}⚠️  User ID not configured${NC}"
    echo "   Run: openclaw config set plugins.entries.armoriq.userId 'user-123'"
fi

# Check 5: Test gateway startup
echo ""
echo "5️⃣  Testing gateway startup (this may take a moment)..."
LOG_FILE="/tmp/openclaw-verify-$$.log"
timeout 10 openclaw gateway run --verbose > "$LOG_FILE" 2>&1 &
GATEWAY_PID=$!
sleep 5

if grep -q "armoriq" "$LOG_FILE" 2>/dev/null; then
    echo -e "${GREEN}✅ ArmorIQ plugin loaded in gateway${NC}"
    echo ""
    echo "   Plugin logs found:"
    grep -i "armoriq" "$LOG_FILE" | head -5 | sed 's/^/   /'
else
    echo -e "${RED}❌ ArmorIQ plugin NOT loaded in gateway${NC}"
    echo ""
    echo "   Gateway logs:"
    tail -20 "$LOG_FILE" | sed 's/^/   /'
fi

# Cleanup
kill $GATEWAY_PID 2>/dev/null || true
rm -f "$LOG_FILE"

echo ""
echo "========================================"
echo "✨ Verification Complete"
echo ""
echo "Next steps:"
echo "  1. Start gateway: openclaw gateway run"
echo "  2. Send test message: openclaw agent --message 'Hello'"
echo "  3. Check logs for ArmorIQ interception"
echo ""
echo "For detailed testing: see TESTING.md"
