#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE_URL = "https://platform.paodingai.com";
const SERVICE_CODE = "chatdoc-studio";
const DEFAULT_UPLOAD_CONCURRENCY = 5;
const MAX_KNOWLEDGE_BASE_FILES = 300;
const SUPPORTED_UPLOAD_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);

function usage() {
  console.log(`Usage:
  node scripts/knowledge-mate.mjs upload-and-create --name <kb-name> [--file <path> ...] [--dir <path> ...]
  node scripts/knowledge-mate.mjs retrieval --library-id <id> --query <text> [--retrieval-token-length <n>] [--retrieval-mode <mode>]
  node scripts/knowledge-mate.mjs list-documents --library-id <id>
  node scripts/knowledge-mate.mjs stats --library-id <id> --upload-id <id>
  node scripts/knowledge-mate.mjs grep --library-id <id> --upload-id <id> --pattern <text> [--case-sensitive <true|false>] [--limit <n>]
  node scripts/knowledge-mate.mjs read --library-id <id> --upload-id <id> --offset <n> [--limit <n>]
  node scripts/knowledge-mate.mjs read-syllabus --library-id <id> --upload-id <id> [--parent-index <n>]

Environment:
  PAODINGAI_API_KEY       Required bearer token for pd_router
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value == null || value.startsWith("--")) {
      options[key] = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(options, key)) {
      if (!Array.isArray(options[key])) {
        options[key] = [options[key]];
      }
      options[key].push(value);
    } else {
      options[key] = value;
    }
    i += 1;
  }
  return { command, options };
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function required(options, key) {
  const value = options[key];
  if (value == null || value === true || value === "") {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function toInteger(value, key) {
  const num = Number(value);
  if (!Number.isInteger(num)) {
    throw new Error(`--${key} must be an integer`);
  }
  return num;
}

function toBoolean(value, key) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${key} must be true or false`);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".doc") return "application/msword";
  if (ext === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return "application/octet-stream";
}

function isSupportedUploadFile(filePath) {
  return SUPPORTED_UPLOAD_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function scanDirectoryFiles(dirPath) {
  const absoluteDir = path.resolve(dirPath);
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read --dir ${absoluteDir}: ${error.message}`);
  }

  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanDirectoryFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function collectUploadFiles(options) {
  const explicitFiles = asArray(options.file).map((filePath) =>
    path.resolve(filePath),
  );
  const directoryFiles = asArray(options.dir).flatMap((dirPath) =>
    scanDirectoryFiles(dirPath),
  );
  const files = [...explicitFiles, ...directoryFiles];
  if (files.length === 0) {
    throw new Error(
      "Missing upload input: provide at least one --file or --dir",
    );
  }
  return [...new Set(files)];
}

function assertKnowledgeBaseFileLimit(filePaths) {
  const uploadableFiles = filePaths.filter((filePath) =>
    isSupportedUploadFile(filePath),
  );
  if (uploadableFiles.length <= MAX_KNOWLEDGE_BASE_FILES) {
    return;
  }
  const error = new Error(
    `Knowledge base supports at most ${MAX_KNOWLEDGE_BASE_FILES} PDF/DOC/DOCX files, but found ${uploadableFiles.length}. ` +
      `Please clean the folder to contain only ${MAX_KNOWLEDGE_BASE_FILES} supported files before running upload-and-create.`,
  );
  error.summary = {
    supported_file_count: uploadableFiles.length,
    maximum_supported_files: MAX_KNOWLEDGE_BASE_FILES,
    skipped_before_upload: true,
  };
  throw error;
}

function getFailureReason(payload, fallback) {
  if (payload == null) return fallback;
  if (typeof payload === "string") return payload || fallback;
  if (typeof payload.detail === "string") return payload.detail;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.code === "string") return payload.code;
  if (typeof payload.raw === "string") return payload.raw;
  return fallback;
}

function buildMultipartBody(filePath) {
  const filename = path.basename(filePath);
  const boundary = `----knowledge-mate-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const fileBuffer = fs.readFileSync(filePath);
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${getMimeType(filePath)}\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return {
    body: Buffer.concat([header, fileBuffer, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

class KnowledgeMateClient {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    apiKey = process.env.PAODINGAI_API_KEY,
  } = {}) {
    if (!apiKey) {
      throw new Error(
        'PAODINGAI_API_KEY is required. Please create a Bearer API Key in pdrouter, then run: export PAODINGAI_API_KEY="sk-..."',
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.prefix = `/openapi/${SERVICE_CODE}`;
  }

  async request(method, endpoint, { body, contentType } = {}) {
    const url = `${this.baseUrl}${this.prefix}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (contentType) {
      headers["Content-Type"] = contentType;
    }
    const response = await fetch(url, { method, headers, body });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!response.ok) {
      const detail = getFailureReason(json, text || response.statusText);
      const error = new Error(`${method} ${endpoint} failed: ${detail}`);
      error.status = response.status;
      error.response = json;
      throw error;
    }
    return json?.data;
  }

  async uploadFile(filePath) {
    const absolutePath = path.resolve(filePath);
    const { body, contentType } = buildMultipartBody(absolutePath);
    const data = await this.request("POST", "/knowledge-base/upload", {
      body,
      contentType,
    });
    return {
      file: absolutePath,
      upload_id: data?.upload_id,
      data,
    };
  }

  async _uploadMany(
    filePaths,
    { concurrency = DEFAULT_UPLOAD_CONCURRENCY } = {},
  ) {
    const files = filePaths.map((filePath) => path.resolve(filePath));
    const uploadableFiles = [];
    const uploaded = [];
    const failed = [];
    for (const file of files) {
      if (isSupportedUploadFile(file)) {
        uploadableFiles.push(file);
      } else {
        failed.push({
          file,
          error: "Skipped unsupported file type. Supported: PDF, DOC, DOCX",
          status: null,
          response: null,
        });
      }
    }
    let index = 0;

    const worker = async () => {
      while (index < uploadableFiles.length) {
        const current = uploadableFiles[index];
        index += 1;
        try {
          const result = await this.uploadFile(current);
          uploaded.push({ file: result.file, upload_id: result.upload_id });
        } catch (error) {
          failed.push({
            file: current,
            error: error.message,
            status: error.status || null,
            response: error.response || null,
          });
        }
      }
    };

    const poolSize = Math.min(
      Math.max(1, concurrency),
      uploadableFiles.length || 1,
    );
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    return {
      uploaded,
      failed,
      successful_upload_ids: uploaded.map((item) => item.upload_id),
    };
  }

  async _createKnowledgeBase(name, uploadIds) {
    return this.request("POST", "/knowledge-base", {
      body: JSON.stringify({ name, upload_ids: uploadIds }),
      contentType: "application/json",
    });
  }

  async uploadAndCreate(
    name,
    filePaths,
    { concurrency = DEFAULT_UPLOAD_CONCURRENCY } = {},
  ) {
    assertKnowledgeBaseFileLimit(filePaths);
    const uploadSummary = await this._uploadMany(filePaths, { concurrency });
    if (uploadSummary.successful_upload_ids.length === 0) {
      const error = new Error(
        "No files uploaded successfully; skip knowledge-base creation.",
      );
      error.summary = uploadSummary;
      throw error;
    }
    const createResult = await this._createKnowledgeBase(
      name,
      uploadSummary.successful_upload_ids,
    );
    return {
      knowledge_base_name: name,
      library_id: createResult?.library_id,
      successful_upload_ids: uploadSummary.successful_upload_ids,
      uploaded: uploadSummary.uploaded,
      failed: uploadSummary.failed,
      knowledge_base: createResult,
    };
  }

  async retrieval(libraryId, payload) {
    return this.request("POST", `/knowledge-base/${libraryId}/retrieval`, {
      body: JSON.stringify(payload),
      contentType: "application/json",
    });
  }

  async listDocuments(libraryId) {
    return this.request("GET", `/knowledge-base/${libraryId}/documents`);
  }

  async stats(libraryId, uploadId) {
    return this.request(
      "GET",
      `/knowledge-base/${libraryId}/${uploadId}/stats`,
    );
  }

  async grep(libraryId, uploadId, payload) {
    return this.request(
      "POST",
      `/knowledge-base/${libraryId}/${uploadId}/grep`,
      {
        body: JSON.stringify(payload),
        contentType: "application/json",
      },
    );
  }

  async read(libraryId, uploadId, payload) {
    return this.request(
      "POST",
      `/knowledge-base/${libraryId}/${uploadId}/read`,
      {
        body: JSON.stringify(payload),
        contentType: "application/json",
      },
    );
  }

  async readSyllabus(libraryId, uploadId, payload = {}) {
    return this.request(
      "POST",
      `/knowledge-base/${libraryId}/${uploadId}/read_syllabus`,
      {
        body: JSON.stringify(payload),
        contentType: "application/json",
      },
    );
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "--help" || command === "help" || options.help) {
    usage();
    process.exit(command ? 0 : 1);
  }

  let result;

  switch (command) {
    case "upload-and-create": {
      const name = required(options, "name");
      const files = collectUploadFiles(options);
      assertKnowledgeBaseFileLimit(files);
      const client = new KnowledgeMateClient();
      result = await client.uploadAndCreate(name, files, {
        concurrency: DEFAULT_UPLOAD_CONCURRENCY,
      });
      break;
    }
    case "retrieval": {
      const client = new KnowledgeMateClient();
      result = await client.retrieval(required(options, "library-id"), {
        query: required(options, "query"),
        retrieval_token_length:
          options["retrieval-token-length"] == null
            ? 6000
            : toInteger(
                options["retrieval-token-length"],
                "retrieval-token-length",
              ),
        retrieval_mode: options["retrieval-mode"] || "contextual",
      });
      break;
    }
    case "list-documents": {
      const client = new KnowledgeMateClient();
      result = await client.listDocuments(required(options, "library-id"));
      break;
    }
    case "stats": {
      const client = new KnowledgeMateClient();
      result = await client.stats(
        required(options, "library-id"),
        required(options, "upload-id"),
      );
      break;
    }
    case "grep": {
      const client = new KnowledgeMateClient();
      result = await client.grep(
        required(options, "library-id"),
        required(options, "upload-id"),
        {
          pattern: required(options, "pattern"),
          case_sensitive:
            options["case-sensitive"] == null
              ? true
              : toBoolean(options["case-sensitive"], "case-sensitive"),
          limit: options.limit == null ? 20 : toInteger(options.limit, "limit"),
        },
      );
      break;
    }
    case "read": {
      const client = new KnowledgeMateClient();
      result = await client.read(
        required(options, "library-id"),
        required(options, "upload-id"),
        {
          offset: toInteger(required(options, "offset"), "offset"),
          limit: options.limit == null ? 20 : toInteger(options.limit, "limit"),
        },
      );
      break;
    }
    case "read-syllabus": {
      const client = new KnowledgeMateClient();
      const payload = {};
      if (options["parent-index"] != null) {
        payload.parent_index = toInteger(
          options["parent-index"],
          "parent-index",
        );
      }
      result = await client.readSyllabus(
        required(options, "library-id"),
        required(options, "upload-id"),
        payload,
      );
      break;
    }
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  const payload = {
    error: error.message,
  };
  if (error.summary) {
    payload.summary = error.summary;
  }
  if (error.response) {
    payload.response = error.response;
  }
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
});
