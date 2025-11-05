#!/bin/bash

echo "========================================="
echo "Test 1: Search with episode name filter"
echo "========================================="
echo "Searching for 'dreams' with episode filter 'Doctor Who Escaped'"
echo ""

curl -s 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "dreams unconscious personality",
    "limit": 5,
    "feedIds": ["6708272"],
    "episodeName": "Doctor Who Escaped"
  }' | jq '.'

echo ""
echo ""
echo "========================================="
echo "Test 2: Date range filter"
echo "========================================="
echo "Searching for content published in November 2025"
echo ""

curl -s 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "dreams unconscious",
    "limit": 5,
    "feedIds": ["6708272"],
    "minDate": "2025-11-01",
    "maxDate": "2025-11-30"
  }' | jq '.'

echo ""
echo ""
echo "========================================="
echo "Test 3: Combined filters"
echo "========================================="
echo "Searching with BOTH episode name AND date filters"
echo ""

curl -s 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "unconscious dreams nature journal",
    "limit": 5,
    "feedIds": ["6708272"],
    "episodeName": "Fiat Medicine",
    "minDate": "2025-11-01",
    "maxDate": "2025-12-31"
  }' | jq '.'

echo ""
echo ""
echo "========================================="
echo "Test 4: Partial episode name match"
echo "========================================="
echo "Testing substring matching with 'Bitcoin'"
echo ""

curl -s 'http://localhost:4132/api/search-quotes' \
  -H 'Content-Type: application/json' \
  --data-raw '{
    "query": "doctor medicine health",
    "limit": 5,
    "feedIds": ["6708272"],
    "episodeName": "Bitcoin"
  }' | jq '.'

echo ""
echo "========================================="
echo "All tests complete!"
echo "========================================="

