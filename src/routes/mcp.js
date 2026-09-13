/**
 * Model Context Protocol (MCP) Server Endpoint
 * Protocol: MCP 2026-07-28 (Stateless Streamable HTTP)
 *
 * Provides native tools for Edge AI agents (e.g. Gemini Spark) to interact
 * directly with the Cloudflare D1 database.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { McpServer } from '@cloudflare/mcp-server/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@cloudflare/mcp-server/server/webStandardStreamableHttp.js';

const mcpRouter = new Hono();

// Intercept requests and verify Authorization: Bearer <MCP_SECRET_KEY>
mcpRouter.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const secretKey = c.env?.MCP_SECRET_KEY;

  if (!secretKey || authHeader !== `Bearer ${secretKey}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});

/**
 * Creates and configures a fresh McpServer instance for a stateless request.
 */
export function createMcpServer(env) {
  const server = new McpServer({
    name: 'aflac-field-prospecting-mcp',
    version: '1.0.0'
  });

  server.tool(
    'update_lead_intel',
    'Updates the pipeline stage and appends field notes/intelligence to a company in the PWA database.',
    {
      company_name: z.string().describe('Fuzzy matching target company name'),
      pipeline_stage: z.string().optional().describe('Pipeline stage to update'),
      new_notes: z.string().optional().describe('Field notes or intelligence to append')
    },
    async ({ company_name, pipeline_stage, new_notes }) => {
      if (!company_name || !company_name.trim()) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Error: company_name parameter is required.' }]
        };
      }

      const pattern = `%${company_name.trim()}%`;
      const { results } = await env.DB.prepare(
        'SELECT company_id, company_name, pipeline_stage, notes FROM companies WHERE company_name LIKE ?'
      ).bind(pattern).all();

      const matches = Array.isArray(results) ? results : [];

      if (matches.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: No company found matching "${company_name}". Please refine your query.` }]
        };
      }

      if (matches.length > 1) {
        const matchedList = matches.map(m => `"${m.company_name}" (${m.company_id})`).join(', ');
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: Multiple companies (${matches.length}) matched "${company_name}": [${matchedList}]. Please refine your query.` }]
        };
      }

      const target = matches[0];
      const stageToUpdate = pipeline_stage ? pipeline_stage.trim() : null;
      const notesToAppend = new_notes && new_notes.trim() ? new_notes.trim() : null;

      await env.DB.prepare(`
        UPDATE companies
        SET pipeline_stage = COALESCE(?, pipeline_stage),
            notes = CASE
              WHEN ? IS NOT NULL THEN COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE '\n' END || '[' || CURRENT_DATE || '] ' || ?
              ELSE notes
            END
        WHERE company_id = ?
      `).bind(stageToUpdate, notesToAppend, notesToAppend, target.company_id).run();

      return {
        content: [{
          type: 'text',
          text: `Successfully updated company "${target.company_name}" (${target.company_id}).`
        }]
      };
    }
  );

  return server;
}

mcpRouter.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createMcpServer(c.env);
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default mcpRouter;
