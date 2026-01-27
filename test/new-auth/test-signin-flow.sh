#!/bin/bash

# Test: New Auth Signin Flow
# 
# Prerequisites:
#   - Auth server running on port 6161
#   - Backend running on port 4132
#   - User already exists (run test-signup-flow.sh first)
#
# Usage: ./test-signin-flow.sh <email> <password>

AUTH_SERVER="http://localhost:6161"
BACKEND_SERVER="http://localhost:4132"

# Use provided credentials or defaults
EMAIL="${1:-jim.carucci+wim@protonmail.com}"
PASSWORD="${2:-testpass123}"

echo "=========================================="
echo "Testing New Auth Signin Flow"
echo "=========================================="
echo ""
echo "Auth Server: $AUTH_SERVER"
echo "Backend: $BACKEND_SERVER"
echo "Email: $EMAIL"
echo ""

# ─────────────────────────────────────────────
# Step 1: Signin on Auth Server
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 1: Signin"
echo "─────────────────────────────────────────"

SIGNIN_RESPONSE=$(curl -s -X POST "$AUTH_SERVER/auth/signin" \
  -H "Content-Type: application/json" \
  -d "{
    \"provider\": \"email\",
    \"credentials\": {
      \"email\": \"$EMAIL\",
      \"password\": \"$PASSWORD\"
    }
  }")

echo "Response: $SIGNIN_RESPONSE"
echo ""

# Extract token
TOKEN=$(echo "$SIGNIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get token from signin"
  echo "Full response: $SIGNIN_RESPONSE"
  exit 1
fi

echo "✅ Got JWT token: ${TOKEN:0:50}..."
echo ""

# Decode JWT payload (base64 decode middle part)
JWT_PAYLOAD=$(echo "$TOKEN" | cut -d'.' -f2 | base64 -d 2>/dev/null || echo "$TOKEN" | cut -d'.' -f2 | base64 -D 2>/dev/null)
echo "JWT Payload: $JWT_PAYLOAD"
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

# ─────────────────────────────────────────────
# Step 3: Test Identity Resolution
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 3: Test Identity Resolution"
echo "─────────────────────────────────────────"
echo "(Requires test endpoint - skip if not available)"
echo ""

# Try to hit a test endpoint that shows identity
IDENTITY_RESPONSE=$(curl -s "$BACKEND_SERVER/api/debug/identity" \
  -H "Authorization: Bearer $TOKEN" 2>/dev/null)

if [ -n "$IDENTITY_RESPONSE" ]; then
  echo "Response: $IDENTITY_RESPONSE"
else
  echo "Endpoint not available (expected during development)"
fi
echo ""

# ─────────────────────────────────────────────
# Step 4: Test Anonymous Access
# ─────────────────────────────────────────────
echo "─────────────────────────────────────────"
echo "Step 4: Test Anonymous Access (no token)"
echo "─────────────────────────────────────────"

ANON_RESPONSE=$(curl -s "$BACKEND_SERVER/api/debug/identity" 2>/dev/null)

if [ -n "$ANON_RESPONSE" ]; then
  echo "Response: $ANON_RESPONSE"
else
  echo "Endpoint not available (expected during development)"
fi
echo ""

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo "=========================================="
echo "Summary"
echo "=========================================="
echo ""
echo "Token obtained successfully!"
echo ""
echo "To use this token in subsequent tests:"
echo "export TEST_TOKEN=\"$TOKEN\""
echo ""
echo "Example curl command:"
echo "curl -H \"Authorization: Bearer \$TEST_TOKEN\" $BACKEND_SERVER/api/debug/user-docs"
echo ""
