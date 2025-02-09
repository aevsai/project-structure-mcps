#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, readdir } from "fs/promises";
import { join, relative } from "path";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({
  name: "postgres-context-server",
  version: "0.1.0",
});

const BASE_DIR = process.cwd();
const FILE_PROMPT_NAME = "file-contents";

// Helper function to recursively list files
async function listFilesRecursively(dir) {
  const files = [];
  const items = await readdir(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = join(dir, item.name);
    if (item.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
    } else {
      files.push(relative(BASE_DIR, fullPath));
    }
  }

  return files;
}

process.stderr.write("Starting filesystem MCP server\n");

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const files = await listFilesRecursively(BASE_DIR);
  return {
    resources: files.map((file) => ({
      uri: `file://${join(BASE_DIR, file)}`,
      mimeType: "text/plain",
      name: file,
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);
  const filePath = resourceUrl.pathname;

  try {
    const contents = await readFile(filePath, "utf-8");
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/plain",
          text: contents,
        },
      ],
    };
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list-files",
        description: "Lists all files in the current directory",
        inputSchema: {
          type: "object",
          properties: {
            recursive: {
              type: "boolean",
              description: "Whether to list files recursively",
              default: false,
            },
          },
        },
      },
      {
        name: "read-file",
        description: "Read contents of a specific file",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to read",
            },
          },
          required: ["path"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "list-files") {
    const recursive = request.params.arguments?.recursive ?? false;

    try {
      const files = recursive
        ? await listFilesRecursively(BASE_DIR)
        : await readdir(BASE_DIR);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(files, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to list files: ${error.message}`);
    }
  }

  if (request.params.name === "read-file") {
    const path = request.params.arguments?.path;

    if (!path) {
      throw new Error("Path is required");
    }

    try {
      const contents = await readFile(join(BASE_DIR, path), "utf-8");
      return {
        content: [
          {
            type: "text",
            text: contents,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  throw new Error("Tool not found");
});

server.setRequestHandler(CompleteRequestSchema, async (request) => {
  process.stderr.write("Handling completions/complete request\n");

  if (request.params.ref.name === FILE_PROMPT_NAME) {
    const fileQuery = request.params.argument.value;
    const files = await listFilesRecursively(BASE_DIR);
    return {
      completion: {
        values: files.filter((file) =>
          file.toLowerCase().includes(fileQuery.toLowerCase()),
        ),
      },
    };
  }

  throw new Error("unknown prompt");
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  process.stderr.write("Handling prompts/list request\n");

  return {
    prompts: [
      {
        name: FILE_PROMPT_NAME,
        description: "Retrieve the contents of a file",
        arguments: [
          {
            name: "path",
            description: "the path to the file",
            required: true,
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  process.stderr.write("Handling prompts/get request\n");

  if (request.params.name === FILE_PROMPT_NAME) {
    const path = request.params.arguments?.path;

    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`Invalid path: ${path}`);
    }

    try {
      const contents = await readFile(join(BASE_DIR, path), "utf-8");
      return {
        description: `Contents of ${path}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: contents,
            },
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  throw new Error(`Prompt '${request.params.name}' not implemented`);
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
