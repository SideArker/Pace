import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'pace-external-fixture', version: '1.0.0' });
server.registerTool('pace_echo', {
  description: 'Echo a value for the external MCP integration test.',
  inputSchema: { value: z.string() },
}, async ({ value }) => ({ content: [{ type: 'text', text: `${process.env.PACE_MCP_TEST_VALUE}:${value}` }] }));
await server.connect(new StdioServerTransport());
