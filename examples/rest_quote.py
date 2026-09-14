#!/usr/bin/env python3
"""Request one public AssetFare quote without MCP, auth, or execution."""

from __future__ import annotations

import json
import sys
import urllib.request


amount_usd = int(sys.argv[1]) if len(sys.argv) > 1 else 300
if not 250 <= amount_usd <= 1000:
    raise SystemExit("amount must be a whole USD value from 250 through 1000")

payload = json.dumps(
    {
        "from_chain": "solana",
        "from_token": "SOL",
        "to_chain": "base",
        "to_token": "ETH",
        "amount_usd": amount_usd,
    },
    separators=(",", ":"),
).encode()
request = urllib.request.Request(
    "https://api.assetfare.dev/v1/quote",
    data=payload,
    headers={
        "content-type": "application/json",
        "user-agent": "AssetFareRestQuoteExample/1",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=15) as response:
    print(json.dumps(json.load(response), indent=2, sort_keys=True))
