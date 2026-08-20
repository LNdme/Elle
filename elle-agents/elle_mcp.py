"""
Connexion MCP partagée vers elle-mcp-server.

Remplace l'ancien elle_tools.py (pont HTTP direct) : les agents parlent
maintenant le protocole MCP standard, et reçoivent automatiquement les 4
outils exposés par elle-mcp-server (create_draft, list_content,
get_content, search_content) sans avoir à les redéclarer ici.
"""
import os

from google.adk.tools.mcp_tool.mcp_session_manager import (
    StreamableHTTPConnectionParams,
)
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset


def get_elle_toolset() -> McpToolset:
    url = os.environ.get("ELLE_MCP_URL", "http://localhost:3001/mcp")
    return McpToolset(connection_params=StreamableHTTPConnectionParams(url=url))
