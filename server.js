/* ==========================================================================
 *  server.js —— 【轻量通讯骨架层 (统一上游 /v1/chat/completions + 5s心跳保活)】
 * ========================================================================== */
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, setGlobalDispatcher } from 'undici';
import * as adapt from './adapt.js';

// 1. 网络底层底座：IPv4 优先，40 分钟超长连接超时
dns.setDefaultResultOrder('ipv4first');
setGlobalDispatcher(
  new Agent({
    headersTimeout: 2400000,
    bodyTimeout: 2400000,
    connectTimeout: 120000
  })
);

const PORT = Number(process.env.PORT || 7860);
const ALLOW_HTTP = false;
const UPSTREAM_TIMEOUT_MS = 2400000;

// ==========================================
// 2. 清晰、便于复制的控制台日志
// ==========================================
function getLogTime() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
  info: (tag, msg, extra = {}) => {
    console.log(`\n\x1b[36m[${getLogTime()}]\x1b[0m \x1b[32m【${tag}】\x1b[0m ${msg}`);
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) {
        const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        console.log(`  \x1b[33m▶ ${k}:\x1b[0m ${valStr}`);
      }
    }
  },
  warn: (tag, msg, extra = {}) => {
    console.warn(`\n\x1b[33m[${getLogTime()}] ⚠️ 【${tag}】 ${msg}\x1b[0m`);
    for (const [k, v] of Object.entries(extra)) {
      console.warn(`  ▶ ${k}:`, v);
    }
  },
  error: (tag, msg, err = null) => {
    console.error(`\n\x1b[31m[${getLogTime()}] ❌ 【${tag}】 ${msg}\x1b[0m`, err || '');
  }
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ==========================================
// 3. 安全防护与 URL 穿透解析
// ==========================================
function parseTargetUrl(req) {
  let raw = req.originalUrl.startsWith('/') ? req.originalUrl.slice(1) : req.originalUrl;
  if (!/^https?:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {}
  }

  const v1Match = raw.match(
    /^(https?:\/\/[^\/]+(?:\/[^\/]+)*?)\/(v1\/(?:messages|chat\/completions|models|messages\/count_tokens))(?:\?(.*))?$/i
  );
  if (v1Match) {
    return {
      upstreamBase: v1Match[1],
      endpoint: '/' + v1Match[2],
      fullTarget: v1Match[1] + '/' + v1Match[2]
    };
  }

  const defaultBase = (process.env.UPSTREAM_BASE_URL || '').replace(/\/$/, '');
  return {
    upstreamBase: defaultBase,
    endpoint: req.path,
    fullTarget: defaultBase + req.path
  };
}

function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const norm = ip.toLowerCase();
    return (
      norm === '::1' ||
      norm === '::' ||
      norm.startsWith('fc') ||
      norm.startsWith('fd') ||
      norm.startsWith('fe80:')
    );
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function validateHost(hostname) {
  if (!hostname || hostname === 'localhost') {
    throw new Error('Localhost target is forbidden.');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private IP targets are forbidden.');
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Cannot resolve target hostname: ${hostname}`);
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error(`Forbidden private address resolved: ${record.address}`);
    }
  }
}

// ==========================================
// 4. 上游流式请求与 SSE 解析 (全走 chat/completions)
// ==========================================
async function* readSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      let dataLines = [];
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        } else if (line === '' && dataLines.length > 0) {
          yield dataLines.join('\n');
          dataLines = [];
        }
      }
    }
    if (buffer.trim()) yield buffer.replace(/^data:\s*/, '');
  } finally {
    reader.releaseLock();
  }
}

async function fetchUpstreamCompletions(upstreamBase, apiKey, model, prompt, clientSignal) {
  const targetUrl = `${upstreamBase.replace(/\/$/, '')}/v1/chat/completions`;
  const urlObj = new URL(targetUrl);
  await validateHost(urlObj.hostname);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    Authorization: `Bearer ${apiKey}`,
    Accept: 'text/event-stream, application/json'
  };

  const body = {
    model: model || 'claude-3-7-sonnet-20250219',
    messages: [{ role: 'user', content: prompt }],
    stream: true
  };

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: clientSignal
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`上游接口报错 HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  let fullContent = '';
  let inThinkTag = false;
  const tagOpen = '<think>';
  const tagClose = '</think>';

  for await (const chunk of readSSE(res)) {
    if (clientSignal.aborted) break;
    if (!chunk || chunk === '[DONE]') continue;
    try {
      const payload = JSON.parse(chunk);
      const delta = payload.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        let piece = delta.content;
        while (piece.length > 0) {
          if (!inThinkTag) {
            const start = piece.indexOf(tagOpen);
            if (start !== -1) {
              fullContent += piece.slice(0, start);
              inThinkTag = true;
              piece = piece.slice(start + tagOpen.length);
            } else {
              fullContent += piece;
              piece = '';
            }
          } else {
            const end = piece.indexOf(tagClose);
            if (end !== -1) {
              inThinkTag = false;
              piece = piece.slice(end + tagClose.length);
            } else {
              piece = '';
            }
          }
        }
      }
    } catch {}
  }

  return fullContent;
}

// ==========================================
// 5. 核心路由: POST */v1/messages (Claude Code 主入口)
// ==========================================
app.post(/(.*)\/v1\/messages$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey =
    req.headers['x-api-key'] ||
    (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body;

  const { globalTask, historyLogsText, latestTurnInput } = adapt.parseConversation(
    messages || []
  );

  logger.info('收到 CC 请求', `${model}`, {
    上游目标: upstreamBase,
    本次增量输入: latestTurnInput.slice(0, 120),
    流式传输: stream === true
  });

  const msgId = 'msg_' + crypto.randomUUID().replaceAll('-', '');
  let heartbeatTimer = null;
  let blockIndex = 0;

  const sendSSE = (ev, data) => {
    if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 1. 初始化 SSE 连接并启动 5 秒定时保活心跳
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sendSSE('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: model || 'claude-3-7-sonnet',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 150, output_tokens: 0 }
      }
    });

    // 【防断线与防重复请求核心】：每 5 秒向 CC 客户端下发一次 SSE 注释心跳
    heartbeatTimer = setInterval(() => {
      try {
        if (!res.writableEnded) {
          res.write(': keep-alive\n\n');
        } else {
          clearInterval(heartbeatTimer);
        }
      } catch {
        clearInterval(heartbeatTimer);
      }
    }, 5000);
  }

  const clientAbortController = new AbortController();
  req.on('close', () => {
    clientAbortController.abort();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  try {
    const prompt = adapt.buildPrompt(globalTask, historyLogsText);

    // 2. 向上游 /v1/chat/completions 请求（抑制 Thinking 转发，全量收取正文）
    const assistantText = await fetchUpstreamCompletions(
      upstreamBase,
      apiKey,
      model,
      prompt,
      clientAbortController.signal
    );

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // 3. 解析模型动作并适配 CC 工具
    const parsedAction = adapt.extractActionAndThought(assistantText);
    let stopReason = 'end_turn';
    let textContent = '';
    let toolBlock = null;

    if (parsedAction && parsedAction.action && parsedAction.action !== 'finish') {
      const mappedTool = adapt.mapActionToClaudeCodeTool(
        parsedAction.action,
        parsedAction.params
      );
      stopReason = 'tool_use';

      const targetDesc =
        mappedTool.arguments?.file_path || mappedTool.arguments?.command || '';
      textContent = `调度 ${mappedTool.name} ${targetDesc ? '-> ' + targetDesc : ''}`.slice(
        0,
        80
      );

      toolBlock = {
        type: 'tool_use',
        id: 'toolu_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20),
        name: mappedTool.name,
        input: mappedTool.arguments
      };

      logger.info('装配 CC 原生工具', mappedTool.name, {
        耗时: `${Date.now() - startTime}ms`,
        参数概览: Object.keys(mappedTool.arguments || {})
      });
    } else {
      textContent =
        parsedAction?.params?.summary || parsedAction?.thought || assistantText;
      stopReason = 'end_turn';
      logger.info('流水线输出文本', textContent.slice(0, 100), {
        耗时: `${Date.now() - startTime}ms`
      });
    }

    // 4. 回写响应给 Claude Code
    if (stream) {
      if (textContent) {
        sendSSE('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'text', text: '' }
        });
        sendSSE('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: textContent }
        });
        sendSSE('content_block_stop', {
          type: 'content_block_stop',
          index: blockIndex
        });
        blockIndex++;
      }

      if (toolBlock) {
        sendSSE('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: toolBlock.id,
            name: toolBlock.name,
            input: {}
          }
        });
        sendSSE('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(toolBlock.input)
          }
        });
        sendSSE('content_block_stop', {
          type: 'content_block_stop',
          index: blockIndex
        });
        blockIndex++;
      }

      sendSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 300 }
      });
      sendSSE('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      const content = [];
      if (textContent) content.push({ type: 'text', text: textContent });
      if (toolBlock) content.push(toolBlock);

      res.json({
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 150, output_tokens: 300 }
      });
    }
  } catch (err) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logger.error('消息处理失败', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: err.message } });
    } else {
      res.end();
    }
  }
});

// ==========================================
// 6. 辅助端点: models / count_tokens / healthz
// ==========================================
app.get('/healthz', (req, res) => {
  res.json({ ok: true, status: 'ready' });
});

app.get(/(.*)\/v1\/models$/, async (req, res) => {
  const { upstreamBase } = parseTargetUrl(req);
  try {
    const authHeader =
      req.headers['authorization'] || `Bearer ${req.headers['x-api-key'] || ''}`;
    const upstreamRes = await fetch(`${upstreamBase}/v1/models`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(6000)
    });
    if (upstreamRes.ok) return res.json(await upstreamRes.json());
  } catch {}

  res.json({
    object: 'list',
    data: [
      { id: 'claude-3-7-sonnet-20250219', object: 'model' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model' }
    ]
  });
});

app.post(/(.*)\/v1\/messages\/count_tokens$/, (req, res) => {
  const bodyText = JSON.stringify(req.body || {});
  res.json({ input_tokens: Math.max(1, Math.ceil(bodyText.length / 4)) });
});

// ==========================================
// 7. 服务启动
// ==========================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` 🚀 CC 流水线智能中介就绪 (端口: ${PORT})`);
  console.log(` 🔗 上游通讯协议: /v1/chat/completions`);
  console.log(` 🛡️  心跳保活: 每 5s 发送一次 SSE keep-alive`);
  console.log(`======================================================\n`);
});

server.requestTimeout = 2400000;
server.headersTimeout = 2400000;
server.keepAliveTimeout = 120000;
