import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import http from "http";

interface ServerConfig {
  command: string;
  args: string[];
  path?: string;
}

interface GatewayConfig {
  hostname: string;
  port: number;
  servers: Record<string, ServerConfig>;
}

class MCPServer {
    constructor(
        public stdioTransport: StdioClientTransport,
        public sseTransport: SSEServerTransport
    ) {}
}

class MCPGateway {
  private servers: Map<string, MCPServer> = new Map();

  constructor(private config: GatewayConfig) { }

  async start() {
    const httpServer = http.createServer(async (req, res) => {
      const serverName = req.url?.split('/')[1].split('?')[0] || "";
      console.debug({
        fullUrl: req.url,
        method: req.method,
        serverName,
        isConfigured: serverName ? !!this.config.servers[serverName] : false,
        configuredServers: Object.keys(this.config.servers)
      });

      if (!serverName || !this.config.servers[serverName] || !req.url) {
        console.log('404: Server not found or invalid URL path');
        res.writeHead(404).end();
        return;
      }

      // Handle root server path - establish SSE connection
      if (req.method === "GET") {
        console.log(`New SSE connection for ${serverName}`);

        try {
          const serverConfig = this.config.servers[serverName];
          const stdioTransport = new StdioClientTransport({
            command: serverConfig.command,
            args: serverConfig.args,
            env: process.env as Record<string, string>,
          });

          // Create SSE transport with just the path portion
          const sseTransport = new SSEServerTransport(`/${serverName}`, res);
          const server = new MCPServer(stdioTransport, sseTransport);
          const sessionId = req.url + "?sessionId=" + sseTransport.sessionId;

          // Store server info
          this.servers.set(sessionId, server);

          // Bridge messages from STDIO to SSE
          server.stdioTransport.onmessage = (msg) => {
            sseTransport.send(msg);
          };
          
          res.on('close', () => {
            console.log(`SSE connection closed for ${sessionId}`);
            server.sseTransport.close();
            server.stdioTransport.close();  
            this.servers.delete(sessionId);
          });
          
          console.log(`Starting transports for ${sessionId}`);
          await server.stdioTransport.start();
          await server.sseTransport.start();

        } catch (error) {
          console.error('Error setting up SSE connection:', error);
          res.writeHead(500).end(String(error));
        }
        return;
      }

      // Handle message endpoint
      if (req.method === "POST") {
        const sessionId = req.url!;
        const server = this.servers.get(sessionId);
        if (!server?.sseTransport) {
          res.writeHead(400).end("No active transport for session " + sessionId);
          return;
        }

        // Read the POST body
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });

        req.on('end', async () => {
          try {
            // Parse and forward message to STDIO server
            const message = JSON.parse(body);
            await server.stdioTransport.send(message);

            // Send success response
            res.writeHead(202).end();
          } catch (error) {
            console.error('Error handling message:', error);
            res.writeHead(500).end(String(error));
          }
        });
        return;
      }

      res.writeHead(404).end();
    });

    httpServer.listen(this.config.port, this.config.hostname);
    console.log(`MCP Gateway listening on ${this.config.hostname}:${this.config.port}`);
  }
}

// Load config from YAML file
const configPath = process.env.CONFIG_PATH || './config.yaml';
console.log(`Loading configuration from ${configPath}`);

try {
  const configFile = readFileSync(configPath, 'utf8');
  const config = parse(configFile) as GatewayConfig;

  // Validate required config fields
  if (!config.hostname) {
    config.hostname = '0.0.0.0'; // Default to all interfaces if not specified
    console.log('No hostname specified, defaulting to 0.0.0.0');
  }
  if (!config.port) {
    throw new Error('Port must be specified in config');
  }
  if (!config.servers || Object.keys(config.servers).length === 0) {
    throw new Error('At least one server must be configured');
  }

  // Start gateway with loaded config
  const gateway = new MCPGateway(config);
  gateway.start().catch(error => {
    console.error('Failed to start gateway:', error);
    process.exit(1);
  });
} catch (error) {
  console.error('Failed to load configuration:', error);
  process.exit(1);
}