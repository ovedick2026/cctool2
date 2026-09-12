/* ==========================================================================
 *  server.js —— 【通讯骨架层 (完整保留 URL 校验、Passthrough 与 Undici 超长连接)】
 * ========================================================================== */
import express from "express";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Agent, setGlobalDispatcher } from "undici";
import * as adapt from "./adapt.js";

// 1. 底层网络配置：IPv4 优先，40 分钟超长连接防断开
dns.setDefaultResultOrder("ipv4first");
setGlobalDispatcher(
  new Agent({
    headersTimeout: 2400000,
    bodyTimeout: 2400000,
    connectTimeout: 120000
  })
);

const PORT = Number(process.env.PORT || 7860);
const ALLOW_HTTP = false;
const ALLOWED_HOSTS = [];
const UPSTREAM_MAX_ATTEMPTS = 2;
const UPSTREAM_TIMEOUT_MS = 2400000;
const RETRY_MAX_DELAY_MS = 30000;
const CONNECT_MAX_ATTEMPTS = 3;

// ==========================================
// 2. 结构化彩色控制台日志 (简单明了，便于直接复制排查)
// ==========================================
function getLogTime() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const logger = {
  info: (tag, msg, extra = {}) => {
    console.log(`\x1b[36m[${getLogTime()}]\x1b[0m \x1b[32m【${tag}】\x1b[0m ${msg}`);
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) {
        const valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
        console.log(`  \x1b[33m▶ ${k}:\x1b[0m ${valStr}`);
      }
    }
  },
  warn: (tag, msg, extra = {}) => {
    console.warn(`\x1b[33m[${getLogTime()}] ⚠️ 【${tag}】 ${msg}\x1b[0m`);
    for (const [k, v] of Object.entries(extra)) {
      console.warn(`  ▶ ${k}:`, v);
    }
  },
  error: (tag, msg, err = null) => {
    console.error(`\x1b[31m[${getLogTime()}] ❌ 【${tag}】 ${msg}\x1b[0m`, err || "");
  }
};

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    [
      "Authorization",
      "Content-Type",
      "x-api-key",
      "anthropic-version",
      "anthropic-auth-token"
    ].join(", ")
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.json({ limit: "100mb" }));

// ==========================================
// 3. 主路由入口 (完整保留 old 的目标 URL 动态提取与 SSRF 保护)
// ==========================================
app.use(async (req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  try {
    const targetUrl = parseTargetFromPath(req);
    if (!targetUrl) {
      return res.status(404).json({
        error: {
          type: "invalid_request_error",
          message: "Expected target URL path, e.g. /https://target.example.com/v1/messages"
        }
      });
    }
    await validateTargetUrl(targetUrl, req);
    const pathname = targetUrl.pathname.replace(/\/+$/, "") || "/";

    // 1. 获取模型列表 —— 绝对透传上游，杜绝假数据！
    if (req.method === "GET" && pathname.endsWith("/v1/models")) {
      return await passthroughRequest(req, res, requestId, targetUrl);
    }

    // 2. Token 计数端点
    if (req.method === "POST" && pathname.endsWith("/v1/messages/count_tokens")) {
      const bodyText = JSON.stringify(req.body || {});
      return res.json({ input_tokens: Math.max(1, Math.ceil(bodyText.length / 4)) });
    }

    // 3. Claude Code /v1/messages 主调度入口
    if (req.method === "POST" && (pathname.endsWith("/v1/messages") || pathname.endsWith("/v1/message"))) {
      return await handleAnthropicMessages(req, res, requestId, targetUrl);
    }

    // 4. 其他常规请求原样透传
    return await passthroughRequest(req, res, requestId, targetUrl);
  } catch (error) {
    const status = Number(error?.status) || 502;
    logger.error("请求失败", `${req.method} ${req.url} -> ${error?.message}`);
    if (!res.headersSent) {
      return res.status(status).json({
        error: { type: "api_error", message: error?.message || "Bridge request failed." }
      });
    } else {
      res.end();
    }
  }
});

// ==========================================
// 4. 核心调度处理 (统一走 /v1/chat/completions + 5s心跳保活)
// ==========================================
async function handleAnthropicMessages(req, res, requestId, originalTargetUrl) {
  const startTime = Date.now();
  const body = req.body || {};
  const isClientStream = body.stream === true;
  const messages = body.messages || [];

  // 1. 智能压缩与流水线提示词组装
  const { globalTask, historyLogsText, latestTurnInput } = adapt.parseConversation(messages);
  const finalPrompt = adapt.buildPrompt(globalTask, historyLogsText);

  logger.info("收到 CC 调度请求", body.model || "claude-sonnet", {
    上游目标: originalTargetUrl.origin,
    本次增量输入: latestTurnInput.slice(0, 100),
    是否流式: isClientStream
  });

  const clientAbortController = new AbortController();
  req.on("close", () => clientAbortController.abort());

  const msgId = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let heartbeatTimer = null;
  let blockIndex = 0;

  const sendSSE = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 2. 建立 SSE 连接并启动 5 秒定时注释保活心跳
  if (isClientStream) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    sendSSE("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: body.model || "claude-sonnet-x",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 150, output_tokens: 0 }
      }
    });

    heartbeatTimer = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(": keep-alive\n\n");
        } else {
          clearInterval(heartbeatTimer);
        }
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, 5000);
  }

  try {
    // 3. 改写目标为 /v1/chat/completions 统一调用上游
    const upstreamUrl = rewriteAnthropicMessagesToOpenAI(originalTargetUrl);
    const openAIBody = {
      model: body.model || "claude-3-7-sonnet-20250219",
      messages: [{ role: "user", content: finalPrompt }],
      temperature: body.temperature,
      top_p: body.top_p,
      stream: true
    };

    const upstreamResponse = await fetchUpstreamStreamWithRetry(requestId, upstreamUrl, {
      method: "POST",
      headers: {
        ...buildUpstreamHeaders(req),
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json"
      },
      body: JSON.stringify(openAIBody),
      signal: clientAbortController.signal
    });

    // 4. 流式收集上游正文（抑制 Thinking 转发给客户端）
    let rawContentText = "";
    let inThinkTag = false;

    for await (const { data } of readSSE(upstreamResponse)) {
      if (clientAbortController.signal.aborted) break;
      if (!data || data === "[DONE]") continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = payload.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        let contentChunk = delta.content;
        while (contentChunk.length > 0) {
          if (!inThinkTag) {
            const thinkStartIdx = contentChunk.indexOf("");
            if (thinkStartIdx !== -1) {
              rawContentText += contentChunk.slice(0, thinkStartIdx);
              inThinkTag = true;
              contentChunk = contentChunk.slice(thinkStartIdx + 7);
            } else {
              rawContentText += contentChunk;
              contentChunk = "";
            }
          } else {
            const thinkEndIdx = contentChunk.indexOf("<think>");
            if (thinkEndIdx !== -1) {
              inThinkTag = false;
              contentChunk = contentChunk.slice(thinkEndIdx + 8);
            } else {
              contentChunk = "";
            }
          }
        }
      }
    }

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // 5. 提取动作配置并转为 CC 原生工具调用
    const { text: cleanText } = adapt.splitThinking(rawContentText);
    const parsedAction = adapt.extractActionAndThought(cleanText);

    let stopReason = "end_turn";
    let textContent = "";
    let toolBlock = null;

    if (parsedAction && parsedAction.action && parsedAction.action !== "finish") {
      const mappedTool = adapt.mapActionToClaudeCodeTool(parsedAction.action, parsedAction.params);
      stopReason = "tool_use";

      const targetDesc = mappedTool.arguments?.file_path || mappedTool.arguments?.command || "";
      textContent = `调度 ${mappedTool.name} ${targetDesc ? "-> " + targetDesc : ""}`.slice(0, 80);

      toolBlock = {
        type: "tool_use",
        id: `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        name: mappedTool.name,
        input: mappedTool.arguments
      };

      logger.info("装配 CC 工具", mappedTool.name, {
        耗时: `${Date.now() - startTime}ms`,
        参数概览: Object.keys(mappedTool.arguments || {})
      });
    } else {
      textContent = parsedAction?.params?.summary || parsedAction?.thought || cleanText;
      stopReason = "end_turn";
      logger.info("输出普通文本", textContent.slice(0, 80), {
        耗时: `${Date.now() - startTime}ms`
      });
    }

    // 6. 响应给 Claude Code
    if (isClientStream) {
      if (textContent) {
        sendSSE("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" }
        });
        sendSSE("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: textContent }
        });
        sendSSE("content_block_stop", { type: "content_block_stop", index: blockIndex });
        blockIndex++;
      }

      if (toolBlock) {
        sendSSE("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: toolBlock.id,
            name: toolBlock.name,
            input: {}
          }
        });
        sendSSE("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(toolBlock.input)
          }
        });
        sendSSE("content_block_stop", { type: "content_block_stop", index: blockIndex });
        blockIndex++;
      }

      sendSSE("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 300 }
      });
      sendSSE("message_stop", { type: "message_stop" });
      res.end();
    } else {
      const content = [];
      if (textContent) content.push({ type: "text", text: textContent });
      if (toolBlock) content.push(toolBlock);

      res.json({
        id: msgId,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 150, output_tokens: 300 }
      });
    }
  } catch (err) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logger.error("消息调度异常", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  }
}

// ==========================================
// 5. URL 穿透与上游网络底层 (原样保留 old 的生产级底座)
// ==========================================
function parseTargetFromPath(req) {
  let raw = req.originalUrl.startsWith("/") ? req.originalUrl.slice(1) : req.originalUrl;
  if (!/^https?:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {}
  }
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    return new URL(raw);
  } catch {
    throw httpError(400, "Invalid target URL.");
  }
}

function rewriteAnthropicMessagesToOpenAI(targetUrl) {
  const url = new URL(targetUrl);
  if (/\/v1\/messages?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/messages?$/i, "/v1/chat/completions");
  }
  return url;
}

async function validateTargetUrl(url, req = null) {
  if (!["https:", "http:"].includes(url.protocol)) {
    throw httpError(400, "Only http(s) target URLs are supported.");
  }
  if (url.protocol === "http:" && !ALLOW_HTTP) {
    throw httpError(400, "HTTP targets are disabled. Use HTTPS.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost") {
    throw httpError(403, "localhost target is forbidden.");
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw httpError(403, "Private IP target is forbidden.");
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw httpError(400, `Cannot resolve target hostname: ${hostname}`);
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw httpError(403, `Target hostname resolves to forbidden private address: ${record.address}`);
    }
  }
}

function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const norm = ip.toLowerCase();
    return (
      norm === "::1" ||
      norm === "::" ||
      norm.startsWith("fc") ||
      norm.startsWith("fd") ||
      norm.startsWith("fe80:")
    );
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function buildUpstreamHeaders(req) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    Accept: "application/json, */*"
  };
  const passHeaders = [
    "authorization",
    "x-api-key",
    "api-key",
    "anthropic-version",
    "anthropic-auth-token"
  ];
  for (const key of passHeaders) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }
  if (!headers.authorization) {
    if (req.headers["x-api-key"]) {
      headers.authorization = `Bearer ${req.headers["x-api-key"]}`;
    } else if (req.headers["anthropic-auth-token"]) {
      headers.authorization = `Bearer ${req.headers["anthropic-auth-token"]}`;
    }
  }
  return headers;
}

// 透传专用函数：用于 /v1/models 与其他非 messages 流量
async function passthroughRequest(req, res, requestId, targetUrl) {
  const hasBody = !["GET", "HEAD"].includes(req.method);
  const upstream = await fetchUpstreamWithRetry(requestId, targetUrl, {
    method: req.method,
    headers: {
      ...buildUpstreamHeaders(req),
      ...(hasBody ? { "Content-Type": "application/json" } : {})
    },
    body: hasBody ? JSON.stringify(req.body || {}) : undefined
  });
  res.status(upstream.response.status);
  res.setHeader(
    "Content-Type",
    upstream.response.headers.get("content-type") || "application/json"
  );
  res.send(upstream.raw);
}

async function fetchUpstreamStreamWithRetry(requestId, targetUrl, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt++) {
    const response = await safeFetch(targetUrl, options, timeoutMs);
    if (!response || !response.headers) {
      throw httpError(502, "Bridge did not receive a valid Response object.");
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      if ([502, 503, 504].includes(response.status) && attempt < UPSTREAM_MAX_ATTEMPTS) {
        await sleep(1500);
        continue;
      }
      throw httpError(response.status, `Upstream error ${response.status}: ${raw.slice(0, 500)}`);
    }
    return response;
  }
  throw httpError(502, "Upstream stream connection failed after retries.");
}

async function fetchUpstreamWithRetry(requestId, targetUrl, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  let last = null;
  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt++) {
    const response = await safeFetch(targetUrl, options, timeoutMs);
    if (!response || !response.headers) {
      throw httpError(502, "Bridge did not receive a valid Response object.");
    }
    const raw = await response.text().catch(() => "");
    last = { response, raw };
    if (![502, 503, 504].includes(response.status) || attempt >= UPSTREAM_MAX_ATTEMPTS) {
      return last;
    }
    await sleep(1500);
  }
  return last;
}

async function safeFetch(initialUrl, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  let current = new URL(initialUrl);
  for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
    await validateTargetUrl(current);
    let response = null;
    let lastError = null;

    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const onCallerAbort = () => controller.abort();
      if (options?.signal) {
        options.signal.addEventListener("abort", onCallerAbort, { once: true });
      }

      try {
        response = await fetch(current, {
          ...options,
          redirect: "manual",
          signal: controller.signal
        });
        clearTimeout(timer);
        if (options?.signal) options.signal.removeEventListener("abort", onCallerAbort);
        break;
      } catch (error) {
        clearTimeout(timer);
        if (options?.signal) options.signal.removeEventListener("abort", onCallerAbort);
        lastError = error;
        if (attempt < CONNECT_MAX_ATTEMPTS) {
          await sleep(500);
          continue;
        }
      }
    }
    if (!response) {
      throw httpError(502, `Upstream network error: ${lastError?.message || "Failed to fetch"}`);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw httpError(502, "Upstream redirect has no Location header.");
    current = new URL(location, current);
  }
  throw httpError(502, "Too many upstream redirects.");
}

async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      let eventType = null;
      let dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        } else if (line === "") {
          if (dataLines.length > 0) {
            yield { event: eventType, data: dataLines.join("\n") };
            eventType = null;
            dataLines = [];
          }
        }
      }
    }
    if (buffer.trim()) {
      const lines = buffer.split(/\r?\n/);
      let eventType = null;
      let dataLines = [];
      for (const line of lines) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length > 0) {
        yield { event: eventType, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================
// 6. 服务监听启动
// ==========================================
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n\x1b[32m======================================================\x1b[0m`);
  console.log(` \x1b[36m🚀 CC 智能中介已稳定就绪 (端口: ${PORT})\x1b[0m`);
  console.log(` \x1b[32m======================================================\x1b[0m\n`);
});

server.requestTimeout = 2400000;
server.headersTimeout = 2400000;
server.keepAliveTimeout = 120000;
