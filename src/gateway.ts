import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLogger, format, transports } from 'winston';
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import http from "http";

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';

interface DebugConfig {
  level: LogLevel;
}

interface AuthConfig {
  basic?: {
    enabled: boolean;
    credentials: Array<{
      username: string;
      password: string;
    }>;
  };
  bearer?: {
    enabled: boolean;
    tokens: string[];
  };
}

interface ServerConfig {
  command: string;
  args: string[];
  path?: string;
}

interface GatewayConfig {
  hostname: string;
  port: number;
  debug?: DebugConfig;
  auth?: AuthConfig;
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
  private logger: ReturnType<typeof createLogger>;

  constructor(private config: GatewayConfig) {
    this.logger = createLogger({
      level: config.debug?.level || 'info',
      format: format.combine(
        format.timestamp(),
        format.colorize(),
        format.printf(({ level, message, timestamp, ...metadata }) => {
          let msg = `${timestamp} [${level}]: ${message}`;
          if (Object.keys(metadata).length > 0) {
            msg += ` ${JSON.stringify(metadata)}`;
          }
          return msg;
        })
      ),
      transports: [
        new transports.Console()
      ]
    });
  }

  private authenticateRequest(req: http.IncomingMessage): boolean {
    // If no auth config is present, allow all requests
    if (!this.config.auth) {
      this.logger.debug('No authentication configured, allowing request');
      return true;
    }

    const authHeader = req.headers.authorization;
    this.logger.verbose('Processing authentication header:', { header: authHeader });

    // Check Bearer token authentication
    if (this.config.auth.bearer?.enabled) {
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const isValid = this.config.auth.bearer.tokens.includes(token);
        this.logger.debug('Bearer token authentication result:', { isValid });
        if (isValid) return true;
      }
    }

    // Check Basic authentication
    if (this.config.auth.basic?.enabled) {
      if (authHeader?.startsWith('Basic ')) {
        const base64Credentials = authHeader.substring(6);
        const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
        const [username, password] = credentials.split(':');

        const validCredentials = this.config.auth.basic.credentials.some(
          cred => cred.username === username && cred.password === password
        );
        
        this.logger.debug('Basic authentication result:', { validCredentials });
        if (validCredentials) return true;
      }
    }

    this.logger.warn('Authentication failed for request');
    return false;
  }

  async start() {
    const httpServer = http.createServer(async (req, res) => {
      // Check authentication first
      if (!this.authenticateRequest(req)) {
        this.logger.warn('Unauthorized request rejected');
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="MCP Gateway", Bearer'
        }).end('Unauthorized');
        return;
      }

      const serverName = req.url?.split('/')[1].split('?')[0] || "";
      this.logger.debug('Incoming request:', {
        fullUrl: req.url,
        method: req.method,
        serverName,
        isConfigured: serverName ? !!this.config.servers[serverName] : false,
        configuredServers: Object.keys(this.config.servers)
      });

      if (!serverName || !this.config.servers[serverName] || !req.url) {
        this.logger.warn('404: Server not found or invalid URL path');
        res.writeHead(404).end();
        return;
      }

      // Handle root server path - establish SSE connection
      if (req.method === "GET") {
        this.logger.info(`New SSE connection for ${serverName}`);

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
          this.logger.debug(`Server instance created with sessionId: ${sessionId}`);

          // Bridge messages from STDIO to SSE
          server.stdioTransport.onmessage = (msg) => {
            this.logger.verbose('STDIO -> SSE:', msg);
            sseTransport.send(msg);
          };
          
          res.on('close', () => {
            this.logger.info(`SSE connection closed for ${sessionId}`);
            server.sseTransport.close();
            server.stdioTransport.close();  
            this.servers.delete(sessionId);
          });
          
          this.logger.info(`Starting transports for ${sessionId}`);
          await server.stdioTransport.start();
          await server.sseTransport.start();

        } catch (error) {
          this.logger.error('Error setting up SSE connection:', error);
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

            this.logger.verbose('SSE -> STDIO:', message);

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