#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Mesh2MotionSession } from './session.js'
import { register_tools, SERVER_INSTRUCTIONS } from './tools.js'

const session = new Mesh2MotionSession()
const server = new McpServer(
  { name: 'mesh2motion', version: '0.1.0' },
  { instructions: SERVER_INSTRUCTIONS }
)
register_tools(server, session)

let closing = false
async function shutdown (): Promise<void> {
  if (closing) return
  closing = true
  await session.close()
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
process.stdin.on('close', () => { void shutdown() })

await server.connect(new StdioServerTransport())
console.error('mesh2motion MCP server running on stdio')
session.prepare_browser()
