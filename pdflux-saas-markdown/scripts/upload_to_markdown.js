#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { stderr, stdout } = require('node:process');

const DEFAULT_BASE_URL = (process.env.PD_ROUTER_BASE_URL || 'https://platform.paodingai.com/').trim();
const DEFAULT_SERVICE_CODE = 'pdflux';

function normalizeBaseUrl(url) {
  return (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function normalizeServiceCode(serviceCode) {
  return (serviceCode || DEFAULT_SERVICE_CODE).trim() || DEFAULT_SERVICE_CODE;
}

function parseBooleanEnv(name) {
  const rawValue = process.env[name];
  if (rawValue == null) {
    return null;
  }

  const normalizedValue = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalizedValue)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${name} must be a boolean string like true/false/1/0.`);
}

function requireGatewayApiKey() {
  const fromEnv = (process.env.PD_ROUTER_API_KEY || '').trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error(
    'PD_ROUTER_API_KEY is required. This skill script does not prompt for input, so ask the user to provide a PD Router API key or set PD_ROUTER_API_KEY before retrying.',
  );
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
    return payload.code || payload.msg || payload.message || JSON.stringify(payload);
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

async function requestSyncMarkdown({ baseUrl, serviceCode, apiKey, filePath, forceUpdate, forceOcr, includeImages }) {
  const formData = new FormData();
  const filename = path.basename(filePath);
  const bytes = await fs.readFile(filePath);
  const fileBlob = new Blob([bytes], { type: 'application/pdf' });
  formData.append('file', fileBlob, filename);
  formData.append('force_update', String(forceUpdate));
  formData.append('force_ocr', String(forceOcr));
  formData.append('include_images', String(includeImages));

  const response = await fetch(buildOpenApiUrl(baseUrl, serviceCode, 'file/markdown'), {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: formData,
  });

  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(`Sync markdown failed (${response.status}): ${extractApiError(payload, 'Request failed')}`);
  }
  if (typeof payload === 'object' && payload !== null && payload.status === false) {
    throw new Error(`Sync markdown failed: ${extractApiError(payload, 'Invalid API response')}`);
  }

  return payload;
}

function resolveOutputText(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  const data = payload?.data;
  if (typeof data?.markdown === 'string') {
    return data.markdown;
  }
  if (typeof payload?.markdown === 'string') {
    return payload.markdown;
  }
  if (typeof data === 'string') {
    return data;
  }
  return JSON.stringify(payload, null, 2);
}

async function ensureInputFile(filePathArg) {
  if (!filePathArg) {
    throw new Error('Usage: node upload_to_markdown.js <local-file-path> [output-markdown-path]');
  }

  const resolvedPath = path.resolve(filePathArg);
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    throw new Error(`Input file does not exist: ${resolvedPath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Input path is not a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

async function main() {
  const filePath = await ensureInputFile(process.argv[2]);
  const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const apiKey = requireGatewayApiKey();
  const baseUrl = normalizeBaseUrl();
  const serviceCode = normalizeServiceCode(process.env.PD_ROUTER_SERVICE_CODE);
  const forceUpdate = (process.env.PDFLUX_FORCE_UPDATE || 'true').trim().toLowerCase() !== 'false';
  const forceOcr = (process.env.PDFLUX_FORCE_OCR || 'true').trim().toLowerCase() !== 'false';
  const includeImages = parseBooleanEnv('PDFLUX_INCLUDE_IMAGES') === true;

  stderr.write(`[pd-router-pdflux-markdown] Requesting sync markdown for ${path.basename(filePath)} via ${baseUrl}\n`);
  const payload = await requestSyncMarkdown({
    baseUrl,
    serviceCode,
    apiKey,
    filePath,
    forceUpdate,
    forceOcr,
    includeImages,
  });

  const outputText = resolveOutputText(payload);

  if (outputPath) {
    stderr.write(`[pd-router-pdflux-markdown] Output saved at ${outputPath}\n`);
    await fs.writeFile(outputPath, outputText, 'utf8');
  }

  stdout.write(outputText);
  if (!outputText.endsWith('\n')) {
    stdout.write('\n');
  }
}

main().catch(error => {
  stderr.write(`[pd-router-pdflux-markdown] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
