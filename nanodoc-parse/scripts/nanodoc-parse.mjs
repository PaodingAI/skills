#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_BASE_URL = "https://platform.paodingai.com";
const SERVICE_CODE = "nanodoc";
const PARSE_PATH = `/openapi/${SERVICE_CODE}/parse`;
const REQUEST_TIMEOUT_MS = 1_920_000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_ERROR_CHARS = 4_000;
const DOCUMENT_FORMATS = Object.freeze({
  pdf: { mime: "application/pdf", magic: Buffer.from("%PDF-") },
  jpg: { mime: "image/jpeg", magic: Buffer.from([0xff, 0xd8, 0xff]) },
  jpeg: { mime: "image/jpeg", magic: Buffer.from([0xff, 0xd8, 0xff]) },
  png: { mime: "image/png", magic: Buffer.from("\x89PNG\r\n\x1a\n", "binary") },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    magic: Buffer.from("PK"),
  },
  pptx: {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    magic: Buffer.from("PK"),
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    magic: Buffer.from("PK"),
  },
});
const SUPPORTED_EXTENSIONS = Object.keys(DOCUMENT_FORMATS);

class ScriptError extends Error {
  constructor(message, response) {
    super(message);
    this.response = response;
  }
}

function fail(message, response) {
  throw new ScriptError(message, response);
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/nanodoc-parse.mjs parse --file <document> --output <directory>

Environment:
  PAODINGAI_API_KEY        Required bearer token for PDRouter
  PAODINGAI_API_BASE_URL   Optional PDRouter origin (default: ${DEFAULT_BASE_URL})
`);
}

function apiKey() {
  const key = process.env.PAODINGAI_API_KEY;
  delete process.env.PAODINGAI_API_KEY;
  if (!key || !key.trim()) {
    fail('PAODINGAI_API_KEY is required. Create a Bearer API key in PDRouter, then run: export PAODINGAI_API_KEY="sk-..."');
  }
  if (/\s/.test(key)) fail("PAODINGAI_API_KEY must not contain whitespace");
  return key;
}

function baseUrl() {
  const raw = (process.env.PAODINGAI_API_BASE_URL || DEFAULT_BASE_URL).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail("PAODINGAI_API_BASE_URL must be an absolute http(s) URL");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) fail("PAODINGAI_API_BASE_URL must use HTTPS (HTTP is allowed only for localhost)");
  if (url.username || url.password || url.search || url.hash) {
    fail("PAODINGAI_API_BASE_URL must not contain credentials, a query, or a fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") fail("PAODINGAI_API_BASE_URL must be an origin; do not include /openapi or a service path");
  return url.origin;
}

function requireUnzip() {
  const check = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if (check.error?.code === "ENOENT") fail("unzip is required to validate and extract NanoDoc results");
  if (check.error) fail(`unzip could not be checked: ${check.error.message}`);
  if (check.status !== 0) fail("unzip is installed but could not be executed");
}

function redact(text, key) {
  if (!key || !text) return text;
  return String(text).split(key).join("[redacted]");
}

async function request(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      fail("parse timed out waiting for PDRouter");
    }
    fail(`request failed: ${error.message}`);
  }
}

function failureReason(payload, fallback) {
  if (payload == null) return fallback;
  if (typeof payload === "string") return payload.slice(0, MAX_ERROR_CHARS) || fallback;
  if (typeof payload.message === "string" && payload.message) {
    const code = typeof payload.error_code === "string" ? payload.error_code : "";
    return code ? `${code}: ${payload.message}` : payload.message;
  }
  if (typeof payload.error_code === "string" && payload.error_code) return payload.error_code;
  if (payload.error && typeof payload.error === "object") {
    const code = typeof payload.error.code === "string" ? payload.error.code : "";
    const message = typeof payload.error.message === "string" ? payload.error.message : "";
    if (code && message) return `${code}: ${message}`;
    if (message || code) return message || code;
  }
  if (typeof payload.detail === "string" && payload.detail) return payload.detail;
  if (typeof payload.code === "string" && payload.code) return payload.code;
  if (typeof payload.raw === "string" && payload.raw) return payload.raw.slice(0, MAX_ERROR_CHARS);
  return fallback;
}

async function readError(response) {
  const text = (await response.text()).slice(0, MAX_ERROR_CHARS);
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { payload, reason: failureReason(payload, text || response.statusText || "request failed") };
}

async function validateInput(file, output) {
  const input = path.resolve(file);
  const outputPath = path.resolve(output);
  const extension = path.extname(input).slice(1).toLowerCase();
  const format = DOCUMENT_FORMATS[extension];
  if (!format) {
    fail(`input file must have a supported extension (${SUPPORTED_EXTENSIONS.join(", ")}): ${input}`);
  }
  let inputMetadata;
  try {
    inputMetadata = await lstat(input);
  } catch (error) {
    if (error.code === "ENOENT") fail(`input document does not exist: ${input}`);
    throw error;
  }
  if (inputMetadata.isSymbolicLink()) fail(`input path must not be a symbolic link: ${input}`);
  if (!inputMetadata.isFile()) fail(`input document is not a file: ${input}`);
  if (inputMetadata.size === 0) fail("input document is empty");
  if (inputMetadata.size > MAX_INPUT_BYTES) fail(`input document exceeds the ${MAX_INPUT_BYTES} byte limit`);
  const bytes = await readFile(input);
  if (!bytes.subarray(0, format.magic.length).equals(format.magic)) {
    fail(`input file does not have a valid ${extension.toUpperCase()} header`);
  }
  let outputMetadata;
  try {
    outputMetadata = await lstat(outputPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (outputMetadata?.isSymbolicLink()) fail(`output path must not be a symbolic link: ${outputPath}`);
  if (outputMetadata && !outputMetadata.isDirectory()) fail(`output path is not a directory: ${outputPath}`);
  if (outputMetadata && (await readdir(outputPath)).length > 0) fail(`output directory must be empty: ${outputPath}`);
  return { input, output: outputPath, bytes, extension, format };
}

async function streamToFile(response, destination) {
  if (!response.body) fail("parse result response has no body");
  const stream = Readable.fromWeb(response.body);
  const writer = createWriteStream(destination, { mode: 0o600 });
  let bytes = 0;
  let magic = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) fail("result archive is too large");
      if (magic.length < 4) magic = Buffer.concat([magic, chunk]).subarray(0, 4);
      if (!writer.write(chunk)) {
        await new Promise((resolve, reject) => {
          writer.once("drain", resolve);
          writer.once("error", reject);
        });
      }
    }
    writer.end();
    await finished(writer);
  } finally {
    writer.destroy();
  }
  if (!magic.equals(Buffer.from("PK\x03\x04"))) fail("parse result was not a zip archive");
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} exited with ${code}${signal ? ` (${signal})` : ""}`));
    });
  });
}

async function validateAndExtract(archive, resultDirectory) {
  await run("unzip", ["-tq", archive], path.dirname(archive));
  const listing = await run("unzip", ["-Z1", archive], path.dirname(archive));
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length > MAX_ARCHIVE_ENTRIES) fail("result archive contains too many entries");
  const seen = new Set();
  const files = new Set();
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..") || /^[A-Za-z]:/.test(entry)) {
      fail(`result archive contains an unsafe path: ${entry}`);
    }
    const canonical = entry.replace(/\/+$/, "").split("/").filter((part) => part && part !== ".").join("/").normalize("NFC");
    if (!canonical) continue;
    if (seen.has(canonical)) fail(`result archive contains a duplicate path: ${entry}`);
    seen.add(canonical);
    if (!entry.endsWith("/")) files.add(canonical);
  }
  const details = await run("unzip", ["-Z", "-l", archive], path.dirname(archive));
  if (details.stdout.split(/\r?\n/).some((line) => /^\s*l/.test(line))) fail("result archive contains a symbolic link");
  const listingWithSizes = await run("unzip", ["-l", archive], path.dirname(archive));
  let uncompressedBytes = 0;
  for (const line of listingWithSizes.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})\s+\d{2}:\d{2}\s+(.+)$/);
    if (match) {
      uncompressedBytes += Number(match[1]);
      if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_EXTRACTED_BYTES) {
        fail("result archive is too large when extracted");
      }
    }
  }
  if (files.size > 0 && uncompressedBytes === 0) fail("result archive has invalid file sizes");
  await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
  await run("unzip", ["-q", archive, "-d", resultDirectory], path.dirname(archive));
  let total = 0;
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("result archive extracted a symbolic link");
      if (entry.isDirectory()) await inspect(full);
      else if (entry.isFile()) {
        total += (await stat(full)).size;
        if (total > MAX_EXTRACTED_BYTES) fail("extracted result is too large");
      }
    }
  }
  await inspect(resultDirectory);
}

async function describeOutput(output) {
  const names = await readdir(output);
  const markdownName = names.filter((name) => name.toLowerCase().endsWith(".md")).sort()[0] || null;
  const resultJson = names.includes("result.json") ? path.join(output, "result.json") : null;
  return {
    output_directory: output,
    markdown: markdownName ? path.join(output, markdownName) : null,
    result_json: resultJson,
  };
}

async function parseDocument(options) {
  const key = apiKey();
  const base = baseUrl();
  requireUnzip();
  const input = await validateInput(options.file, options.output);
  const parent = path.dirname(input.output);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".nanodoc-parse-"));
  try {
    process.stderr.write(`NanoDoc parse: uploading ${path.basename(input.input)}\n`);
    const form = new FormData();
    form.append("file", new Blob([input.bytes], { type: input.format.mime }), path.basename(input.input));
    const response = await request(`${base}${PARSE_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/zip, application/json",
      },
      body: form,
    });
    if (!response.ok) {
      const error = await readError(response);
      fail(`POST ${PARSE_PATH} failed: ${error.reason}`, error.payload);
    }
    const archive = path.join(staging, "result.zip");
    await streamToFile(response, archive);
    const extracted = path.join(staging, "extracted");
    await validateAndExtract(archive, extracted);
    let outputExists = false;
    try {
      outputExists = (await lstat(input.output)).isDirectory();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (outputExists) await rm(input.output, { recursive: true, force: true });
    await rename(extracted, input.output);
    const described = await describeOutput(input.output);
    process.stdout.write(`${JSON.stringify(described, null, 2)}\n`);
  } catch (error) {
    if (error instanceof ScriptError) throw error;
    fail(redact(error.message, key));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
    usage();
    process.exit(0);
  }
  if (args[0] !== "parse") fail(`unknown command: ${args[0]}`);
  const options = { file: "", output: "" };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--help") {
      usage();
      process.exit(0);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) fail(`missing value for ${option}`);
    if (option === "--file") {
      if (options.file) fail("--file can be set only once");
      options.file = value;
    } else if (option === "--output") {
      if (options.output) fail("--output can be set only once");
      options.output = value;
    } else {
      fail(`unknown option: ${option}`);
    }
  }
  if (!options.file || !options.output) fail("--file and --output are required");
  return options;
}

try {
  await parseDocument(parseArgs(process.argv.slice(2)));
} catch (error) {
  const payload = { error: error.message };
  if (error.response !== undefined) payload.response = error.response;
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}
