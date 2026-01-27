#!/bin/bash

# Test: New Auth Signup Flow
# 
# Prerequisites:
#   - Auth server running on port 6161
#   - Backend running on port 4132
#
# Usage: ./test-signup-flow.sh [email]

AUTH_SERVER="http://localhost:6161"
BACKEND_SERVER="http://localhost:4132"

# Generate unique email if not provided
EMAIL="${1:-test+$(date +%s)@example.com}"
PASSWORD="testpass123"

echo "=========================================="
echo "Testing New Auth Signup Flow"
echo "=========================================="
echo ""
echo "Auth Server: $AUTH_SERVER"
echo "Backend: $BACKEND_SERVER"
echo "Test Email: $EMAIL"
echo ""

# ─────────────────────────────────────────────
# Step 1: Signup on Auth Server
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 1: Signup"
echo "─────────────────────────────────────────"

SIGNUP_RESPONSE=$(curl -s -X POST "$AUTH_SERVER/auth/signup" \
  -H "Content-Type: application/json" \
  -d "{
    \"provider\": \"email\",
    \"credentials\": {
      \"email\": \"$EMAIL\",
      \"password\": \"$PASSWORD\"
    }
  }")

echo "Response: $SIGNUP_RESPONSE"
echo ""

# Extract token
TOKEN=$(echo "$SIGNUP_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get token from signup"
  echo "Full response: $SIGNUP_RESPONSE"
  exit 1
fi

echo "✅ Got JWT token: ${TOKEN:0:50}..."
echo ""

# ─────────────────────────────────────────────
# Step 2: Test Backend Debug Endpoint
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 2: Test Backend (debug/user-docs)"
echo "─────────────────────────────────────────"

DEBUG_RESPONSE=$(curl -s "$BACKEND_SERVER/api/debug/user-docs" \
  -H "Authorization: Bearer $TOKEN")

echo "Response: $DEBUG_RESPONSE"
echo ""

# Check if user was found
if echo "$DEBUG_RESPONSE" | grep -q "\"count\":1"; then
  echo "✅ User found in backend"
else
  echo "⚠️  User might not be found (check response)"
fi
echo ""

# ─────────────────────────────────────────────
# Step 3: Test Search Quotes (with entitlement)
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 3: Test Search Quotes Endpoint"
echo "─────────────────────────────────────────"
echo "(This would test entitlement middleware once applied)"
echo ""

# For now, just test that we can reach search-quotes-3d
SEARCH_RESPONSE=$(curl -s -X POST "$BACKEND_SERVER/api/search-quotes-3d" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "searchQuery": "test query",
    "limit": 1
  }' \
  -w "\nHTTP Status: %{http_code}")

echo "Response (truncated): ${SEARCH_RESPONSE:0:500}..."
echo ""

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo "=========================================="
echo "Summary"
echo "=========================================="
echo ""
echo "Email: $EMAIL"
echo "Password: $PASSWORD"
echo "Token: ${TOKEN:0:80}..."
echo ""
echo "Save this token for signin test:"
echo "export TEST_TOKEN=\"$TOKEN\""
echo ""
