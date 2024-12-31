# MCP Gateway

A flexible gateway server that bridges Model Context Protocol (MCP) STDIO servers to MCP HTTP+SSE and REST API, enabling multi-instance MCP servers to be exposed over HTTP.

## Experimental Docker Support 🐳

This MCP Gateway branch includes support for running in a Docker container. The container is designed with essential dependencies for a variety of MCP servers that I use. It is **experimental** and I will continue to change and break things as my needs and MCP servers change.

### Quick Start with Docker

```bash
# Build the Docker image
docker build -t mcp-gateway .

# Run the Docker container using the default configuration
docker run -p 3000:3000 mcp-gateway

# Run with a custom configuration and mount a volume for file persistence
docker run -p 3000:3000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -v $(pwd)/downloads:/downloads \
  mcp-gateway
```

### Features and Dependencies in the Container

- **Node.js 23**: For running JavaScript-based MCP servers.
- **Python 3 with pip**: For Python-based MCP servers.
- **Chromium with SwiftShader**: Supports headless Chrome for Puppeteer. Source [landure/alpine-chrome](https://github.com/jlandure/alpine-chrome)
- **FFmpeg**: For media encoding/decoding tasks such as yt-dlp.
- **Xvfb**: Enables headless graphical applications in a virtual framebuffer environment.

## Features

- Run multiple instances of the same MCP server type
- Configure multiple different MCP server types
- Flexible network binding configuration
- Clean separation between server instances using session IDs
- Automatic cleanup of server resources on connection close
- YAML-based configuration
- Optional Basic and Bearer token authentication
- Configurable debug logging levels
- REST API Support

## REST API Support

MCP Gateway now provides a REST API interface to MCP servers, making them accessible to any HTTP client that supports OpenAPI/Swagger specifications. This feature is particularly useful for integrating with OpenAI's custom GPTs and other REST API clients.

### REST API Endpoints

Before making tool calls, you need to get a session ID:
```bash
curl "http://localhost:3000/api/sessionid"
# Returns: {"sessionId": "<generated-id>"}
```

Each tool exposed by an MCP server is available at:
```
POST /api/{serverName}/{toolName}?sessionId={session-id}
```
Note: The `sessionId` query parameter is required for all tool calls.

For example, to call the `directory_tree` tool on a `filesystem` MCP server:
```bash
# First get a session ID
SESSION_ID=$(curl -s "http://localhost:3000/api/sessionid" | jq -r .sessionId)

# Then make the tool call
curl -X POST "http://localhost:3000/api/filesystem/directory_tree?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"path": "/some/path"}'
```

### OpenAPI Schema Generation

The gateway can generate OpenAPI schemas for all configured tools, making it easy to integrate with OpenAPI-compatible clients:

```bash
# Generate YAML format (default)
npm start -- --schemaDump

# Generate JSON format
npm start -- --schemaDump --schemaFormat json
```

The generated schema includes:
- All available endpoints for each configured server
- Tool descriptions and parameter schemas
- Request/response formats
- Authentication requirements

## Purpose

At the moment, most MCP servers are designed for local execution. MCP Gateway enables HTTP+SSE capable clients to interact with MCP servers running on remote machines. This addresses common deployment scenarios, such as running [LibreChat](https://github.com/LibreChat/LibreChat) in a containerized environment where certain MCP servers, like the Puppeteer server, may have limited functionality. MCP Gateway provides a robust solution for distributing MCP servers across multiple machines while maintaining seamless connectivity.

## Security Features

MCP Gateway supports two authentication methods that can be enabled independently:

1. Basic Authentication: Username/password pairs
2. Bearer Token Authentication: Token-based authentication

Both methods can be enabled simultaneously, and any valid authentication will grant access.

### Authentication Configuration

Add authentication settings to your `config.yaml`:

```yaml
auth:
  basic:
    enabled: true
    credentials:
      - username: "admin"
        password: "your-secure-password"
      # Add more username/password pairs as needed
  bearer:
    enabled: true
    tokens:
      - "your-secure-token"
      # Add more tokens as needed
```

### Using Authentication

#### Basic Authentication
```bash
curl -u username:password http://localhost:3000/serverName
```

#### Bearer Token Authentication
```bash
curl -H "Authorization: Bearer your-secure-token" http://localhost:3000/serverName
```

## Installation

```bash
npm install
```

## Configuration

The gateway is configured using a YAML file. By default, it looks for `config.yaml` in the current directory, but you can specify a different path using the `CONFIG_PATH` environment variable.

### Debug Configuration

The gateway uses [Winston](https://github.com/winstonjs/winston) for logging, providing rich formatting and multiple log levels:

```yaml
debug:
  level: "info"  # Possible values: "error", "warn", "info", "debug", "verbose"
```

Log levels, from least to most verbose:
- `error`: Only show errors
- `warn`: Show warnings and errors
- `info`: Show general information, warnings, and errors (default)
- `debug`: Show debug information and all above
- `verbose`: Show all possible logging information

The logs include timestamps and are color-coded by level when viewing in a terminal. Additional metadata is included as JSON when relevant.

Example log output:
```
2024-01-20T10:15:30.123Z [INFO]: New SSE connection for filesystem
2024-01-20T10:15:30.124Z [DEBUG]: Server instance created with sessionId: /filesystem?sessionId=abc123
2024-01-20T10:15:30.125Z [VERBOSE]: STDIO message received: {"type":"ready"}
```

### Basic Configuration Example

```yaml
hostname: "0.0.0.0"  # Listen on all interfaces
port: 3000

servers:
  filesystem:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - "/path/to/root"
    
  git:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-git"
```

### Network Configuration Examples

#### Listen on localhost only (development)
```yaml
hostname: "127.0.0.1"
port: 3000
```

#### Listen on a specific interface
```yaml
hostname: "192.168.1.100"
port: 3000
```

#### Listen on all interfaces (default)
```yaml
hostname: "0.0.0.0"
port: 3000
```

### Server Configuration

Each server in the `servers` section needs:

- `command`: The command to run the server
- `args`: List of arguments for the command
- `path` (optional): Working directory for the server

Example with all options:
```yaml
servers:
  myserver:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-mytype"
      - "--some-option"
```

### Complete Configuration Example

```yaml
hostname: "0.0.0.0"
port: 3000

# Authentication configuration (optional)
auth:
  basic:
    enabled: true
    credentials:
      - username: "admin"
        password: "your-secure-password"
  bearer:
    enabled: true
    tokens:
      - "your-secure-token"

servers:
  filesystem:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - "/path/to/root"
```

## Running the Gateway

Standard start:
```bash
npm start
```

With custom config:
```bash
CONFIG_PATH=/path/to/my/config.yaml npm start
```

## Adding New Server Types

1. Install the MCP server package you want to use
2. Add a new entry to the `servers` section in your config:
```yaml
servers:
  mynewserver:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-newtype"
      # Add any server-specific arguments here
```

## Architecture

The gateway creates a unique session for each server instance, allowing multiple clients to use the same server type independently. Each session maintains its own:

- STDIO connection to the actual MCP server
- SSE connection to the client
- Message bridging between the transports

When a client disconnects, all associated resources are automatically cleaned up.

## Environment Variables

- `CONFIG_PATH`: Path to the YAML configuration file (default: `./config.yaml`)

## Contributing

Issues and PRs are welcome, but in all honesty they could languish a while.

## License

MIT License


curl -X POST   "http://localhost:3000/api/filesystem/directory_tree?sessionId=randomSession12345"   -H "Content-Type: application/json"   -d '{
    "path": "/home/aaron/Clara"
}'
