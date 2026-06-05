#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { stderr, stdout } = require('node:process');

const DEFAULT_BASE_URL = (
  process.env.PD_ROUTER_BASE_URL || 'https://platform.paodingai.com/'
).trim();
const DEFAULT_SERVICE_CODE = 'calliper';
const DEFAULT_COMPARE_ENDPOINT = '/compare/markdown';

function normalizeBaseUrl(url) {
  return (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function normalizeServiceCode(serviceCode) {
  return (serviceCode || DEFAULT_SERVICE_CODE).trim() || DEFAULT_SERVICE_CODE;
}

function requireBearerToken() {
  const fromEnv = (process.env.PAODINGAI_API_KEY || '').trim();
  if (fromEnv) {
    return { token: fromEnv, source: 'PAODINGAI_API_KEY' };
  }

  const fallback = (process.env.CALLIPER_ACCESS_TOKEN || '').trim();
  if (fallback) {
    return { token: fallback, source: 'CALLIPER_ACCESS_TOKEN' };
  }

  throw new Error(
    'Missing bearer token. Set PAODINGAI_API_KEY (preferred) or CALLIPER_ACCESS_TOKEN before retrying.',
  );
}

function parseCompareConfig() {
  const raw = (process.env.CALLIPER_COMPARE_CONFIG || '{}').trim();
  if (!raw) {
    return '{}';
  }
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    throw new Error('CALLIPER_COMPARE_CONFIG must be valid JSON.');
  }
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const bodyText = await response.text();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(bodyText);
    } catch {
      return { status: false, msg: bodyText || 'Invalid JSON response' };
    }
  }
  return bodyText;
}

function extractApiError(payload, fallback) {
  if (!payload) {
    return fallback;
  }
  if (typeof payload === 'string') {
    return payload || fallback;
  }
  if (typeof payload === 'object') {
    return (
      payload.code || payload.msg || payload.message || JSON.stringify(payload)
    );
  }
  return fallback;
}

function buildOpenApiUrl(baseUrl, serviceCode, endpoint) {
  const normalizedEndpoint = endpoint.replace(/^\/+/, '');
  return `${baseUrl}/openapi/${serviceCode}/${normalizedEndpoint}`;
}

function buildAuthHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

async function requestCompareMarkdown({
  baseUrl,
  serviceCode,
  token,
  endpoint,
  filePath1,
  filePath2,
  config,
}) {
  const formData = new FormData();

  const filename1 = path.basename(filePath1);
  const bytes1 = await fs.readFile(filePath1);
  formData.append(
    'file1',
    new Blob([bytes1], { type: 'application/octet-stream' }),
    filename1,
  );

  const filename2 = path.basename(filePath2);
  const bytes2 = await fs.readFile(filePath2);
  formData.append(
    'file2',
    new Blob([bytes2], { type: 'application/octet-stream' }),
    filename2,
  );

  formData.append('config', config);

  const response = await fetch(
    buildOpenApiUrl(baseUrl, serviceCode, endpoint),
    {
      method: 'POST',
      headers: buildAuthHeaders(token),
      body: formData,
    },
  );

  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      `Compare markdown failed (${response.status}): ${extractApiError(payload, 'Request failed')}`,
    );
  }
  if (
    typeof payload === 'object' &&
    payload !== null &&
    payload.status === false
  ) {
    throw new Error(
      `Compare markdown failed: ${extractApiError(payload, 'Invalid API response')}`,
    );
  }

  return payload;
}

function resolveOutputText(payload) {
  if (typeof payload === 'string') {
    return payload;
  }

  if (typeof payload?.data?.markdown === 'string') {
    return payload.data.markdown;
  }
  if (typeof payload?.markdown === 'string') {
    return payload.markdown;
  }
  if (typeof payload?.data === 'string') {
    return payload.data;
  }

  return JSON.stringify(payload, null, 2);
}

async function ensureInputFile(filePathArg, label) {
  if (!filePathArg) {
    throw new Error(
      'Usage: node compare_to_markdown.js <left-file-path> <right-file-path> [output-markdown-path]',
    );
  }

  const resolvedPath = path.resolve(filePathArg);
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`${label} file does not exist: ${resolvedPath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`${label} path is not a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

async function main() {
  const filePath1 = await ensureInputFile(process.argv[2], 'Left');
  const filePath2 = await ensureInputFile(process.argv[3], 'Right');
  const outputPath = process.argv[4] ? path.resolve(process.argv[4]) : null;

  const { token, source: tokenSource } = requireBearerToken();
  const baseUrl = normalizeBaseUrl();
  const serviceCode = normalizeServiceCode(process.env.PD_ROUTER_SERVICE_CODE);
  const compareEndpoint =
    (process.env.PD_ROUTER_COMPARE_ENDPOINT || DEFAULT_COMPARE_ENDPOINT).trim() ||
    DEFAULT_COMPARE_ENDPOINT;
  const compareConfig = parseCompareConfig();

  stderr.write(
    `[pd-router-calliper-markdown] Requesting sync compare markdown for ${path.basename(filePath1)} vs ${path.basename(filePath2)} via ${baseUrl} (token=${tokenSource}, endpoint=${compareEndpoint})\n`,
  );

  const payload = await requestCompareMarkdown({
    baseUrl,
    serviceCode,
    token,
    endpoint: compareEndpoint,
    filePath1,
    filePath2,
    config: compareConfig,
  });

  const outputText = resolveOutputText(payload);

  if (outputPath) {
    stderr.write(
      `[pd-router-calliper-markdown] Output saved at ${outputPath}\n`,
    );
    await fs.writeFile(outputPath, outputText, 'utf8');
  }

  stdout.write(outputText);
  if (!outputText.endsWith('\n')) {
    stdout.write('\n');
  }
}

main().catch(error => {
  stderr.write(
    `[pd-router-calliper-markdown] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
