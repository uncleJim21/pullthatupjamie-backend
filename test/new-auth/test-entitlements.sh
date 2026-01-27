#!/bin/bash

# Test: Entitlement Middleware
# 
# Prerequisites:
#   - Backend running on port 4132
#   - TEST_TOKEN environment variable set (from signin flow)
#
# Usage: ./test-entitlements.sh [token]

BACKEND_SERVER="http://localhost:4132"

# Use provided token or env var
TOKEN="${1:-$TEST_TOKEN}"

if [ -z "$TOKEN" ]; then
  echo "❌ No token provided!"
  echo ""
  echo "Usage: ./test-entitlements.sh <token>"
  echo "Or: export TEST_TOKEN=<token> && ./test-entitlements.sh"
  exit 1
fi

echo "=========================================="
echo "Testing Entitlement Middleware"
echo "=========================================="
echo ""
echo "Backend: $BACKEND_SERVER"
echo "Token: ${TOKEN:0:50}..."
echo ""

# ─────────────────────────────────────────────
# Step 1: Test Identity Resolution
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 1: Test Identity Resolution"
echo "─────────────────────────────────────────"

curl -s "$BACKEND_SERVER/api/debug/test-identity" \
  -H "Authorization: Bearer $TOKEN"
echo ""
echo ""

# ─────────────────────────────────────────────
# Step 2: Test Entitlement Check
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 2: Test Entitlement (searchQuotes)"
echo "─────────────────────────────────────────"

curl -s "$BACKEND_SERVER/api/debug/test-entitlement/searchQuotes" \
  -H "Authorization: Bearer $TOKEN"
echo ""
echo ""

# ─────────────────────────────────────────────
# Step 3: Test Another Entitlement Type
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 3: Test Entitlement (search3D)"
echo "─────────────────────────────────────────"

curl -s "$BACKEND_SERVER/api/debug/test-entitlement/search3D" \
  -H "Authorization: Bearer $TOKEN"
echo ""
echo ""

# ─────────────────────────────────────────────
# Step 4: Test Anonymous Access
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 4: Test Anonymous Entitlement"
echo "─────────────────────────────────────────"

curl -s "$BACKEND_SERVER/api/debug/test-entitlement/searchQuotes"
echo ""
echo ""

# ─────────────────────────────────────────────
# Step 5: Check Quota Headers
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 5: Check Quota Headers"
echo "─────────────────────────────────────────"

curl -s -D - "$BACKEND_SERVER/api/debug/test-entitlement/searchQuotes" \
  -H "Authorization: Bearer $TOKEN" \
  -o /dev/null | grep -i "X-Quota"
echo ""

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo "=========================================="
echo "Test Complete"
echo "=========================================="
