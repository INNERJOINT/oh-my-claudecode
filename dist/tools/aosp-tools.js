/**
 * AOSP Code Search Tools
 *
 * Proxy tool that forwards code search requests to a remote AOSP MCP server.
 * Uses MCP Streamable HTTP protocol (session-based with SSE responses).
 * Endpoint: configurable via AOSP_MCP_URL env var
 */
import { z } from 'zod';
const AOSP_MCP_URL = (process.env.AOSP_MCP_URL || 'http://10.23.12.96:8888/mcp').replace(/\/+$/, '');
const AOSP_MCP_KEY = process.env.AOSP_MCP_KEY || 'sk-abc123';
// Session management — lazily initialized, reused across calls
let sessionId = null;
let sessionInitPromise = null;
let requestCounter = 0;
// Detected server schema format: if true, arguments must be wrapped in {inp: {...}}
let needsInpWrapping = null;
function nextId() {
    return ++requestCounter;
}
/**
 * Parse SSE response body and extract the JSON-RPC result.
 */
function parseSseResponse(body) {
    const lines = body.split('\n');
    const events = [];
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data) {
                try {
                    events.push(JSON.parse(data));
                }
                catch {
                    // skip malformed SSE data lines
                }
            }
        }
    }
    // Return the last JSON-RPC response (has 'id' + 'result'/'error'), skipping notifications
    for (let i = events.length - 1; i >= 0; i--) {
        const evt = events[i];
        if (evt && typeof evt === 'object' && 'id' in evt && ('result' in evt || 'error' in evt)) {
            return evt;
        }
    }
    // Fallback: return last event or try parsing whole body
    if (events.length > 0)
        return events[events.length - 1];
    return JSON.parse(body);
}
/**
 * Send a JSON-RPC request to the AOSP MCP server.
 */
async function mcpPost(payload, sid) {
    const headers = {
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
async function initSession() {
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
    await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid).catch(() => { });
    return sid;
}
/**
 * Get or create a session. Concurrent callers share the same init promise.
 */
async function getSession() {
    if (sessionId)
        return sessionId;
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
 * Detect whether the remote server requires arguments wrapped in {inp: {...}}.
 * Checks the inputSchema of the first tool from tools/list — if its top-level
 * properties contain only an "inp" key with a $ref, the server uses inp wrapping.
 */
async function detectInpWrapping() {
    if (needsInpWrapping !== null)
        return needsInpWrapping;
    const result = await callAospMcp('tools/list', {});
    const tools = result.tools;
    if (!tools || tools.length === 0) {
        needsInpWrapping = false;
        return false;
    }
    const firstSchema = tools[0].inputSchema;
    const props = firstSchema?.properties;
    if (props && Object.keys(props).length === 1 && 'inp' in props) {
        needsInpWrapping = true;
    }
    else {
        needsInpWrapping = false;
    }
    return needsInpWrapping;
}
/**
 * Call a method on the AOSP MCP server with session management.
 * Automatically retries once with a fresh session on 400/404 (stale session).
 */
async function callAospMcp(method, params) {
    let sid = await getSession();
    const doCall = async (currentSid) => {
        const res = await mcpPost({ jsonrpc: '2.0', id: nextId(), method, params }, currentSid);
        if (res.status === 400 || res.status === 404) {
            // Session may be stale — reset and retry once
            sessionId = null;
            needsInpWrapping = null;
            const newSid = await getSession();
            const retry = await mcpPost({ jsonrpc: '2.0', id: nextId(), method, params }, newSid);
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
    const json = parseSseResponse(res.body);
    if (json.error) {
        throw new Error(`AOSP MCP error: ${json.error.message}`);
    }
    return json.result ?? { content: [{ type: 'text', text: JSON.stringify(json) }] };
}
export const aospCodeSearchTool = {
    name: 'sourcepilot',
    description: 'Search AOSP (Android Open Source Project) codebase via remote MCP server. Use the "tool" param to specify which remote tool to call (e.g. "list_projects", "search_code", "search_symbol", "search_file"), and "arguments" for tool-specific parameters. The tool auto-detects whether the server requires arguments wrapped in an "inp" object.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    schema: {
        tool: z.string().describe('Remote AOSP MCP tool name to invoke (e.g. "list_projects", "search_code", "search_symbol", "search_file", "search_regex", "list_repos", "get_file_content", "list_tools")'),
        arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('Arguments to pass to the remote tool as key-value pairs'),
    },
    handler: async (args) => {
        try {
            if (args.tool === 'list_tools') {
                const result = await callAospMcp('tools/list', {});
                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            }
            const useInp = await detectInpWrapping();
            const toolArguments = useInp ? { inp: args.arguments ?? {} } : (args.arguments ?? {});
            const result = await callAospMcp('tools/call', {
                name: args.tool,
                arguments: toolArguments,
            });
            return {
                content: result.content
                    ? result.content.map(c => ({ type: 'text', text: c.text }))
                    : [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            };
        }
        catch (error) {
            return {
                content: [{ type: 'text', text: `AOSP MCP error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
            };
        }
    },
};
export const aospTools = [aospCodeSearchTool];
//# sourceMappingURL=aosp-tools.js.map