import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import dns from 'node:dns/promises';
import { Agent, setGlobalDispatcher } from 'undici';

dotenv.config();

// 1. 网络配置：IPv4 优先，并配置 40 分钟超长超时，杜绝 Node fetch 重置连接
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
// 1. 结构化日志 (仅输出本次增量，杜绝刷屏)
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
// 4. 上下文过滤与精细化压缩 (保留 10 轮)
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

  const lastReadMap = new Map();
  trimmed.forEach((s, idx) => {
    if (s.action === 'fs_read' && s.params?.file_path) {
      lastReadMap.set(s.params.file_path, idx);
    }
  });

  return trimmed.map((step, idx) => {
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let params = { ...step.params };

    if (step.action === 'fs_write') {
      const len = step.params?.content ? step.params.content.length : 0;
      params.content = `[源码文件已写入本地磁盘，大小: ${len} 字符]`;
    }

    if (step.action === 'fs_replace') {
      if (params.old_string?.length > 80) params.old_string = params.old_string.slice(0, 30) + '...[略]...' + params.old_string.slice(-20);
      if (params.new_string?.length > 80) params.new_string = params.new_string.slice(0, 30) + '...[略]...' + params.new_string.slice(-20);
    }

    if (step.action === 'fs_read') {
      const p = step.params?.file_path;
      if (lastReadMap.get(p) !== idx) {
        feedback = `[早期版本已读取，第 ${lastReadMap.get(p) + 1} 步有最新读取结果，此处折叠]`;
      } else if (feedback.length > 3000) {
        feedback = feedback.slice(0, 1800) + '\n...[中间部分省略]...\n' + feedback.slice(-1000);
      }
    }

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
【思考】: ${step.step_thought}
【调度动作】: ${step.action}
\`\`\`json
${JSON.stringify(params, null, 2)}
\`\`\`
【本地执行反馈】：
${feedback}`;
  }).join('\n\n');
}

function parseConversation(messages = []) {
  let globalTask = '';
  const rawSteps = [];
  let latestTurnInput = null;

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
      if (clean && !clean.startsWith('<tool_result') && !clean.includes("Today's date is")) {
        globalTask = clean;
        break;
      }
    }
  }

  if (!globalTask) {
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
// 5. 提示词构建器 (带强约束的返回格式模板)
// ==========================================
function buildPrompt(globalTask, historyLogsText) {
  return `我们正在维护一个本地自动化工作流引擎。该引擎按流水线（Pipeline）逐步执行任务。每个步骤由你根据历史日志输出一个独立的任务指令，由外部执行脚本读取并在本地操作系统中执行，执行完毕后会将终端标准输出作为日志反馈给你。

【流水线可用指令库】：
1. 文件与代码管理：
   - fs_write: {"file_path": "相对路径", "content": "写入的完整文本"}
   - fs_read: {"file_path": "相对路径"}
   - fs_replace: {"file_path": "相对路径", "old_string": "原文本", "new_string": "新文本"}
   - notebook_patch: {"notebook_path": "路径", "cell_id": "ID", "edit_mode": "replace|insert|delete", "new_source": "代码"}
2. 系统与环境交互：
   - shell_exec: {"command": "终端Shell命令"}
   - user_prompt: {"question": "需用户确认的问题", "options": ["选项1", "选项2"]}
   - git_worktree: {"action": "enter|exit", "path": "目录路径"}
3. 网络与知识检索：
   - net_search: {"query": "搜索词"}
   - net_fetch: {"url": "网址", "prompt": "提取目标"}
4. 任务编排与治理：
   - task_entry: {"action": "create|update", "title": "任务名", "status": "pending|completed"}
   - subflow_spawn: {"title": "子任务名", "instructions": "分派执行说明"}
   - code_audit: {"findings": [{"file": "文件", "summary": "问题", "verdict": "CONFIRMED"}]}
5. 流程终结：
   - finish: {"summary": "全部流水线验收完成后的总结报告"}

【流水线核心约束】：
1. 规划优先：若工作流初次启动（无历史记录），第一步必须对任务做细致拆解，调度 fs_write 将任务项全为 [ ] 的 todo.md 写入本地。
2. 单步原子性：单次回复有且仅能包含 1 个工具动作！严禁合并多个动作。
3. 状态闭环：当外部日志提示某子任务已完成，后续应当安排 fs_replace 将 todo.md 中对应项目标记为 [x]。
4. 终止条件：当且仅当所有待办项均已完成验收时，调度动作输出为 finish。

=======================================================
【必须严格遵守的响应格式模板】：
你的每次回复必须严格按照以下三段式结构输出，严禁随意增删格式：

【思考】: 简要分析当前执行状态以及下一步骤的具体意图。
【调度动作】: 指令名称（例如 fs_write，必须完全匹配上方指令库）
\`\`\`json
{
  ...参数内容...
}
\`\`\`

=======================================================
【全局目标任务】：
${globalTask}

=======================================================
【历史执行记录】：
${historyLogsText}

=======================================================
【当前调度决策】：
请综合【全局目标任务】与【历史执行记录】，严格按照上述【响应格式模板】输出下一步操作：`;
}

// ==========================================
// 6. 核心双模解析器：将模型输出转换为 CC 工具协议
// ==========================================
function parseModelOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { thought: '', action: null, params: {}, isFinish: true };
  }

  let thought = '';
  let action = null;
  let params = {};

  // 1. 优先提取标准【思考】段
  const thoughtMatch = rawText.match(/【思考】\s*[:：]?\s*([\s\S]*?)(?=【调度动作】|```json|```|$)/i);
  if (thoughtMatch) {
    thought = thoughtMatch[1].trim();
  }

  // 2. 提取【调度动作】
  const actionMatch = rawText.match(/【调度动作】\s*[:：]?\s*([a-zA-Z0-9_]+)/i) ||
                      rawText.match(/(?:^|\n)\s*(?:action|调度动作)\s*[:：]?\s*["']?([a-zA-Z0-9_]+)["']?/i);
  if (actionMatch) {
    action = actionMatch[1].trim();
  }

  // 3. 提取 ```json 代码块中的参数对象
  const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let parsedJson = null;

  if (jsonMatch) {
    try {
      parsedJson = JSON.parse(jsonMatch[1].replace(/,\s*([}\]])/g, '$1').replace(/\r\n/g, '\n'));
    } catch {}
  }

  // 如果上面没提取到，兜底提取大括号对象
  if (!parsedJson) {
    const braceMatch = rawText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        parsedJson = JSON.parse(braceMatch[0].replace(/,\s*([}\]])/g, '$1'));
      } catch {}
    }
  }

  if (parsedJson && typeof parsedJson === 'object') {
    // 兼容模型输出完整单一 JSON 结构的情况
    if (!action && parsedJson.action) {
      action = parsedJson.action;
    }
    if (!thought && (parsedJson.step_thought || parsedJson.thought)) {
      thought = parsedJson.step_thought || parsedJson.thought;
    }
    if (parsedJson.params && typeof parsedJson.params === 'object') {
      params = parsedJson.params;
    } else {
      const { action: _a, step_thought: _st, thought: _th, ...rest } = parsedJson;
      params = rest;
    }
  }

  // 如果没有提取到任何 thought，以代码块前的非空文本作为 thought
  if (!thought) {
    const cutPos = rawText.indexOf('```');
    thought = cutPos > 0 ? rawText.slice(0, cutPos).replace(/【调度动作】.*$/m, '').trim() : rawText.trim();
  }

  const isFinish = !action || action === 'finish';
  return { thought, action, params, isFinish };
}

// 规范化并映射为 Claude Code 原生入参
function normalizeCcToolCall(action, params) {
  const ccTool = ACTION_TO_CC_TOOL[action] || 'Bash';
  let input = { ...params };

  switch (ccTool) {
    case 'Write':
      input = {
        file_path: params.file_path || params.path || '',
        content: params.content !== undefined ? params.content : (params.text || '')
      };
      break;
    case 'Read':
      input = {
        file_path: params.file_path || params.path || ''
      };
      break;
    case 'Edit':
      input = {
        file_path: params.file_path || params.path || '',
        old_string: params.old_string || params.old_str || '',
        new_string: params.new_string || params.new_str || ''
      };
      break;
    case 'Bash':
      input = {
        command: params.command || params.cmd || ''
      };
      break;
    case 'AskUserQuestion':
      if (!input.questions) {
        input = {
          questions: [
            {
              question: params.question || '请确认',
              header: '用户决策',
              multiSelect: false,
              options: (params.options || ['确认', '取消']).map(o => typeof o === 'string' ? { label: o, description: o } : o)
            }
          ]
        };
      }
      break;
    case 'Agent':
      input = {
        description: params.description || '',
        prompt: params.prompt || params.instructions || ''
      };
      break;
    case 'TaskCreate':
      input = {
        subject: params.title || params.subject || '',
        description: params.description || ''
      };
      break;
  }

  return { ccTool, input };
}

// ==========================================
// 7. 上游 SSE 流式通信核心
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

async function fetchUpstreamStream(targetBase, apiKey, model, prompt, onThinkingChunk) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
    logger.debug('Anthropic 协议流式尝试未果，自动切换 chat/completions', err.message);
  }

  // 2. 回退尝试 OpenAI /v1/chat/completions
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
    throw new Error(`上游调用失败: HTTP ${chatRes.status} - ${errText}`);
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

      const think = delta.reasoning_content || delta.reasoning || '';
      if (think) {
        thinkingText += think;
        if (onThinkingChunk) onThinkingChunk(think);
      }

      if (delta.content) {
        let piece = delta.content;
        while (piece.length > 0) {
          if (!inThinkTag) {
            const start = piece.indexOf('<think>');
            if (start !== -1) {
              fullText += piece.slice(0, start);
              inThinkTag = true;
              piece = piece.slice(start + 7);
            } else {
              fullText += piece;
              piece = '';
            }
          } else {
            const end = piece.indexOf('</think>');
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
// 8. 路由: GET */v1/models
// ==========================================
app.get(/(.*)\/v1\/models$/, async (req, res) => {
  const { upstreamBase } = parseTargetUrl(req);
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
// 9. 路由: POST */v1/messages/count_tokens
// ==========================================
app.post(/(.*)\/v1\/messages\/count_tokens$/, (req, res) => {
  const bodyText = JSON.stringify(req.body || {});
  const estimated = Math.max(1, Math.ceil(bodyText.length / 4));
  res.json({ input_tokens: estimated });
});

// ==========================================
// 10. 路由: POST */v1/messages (Claude Code 适配核心)
// ==========================================
app.post(/(.*)\/v1\/messages$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body;

  const { globalTask, historyLogsText, latestTurnInput } = parseConversation(messages || []);
  logger.debug('收到 Claude Code 请求', {
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

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // 立即握手，防止客户端超时
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

    const { text: assistantText, thinking } = await fetchUpstreamStream(
      upstreamBase,
      apiKey,
      model,
      prompt,
      onThinkingChunk
    );

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    if (stream && thinkingStarted) {
      sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex++;
    }

    // 【关键】：使用重构后的双模解析器提取调度信息
    const { thought, action, params, isFinish } = parseModelOutput(assistantText);
    const toolCallId = 'call_' + crypto.randomBytes(8).toString('hex');

    let responseBlocks = [];
    let stopReason = 'end_turn';

    if (!isFinish && action) {
      // 成功解析出工具调用：映射为 Claude Code 原生协议
      const { ccTool, input } = normalizeCcToolCall(action, params);
      stopReason = 'tool_use';

      responseBlocks = [
        { type: 'text', text: thought || `调度 ${ccTool}...` },
        { type: 'tool_use', id: toolCallId, name: ccTool, input }
      ];

      logger.debug('成功编译并下发 CC 原生工具', {
        耗时: `${Date.now() - startTime}ms`,
        正文思考: thought,
        下发工具: ccTool,
        转换参数: input
      });
    } else {
      // 流程终结或纯文本
      const finalText = params.summary || thought || assistantText;
      responseBlocks = [{ type: 'text', text: finalText }];
      stopReason = 'end_turn';

      logger.debug('任务终结总结', {
        耗时: `${Date.now() - startTime}ms`,
        总结文本: finalText.slice(0, 150)
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
    logger.error('Claude Code 处理链路异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

// ==========================================
// 11. 路由: POST */v1/chat/completions (OpenWebUI 适配通道)
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

    const { thought, action, params, isFinish } = parseModelOutput(assistantText);
    let finalOutput = assistantText;

    if (!isFinish && action) {
      finalOutput = `【思考】: ${thought}\n【调度动作】: ${action}\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
    }

    logger.debug('OpenWebUI 响应就绪', { 耗时: `${Date.now() - startTime}ms` });

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
    logger.error('OpenWebUI 处理异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` CC Web 全功能中介代理已启动 (端口: ${PORT})`);
  console.log(` 调试模式: ${IS_DEBUG ? '开启 (DEBUG=true)' : '关闭 (仅错误日志)'}`);
  console.log(` 状态: 双模解析器已载入，工具调用将精准转换为原生 CC 格式`);
  console.log(`======================================================\n`);
});

server.requestTimeout = 2400000;
server.headersTimeout = 2400000;
server.keepAliveTimeout = 120000;
