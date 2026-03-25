#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { stderr, stdout } = require('node:process');

const DEFAULT_BASE_URL = (process.env.PD_ROUTER_BASE_URL || 'https://platform.paodingai.com/').trim();
const DEFAULT_SERVICE_CODE = 'pdflux';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function uploadFile({ baseUrl, serviceCode, apiKey, filePath, forceUpdate, forceOcr }) {
  const formData = new FormData();
  const filename = path.basename(filePath);
  const bytes = await fs.readFile(filePath);
  const fileBlob = new Blob([bytes], { type: 'application/pdf' });
  formData.append('file', fileBlob, filename);
  formData.append('force_update', String(forceUpdate));
  formData.append('force_ocr', String(forceOcr));

  const response = await fetch(buildOpenApiUrl(baseUrl, serviceCode, 'upload'), {
    method: 'POST',
    headers: buildAuthHeaders(apiKey),
    body: formData,
  });

  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}): ${extractApiError(payload, 'Request failed')}`);
  }
  if (typeof payload !== 'object' || payload.status === false) {
    throw new Error(`Upload failed: ${extractApiError(payload, 'Invalid upload response')}`);
  }

  const uuid = payload?.data?.uuid;
  if (!uuid) {
    throw new Error(`Upload succeeded but uuid is missing: ${JSON.stringify(payload)}`);
  }

  return uuid;
}

async function pollParsed({ baseUrl, serviceCode, apiKey, uuid, pollIntervalMs, timeoutMs }) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(buildOpenApiUrl(baseUrl, serviceCode, `document/${uuid}`), {
      method: 'GET',
      headers: buildAuthHeaders(apiKey),
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(`Polling failed (${response.status}): ${extractApiError(payload, 'Request failed')}`);
    }
    if (typeof payload !== 'object' || payload.status === false) {
      throw new Error(`Polling failed: ${extractApiError(payload, 'Invalid status response')}`);
    }

    const parsed = payload?.data?.parsed;
    if (parsed === 2) {
      return payload;
    }
    if (typeof parsed === 'number' && parsed < 0) {
      throw new Error(`Parsing failed with status ${parsed}: ${extractApiError(payload, 'Parse failed')}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Polling timed out after ${Math.floor(timeoutMs / 1000)} seconds.`);
}

async function downloadMarkdown({ baseUrl, serviceCode, apiKey, uuid, outputPath, includeImages }) {
  const endpoint = includeImages ? `document/${uuid}/markdown?include_images=true` : `document/${uuid}/markdown`;
  const response = await fetch(buildOpenApiUrl(baseUrl, serviceCode, endpoint), {
    method: 'GET',
    headers: buildAuthHeaders(apiKey),
  });

  const contentType = response.headers.get('content-type') || '';
  const bodyText = await response.text();

  if (!response.ok) {
    let errorMessage = bodyText;
    if (contentType.includes('application/json')) {
      try {
        const payload = JSON.parse(bodyText);
        errorMessage = extractApiError(payload, bodyText);
      } catch {
        // keep bodyText
      }
    }
    throw new Error(`Markdown download failed (${response.status}): ${errorMessage || 'Request failed'}`);
  }

  if (contentType.includes('application/json')) {
    try {
      const payload = JSON.parse(bodyText);
      if (payload?.status === false) {
        throw new Error(`Markdown download failed: ${extractApiError(payload, 'API returned error')}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
    }
  }

  if (outputPath) {
    await fs.writeFile(outputPath, bodyText, 'utf8');
  }
  return bodyText;
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

  stderr.write(`[pd-router-pdflux-markdown] Uploading ${path.basename(filePath)} via ${baseUrl}\n`);
  const uuid = await uploadFile({ baseUrl, serviceCode, apiKey, filePath, forceUpdate, forceOcr });

  stderr.write(`[pd-router-pdflux-markdown] Uploaded uuid=${uuid}\n`);
  stderr.write('[pd-router-pdflux-markdown] Polling parse status\n');
  await pollParsed({
    baseUrl,
    serviceCode,
    apiKey,
    uuid,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  stderr.write('[pd-router-pdflux-markdown] Parse completed, downloading markdown\n');
  const markdown = await downloadMarkdown({
    baseUrl,
    serviceCode,
    apiKey,
    uuid,
    outputPath,
    includeImages,
  });

  if (outputPath) {
    stderr.write(`[pd-router-pdflux-markdown] Markdown saved at ${outputPath}\n`);
  }

  stdout.write(markdown);
  if (!markdown.endsWith('\n')) {
    stdout.write('\n');
  }
}

main().catch(error => {
  stderr.write(`[pd-router-pdflux-markdown] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
