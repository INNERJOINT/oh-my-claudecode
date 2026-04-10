/**
 * AOSP Code Search Tools
 *
 * Proxy tool that forwards code search requests to a remote AOSP MCP server.
 * Uses MCP Streamable HTTP protocol (session-based with SSE responses).
 * Endpoint: http://10.23.12.96:8888/mcp/
 */

import { z } from 'zod';
import type { ToolDefinition } from './types.js';

const AOSP_MCP_URL = process.env.AOSP_MCP_URL || 'http://10.23.12.96:8888/mcp/';
const AOSP_MCP_KEY = process.env.AOSP_MCP_KEY || 'sk-abc123';

interface McpToolResult {
  content?: Array<{ type: string; text: string }>;
  error?: string;
}

// Session management — lazily initialized, reused across calls
let sessionId: string | null = null;
let sessionInitPromise: Promise<string> | null = null;
let requestCounter = 0;

function nextId(): number {
  return ++requestCounter;
}

/**
 * Parse SSE response body and extract the JSON-RPC result.
 */
function parseSseResponse(body: string): unknown {
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();
      if (data) {
        return JSON.parse(data);
      }
    }
  }
  // Fallback: try parsing the whole body as JSON
  return JSON.parse(body);
}

/**
 * Send a JSON-RPC request to the AOSP MCP server.
 */
async function mcpPost(payload: Record<string, unknown>, sid?: string): Promise<{ body: string; headers: Headers; status: number }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${AOSP_MCP_KEY}`,
  };
  if (sid) {
    headers['Mcp-Session-Id'] = sid;
  }

  const res = await fetch(AOSP_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  return { body, headers: res.headers, status: res.status };
}

/**
 * Initialize MCP session: send initialize + notifications/initialized.
 * Returns the session ID.
 */
async function initSession(): Promise<string> {
  // Step 1: initialize
  const initRes = await mcpPost({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'omc-aosp', version: '1.0' },
    },
  });

  if (initRes.status !== 200) {
    throw new Error(`AOSP MCP initialize failed: ${initRes.status} — ${initRes.body}`);
  }

  const sid = initRes.headers.get('mcp-session-id');
  if (!sid) {
    throw new Error('AOSP MCP server did not return a session ID');
  }

  // Step 2: send initialized notification (fire-and-forget)
  await mcpPost(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    sid,
  ).catch(() => { /* notification failures are non-fatal */ });

  return sid;
}

/**
 * Get or create a session. Concurrent callers share the same init promise.
 */
async function getSession(): Promise<string> {
  if (sessionId) return sessionId;
  if (!sessionInitPromise) {
    sessionInitPromise = initSession().then((sid) => {
      sessionId = sid;
      sessionInitPromise = null;
      return sid;
    }).catch((err) => {
      sessionInitPromise = null;
      throw err;
    });
  }
  return sessionInitPromise;
}

/**
 * Call a method on the AOSP MCP server with session management.
 * Automatically retries once with a fresh session on 400/404 (stale session).
 */
async function callAospMcp(method: string, params: Record<string, unknown>): Promise<McpToolResult> {
  let sid = await getSession();

  const doCall = async (currentSid: string) => {
    const res = await mcpPost(
      { jsonrpc: '2.0', id: nextId(), method, params },
      currentSid,
    );

    if (res.status === 400 || res.status === 404) {
      // Session may be stale — reset and retry once
      sessionId = null;
      const newSid = await getSession();
      const retry = await mcpPost(
        { jsonrpc: '2.0', id: nextId(), method, params },
        newSid,
      );
      if (retry.status !== 200) {
        throw new Error(`AOSP MCP request failed after session refresh: ${retry.status} — ${retry.body}`);
      }
      return retry;
    }

    if (res.status !== 200) {
      throw new Error(`AOSP MCP request failed: ${res.status} — ${res.body}`);
    }

    return res;
  };

  const res = await doCall(sid);
  const json = parseSseResponse(res.body) as { result?: McpToolResult; error?: { message: string } };

  if (json.error) {
    throw new Error(`AOSP MCP error: ${json.error.message}`);
  }

  return json.result ?? { content: [{ type: 'text', text: JSON.stringify(json) }] };
}

export const aospCodeSearchTool: ToolDefinition<{
  tool: z.ZodString;
  arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
}> = {
  name: 'aosp_code_search',
  description: 'Search AOSP (Android Open Source Project) codebase via remote MCP server. Use the "tool" param to specify which remote tool to call (e.g. "search_code", "search_symbol", "search_file"), and "arguments" for tool-specific parameters.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  schema: {
    tool: z.string().describe('Remote AOSP MCP tool name to invoke (e.g. "search_code", "search_symbol", "search_file", "search_regex", "list_repos", "get_file_content", "list_tools")'),
    arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Arguments to pass to the remote tool as key-value pairs'),
  },
  handler: async (args) => {
    try {
      if (args.tool === 'list_tools') {
        const result = await callAospMcp('tools/list', {});
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      const result = await callAospMcp('tools/call', {
        name: args.tool,
        arguments: args.arguments ?? {},
      });

      return {
        content: result.content
          ? result.content.map(c => ({ type: 'text' as const, text: c.text }))
          : [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `AOSP MCP error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
};

export const aospTools = [aospCodeSearchTool];
