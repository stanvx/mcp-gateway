import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLogger, format, transports } from 'winston';
import { parse } from 'yaml';
import { readFileSync } from 'fs';
import http from "http";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { stringify } from "yaml";
import { randomUUID } from "crypto";

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

// We’ll store session info and track timeouts
interface SessionData {
  serverProcess: StdioClientTransport;
  lastActive: number; // timestamp of last request
}

const SESSION_TIMEOUT_MS = 10 * 60_000; // 10 minutes
const sessions: Map<string, SessionData> = new Map();

// Periodically clean up expired sessions
setInterval(() => {
  cleanupExpiredSessions();
}, 30_000); // check every 30s

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, data] of sessions.entries()) {
    if (now - data.lastActive > SESSION_TIMEOUT_MS) {
      data.serverProcess.close().catch(() => {});
      sessions.delete(sessionId);
    }
  }
}

// Creates or reuses a session (restarts process if timed out)
async function getOrCreateSession(sessionId: string, serverName: string, config: ServerConfig) {
  // If existing session is found and not timed out, reuse
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastActive = Date.now();
    return existing.serverProcess;
  }

  // Otherwise, create a new STDIO transport
  const stdioTransport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: process.env as Record<string, string>
  });

  await stdioTransport.start();

  // Store in sessions
  sessions.set(sessionId, {
    serverProcess: stdioTransport,
    lastActive: Date.now()
  });

  return stdioTransport;
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

      // If it starts with /api/, it’s a REST call
      if ((req.url || "").startsWith("/api/")) {
        await handleRestRequest(req, res, this.config);
        return;
      }

      // Otherwise, fallback to SSE logic
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
    this.logger.info(`MCP Gateway listening on ${this.config.hostname}:${this.config.port}`);
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

  // 1) We'll parse arguments for schemaDump, schemaFormat
  const argv = await yargs(hideBin(process.argv))
    .option('schemaDump', { type: 'boolean', default: false })
    .option('schemaFormat', { type: 'string', default: 'yaml' })
    .argv;

  // 2) If schemaDump, gather all tools and dump. Then exit.
  if (argv.schemaDump) {
    dumpSchemas(config, argv.schemaFormat === 'json' ? 'json' : 'yaml')
      .then(() => process.exit(0))
      .catch(err => {
        console.error(err);
        process.exit(1);
      });
  } else {
    // Otherwise, proceed with normal gateway startup
    const gateway = new MCPGateway(config);
    gateway.start().catch(error => {
      console.error('Failed to start gateway:', error);
      process.exit(1);
    });
  }
} catch (error) {
  console.error('Failed to load configuration:', error);
  process.exit(1);
}

async function handleRestRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: GatewayConfig
) {

  // Add endpoint for session ID generation
  if (req.url == "/api/sessionid" && req.method === "GET") {
    const sessionId = randomUUID();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId }));
    return;
  }

  // Example route: POST /api/<serverName>/<toolName>?sessionId=123
  const urlParts = (req.url || "").split("?")[0].split("/").filter(Boolean); // skip empty
  // UrlParts would look like [ 'api', 'serverName', 'toolName' ]
  if (urlParts.length < 3) {
    res.writeHead(404).end("Invalid REST route");
    return;
  }
  const [api, serverName, toolName] = urlParts;

  if (api !== "api") {
    res.writeHead(404).end("Invalid REST route");
    return;
  }

  // parse query, expecting ?sessionId=...
  const query = new URLSearchParams((req.url || "").split("?")[1] || "");
  const sessionId = query.get("sessionId");

  if (!sessionId) {
    res.writeHead(400).end("sessionId query parameter is required");
    return;
  }

  // If server not configured
  if (!serverName || !config.servers[serverName]) {
    res.writeHead(404).end("Server not found");
    return;
  }

  // Read body
  let body = "";
  req.on("data", chunk => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    try {
      const parsedBody = JSON.parse(body); // user’s tool input
      // Prepare JSON-RPC for MCP
      const message = {
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method: "tools/call",
        params: {
          name: toolName,
          arguments: parsedBody
        }
      };

      // Create or reuse session & send request
      const stdioTransport = await getOrCreateSession(sessionId, serverName, config.servers[serverName]);

      // Wrap in a small function that awaits the next response
      // You’d typically have a queue in real usage; for simplicity, we’ll
      // just listen for the next message event.
      const response = await sendAndWaitForResponse(stdioTransport, message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      console.error(error);
      res.writeHead(500).end(String(error));
    }
  });
}

// Very simple “send and wait” helper
function sendAndWaitForResponse(stdioTransport: StdioClientTransport, message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMsg = (msg: any) => {
      // console.log("Got message:", msg);
      if (msg.id === message.id) {
        stdioTransport.onmessage = undefined;
        resolve(msg.result ?? msg.error ?? {});
      }
    };
    stdioTransport.onmessage = onMsg;
    stdioTransport.onerror = reject;
    stdioTransport.send(message).then(() => { 
      // console.log("Sent message:", message) 
    }).catch(reject);
  });
}

async function dumpSchemas(config: GatewayConfig, format: 'json' | 'yaml') {
  const openApi: any = {
    openapi: "3.0.0",
    info: { title: "MCP Gateway Tools", version: "1.0.0" },
    paths: {}
  };

  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    // console.log("Dumping tools for server:", serverName);

    // Spin up a temporary session, get tools
    const stdio = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      env: process.env as Record<string, string>
    });
    await stdio.start();


    //TODO: Use the Client object from the SDK to talk to the server

    //// Hack: this didn't work with one of the servers I tried
    //// initialize
    // await sendAndWaitForResponse(stdio, {
    //   method: "initialize",
    //   params: {
    //       protocolVersion: "2024-11-05",
    //       capabilities: {},
    //       clientInfo: {},
    //   },
    // });

    await stdio.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // We'll ask for tools ( "tools/list" ), ignoring advanced flows
    const toolsList = await sendAndWaitForResponse(stdio, {
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "tools/list",
      params: {}
    });

    // console.log("Got tools:", toolsList);

    if (toolsList && Array.isArray(toolsList.tools)) {
      for (const tool of toolsList.tools) {
        // Create an endpoint: POST /{serverName}/{tool.name}?sessionId=
        const pathName = `/${serverName}/${tool.name}`;
        openApi.paths[pathName] = {
          post: {
            operationId: `${serverName}-${tool.name}`,
            summary: `Call tool: ${tool.name}`,
            description: tool.description || "",
            parameters: [ 
              {
                name: "sessionId",
                in: "query",
                schema: { type: "string" },
                required: true,
                description: "Session ID for the tool call. Get one from GET /api/sessionid"
              }
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: tool.inputSchema || { type: "object" }
                }
              }
            },
            responses: {
              200: {
                description: "Success"
              }
            }
          }
        };
      }
    }

    // Close the transport
    await stdio.close();
  }

  // Add session ID generation endpoint to OpenAPI schema
  openApi.paths["/sessionid"] = {
    get: {
      summary: "Generate a new session ID",
      description: "Returns a new session ID that can be used for tool calls",
      responses: {
        200: {
          description: "A new session ID",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  sessionId: {
                    type: "string",
                    description: "The generated session ID"
                  }
                },
                required: ["sessionId"]
              }
            }
          }
        }
      }
    }
  };

  // Output
  if (format === "json") {
    console.log(JSON.stringify(openApi, null, 2));
  } else {
    const yamlData = stringify(openApi);
    console.log(yamlData);
  }
}