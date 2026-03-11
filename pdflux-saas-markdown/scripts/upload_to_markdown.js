#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stderr, stdout } = require('node:process');

const DEFAULT_BASE_URL = 'https://saas.pdflux.com';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url) {
  return (url || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

async function readAccessToken() {
  const fromEnv = (process.env.PAODINGAI_API_KEY || '').trim();
  if (fromEnv) {
    return fromEnv;
  }

  const rl = readline.createInterface({
    input: stdin,
    output: stderr,
  });

  try {
    const input = await rl.question('Enter PAODINGAI_API_KEY: ');
    const token = (input || '').trim();
    if (!token) {
      throw new Error('PAODINGAI_API_KEY is required but not provided.');
    }
    return token;
  } finally {
    rl.close();
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
    return payload.msg || payload.message || JSON.stringify(payload);
  }
  return fallback;
}

async function uploadFile({ baseUrl, token, filePath }) {
  const formData = new FormData();
  const filename = path.basename(filePath);
  const bytes = await fs.readFile(filePath);
  const fileBlob = new Blob([bytes], { type: 'application/octet-stream' });
  formData.append('file', fileBlob, filename);

  const response = await fetch(`${baseUrl}/api/v1/saas/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(
      `Upload failed (${response.status}): ${extractApiError(payload, 'Request failed')}`,
    );
  }

  if (typeof payload !== 'object' || payload.status === false) {
    throw new Error(
      `Upload failed: ${extractApiError(payload, 'Invalid upload response')}`,
    );
  }

  const uuid = payload?.data?.uuid;
  if (!uuid) {
    throw new Error(
      `Upload succeeded but uuid is missing: ${JSON.stringify(payload)}`,
    );
  }

  return uuid;
}

async function pollParsed({ baseUrl, token, uuid, pollIntervalMs, timeoutMs }) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await fetch(`${baseUrl}/api/v1/saas/document/${uuid}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const payload = await parseResponse(response);
    if (!response.ok) {
      throw new Error(
        `Polling failed (${response.status}): ${extractApiError(payload, 'Request failed')}`,
      );
    }
    if (typeof payload !== 'object' || payload.status === false) {
      throw new Error(
        `Polling failed: ${extractApiError(payload, 'Invalid status response')}`,
      );
    }

    const parsed = payload?.data?.parsed;
    if (parsed === 2) {
      return;
    }
    if (typeof parsed === 'number' && parsed < 0) {
      throw new Error(
        `Parsing failed with status ${parsed}: ${extractApiError(payload, 'Parse failed')}`,
      );
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Polling timed out after ${Math.floor(timeoutMs / 1000)} seconds.`,
  );
}

async function downloadMarkdown({ baseUrl, token, uuid }) {
  const response = await fetch(
    `${baseUrl}/api/v1/saas/document/${uuid}/markdown`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  const contentType = response.headers.get('content-type') || '';
  const bodyText = await response.text();

  if (!response.ok) {
    let errorMessage = bodyText;
    if (contentType.includes('application/json')) {
      try {
        const payload = JSON.parse(bodyText);
        errorMessage = extractApiError(payload, bodyText);
      } catch {
        // Keep bodyText
      }
    }
    throw new Error(
      `Markdown download failed (${response.status}): ${errorMessage || 'Request failed'}`,
    );
  }

  if (contentType.includes('application/json')) {
    try {
      const payload = JSON.parse(bodyText);
      if (payload?.status === false) {
        throw new Error(
          `Markdown download failed: ${extractApiError(payload, 'API returned error')}`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
    }
  }

  return bodyText;
}

async function ensureInputFile(filePathArg) {
  if (!filePathArg) {
    throw new Error('Usage: node upload_to_markdown.js <local-file-path>');
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
  const token = await readAccessToken();
  const baseUrl = normalizeBaseUrl(process.env.PAODINGAI_API_BASE_URL);

  const pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = DEFAULT_TIMEOUT_MS;

  stderr.write(`[pdflux-saas-markdown] Uploading ${path.basename(filePath)}\n`);
  const uuid = await uploadFile({ baseUrl, token, filePath });

  stderr.write(`[pdflux-saas-markdown] Uploaded uuid=${uuid}\n`);
  stderr.write('[pdflux-saas-markdown] Polling parse status\n');
  await pollParsed({ baseUrl, token, uuid, pollIntervalMs, timeoutMs });

  stderr.write(
    '[pdflux-saas-markdown] Parse completed, downloading markdown\n',
  );
  const markdown = await downloadMarkdown({ baseUrl, token, uuid });

  stdout.write(markdown);
  if (!markdown.endsWith('\n')) {
    stdout.write('\n');
  }
}

main().catch(error => {
  stderr.write(
    `[pdflux-saas-markdown] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
