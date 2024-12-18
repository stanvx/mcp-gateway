# MCP Gateway

A flexible gateway server that bridges Model Context Protocol (MCP) STDIO servers to HTTP+SSE, enabling multi-instance MCP servers to be exposed over HTTP.

## Features

- Run multiple instances of the same MCP server type
- Configure multiple different MCP server types
- Flexible network binding configuration
- Clean separation between server instances using session IDs
- Automatic cleanup of server resources on connection close
- YAML-based configuration

## Installation

```bash
npm install
```

## Configuration

The gateway is configured using a YAML file. By default, it looks for `config.yaml` in the current directory, but you can specify a different path using the `CONFIG_PATH` environment variable.

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

Feel free to submit issues and pull requests!

## License

MIT License