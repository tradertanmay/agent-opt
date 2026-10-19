import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { AgentOptimizerCore } from '../core/optimizer.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Lightweight, zero-dependency Model Context Protocol (MCP) server over stdio.
 * Exposes context ranking, targeted symbol slice reading, task verification, and verified project memory
 * to Claude Code, Cursor, OpenAI Codex, and Google Antigravity.
 */
export class AgentOptMcpServer {
  private core: AgentOptimizerCore;

  constructor(cwd: string) {
    this.core = new AgentOptimizerCore({ cwd });
  }

  public handleRpcRequest(req: JsonRpcRequest): JsonRpcResponse | null {
    const id = req.id ?? null;

    if (req.method === 'notifications/initialized') {
      return null;
    }

    if (req.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'agent-opt',
            version: '0.1.0',
          },
        },
      };
    }

    if (req.method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'agent_opt_query_context',
              description:
                'Ranks repository files, symbols, and 1-hop dependencies for a task query and returns targeted line-range slices.',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Task description, symbol name, or error message',
                  },
                },
                required: ['query'],
              },
            },
            {
              name: 'agent_opt_read_symbol_slice',
              description:
                'Reads only the exact definition lines of a specific function, class, or symbol in a file to save context tokens.',
              inputSchema: {
                type: 'object',
                properties: {
                  file_path: { type: 'string' },
                  symbol_name: { type: 'string' },
                },
                required: ['file_path', 'symbol_name'],
              },
            },
            {
              name: 'agent_opt_verify_task',
              description:
                'Evaluates current task verification status (VERIFIED, FAILED, NOT_VERIFIED) based on dirty files, test runs, and requirement checks.',
              inputSchema: {
                type: 'object',
                properties: {
                  session_id: { type: 'string' },
                },
              },
            },
            {
              name: 'agent_opt_get_memory',
              description:
                'Returns empirically verified project memories (build/test commands, module constraints, confirmed discoveries).',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
          ],
        },
      };
    }

    if (req.method === 'tools/call') {
      const params = req.params || {};
      const toolName = params.name as string;
      const args = (params.arguments as Record<string, unknown>) || {};

      try {
        if (toolName === 'agent_opt_query_context') {
          const query = String(args.query || '');
          const res = this.core.contextEngine.optimizeForQuery(query);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text:
                    res.compactRepoMap ||
                    'No matching files found for query.',
                },
              ],
            },
          };
        }

        if (toolName === 'agent_opt_read_symbol_slice') {
          const relFile = String(args.file_path || '');
          const symName = String(args.symbol_name || '');
          const graph = this.core.contextEngine.buildRepoGraph();
          const node = graph[relFile];
          if (!node) {
            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `File '${relFile}' not found in index.` }],
                isError: true,
              },
            };
          }
          const sym = node.symbols.find(
            (s) => s.name.toLowerCase() === symName.toLowerCase()
          );
          const absPath = path.resolve(this.core.cwd, relFile);
          const lines = fs.readFileSync(absPath, 'utf-8').split(/\r?\n/);
          const start = sym ? Math.max(1, sym.line - 2) : 1;
          const end = sym
            ? Math.min(lines.length, sym.endLine + 2)
            : Math.min(lines.length, 60);
          const slice = lines
            .slice(start - 1, end)
            .map((l, idx) => `${start + idx}: ${l}`)
            .join('\n');

          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: `// ${relFile}:L${start}-${end}\n${slice}`,
                },
              ],
            },
          };
        }

        if (toolName === 'agent_opt_verify_task') {
          const sessionId = String(args.session_id || 'default');
          const session = this.core.loadOrCreateSession(sessionId);
          const report = this.core.verificationEngine.evaluate(session);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(report, null, 2),
                },
              ],
            },
          };
        }

        if (toolName === 'agent_opt_get_memory') {
          const memText =
            this.core.memoryStore.formatMemoriesForPrompt() ||
            'No active verified project memories.';
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: memText }],
            },
          };
        }

        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${toolName}` },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  }

  public startStdio(): Promise<void> {
    return new Promise<void>((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        terminal: false,
      });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const req = JSON.parse(trimmed) as JsonRpcRequest;
          const resp = this.handleRpcRequest(req);
          if (resp) {
            process.stdout.write(JSON.stringify(resp) + '\n');
          }
        } catch {
          // Ignore malformed lines
        }
      });

      rl.on('close', () => {
        resolve();
      });
    });
  }
}
