/* ==========================================================================
 *  server.js —— 【网络底座与协议中继层】
 * ========================================================================== */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { Agent, setGlobalDispatcher } from 'undici';
import * as adapt from './adapt.js';

dotenv.config();

// 1. 网络底座：undici 40分钟超长超时防断开
dns.setDefaultResultOrder('ipv4first');
setGlobalDispatcher(
  new Agent({
    headersTimeout: 2400000,
    bodyTimeout: 2400000,
    connectTimeout: 120000
  })
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const PORT = Number(process.env.PORT || 7860);
const IS_DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
  debug: (stage, details = {}) => {
    if (!IS_DEBUG) return;
    console.log(`\n\x1b[36m[${getTimestamp()}]\x1b[0m \x1b[32m【流程: ${stage}】\x1b[0m`);
    for (const [k, v] of Object.entries(details)) {
      if (v !== undefined && v !== null) {
        const valStr = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
        console.log(`  \x1b[33m▶ ${k}:\x1b[0m ${valStr}`);
      }
    }
  },
  error: (stage, err) => {
    console.error(`\n\x1b[31m[${getTimestamp()}] 【错误: ${stage}】\x1b[0m`, err);
  }
};

function parseTargetUrl(req) {
  let raw = req.originalUrl.startsWith('/') ? req.originalUrl.slice(1) : req.originalUrl;
  if (!/^https?:\/\//i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch {}
  }

  const v1Match = raw.match(/^(https?:\/\/[^\/]+(?:\/[^\/]+)*?)\/(v1\/(?:messages|chat\/completions|models|messages\/count_tokens))(?:\?(.*))?$/i);
  if (v1Match) {
    return {
      upstreamBase: v1Match[1],
      endpoint: '/' + v1Match[2],
      fullTarget: v1Match[1] + '/' + v1Match[2]
    };
  }

  return {
    upstreamBase: (process.env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    endpoint: req.path,
    fullTarget: (process.env.UPSTREAM_BASE_URL || '').replace(/\/$/, '') + req.path
  };
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || {});
  return Math.max(1, Math.ceil(text.length / 4));
}

// SSE 解析生成器
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

// 上游流式调用（聚合文本与思考）
async function fetchUpstream(targetBase, apiKey, model, prompt) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Accept': 'text/event-stream, application/json'
  };

  // 1. 尝试 Anthropic /v1/messages
  try {
    const res = await fetch(`${targetBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'claude-3-7-sonnet-20250219',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
        stream: true
      })
    });

    if (res.ok) {
      let fullText = '';
      let thinkingText = '';
      for await (const chunk of readSSE(res)) {
        if (!chunk || chunk === '[DONE]') continue;
        try {
          const payload = JSON.parse(chunk);
          if (payload.type === 'content_block_delta') {
            if (payload.delta?.type === 'thinking_delta' && payload.delta.thinking) {
              thinkingText += payload.delta.thinking;
            } else if (payload.delta?.type === 'text_delta' && payload.delta.text) {
              fullText += payload.delta.text;
            }
          }
        } catch {}
      }
      return { text: fullText, thinking: thinkingText };
    }
  } catch {}

  // 2. 回退 OpenAI /v1/chat/completions
  const chatRes = await fetch(`${targetBase}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'claude-3-7-sonnet-20250219',
      messages: [{ role: 'user', content: prompt }],
      stream: true
    })
  });

  if (!chatRes.ok) {
    const errText = await chatRes.text();
    throw new Error(`上游接口响应异常: HTTP ${chatRes.status} - ${errText}`);
  }

  let fullText = '';
  let thinkingText = '';
  let inThinkTag = false;

  for await (const chunk of readSSE(chatRes)) {
    if (!chunk || chunk === '[DONE]') continue;
    try {
      const payload = JSON.parse(chunk);
      const delta = payload.choices?.[0]?.delta;
      if (delta) {
        if (delta.reasoning_content || delta.reasoning) {
          thinkingText += delta.reasoning_content || delta.reasoning;
        }
        if (delta.content) {
          let piece = delta.content;
          while (piece.length > 0) {
            if (!inThinkTag) {
              const start = piece.indexOf('<think>');
              if (end !== -1) {
                thinkingText += piece.slice(0, end);
                inThinkTag = false;
                piece = piece.slice(end + 8);
              } else {
                thinkingText += piece;
                piece = '';
              }
            }
          }
        }
      }
    } catch {}
  }

  return { text: fullText, thinking: thinkingText };
}

// ==========================================
// 路由定义
// ==========================================

// 1. 模型列表
app.get(/(.*)\/v1\/models$/, async (req, res) => {
  const { upstreamBase } = parseTargetUrl(req);
  try {
    const authHeader = req.headers['authorization'] || `Bearer ${req.headers['x-api-key'] || ''}`;
    const upstreamRes = await fetch(`${upstreamBase}/v1/models`, {
      headers: { 'Authorization': authHeader, 'x-api-key': req.headers['x-api-key'] || '' },
      signal: AbortSignal.timeout(8000)
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

// 2. Token 计数通道 —— 【老代码核心机制：如实反馈，使 CC 客户端自动瘦身/压缩生效】
app.post(/(.*)\/v1\/messages\/count_tokens$/, (req, res) => {
  const estimated = estimateTokens(req.body || {});
  res.json({ input_tokens: estimated });
});

// 3. 主调度通道：POST */v1/messages (Claude Code 原生调用入口)
app.post(/(.*)\/v1\/messages$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body;

  const isCompacting = adapt.isCompactionRequest(messages);
  const { globalTask, historyLogsText } = adapt.parseConversation(messages || []);

  logger.debug('收到 Claude Code 调度请求', {
    '目标上游': upstreamBase,
    '模型': model,
    '模式': isCompacting ? '会话归档压缩 (Compaction)' : '正常流水线推进'
  });

  const msgId = 'msg_' + crypto.randomBytes(12).toString('hex');
  let heartbeatTimer = null;
  let blockIndex = 0;

  const sendSSE = (ev, data) => {
    if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 准确估算真实的输入 Token
  const realInputTokens = estimateTokens(req.body);

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
        usage: { input_tokens: realInputTokens, output_tokens: 0 }
      }
    });

    heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 5000);
  }

  try {
    let prompt = '';
    if (isCompacting) {
      prompt = `请对以下任务流水线当前的历史进展提供一份结构化、简明扼要的摘要总结，包括：已完成的步骤、生成的文件清单、以及当前待推进的下一个阶段。请直接给出总结文本：\n\n【全局任务】：${globalTask}\n\n【执行历史】：\n${historyLogsText}`;
    } else {
      // 组装你所要求的提示词模板
      prompt = adapt.buildPipelinePrompt(globalTask, historyLogsText);
    }

    const { text: assistantText, thinking } = await fetchUpstream(upstreamBase, apiKey, model, prompt);

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    let stopReason = 'end_turn';
    let textContent = '';
    let toolBlock = null;

    if (isCompacting) {
      textContent = assistantText.replace(/【思考】[\s\S]*?(?=【调度动作】|$)/gi, '').trim() || '流水线历史状态已压缩归纳。';
      stopReason = 'end_turn';
    } else {
      const parsedAction = adapt.extractActionAndThought(assistantText);

      if (parsedAction && parsedAction.action && parsedAction.action !== 'finish') {
        const mappedTool = adapt.mapActionToClaudeCodeTool(parsedAction.action, parsedAction.params);
        stopReason = 'tool_use';

        const targetDesc = mappedTool.arguments?.file_path || mappedTool.arguments?.command || '';
        textContent = `调度 ${mappedTool.name} ${targetDesc ? '-> ' + targetDesc : ''}`.slice(0, 80);

        toolBlock = {
          type: 'tool_use',
          id: 'toolu_' + crypto.randomBytes(10).toString('hex'),
          name: mappedTool.name,
          input: mappedTool.arguments
        };

        logger.debug('成功装配 CC 原生工具调用', {
          '耗时': `${Date.now() - startTime}ms`,
          '工具': mappedTool.name,
          '参数长度': `${JSON.stringify(mappedTool.arguments).length} 字符`
        });
      } else {
        textContent = parsedAction?.params?.summary || parsedAction?.thought || assistantText;
        stopReason = 'end_turn';
      }
    }

    const realOutputTokens = estimateTokens(assistantText + (thinking || ''));

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
        usage: { output_tokens: realOutputTokens }
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
        usage: { input_tokens: realInputTokens, output_tokens: realOutputTokens }
      });
    }
  } catch (err) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logger.error('通道异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

// 4. OpenAI 格式兼容通道
app.post(/(.*)\/v1\/chat\/completions$/, async (req, res) => {
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '') || req.headers['x-api-key'];
  const { model, messages, stream } = req.body;
  const { globalTask, historyLogsText } = adapt.parseConversation(messages || []);

  let heartbeatTimer = null;
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 5000);
  }

  try {
    const prompt = adapt.buildPipelinePrompt(globalTask, historyLogsText);
    const { text: assistantText, thinking } = await fetchUpstream(upstreamBase, apiKey, model, prompt);

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    const parsedAction = adapt.extractActionAndThought(assistantText);
    let toolCalls = null;
    let finishReason = 'stop';
    let textContent = '';

    if (parsedAction && parsedAction.action && parsedAction.action !== 'finish') {
      const mappedTool = adapt.mapActionToClaudeCodeTool(parsedAction.action, parsedAction.params);
      finishReason = 'tool_calls';
      textContent = parsedAction.thought || `调度 ${mappedTool.name}...`;
      toolCalls = [{
        index: 0,
        id: 'call_' + crypto.randomBytes(8).toString('hex'),
        type: 'function',
        function: {
          name: mappedTool.name,
          arguments: JSON.stringify(mappedTool.arguments)
        }
      }];
    } else {
      textContent = parsedAction?.params?.summary || parsedAction?.thought || assistantText;
      finishReason = 'stop';
    }

    if (stream) {
      if (textContent) {
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ delta: { content: textContent, reasoning_content: thinking }, index: 0 }]
        })}\n\n`);
      }
      if (toolCalls) {
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ delta: { tool_calls: toolCalls }, index: 0 }]
        })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ delta: {}, finish_reason: finishReason, index: 0 }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          message: {
            role: 'assistant',
            content: textContent,
            reasoning_content: thinking,
            ...(toolCalls ? { tool_calls: toolCalls } : {})
          },
          finish_reason: finishReason
        }]
      });
    }
  } catch (err) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logger.error('ChatCompletions 异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` CC 智能中介已启动 (端口: ${PORT})`);
  console.log(`======================================================\n`);
});

server.requestTimeout = 2400000;
server.headersTimeout = 2400000;
server.keepAliveTimeout = 120000;
