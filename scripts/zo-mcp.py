#!/usr/bin/env python3
"""Call a Zo MCP tool over HTTP: zo-mcp.py <tool> ['<json-args>']

Use when the in-session `zo` MCP server is unavailable, or from a script that has no
MCP client of its own. Requires ZO_MCP_API_KEY (or ZO_CLIENT_IDENTITY_TOKEN).
"""
import json
import sys

from zolib import tool

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        raise SystemExit(0)
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(tool(sys.argv[1], args))
