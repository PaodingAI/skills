#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MAX_FILE_SIZE = 104_857_600;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const ZIP_SIGNATURES = new Set(['504b0304', '504b0506', '504b0708']);
const PDROUTER_SERVICE_CODE = 'autodoc-next';
const DEFAULT_PAODINGAI_API_BASE_URL = 'https://platform.paodingai.com';
const DOWNLOAD_RETRIES = 2;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const STATUS_REQUEST_TIMEOUT_MS = 30_000;
const STATUS_REQUEST_ATTEMPTS = 3;
const HEARTBEAT_INTERVAL_MS = 30_000;
const TERMINAL_SUCCESS_STATES = new Set([
  'completed',
  'done',
  'finished',
  'success',
  'succeeded',
]);
const TERMINAL_FAILURE_STATES = new Set([
  'cancelled',
  'canceled',
  'error',
  'failed',
  'failure',
  'rejected',
]);

export class AuditError extends Error {
  constructor(errorCode, message, options = {}) {
    super(message, options);
    this.name = 'AuditError';
    this.errorCode = errorCode;
    this.requestId = options.requestId ?? null;
  }
}

function usage() {
  return [
    'Usage:',
    '  node scripts/audit_document.mjs start <file> [--max-wait-seconds <seconds>] [--json]',
    '  node scripts/audit_document.mjs watch <request_id> [--max-wait-seconds <seconds>] [--json]',
    '  node scripts/audit_document.mjs status <request_id> [--json]',
    '  node scripts/audit_document.mjs download <request_id> [--output-dir <dir>] [--json]',
  ].join('\n');
}

function positiveSeconds(value, optionName) {
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  ) {
    throw new AuditError('audit.invalid_arguments', `${optionName} 必须是正整数秒数`);
  }
  return seconds;
}

export function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') return { help: true };
  const mode = argv[0];
  if (!['start', 'watch', 'status', 'download'].includes(mode)) {
    throw new AuditError('audit.invalid_arguments', '必须指定 start、watch、status 或 download 命令');
  }

  let inputFile = null;
  let requestId = null;
  let outputDir = null;
  let jsonProgress = false;
  let maxWaitSeconds = null;

  const positional = argv[1];
  if (!positional || positional.startsWith('-')) {
    throw new AuditError(
      'audit.invalid_arguments',
      `${mode} 缺少${mode === 'start' ? '本地文件' : 'request_id'}`,
    );
  }
  if (mode === 'start') inputFile = positional;
  else requestId = positional;

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output-dir') {
      outputDir = argv[index + 1];
      if (!outputDir || outputDir.startsWith('--')) {
        throw new AuditError('audit.invalid_arguments', '--output-dir 缺少目录参数');
      }
      index += 1;
    } else if (argument === '--max-wait-seconds') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--') || maxWaitSeconds !== null) {
        throw new AuditError('audit.invalid_arguments', '--max-wait-seconds 缺少唯一的秒数');
      }
      maxWaitSeconds = positiveSeconds(value, '--max-wait-seconds');
      index += 1;
    } else if (argument === '--json') {
      jsonProgress = true;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else if (argument.startsWith('-')) {
      throw new AuditError('audit.invalid_arguments', `不支持的参数: ${argument}`);
    } else {
      throw new AuditError('audit.invalid_arguments', `参数位置无效: ${argument}`);
    }
  }

  if (mode !== 'download' && outputDir !== null) {
    throw new AuditError('audit.invalid_arguments', '--output-dir 仅适用于 download 命令');
  }
  if (!['start', 'watch'].includes(mode) && maxWaitSeconds !== null) {
    throw new AuditError('audit.invalid_arguments', '--max-wait-seconds 仅适用于 start 和 watch 命令');
  }
  if (mode !== 'start') validateRequestId(requestId);
  return {
    help: false,
    mode,
    inputFile,
    requestId,
    outputDir,
    jsonProgress,
    maxWaitSeconds,
  };
}

export async function validateInputFile(filePath) {
  const absolutePath = path.resolve(filePath);
  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    throw new AuditError('audit.file_required', '输入文件不存在或无法读取', { cause: error });
  }
  if (!metadata.isFile()) {
    throw new AuditError('audit.invalid_document', '输入必须是普通文件');
  }
  if (metadata.size === 0) {
    throw new AuditError('audit.invalid_document', '输入文件不能为空');
  }
  if (metadata.size > MAX_FILE_SIZE) {
    throw new AuditError('audit.file_too_large', '输入文件不能超过 100 MiB');
  }

  const extension = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new AuditError('audit.invalid_document', '仅支持 PDF、DOC 或 DOCX 文件');
  }

  const handle = await open(absolutePath, 'r');
  const header = Buffer.alloc(8);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }

  const valid =
    (extension === '.pdf' && header.subarray(0, 5).equals(Buffer.from('%PDF-'))) ||
    (extension === '.doc' && header.equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) ||
    (extension === '.docx' && ZIP_SIGNATURES.has(header.subarray(0, 4).toString('hex')));
  if (!valid) {
    throw new AuditError('audit.invalid_document', '文件内容与扩展名不匹配');
  }

  return { absolutePath, extension, size: metadata.size };
}

function requiredEnvironment(name, environment) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new AuditError('audit.configuration_error', `缺少环境变量 ${name}`);
  }
  return value;
}

function normalizeBaseUrl(value) {
  let baseUrl;
  try {
    baseUrl = new URL(value);
  } catch (error) {
    throw new AuditError(
      'audit.configuration_error',
      'PAODINGAI_API_BASE_URL 应为完整的 HTTP(S) URL',
      { cause: error },
    );
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new AuditError('audit.configuration_error', 'PDRouter 服务地址必须使用 HTTP 或 HTTPS');
  }
  if (baseUrl.search || baseUrl.hash) {
    throw new AuditError(
      'audit.configuration_error',
      'PAODINGAI_API_BASE_URL 应采用 HTTP(S) 基础地址格式，例如 https://router.example/customer-a/',
    );
  }
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
  return baseUrl;
}

export function loadConfig(args, environment = process.env) {
  const baseUrlText =
    environment.PAODINGAI_API_BASE_URL?.trim() || DEFAULT_PAODINGAI_API_BASE_URL;
  const environmentMaxWait = environment.AUTODOC_MAX_WAIT_SECONDS?.trim();
  const maxWaitSeconds =
    args.maxWaitSeconds ??
    (environmentMaxWait ? positiveSeconds(environmentMaxWait, 'AUTODOC_MAX_WAIT_SECONDS') : null);

  return {
    baseUrl: normalizeBaseUrl(baseUrlText),
    apiKey: requiredEnvironment('PAODINGAI_API_KEY', environment),
    outputDir: path.resolve(
      args.outputDir ?? environment.AUTODOC_OUTPUT_DIR ?? path.join(process.cwd(), 'autodoc-results'),
    ),
    maxWaitMs: maxWaitSeconds === null ? null : maxWaitSeconds * 1_000,
  };
}

export class AutoDocNextClient {
  constructor({
    baseUrl = DEFAULT_PAODINGAI_API_BASE_URL,
    apiKey = process.env.PAODINGAI_API_KEY,
    fetchImpl = fetch,
  } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new AuditError('audit.configuration_error', '缺少环境变量 PAODINGAI_API_KEY');
    }
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.apiKey = apiKey.trim();
    this.fetchImpl = fetchImpl;
    this.prefix = `openapi/${encodeURIComponent(PDROUTER_SERVICE_CODE)}`;
  }

  endpointUrl(relativePath = '') {
    const normalizedPath = relativePath.replace(/^\/+/, '');
    const suffix = normalizedPath ? `/${normalizedPath}` : '';
    return new URL(`${this.prefix}${suffix}`, this.baseUrl);
  }

  returnedUrl(value, requestId) {
    let url;
    try {
      url = new URL(value, this.endpointUrl('audits'));
    } catch (error) {
      throw new AuditError('audit.invalid_result', '服务返回了非法请求地址', {
        cause: error,
        requestId,
      });
    }
    if (url.origin !== this.baseUrl.origin) {
      throw new AuditError('audit.invalid_result', '服务返回了跨域请求地址', { requestId });
    }
    return url;
  }

  async request(method, url, { requestId, accept = 'application/json', body, timeoutMs } = {}) {
    const controller = timeoutMs ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await this.fetchImpl(url, {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.apiKey}`,
          'X-Request-Id': requestId,
        },
        body,
        signal: controller?.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async submit(input, requestId) {
    const form = new FormData();
    const content = await readFile(input.absolutePath);
    form.append('file', new Blob([content]), path.basename(input.absolutePath));
    return this.request('POST', this.endpointUrl('audits'), { requestId, body: form });
  }

  async status(
    auditRequestId,
    requestId,
    statusUrl = null,
    timeoutMs = STATUS_REQUEST_TIMEOUT_MS,
  ) {
    validateRequestId(auditRequestId);
    validateRequestId(requestId);
    const url = statusUrl
      ? this.returnedUrl(
          statusUrl.replaceAll('{request_id}', encodeURIComponent(auditRequestId)),
          auditRequestId,
        )
      : this.endpointUrl('status');
    url.searchParams.set('request_id', auditRequestId);
    return this.request('GET', url, { requestId, timeoutMs });
  }

  async download(auditRequestId, requestId, downloadUrl = null) {
    validateRequestId(auditRequestId);
    const url = downloadUrl
      ? this.returnedUrl(downloadUrl, auditRequestId)
      : this.endpointUrl('download');
    url.searchParams.set('request_id', auditRequestId);
    return this.request('GET', url, {
      requestId,
      accept: 'application/octet-stream',
    });
  }
}

async function responseError(response, fallbackCode, requestId) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Public errors use the stable status and structured fields available here.
  }
  const routerErrorCode =
    typeof payload?.error_code === 'string'
      ? payload.error_code
      : typeof payload?.code === 'string'
        ? payload.code
        : fallbackCode;
  const errorCode = response.status === 401 ? 'auth.invalid_token' : routerErrorCode;
  const message =
    payload?.message ?? payload?.msg ?? payload?.detail ?? `服务请求失败 (HTTP ${response.status})`;
  return new AuditError(errorCode, message, { requestId });
}

function emitProgress(payload, jsonProgress, stderr = process.stderr) {
  if (jsonProgress) {
    stderr.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  const scope = [payload.stage, payload.module, payload.task_type, payload.sub_module]
    .filter(Boolean)
    .join('/');
  stderr.write(`[${scope || 'audit'}] ${payload.message ?? payload.phase ?? '处理中'}\n`);
}

async function parseJsonResponse(response, requestId, errorCode = 'audit.invalid_response') {
  const text = await response.text();
  if (!text) {
    throw new AuditError(errorCode, '服务返回了空响应', { requestId });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AuditError(errorCode, '服务返回了非法 JSON', { cause: error, requestId });
  }
}

function unwrapData(payload) {
  if (
    payload &&
    typeof payload === 'object' &&
    payload.data &&
    typeof payload.data === 'object' &&
    !Array.isArray(payload.data)
  ) {
    return payload.data;
  }
  return payload;
}

function findRequestId(payload) {
  const candidates = [
    payload?.request_id,
    payload?.requestId,
    payload?.task_id,
    payload?.taskId,
    payload?.data?.request_id,
    payload?.data?.requestId,
    payload?.data?.task_id,
    payload?.data?.taskId,
  ];
  return candidates.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

function validateResponseRequestId(payload, requestId) {
  const returnedRequestId = findRequestId(payload);
  if (!returnedRequestId || returnedRequestId !== requestId) {
    throw new AuditError('audit.invalid_response', '服务返回的审核请求编号不一致', { requestId });
  }
}

function findResult(payload) {
  const candidates = [
    payload?.result,
    payload?.data?.result,
    payload?.output,
    payload?.data?.output,
    payload,
    payload?.data,
  ];
  return candidates.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.file_name === 'string' &&
      Number.isSafeInteger(candidate.file_size) &&
      typeof candidate.sha256 === 'string',
  );
}

function statusValue(payload) {
  const value =
    payload?.status ??
    payload?.state ??
    payload?.data?.status ??
    payload?.data?.state ??
    payload?.phase ??
    payload?.data?.phase;
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function progressItems(payload) {
  const items = [];
  if (Array.isArray(payload)) items.push(...payload);
  if (Array.isArray(payload?.data)) items.push(...payload.data);
  const candidates = [
    payload?.progress,
    payload?.progresses,
    payload?.events,
    payload?.logs,
    payload?.log,
    payload?.data?.progress,
    payload?.data?.progresses,
    payload?.data?.events,
    payload?.data?.logs,
    payload?.data?.log,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) items.push(...candidate);
    else if (candidate && typeof candidate === 'object') items.push(candidate);
  }
  for (const candidate of [payload, payload?.data]) {
    if (candidate && typeof candidate === 'object' && typeof candidate.message === 'string') {
      items.push(candidate);
    }
  }
  return items.filter((item) => item && typeof item === 'object');
}

function validateRequestId(requestId) {
  if (
    typeof requestId !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(requestId)
  ) {
    throw new AuditError('audit.invalid_result', '服务返回了非法请求编号', {
      requestId: typeof requestId === 'string' ? requestId : null,
    });
  }
  return requestId;
}

function statusUrlFromPayload(payload) {
  return (
    payload?.status_url ??
    payload?.statusUrl ??
    payload?.poll_url ??
    payload?.pollUrl ??
    payload?.data?.status_url ??
    payload?.data?.statusUrl ??
    payload?.data?.poll_url ??
    payload?.data?.pollUrl ??
    null
  );
}

function normalizeTerminalResult(result, requestId, payload = null) {
  if (!result) return null;
  const resultRequestId = result.request_id ?? result.requestId;
  if (resultRequestId && resultRequestId !== requestId) {
    throw new AuditError('audit.invalid_response', '服务返回的审核请求编号不一致', { requestId });
  }
  return {
    ...result,
    request_id: requestId,
    download_url:
      result.download_url ??
      result.downloadUrl ??
      payload?.download_url ??
      payload?.downloadUrl ??
      payload?.data?.download_url ??
      payload?.data?.downloadUrl,
  };
}

function terminalError(payload, requestId) {
  const rawErrorCode =
    payload?.error_code ??
    payload?.errorCode ??
    payload?.error?.code ??
    payload?.data?.error_code ??
    payload?.data?.errorCode ??
    payload?.data?.error?.code ??
    'audit.processing_failed';
  const errorCode = typeof rawErrorCode === 'string' ? rawErrorCode : 'audit.processing_failed';
  const rawMessage =
    payload?.message ??
    payload?.msg ??
    payload?.detail ??
    payload?.error?.message ??
    payload?.data?.message ??
    payload?.data?.error?.message ??
    '审核处理失败';
  const message = typeof rawMessage === 'string' ? rawMessage : '审核处理失败';
  return new AuditError(errorCode, message, {
    requestId: findRequestId(payload) ?? requestId,
  });
}

function classifyStatus(payload, requestId) {
  const data = unwrapData(payload);
  const state = statusValue(payload);
  const result = normalizeTerminalResult(findResult(payload), requestId, payload);
  if (state && TERMINAL_SUCCESS_STATES.has(state)) {
    if (!result) {
      return {
        type: 'error',
        error: new AuditError('audit.invalid_response', '服务返回的审核成功终态缺少下载元数据', {
          requestId,
        }),
      };
    }
    return { type: 'result', result };
  }
  if (result && !state) {
    return { type: 'result', result };
  }
  if (state && TERMINAL_FAILURE_STATES.has(state)) {
    return { type: 'error', error: terminalError(data, requestId) };
  }
  if (data?.error_code || data?.errorCode || data?.error) {
    return { type: 'error', error: terminalError(data, requestId) };
  }
  return { type: 'pending' };
}

export async function submitAudit(input, client, options = {}) {
  const requestId = options.requestId ?? randomUUID();

  let response;
  try {
    response = await client.submit(input, requestId);
  } catch (error) {
    throw new AuditError(
      'audit.submit_uncertain',
      `审核连接中断，服务端状态未知，可能当前沙箱环境限制了网络访问，请申请网络访问权限后重试；重试仍不可用，可使用 request_id ${requestId} 人工确认后续处理`,
      { cause: error, requestId },
    );
  }

  if (!response.ok) {
    throw await responseError(response, 'audit.request_failed', requestId);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.toLowerCase().includes('text/event-stream')) {
    throw new AuditError(
      'audit.invalid_response',
      'PDRouter 未返回 JSON 任务响应，请确认服务已配置为轮询接口',
      { requestId },
    );
  }
  const payload = await parseJsonResponse(response, requestId);
  validateResponseRequestId(payload, requestId);
  const terminal = classifyStatus(payload, requestId);
  if (terminal.type === 'error') {
    throw terminal.error;
  }
  return {
    requestId,
    result: terminal.type === 'result' ? terminal.result : null,
    statusUrl: statusUrlFromPayload(payload),
    accepted: unwrapData(payload),
  };
}

function retryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function discardResponse(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The next retry does not depend on draining an already failed response.
  }
}

async function requestStatusWithRetry(requestId, client, options) {
  const attempts = options.statusRequestAttempts ?? STATUS_REQUEST_ATTEMPTS;
  const statusRequestId = randomUUID();
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await client.status(
        requestId,
        statusRequestId,
        options.statusUrl,
        options.statusRequestTimeoutMs,
      );
      if (response.ok || !retryableStatus(response.status) || attempt === attempts) return response;
      await discardResponse(response);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
    }
    options.onRetry();
    await options.sleep(options.retryDelayMs);
  }
  throw new AuditError(
    'audit.poll_uncertain',
    `审核状态查询连接中断，可能当前沙箱环境限制了网络访问，请申请网络访问权限后重试；重试仍不可用，可使用 request_id ${requestId} 恢复轮询`,
    { cause: lastError, requestId },
  );
}

export async function pollAudit(requestId, client, options = {}) {
  validateRequestId(requestId);
  const onProgress = options.onProgress ?? (() => {});
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? null;
  const statusRequestTimeoutMs = options.statusRequestTimeoutMs ?? STATUS_REQUEST_TIMEOUT_MS;
  const statusRequestAttempts = options.statusRequestAttempts ?? STATUS_REQUEST_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? pollIntervalMs;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const seenProgress = new Set();
  const startedAt = now();
  let lastHeartbeatAt = startedAt;
  let latestHeartbeat = {
    request_id: requestId,
    phase: 'heartbeat',
    status: 'processing',
    message: '审核任务仍在处理中',
  };

  const emitHeartbeatIfDue = () => {
    const currentTime = now();
    if (currentTime - lastHeartbeatAt < heartbeatIntervalMs) return;
    onProgress({
      ...latestHeartbeat,
      request_id: requestId,
      phase: 'heartbeat',
      status: 'processing',
      timestamp: Math.floor(currentTime / 1_000),
    });
    lastHeartbeatAt = currentTime;
  };

  const heartbeatTimer = setInterval(emitHeartbeatIfDue, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  try {
    while (true) {
      const elapsed = now() - startedAt;
      if (maxWaitMs !== null && elapsed >= maxWaitMs) {
        throw new AuditError('audit.poll_timeout', '已达到用户设置的最大等待时间', { requestId });
      }
      const remainingWaitMs = maxWaitMs === null ? null : maxWaitMs - elapsed;
      const requestTimeoutMs =
        remainingWaitMs === null
          ? statusRequestTimeoutMs
          : Math.min(statusRequestTimeoutMs, remainingWaitMs);
      const response = await requestStatusWithRetry(requestId, client, {
        statusUrl: options.statusUrl,
        statusRequestTimeoutMs: requestTimeoutMs,
        statusRequestAttempts,
        retryDelayMs,
        sleep,
        onRetry: emitHeartbeatIfDue,
      });
      if (!response.ok) {
        throw await responseError(response, 'audit.poll_failed', requestId);
      }
      const payload = await parseJsonResponse(response, requestId, 'audit.poll_failed');
      validateResponseRequestId(payload, requestId);
      for (const progress of progressItems(payload)) {
        if (progress.phase === 'heartbeat') {
          latestHeartbeat = {
            ...latestHeartbeat,
            ...(typeof progress.stage === 'string' ? { stage: progress.stage } : {}),
            ...(typeof progress.message === 'string' ? { message: progress.message } : {}),
          };
          continue;
        }
        if (typeof progress.stage === 'string') {
          latestHeartbeat = { ...latestHeartbeat, stage: progress.stage };
        }
        const key = JSON.stringify(progress);
        if (!seenProgress.has(key)) {
          seenProgress.add(key);
          onProgress(progress);
        }
      }
      const terminal = classifyStatus(payload, requestId);
      if (terminal.type === 'result') return terminal.result;
      if (terminal.type === 'error') throw terminal.error;
      emitHeartbeatIfDue();
      await sleep(pollIntervalMs);
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function getAuditStatus(requestId, client, options = {}) {
  validateRequestId(requestId);
  const response = await requestStatusWithRetry(requestId, client, {
    statusUrl: options.statusUrl ?? null,
    statusRequestTimeoutMs: options.statusRequestTimeoutMs ?? STATUS_REQUEST_TIMEOUT_MS,
    statusRequestAttempts: options.statusRequestAttempts ?? STATUS_REQUEST_ATTEMPTS,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_POLL_INTERVAL_MS,
    sleep:
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    onRetry: options.onRetry ?? (() => {}),
  });
  if (!response.ok) {
    throw await responseError(response, 'audit.poll_failed', requestId);
  }
  const payload = await parseJsonResponse(response, requestId, 'audit.poll_failed');
  validateResponseRequestId(payload, requestId);
  const data = unwrapData(payload);
  const state = statusValue(payload);
  const terminal = classifyStatus(payload, requestId);
  const progress = progressItems(payload);
  const latestProgress = progress.at(-1);
  return {
    request_id: requestId,
    status: state ?? 'unknown',
    stage:
      typeof data?.stage === 'string'
        ? data.stage
        : typeof latestProgress?.stage === 'string'
          ? latestProgress.stage
          : undefined,
    message:
      typeof data?.message === 'string'
        ? data.message
        : typeof latestProgress?.message === 'string'
          ? latestProgress.message
          : undefined,
    progress,
    result: terminal.type === 'result' ? terminal.result : null,
    terminal: terminal.type !== 'pending',
    error: terminal.type === 'error' ? terminal.error : null,
  };
}

function safeResultFileName(fileName) {
  const cleaned = fileName.replace(/[\u0000-\u001f\u007f]/g, '_');
  if (
    !cleaned ||
    path.isAbsolute(fileName) ||
    cleaned !== path.basename(cleaned) ||
    cleaned.includes('\\') ||
    cleaned === '.' ||
    cleaned === '..'
  ) {
    throw new AuditError('audit.invalid_result', '服务返回了不安全的结果文件名');
  }
  return cleaned;
}

function validateResultMetadata(result) {
  if (
    typeof result.request_id !== 'string' ||
    typeof result.file_name !== 'string' ||
    !Number.isSafeInteger(result.file_size) ||
    result.file_size < 0 ||
    typeof result.sha256 !== 'string' ||
    !/^[a-fA-F0-9]{64}$/.test(result.sha256)
  ) {
    throw new AuditError('audit.invalid_result', '服务返回的下载元数据不完整');
  }
}

async function downloadAttempt(
  client,
  auditRequestId,
  requestId,
  downloadUrl,
  partPath,
  expectedSize,
  expectedSha256,
) {
  const response = await client.download(auditRequestId, requestId, downloadUrl);
  if (!response.ok) return { response };
  if (!response.body) {
    throw new AuditError('audit.download_failed', '下载响应没有文件内容');
  }

  const handle = await open(partPath, 'wx');
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      if (bytes.length > expectedSize - size) {
        throw new AuditError('audit.download_size_mismatch', '下载文件大小校验失败');
      }
      await handle.write(bytes);
      hash.update(bytes);
      size += bytes.length;
    }
  } catch (error) {
    try {
      await response.body.cancel();
    } catch {
      // The stream iterator may already have cancelled or released the body.
    }
    throw error;
  } finally {
    await handle.close();
  }

  const sha256 = hash.digest('hex');
  if (size !== expectedSize) {
    throw new AuditError('audit.download_size_mismatch', '下载文件大小校验失败');
  }
  if (sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new AuditError('audit.download_checksum_mismatch', '下载文件 SHA-256 校验失败');
  }
  return { response, size, sha256 };
}

async function cleanupPartFile(partPath, stderr = process.stderr) {
  try {
    await rm(partPath, { force: true });
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'unknown';
    stderr.write(`[audit] 临时文件清理失败 (${code})，不影响审核结果\n`);
  }
}

function numberedResultFileName(fileName, index) {
  if (index === 0) return fileName;
  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  return `${stem}（${index}）${extension}`;
}

async function publishResultFile(partPath, outputDir, fileName, input) {
  for (let index = 0; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const outputPath = path.join(outputDir, numberedResultFileName(fileName, index));
    if (input && path.resolve(outputPath) === input.absolutePath) continue;
    try {
      await link(partPath, outputPath);
      return outputPath;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw new AuditError('audit.output_write_failed', '无法保存审核结果文件', {
        cause: error,
      });
    }
  }
  throw new AuditError('audit.output_write_failed', '无法分配审核结果文件名');
}

export async function downloadResult(result, input, outputDir, client, options = {}) {
  validateResultMetadata(result);
  const fileName = safeResultFileName(result.file_name);
  await mkdir(outputDir, { recursive: true });
  const stderr = options.stderr ?? process.stderr;

  const downloadRequestId = randomUUID();
  let lastError = null;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    const partPath = path.join(outputDir, `.autodoc-${randomUUID()}.part`);
    try {
      const downloaded = await downloadAttempt(
        client,
        result.request_id,
        downloadRequestId,
        result.download_url,
        partPath,
        result.file_size,
        result.sha256,
      );
      if (!downloaded.response.ok) {
        if (downloaded.response.status < 500 || attempt === DOWNLOAD_RETRIES) {
          throw await responseError(downloaded.response, 'audit.download_failed', result.request_id);
        }
        await discardResponse(downloaded.response);
        lastError = new AuditError('audit.download_failed', '下载服务暂时不可用');
        continue;
      }
      const outputPath = await publishResultFile(partPath, outputDir, fileName, input);
      return { outputPath, size: downloaded.size, sha256: downloaded.sha256 };
    } catch (error) {
      lastError = error;
      if (error instanceof AuditError || attempt === DOWNLOAD_RETRIES) throw error;
    } finally {
      await cleanupPartFile(partPath, stderr);
    }
  }
  throw lastError ?? new AuditError('audit.download_failed', '下载失败');
}

export async function run(argv = process.argv.slice(2), environment = process.env, options = {}) {
  if (argv[0] === '--help' || argv[0] === '-h' || argv.length === 0) {
    return { status: 'help', message: usage() };
  }
  const args = parseArgs(argv);
  if (args.help) {
    return { status: 'help', message: usage() };
  }
  const config = loadConfig(args, environment);
  const client =
    options.client ??
    new AutoDocNextClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      fetchImpl: options.fetchImpl,
    });

  if (args.mode === 'status') {
    const current = await getAuditStatus(args.requestId, client, {
      statusRequestTimeoutMs: options.statusRequestTimeoutMs,
      statusRequestAttempts: options.statusRequestAttempts,
      retryDelayMs: options.retryDelayMs,
      sleep: options.sleep,
    });
    if (current.error) throw current.error;
    return {
      status: current.status,
      request_id: current.request_id,
      ...(current.stage === undefined ? {} : { stage: current.stage }),
      ...(current.message === undefined ? {} : { message: current.message }),
      ...(current.progress.length === 0 ? {} : { progress: current.progress }),
      ...(current.result
        ? {
            file_name: current.result.file_name,
            file_size: current.result.file_size,
            sha256: current.result.sha256,
          }
        : {}),
    };
  }

  if (args.mode === 'download') {
    const current = await getAuditStatus(args.requestId, client, {
      pollIntervalMs: options.pollIntervalMs,
      statusRequestTimeoutMs: options.statusRequestTimeoutMs,
      statusRequestAttempts: options.statusRequestAttempts,
      retryDelayMs: options.retryDelayMs,
      sleep: options.sleep,
    });
    if (current.error) throw current.error;
    if (!current.result) {
      throw new AuditError('audit.not_ready', '审核任务尚未成功完成，请稍后重试下载', {
        requestId: args.requestId,
      });
    }
    const result = current.result;
    const downloaded = await downloadResult(result, null, config.outputDir, client, {
      stderr: options.stderr ?? process.stderr,
    });
    return {
      status: 'downloaded',
      request_id: result.request_id,
      output_file: path.resolve(downloaded.outputPath),
      file_size: downloaded.size,
      sha256: downloaded.sha256,
    };
  }

  const input = args.mode === 'start' ? await validateInputFile(args.inputFile) : null;
  const submitted = args.mode === 'watch'
    ? {
        requestId: args.requestId,
        result: null,
        statusUrl: null,
      }
    : await submitAudit(input, client, {
        requestId: options.requestId,
      });
  if (args.mode === 'start') {
    const accepted = {
      status: 'accepted',
      request_id: submitted.requestId,
    };
    options.onSubmitted?.(accepted);
    emitProgress(
      {
        ...accepted,
        phase: 'submitted',
        message: submitted.result
          ? `审核任务已提交，request_id: ${submitted.requestId}；服务端已返回审核终态，下载请单独执行 download 命令`
          : `审核任务已提交，request_id: ${submitted.requestId}；后台将继续轮询，下载请单独执行 download 命令`,
      },
      args.jsonProgress,
      options.stderr ?? process.stderr,
    );
  }
  const result =
    submitted.result ??
    (await pollAudit(submitted.requestId, client, {
      onProgress: (payload) =>
        emitProgress(payload, args.jsonProgress, options.stderr ?? process.stderr),
      pollIntervalMs: options.pollIntervalMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      maxWaitMs: options.maxWaitMs ?? config.maxWaitMs,
      statusRequestTimeoutMs: options.statusRequestTimeoutMs,
      statusRequestAttempts: options.statusRequestAttempts,
      retryDelayMs: options.retryDelayMs,
      now: options.now,
      sleep: options.sleep,
      statusUrl: submitted.statusUrl,
    }));
  return {
    status: 'succeeded',
    request_id: result.request_id ?? submitted.requestId,
    file_name: result.file_name,
    file_size: result.file_size,
    sha256: result.sha256,
  };
}

async function main() {
  try {
    const result = await run(process.argv.slice(2), process.env, {
      onSubmitted: (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
    });
    if (result.status === 'help') {
      process.stdout.write(`${result.message}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } catch (error) {
    const auditError =
      error instanceof AuditError
        ? error
        : new AuditError('audit.client_failed', '审核客户端执行失败', { cause: error });
    process.stdout.write(
      `${JSON.stringify({
        status: 'failed',
        request_id: auditError.requestId,
        error_code: auditError.errorCode,
        message: auditError.message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
