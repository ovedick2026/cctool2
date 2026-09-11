import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import dns from 'node:dns/promises';
import { Agent, setGlobalDispatcher } from 'undici';

dotenv.config();

// 1. 强制 IPv4 优先，并配置 undici 40分钟超长连接超时，杜绝 Node fetch 连接重置
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

// ==========================================
// 1. 结构化日志模块 (仅打印增量，绝不刷屏)
// ==========================================
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

// ==========================================
// 2. 动态 URL 穿透与路径解析
// ==========================================
function parseTargetUrl(req) {
  let raw = req.originalUrl.startsWith('/') ? req.originalUrl.slice(1) : req.originalUrl;
  if (!/^https?:\/\//i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch {}
  }
  
  // 提取真正的上游 Base 和当前端点
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

// ==========================================
// 3. 工具映射字典 (脱敏 Pipeline <-> CC 原生)
// ==========================================
const ACTION_TO_CC_TOOL = {
  fs_write: 'Write',
  fs_read: 'Read',
  fs_replace: 'Edit',
  shell_exec: 'Bash',
  net_search: 'WebSearch',
  net_fetch: 'WebFetch',
  user_prompt: 'AskUserQuestion',
  subflow_spawn: 'Agent',
  task_entry: 'TaskCreate',
  notebook_patch: 'NotebookEdit',
  git_worktree: 'EnterWorktree',
  code_audit: 'ReportFindings'
};

const CC_TOOL_TO_ACTION = {
  Write: 'fs_write',
  Read: 'fs_read',
  Edit: 'fs_replace',
  Bash: 'shell_exec',
  WebSearch: 'net_search',
  WebFetch: 'net_fetch',
  AskUserQuestion: 'user_prompt',
  Agent: 'subflow_spawn',
  Workflow: 'subflow_spawn',
  TaskCreate: 'task_entry',
  TaskUpdate: 'task_entry',
  NotebookEdit: 'notebook_patch',
  EnterWorktree: 'git_worktree',
  ReportFindings: 'code_audit'
};

// ==========================================
// 4. 深度噪音清洗与上下文压缩 (保留10轮)
// ==========================================
function cleanNoise(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<context>[\s\S]*?<\/context>/gi, '')
    .trim();
}

function compressHistorySteps(rawSteps) {
  const trimmed = rawSteps.slice(-10);
  if (trimmed.length === 0) return '（当前为初始化阶段，尚无执行历史）';

  // 标记文件最后读取索引
  const lastReadMap = new Map();
  trimmed.forEach((s, idx) => {
    if (s.action === 'fs_read' && s.params?.file_path) {
      lastReadMap.set(s.params.file_path, idx);
    }
  });

  return trimmed.map((step, idx) => {
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let params = { ...step.params };

    // 1. fs_write 脱敏
    if (step.action === 'fs_write') {
      const len = step.params?.content ? step.params.content.length : 0;
      params.content = `[源码文件已写入本地磁盘，大小: ${len} 字符]`;
    }

    // 2. fs_replace 截断
    if (step.action === 'fs_replace') {
      if (params.old_string?.length > 80) params.old_string = params.old_string.slice(0, 30) + '...[略]...' + params.old_string.slice(-20);
      if (params.new_string?.length > 80) params.new_string = params.new_string.slice(0, 30) + '...[略]...' + params.new_string.slice(-20);
    }

    // 3. fs_read 重复折叠
    if (step.action === 'fs_read') {
      const p = step.params?.file_path;
      if (lastReadMap.get(p) !== idx) {
        feedback = `[早期版本已读取，第 ${lastReadMap.get(p) + 1} 步有最新读取结果，此处折叠]`;
      } else if (feedback.length > 3000) {
        feedback = feedback.slice(0, 1800) + '\n...[中间部分省略]...\n' + feedback.slice(-1000);
      }
    }

    // 4. shell_exec 智能截断 (错误高保真)
    if (step.action === 'shell_exec') {
      const hasErr = /error|fail|exit code [1-9]|command not found/i.test(feedback);
      if (!hasErr && feedback.length > 800) {
        feedback = feedback.slice(0, 250) + `\n...[输出流水已折叠 ${feedback.length - 500} 字符]...\n` + feedback.slice(-250);
      } else if (hasErr && feedback.length > 2500) {
        feedback = feedback.slice(-2500);
      }
    }

    return `--- Step ${idx + 1} ---
【执行配置】：
${JSON.stringify({ step_thought: step.step_thought, action: step.action, params }, null, 2)}
【本地执行反馈】：
${feedback}`;
  }).join('\n\n');
}

function parseConversation(messages = []) {
  let globalTask = '';
  const rawSteps = [];
  let latestTurnInput = null;

  // 1. 深度寻找最原始的用户自然语言指令（跳过系统日期注入）
  for (const msg of messages) {
    if (msg.role === 'user') {
      let rawText = '';
      if (typeof msg.content === 'string') {
        rawText = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textItems = msg.content.filter(c => c.type === 'text');
        rawText = textItems.map(c => c.text).join('\n');
      }
      const clean = cleanNoise(rawText);
      // 必须不是 tool_result 且有实质内容
      if (clean && !clean.startsWith('<tool_result') && !clean.includes('Today\'s date is')) {
        globalTask = clean;
        break;
      }
    }
  }

  if (!globalTask) {
    // 兜底：如果被 system-reminder 冲刷，提取最后一条包含实质性要求的信息
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'user') {
        const text = cleanNoise(typeof msg.content === 'string' ? msg.content : (msg.content?.map(c => c.text || '').join('') || ''));
        if (text && !text.startsWith('<tool_result')) {
          globalTask = text;
          break;
        }
      }
    }
  }

  if (!globalTask) globalTask = '处理当前工作目录下的开发与代码任务。';

  // 2. 提取最新一轮输入 (用于 DEBUG 展示)
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    if (typeof lastMsg.content === 'string') {
      latestTurnInput = cleanNoise(lastMsg.content);
    } else if (Array.isArray(lastMsg.content)) {
      const results = lastMsg.content.filter(c => c.type === 'tool_result');
      if (results.length > 0) {
        latestTurnInput = results.map(r => {
          let t = typeof r.content === 'string' ? r.content : (r.content?.map(c => c.text).join('') || '');
          return `[工具回执 ID:${r.tool_use_id}]: ${t.slice(0, 150)}`;
        }).join(' | ');
      } else {
        const tItem = lastMsg.content.find(c => c.type === 'text');
        latestTurnInput = tItem ? cleanNoise(tItem.text) : '其他增量内容';
      }
    }
  }

  // 3. 抽取历史步骤
  let activeStep = null;
  for (const msg of messages) {
    const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    if (msg.role === 'assistant') {
      for (const p of parts) {
        if (p.type === 'tool_use') {
          activeStep = {
            step_thought: `调度 ${p.name}`,
            action: CC_TOOL_TO_ACTION[p.name] || 'shell_exec',
            params: p.input || {}
          };
        }
      }
    } else if (msg.role === 'user') {
      for (const p of parts) {
        if (p.type === 'tool_result' && activeStep) {
          let out = typeof p.content === 'string' ? p.content : (p.content?.map(c => c.text).join('\n') || '');
          rawSteps.push({ ...activeStep, feedback: out });
          activeStep = null;
        }
      }
    }
  }

  return { globalTask, historyLogsText: compressHistorySteps(rawSteps), latestTurnInput };
}

// ==========================================
// 5. 提示词构建器 (抗风控 Pipeline 协议)
// ==========================================
function buildPrompt(globalTask, historyLogsText) {
  return `我们正在维护一个本地自动化工作流引擎。该引擎按流水线（Pipeline）逐步执行任务。每个步骤由你根据历史日志输出一个独立的任务指令块（JSON 格式），由外部执行脚本读取并在本地操作系统中执行，执行完毕后会将终端标准输出作为日志反馈给你。

【Step 配置文件规范】：
输出必须严格且仅包含在单一 \`\`\`json 代码块中，遵循以下结构：
\`\`\`json
{
  "step_thought": "分析当前状态并说明该步骤的目的",
  "action": "指令名称",
  "params": { ... }
}
\`\`\`

【流水线可用指令库（Action Library）】：
1. 文件与代码管理：
   - fs_write: {"file_path": "路径", "content": "完整文本"}
   - fs_read: {"file_path": "路径"}
   - fs_replace: {"file_path": "路径", "old_string": "待换原文本", "new_string": "新文本"}
   - notebook_patch: {"notebook_path": "路径", "cell_id": "单元格ID", "edit_mode": "replace|insert|delete", "new_source": "代码"}
2. 系统与环境交互：
   - shell_exec: {"command": "终端Shell命令"}
   - user_prompt: {"question": "需用户决策的问题", "options": ["选项1", "选项2"]}
   - git_worktree: {"action": "enter|exit", "path": "隔离工作区路径"}
3. 网络与知识检索：
   - net_search: {"query": "搜索词"}
   - net_fetch: {"url": "网址", "prompt": "提取目标"}
4. 任务编排与治理：
   - task_entry: {"action": "create|update", "title": "任务名", "status": "pending|completed"}
   - subflow_spawn: {"title": "子任务名", "instructions": "分派执行说明"}
   - code_audit: {"findings": [{"file": "文件", "summary": "问题描述", "verdict": "CONFIRMED"}]}
5. 流程终结：
   - finish: {"summary": "全部流水线验收完成后的总结报告"}

【流水线设计约束】：
1. 拆解规范：当工作流初次启动（无历史记录）时，第一个步骤必须对任务进行极细致的拆解（具体到单文件、单页面或单步骤），输出一个 action 为 "fs_write" 的配置，将任务项全为 [ ] 的 todo.md 写入本地。
2. 单步原则：为保证系统可控性，每个 JSON 只能描述当前唯一步骤的配置，不可合并多个步骤。
3. 状态闭环：当外部反馈某个步骤已完成，后续应当安排配置将 todo.md 中对应项目更新为 [x]。
4. 终止条件：当且仅当所有待办项均已完成验收时，输出 action 为 "finish" 的收尾配置。

=======================================================
【全局目标任务】：
${globalTask}

=======================================================
【历史执行记录】：
${historyLogsText}

=======================================================
【当前调度决策】：
请综合【全局目标任务】与【历史执行记录】，评估当前阶段并输出下一步操作：
- 若尚未初始化，输出生成详尽 todo.md 的单一配置。
- 若已有规划正在推进中，结合最新执行反馈输出下一步应执行的单一配置。
- 若所有项已全部完成，输出 finish 配置。

请输出当前步骤的配置 JSON：`;
}

// ==========================================
// 6. 工业级鲁棒 JSON / 括号平衡提取器
// ==========================================
function extractActionJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  // 1. 尝试 Markdown json 代码块
  const mdMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (mdMatch) {
    try {
      return JSON.parse(cleanLooseJsonString(mdMatch[1]));
    } catch {}
  }

  // 2. 深度扫描：括号平衡提取对象切片
  let depth = 0;
  let inStr = false;
  let quoteChar = '';
  let escape = false;
  let startIdx = -1;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quoteChar) inStr = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inStr = true;
      quoteChar = ch;
    } else if (ch === '{') {
      if (depth === 0) startIdx = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        const slice = rawText.slice(startIdx, i + 1);
        try {
          const parsed = JSON.parse(cleanLooseJsonString(slice));
          if (parsed && typeof parsed === 'object' && (parsed.action || parsed.step_thought)) {
            return parsed;
          }
        } catch {}
        startIdx = -1;
      }
    }
  }

  return null;
}

function cleanLooseJsonString(str) {
  return str
    .replace(/,\s*([}\]])/g, '$1') // 移除尾随逗号
    .replace(/\r\n/g, '\n');
}

// ==========================================
// 7. 上游 SSE 流式读取解析器 (永不超时的核心)
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

// 向上游发起纯流式请求，边读边提取，支持 Thinking 流式广播
async function fetchUpstreamStream(targetBase, apiKey, model, prompt, onThinkingChunk) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Accept': 'text/event-stream, application/json'
  };

  // 1. 尝试 Anthropic /v1/messages (stream: true)
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
              if (onThinkingChunk) onThinkingChunk(payload.delta.thinking);
            } else if (payload.delta?.type === 'text_delta' && payload.delta.text) {
              fullText += payload.delta.text;
            }
          }
        } catch {}
      }
      return { text: fullText, thinking: thinkingText };
    }
  } catch (err) {
    logger.debug('上游 messages 流式连接异常，切换 chat/completions', err.message);
  }

  // 2. 回退尝试 OpenAI /v1/chat/completions (stream: true)
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
    throw new Error(`上游调用完全失败: HTTP ${chatRes.status} - ${errText}`);
  }

  let fullText = '';
  let thinkingText = '';
  let inThinkTag = false;

  for await (const chunk of readSSE(chatRes)) {
    if (!chunk || chunk === '[DONE]') continue;
    try {
      const payload = JSON.parse(chunk);
      const delta = payload.choices?.[0]?.delta;
      if (!delta) continue;

      // 提取原生思考 (DeepSeek/GLM)
      const think = delta.reasoning_content || delta.reasoning || '';
      if (think) {
        thinkingText += think;
        if (onThinkingChunk) onThinkingChunk(think);
      }

      // 提取正文并解析可能内嵌的<think>标签
      if (delta.content) {
        let piece = delta.content;
        while (piece.length > 0) {
          if (!inThinkTag) {
            const start = piece.indexOf('');
            if (start !== -1) {
              fullText += piece.slice(0, start);
              inThinkTag = true;
              piece = piece.slice(start + 7);
            } else {
              fullText += piece;
              piece = '';
            }
          } else {
            const end = piece.indexOf('<think>');
            if (end !== -1) {
              const tPiece = piece.slice(0, end);
              thinkingText += tPiece;
              if (onThinkingChunk) onThinkingChunk(tPiece);
              inThinkTag = false;
              piece = piece.slice(end + 8);
            } else {
              thinkingText += piece;
              if (onThinkingChunk) onThinkingChunk(piece);
              piece = '';
            }
          }
        }
      }
    } catch {}
  }

  return { text: fullText, thinking: thinkingText };
}

// ==========================================
// 8. 路由: GET */v1/models (模型列表透传)
// ==========================================
app.get(/(.*)\/v1\/models$/, async (req, res) => {
  const { upstreamBase } = parseTargetUrl(req);
  logger.debug('拉取模型列表', { 目标上游: upstreamBase });

  try {
    const authHeader = req.headers['authorization'] || `Bearer ${req.headers['x-api-key'] || ''}`;
    const upstreamRes = await fetch(`${upstreamBase}/v1/models`, {
      headers: { 'Authorization': authHeader, 'x-api-key': req.headers['x-api-key'] || '' },
      signal: AbortSignal.timeout(10000)
    });
    if (upstreamRes.ok) return res.json(await upstreamRes.json());
  } catch (e) {}

  res.json({
    object: 'list',
    data: [
      { id: 'claude-3-7-sonnet-20250219', object: 'model' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model' }
    ]
  });
});

// ==========================================
// 9. 路由: POST */v1/messages/count_tokens (CC必须端点)
// ==========================================
app.post(/(.*)\/v1\/messages\/count_tokens$/, (req, res) => {
  const bodyText = JSON.stringify(req.body || {});
  const estimated = Math.max(1, Math.ceil(bodyText.length / 4));
  res.json({ input_tokens: estimated });
});

// ==========================================
// 10. 路由: POST */v1/messages (Claude Code 主交互入口)
// ==========================================
app.post(/(.*)\/v1\/messages$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body;

  const { globalTask, historyLogsText, latestTurnInput } = parseConversation(messages || []);
  logger.debug('收到 Claude Code 调度请求', {
    目标上游: upstreamBase,
    模型: model,
    本次增量输入: latestTurnInput || '（初始启动任务）'
  });

  const msgId = 'msg_' + crypto.randomBytes(12).toString('hex');
  let heartbeatTimer = null;
  let blockIndex = 0;
  let thinkingStarted = false;

  const sendSSE = (ev, data) => {
    if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 1. 如果客户端要求流式，立即握手建立 SSE 并启动保活
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // 立即下发 message_start，杜绝客户端 30 秒超时
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

    heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 5000);
  }

  try {
    const prompt = buildPrompt(globalTask, historyLogsText);

    // 回调：实时下发 Thinking 内容给 Claude Code
    const onThinkingChunk = (chunk) => {
      if (!stream || !chunk) return;
      if (!thinkingStarted) {
        sendSSE('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'thinking', thinking: '' }
        });
        thinkingStarted = true;
      }
      sendSSE('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'thinking_delta', thinking: chunk }
      });
    };

    // 向上游流式拉取完整响应
    const { text: assistantText, thinking } = await fetchUpstreamStream(
      upstreamBase,
      apiKey,
      model,
      prompt,
      onThinkingChunk
    );

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    // 关闭 thinking block
    if (stream && thinkingStarted) {
      sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex++;
    }

    // 解析出动作与参数
    const actionObj = extractActionJson(assistantText);
    const toolCallId = 'call_' + crypto.randomBytes(8).toString('hex');
    let stopReason = 'end_turn';
    let responseBlocks = [];

    if (actionObj && actionObj.action && actionObj.action !== 'finish') {
      const ccTool = ACTION_TO_CC_TOOL[actionObj.action] || 'Bash';
      stopReason = 'tool_use';
      responseBlocks = [
        { type: 'text', text: actionObj.step_thought || `调度 ${ccTool}...` },
        { type: 'tool_use', id: toolCallId, name: ccTool, input: actionObj.params || {} }
      ];

      logger.debug('成功编译工具调度', {
        耗时: `${Date.now() - startTime}ms`,
        思考: actionObj.step_thought,
        下发工具: ccTool,
        参数: actionObj.params
      });
    } else {
      const summary = actionObj?.params?.summary || assistantText;
      responseBlocks = [{ type: 'text', text: summary }];
      stopReason = 'end_turn';

      logger.debug('流程终结或纯文本', {
        耗时: `${Date.now() - startTime}ms`,
        总结: summary.slice(0, 150)
      });
    }

    if (stream) {
      for (const block of responseBlocks) {
        sendSSE('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} }
        });

        if (block.type === 'text') {
          sendSSE('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: block.text }
          });
        } else {
          sendSSE('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
          });
        }

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
      // 非流式响应
      const content = [];
      if (thinking) content.push({ type: 'thinking', thinking });
      content.push(...responseBlocks);

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
    logger.error('Claude Code 消息通道异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

// ==========================================
// 11. 路由: POST */v1/chat/completions (OpenWebUI 入口)
// ==========================================
app.post(/(.*)\/v1\/chat\/completions$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '') || req.headers['x-api-key'];
  const { model, messages, stream } = req.body;

  const { globalTask, historyLogsText, latestTurnInput } = parseConversation(messages || []);
  logger.debug('收到 OpenWebUI 请求', {
    目标上游: upstreamBase,
    本次增量输入: latestTurnInput || '（初始启动任务）'
  });

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
    const prompt = buildPrompt(globalTask, historyLogsText);
    const { text: assistantText, thinking } = await fetchUpstreamStream(
      upstreamBase,
      apiKey,
      model,
      prompt,
      null
    );

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    const actionObj = extractActionJson(assistantText);
    let finalOutput = assistantText;
    if (actionObj && actionObj.action) {
      finalOutput = `【思考】: ${actionObj.step_thought || ''}\n【调度动作】: ${actionObj.action}\n\`\`\`json\n${JSON.stringify(actionObj.params, null, 2)}\n\`\`\``;
    }

    logger.debug('OpenWebUI 响应完成', { 耗时: `${Date.now() - startTime}ms` });

    if (stream) {
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ delta: { content: finalOutput, reasoning_content: thinking } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ message: { role: 'assistant', content: finalOutput, reasoning_content: thinking }, finish_reason: 'stop' }]
      });
    }
  } catch (err) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    logger.error('OpenWebUI 消息通道异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

// 解除 Node.js 服务端自身的默认 5 分钟超时限制
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` 工业级全功能 CC 中介已启动 (监听端口: ${PORT})`);
  console.log(`======================================================\n`);
});

server.requestTimeout = 2400000;
server.headersTimeout = 2400000;
server.keepAliveTimeout = 120000;
