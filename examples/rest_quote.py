#!/usr/bin/env python3
"""Request one public AssetFare quote without MCP, auth, or execution."""

from __future__ import annotations

import json
import math
import sys
import urllib.request


# USD 1 is reachability/schema smoke only. The representative default is USD
# 1,000 native USDC; always compare fresh alternatives at the intended amount.
amount_usd = float(sys.argv[1]) if len(sys.argv) > 1 else 1000
from_chain = sys.argv[2].lower() if len(sys.argv) > 2 else "solana"
from_token = sys.argv[3].upper() if len(sys.argv) > 3 else "USDC"
to_chain = sys.argv[4].lower() if len(sys.argv) > 4 else "base"
to_token = sys.argv[5].upper() if len(sys.argv) > 5 else "USDC"
if not math.isfinite(amount_usd) or amount_usd < 1:
    raise SystemExit("amount must be a finite USD number of at least 1")

payload = json.dumps(
    {
        "from_chain": from_chain,
        "from_token": from_token,
        "to_chain": to_chain,
        "to_token": to_token,
        "amount_usd": amount_usd,
    },
    separators=(",", ":"),
).encode()
request = urllib.request.Request(
    "https://api.assetfare.dev/v2/quote",
    data=payload,
    headers={
        "content-type": "application/json",
        "user-agent": "AssetFareRestQuoteExample/1",
    },
    method="POST",
)
with urllib.request.urlopen(request, timeout=15) as response:
    print(json.dumps(json.load(response), indent=2, sort_keys=True))
