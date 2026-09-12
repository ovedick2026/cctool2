/* ==========================================================================
 *  server.js —— 【网络代理骨架层】
 * ========================================================================== */
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { Agent, setGlobalDispatcher } from 'undici';
import * as adapt from './adapt.js';

// 1. 底层网络增强：IPv4优先，超长连接防止断开
dns.setDefaultResultOrder('ipv4first');
setGlobalDispatcher(
  new Agent({
    headersTimeout: 2400000,
    bodyTimeout: 2400000,
    connectTimeout: 120000
  })
);

const PORT = Number(process.env.PORT || 7860);

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
// 2. 目标上游与 API 密钥解析
// ==========================================
function parseTargetCompletionsUrl(req) {
  let raw = req.originalUrl.startsWith('/') ? req.originalUrl.slice(1) : req.originalUrl;
  if (!/^https?:\/\//i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {}
  }

  // 1. 穿透代理模式：/https://api.example.com/...
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      // 抹除 query，并将 /v1/messages 统一映射为 /v1/chat/completions
      url.search = '';
      if (/\/v1\/messages?$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/v1\/messages?$/i, '/v1/chat/completions');
      } else if (!url.pathname.endsWith('/chat/completions')) {
        url.pathname = url.pathname.replace(/\/+$/, '') + '/v1/chat/completions';
      }
      return url.toString();
    } catch {}
  }

  // 2. 环境变量回退模式：UPSTREAM_BASE_URL
  const envBase = (process.env.UPSTREAM_BASE_URL || '').replace(/\/+$/, '');
  if (envBase) {
    return `${envBase}/v1/chat/completions`;
  }
  return null;
}

function extractApiKey(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-api-key']) return String(req.headers['x-api-key']).trim();
  if (req.headers['anthropic-auth-token']) return String(req.headers['anthropic-auth-token']).trim();
  return (process.env.UPSTREAM_API_KEY || '').trim();
}

// ==========================================
// 3. 上游 SSE 解析器
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
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          yield trimmed.slice(5).trim();
        }
      }
    }
    if (buffer.trim().startsWith('data:')) {
      yield buffer.trim().slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchUpstreamCompletions(targetUrl, apiKey, model, prompt, clientSignal) {
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
    throw new Error(`上游 HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }

  let fullText = '';
  let inThink = false;
  // 使用拼接防止 markdown 解析歧义
  const tagThinkOpen = '<' + 'think>';
  const tagThinkClose = '<' + '/think>';

  for await (const chunk of readSSE(res)) {
    if (clientSignal.aborted) break;
    if (!chunk || chunk === '[DONE]') continue;

    let payload;
    try {
      payload = JSON.parse(chunk);
    } catch {
      continue;
    }

    const delta = payload.choices?.[0]?.delta;
    if (!delta || !delta.content) continue;

    let piece = delta.content;
    while (piece.length > 0) {
      if (!inThink) {
        const start = piece.indexOf(tagThinkOpen);
        if (start !== -1) {
          fullText += piece.slice(0, start);
          inThink = true;
          piece = piece.slice(start + tagThinkOpen.length);
        } else {
          fullText += piece;
          piece = '';
        }
      } else {
        const end = piece.indexOf(tagThinkClose);
        if (end !== -1) {
          inThink = false;
          piece = piece.slice(end + tagThinkClose.length);
        } else {
          piece = '';
        }
      }
    }
  }

  return fullText;
}

// ==========================================
// 4. 全局路由网关（无死角捕获）
// ==========================================
app.use(async (req, res) => {
  const pathname = req.path.toLowerCase();

  // 1. 健康检查
  if (req.method === 'GET' && pathname === '/healthz') {
    return res.json({ ok: true, service: 'cc-tool-pipeline-bridge' });
  }

  // 2. 模型列表接口透传
  if (req.method === 'GET' && pathname.endsWith('/v1/models')) {
    return res.json({
      object: 'list',
      data: [
        { id: 'claude-3-7-sonnet-20250219', object: 'model' },
        { id: 'claude-3-5-sonnet-20241022', object: 'model' }
      ]
    });
  }

  // 3. Token 计数接口
  if (req.method === 'POST' && pathname.endsWith('/v1/messages/count_tokens')) {
    const bodyText = JSON.stringify(req.body || {});
    return res.json({ input_tokens: Math.max(1, Math.ceil(bodyText.length / 4)) });
  }

  // 4. Claude Code 核心主入口：/v1/messages
  if (req.method === 'POST' && (pathname.endsWith('/v1/messages') || pathname.endsWith('/v1/messages/'))) {
    const startTime = Date.now();
    const targetUrl = parseTargetCompletionsUrl(req);
    const apiKey = extractApiKey(req);
    const { model, messages, stream } = req.body;

    logger.info('收到 CC 任务请求', `Model: ${model || 'default'}`, {
      入口路径: req.originalUrl,
      上游目标: targetUrl || '未配置上游目标',
      消息轮数: (messages || []).length
    });

    if (!targetUrl) {
      return res.status(400).json({
        error: {
          message: '未指定有效的上游地址。请通过 /https://api.your-host.com/v1/messages 访问或配置 UPSTREAM_BASE_URL。'
        }
      });
    }

    const { globalTask, historyLogsText, latestTurnInput } = adapt.parseConversation(messages || []);
    logger.info('历史解析完毕', `最新步骤反馈: ${latestTurnInput.slice(0, 100)}`);

    const msgId = 'msg_' + crypto.randomUUID().replaceAll('-', '');
    let heartbeatTimer = null;
    let blockIndex = 0;

    const sendSSE = (ev, data) => {
      if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    };

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

      // 5 秒定时心跳保活
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
      logger.info('正在请求上游', `${targetUrl}`);

      const assistantText = await fetchUpstreamCompletions(
        targetUrl,
        apiKey,
        model,
        prompt,
        clientAbortController.signal
      );

      if (heartbeatTimer) clearInterval(heartbeatTimer);

      const parsedAction = adapt.extractActionAndThought(assistantText);
      let stopReason = 'end_turn';
      let textContent = '';
      let toolBlock = null;

      if (parsedAction && parsedAction.action && parsedAction.action !== 'finish') {
        const mappedTool = adapt.mapActionToClaudeCodeTool(parsedAction.action, parsedAction.params);
        stopReason = 'tool_use';

        const targetDesc = mappedTool.arguments?.file_path || mappedTool.arguments?.command || '';
        textContent = `调度 ${mappedTool.name} ${targetDesc ? '-> ' + targetDesc : ''}`.slice(0, 80);

        toolBlock = {
          type: 'tool_use',
          id: 'toolu_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20),
          name: mappedTool.name,
          input: mappedTool.arguments
        };

        logger.info('装配 CC 工具', mappedTool.name, {
          耗时: `${Date.now() - startTime}ms`,
          工具参数: Object.keys(mappedTool.arguments || {})
        });
      } else {
        textContent = parsedAction?.params?.summary || parsedAction?.thought || assistantText;
        stopReason = 'end_turn';
        logger.info('流水线输出纯文本', textContent.slice(0, 100), {
          耗时: `${Date.now() - startTime}ms`
        });
      }

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
          sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
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
          sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
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
    return;
  }

  // 兜底 404
  res.status(404).json({ error: { message: `Route not supported: ${req.method} ${req.originalUrl}` } });
});

// ==========================================
// 5. 启动服务
// ==========================================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` 🚀 CC 智能中介已启动 (端口: ${PORT})`);
  console.log(` 📡 自动将所有请求转接至上游: /v1/chat/completions`);
  console.log(` ⏱️  5秒定时保活心跳: 开启`);
  console.log(`======================================================\n`);
});

server.requestTimeout = 2400000;
server.headersTimeout = 2400000;
server.keepAliveTimeout = 120000;
