/**
 * AOSP Code Search Tools
 *
 * Proxy tool that forwards code search requests to a remote AOSP MCP server.
 * Uses MCP Streamable HTTP protocol (session-based with SSE responses).
 * Endpoint: http://10.23.12.96:8888/mcp/
 */
import { z } from 'zod';
import type { ToolDefinition } from './types.js';
export declare const aospCodeSearchTool: ToolDefinition<{
    tool: z.ZodString;
    arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
}>;
export declare const aospTools: ToolDefinition<{
    tool: z.ZodString;
    arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<[z.ZodString, z.ZodNumber, z.ZodBoolean]>>>;
}>[];
//# sourceMappingURL=aosp-tools.d.ts.map