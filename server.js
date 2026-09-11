import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const PORT = process.env.PORT || 7860;
const IS_DEBUG = (process.env.DEBUG || 'false').toLowerCase() === 'true';

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
  debug: (stage, details = {}) => {
    if (!IS_DEBUG) return;
    console.log(`\n\x1b[36m[${getTimestamp()}]\x1b[0m \x1b[32m【流程: ${stage}】\x1b[0m`);
    for (const [key, val] of Object.entries(details)) {
      if (val !== undefined && val !== null) {
        const valStr = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
        console.log(`  \x1b[33m▶ ${key}:\x1b[0m ${valStr}`);
      }
    }
  },
  error: (stage, err) => {
    console.error(`\n\x1b[31m[${getTimestamp()}] 【错误: ${stage}】\x1b[0m`, err);
  }
};

// ==========================================
// 1. 动态 URL 穿透与前缀提取
// ==========================================
function parseDynamicUpstream(req) {
  let rawPath = req.originalUrl || req.url;
  const [cleanPath, query] = rawPath.split('?');
  
  // 还原被折叠的 http:/ 或 https:/ 为 http:// 或 https://
  let normalized = cleanPath.replace(/^\/+/, '').replace(/(https?):\/+(?!\/)/g, '$1://');
  
  const v1Index = normalized.lastIndexOf('/v1/');
  if (v1Index !== -1) {
    const upstreamBase = normalized.substring(0, v1Index);
    const endpoint = normalized.substring(v1Index) + (query ? `?${query}` : '');
    return { upstreamBase, endpoint };
  }
  
  return {
    upstreamBase: (process.env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    endpoint: cleanPath + (query ? `?${query}` : '')
  };
}

// ==========================================
// 2. 工具双向映射
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
// 3. 上下文压缩器 (保留最近10轮，去重文件读取与日志)
// ==========================================
function compressHistorySteps(rawSteps) {
  const trimmed = rawSteps.slice(-10);
  if (trimmed.length === 0) return '（当前为初始化阶段，尚无执行历史）';

  const lastReadIndexMap = new Map();
  trimmed.forEach((step, idx) => {
    if (step.action === 'fs_read' && step.params?.file_path) {
      lastReadIndexMap.set(step.params.file_path, idx);
    }
  });

  const formattedLogs = trimmed.map((step, idx) => {
    const stepNum = idx + 1;
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let displayParams = { ...step.params };

    if (step.action === 'fs_write') {
      const len = step.params.content ? step.params.content.length : 0;
      displayParams.content = `[源码已写入本地，长度: ${len} 字符]`;
    }

    if (step.action === 'fs_replace') {
      if (displayParams.old_string && displayParams.old_string.length > 80) {
        displayParams.old_string = displayParams.old_string.slice(0, 40) + '...[略]...' + displayParams.old_string.slice(-30);
      }
      if (displayParams.new_string && displayParams.new_string.length > 80) {
        displayParams.new_string = displayParams.new_string.slice(0, 40) + '...[略]...' + displayParams.new_string.slice(-30);
      }
    }

    if (step.action === 'fs_read') {
      const filePath = step.params.file_path;
      const lastIdx = lastReadIndexMap.get(filePath);
      if (lastIdx !== undefined && lastIdx !== idx) {
        feedback = `[早期版本已读取，第 ${lastIdx + 1} 步有最新内容，此处折叠]`;
      } else if (feedback.length > 3000) {
        feedback = feedback.slice(0, 1800) + '\n...[中间省略]...\n' + feedback.slice(-1000);
      }
    }

    if (step.action === 'shell_exec') {
      const isError = /error|failed|exit code [1-9]|command not found/i.test(feedback);
      if (!isError && feedback.length > 800) {
        feedback = feedback.slice(0, 300) + `\n...[输出省略 ${feedback.length - 600} 字符]...\n` + feedback.slice(-300);
      } else if (isError && feedback.length > 2500) {
        feedback = feedback.slice(-2500);
      }
    }

    return `--- Step ${stepNum} ---
【执行配置】：
${JSON.stringify({ step_thought: step.step_thought, action: step.action, params: displayParams }, null, 2)}
【本地执行反馈】：
${feedback}`;
  });

  return formattedLogs.join('\n\n');
}

function parseMessages(messages = []) {
  let globalTask = '';
  const rawSteps = [];
  let latestTurnInput = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = Array.isArray(msg.content)
        ? msg.content.find(c => c.type === 'text')?.text || ''
        : (typeof msg.content === 'string' ? msg.content : '');
      if (content && !content.startsWith('<tool_result')) {
        globalTask = content;
        break;
      }
    }
  }
  if (!globalTask) globalTask = '处理当前工作目录下的任务。';

  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    if (typeof lastMsg.content === 'string') {
      latestTurnInput = lastMsg.content;
    } else if (Array.isArray(lastMsg.content)) {
      const toolResults = lastMsg.content.filter(c => c.type === 'tool_result');
      if (toolResults.length > 0) {
        latestTurnInput = toolResults.map(tr => {
          let text = typeof tr.content === 'string' ? tr.content : (tr.content?.map(c => c.text).join('') || '');
          return `[工具回执 ID:${tr.tool_use_id}]: ${text.slice(0, 200)}`;
        }).join(' | ');
      } else {
        const textItem = lastMsg.content.find(c => c.type === 'text');
        latestTurnInput = textItem ? textItem.text : JSON.stringify(lastMsg.content);
      }
    }
  }

  let activeStep = null;
  for (const msg of messages) {
    const contents = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
    if (msg.role === 'assistant') {
      for (const item of contents) {
        if (item.type === 'tool_use') {
          activeStep = {
            step_thought: `调度 ${item.name}`,
            action: CC_TOOL_TO_ACTION[item.name] || 'shell_exec',
            params: item.input || {}
          };
        }
      }
    } else if (msg.role === 'user') {
      for (const item of contents) {
        if (item.type === 'tool_result' && activeStep) {
          let out = typeof item.content === 'string' ? item.content : (item.content?.map(c => c.text).join('\n') || '');
          rawSteps.push({ ...activeStep, feedback: out });
          activeStep = null;
        }
      }
    }
  }

  return { globalTask, historyLogsText: compressHistorySteps(rawSteps), latestTurnInput };
}

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

function extractActionJson(rawText) {
  try {
    const match = rawText.match(/```json\s*([\s\S]*?)\s*```/);
    if (match && match[1]) return JSON.parse(match[1]);
    const looseMatch = rawText.match(/\{[\s\S]*"action"[\s\S]*\}/);
    if (looseMatch) return JSON.parse(looseMatch[0]);
  } catch (e) {}
  return null;
}

// ==========================================
// 4. 向上游请求核心调度器 (带自动回退与防卡死)
// ==========================================
async function callUpstream(upstreamBase, apiKey, model, prompt) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };

  // 1. 先尝试 Anthropic /v1/messages 接口
  try {
    const res = await fetch(`${upstreamBase}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'claude-3-7-sonnet-20250219',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(45000)
    });

    if (res.ok) {
      const data = await res.json();
      return data.content?.[0]?.text || '';
    }
  } catch (e) {
    logger.debug('原生 messages 接口尝试未果，切入 chat/completions 兼容模式', e.message);
  }

  // 2. 回退尝试 OpenAI /v1/chat/completions 接口
  const chatRes = await fetch(`${upstreamBase}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'claude-3-7-sonnet-20250219',
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(45000)
  });

  if (!chatRes.ok) {
    const errText = await chatRes.text();
    throw new Error(`上游调用双向失败: ${chatRes.status} ${errText}`);
  }

  const chatData = await chatRes.json();
  return chatData.choices?.[0]?.message?.content || '';
}

// ==========================================
// 5. 路由 1: GET */v1/models (模型列表透传)
// ==========================================
app.get(/(.*)\/v1\/models$/, async (req, res) => {
  const { upstreamBase } = parseDynamicUpstream(req);
  logger.debug('拉取模型列表', { 目标上游: upstreamBase });

  try {
    const authHeader = req.headers['authorization'] || `Bearer ${req.headers['x-api-key'] || ''}`;
    const upstreamRes = await fetch(`${upstreamBase}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'x-api-key': req.headers['x-api-key'] || '',
        'User-Agent': 'Mozilla/5.0'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (upstreamRes.ok) {
      const data = await upstreamRes.json();
      return res.json(data);
    }
  } catch (err) {
    logger.error('上游模型列表获取失败，启用默认列表', err.message);
  }

  res.json({
    object: 'list',
    data: [
      { id: 'claude-3-7-sonnet-20250219', object: 'model' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model' }
    ]
  });
});

// ==========================================
// 6. 路由 2: POST */v1/chat/completions (OpenWebUI 适配通道)
// ==========================================
app.post(/(.*)\/v1\/chat\/completions$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseDynamicUpstream(req);
  const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '') || req.headers['x-api-key'];
  const { model, messages, stream } = req.body;

  const { globalTask, historyLogsText, latestTurnInput } = parseMessages(messages || []);
  logger.debug('收到 OpenWebUI 请求', {
    目标上游: upstreamBase,
    模型: model,
    本次增量输入: latestTurnInput || '（初始启动任务）'
  });

  try {
    const prompt = buildPrompt(globalTask, historyLogsText);
    const assistantText = await callUpstream(upstreamBase, apiKey, model, prompt);
    const actionObj = extractActionJson(assistantText);

    let finalOutput = assistantText;
    if (actionObj && actionObj.action) {
      finalOutput = `【思考】: ${actionObj.step_thought || ''}\n【调度动作】: ${actionObj.action}\n\`\`\`json\n${JSON.stringify(actionObj.params, null, 2)}\n\`\`\``;
    }

    logger.debug('OpenWebUI 响应完成', { 耗时: `${Date.now() - startTime}ms` });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [{ delta: { content: finalOutput } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ message: { role: 'assistant', content: finalOutput }, finish_reason: 'stop' }]
      });
    }
  } catch (err) {
    logger.error('OpenWebUI 链路异常', err.message);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ==========================================
// 7. 路由 3: POST */v1/messages (Claude Code 适配通道)
// ==========================================
app.post(/(.*)\/v1\/messages$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseDynamicUpstream(req);
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body;

  const { globalTask, historyLogsText, latestTurnInput } = parseMessages(messages || []);
  logger.debug('收到 Claude Code 请求', {
    目标上游: upstreamBase,
    模型: model,
    本次增量输入: latestTurnInput || '（初始启动任务）'
  });

  try {
    const prompt = buildPrompt(globalTask, historyLogsText);
    const assistantText = await callUpstream(upstreamBase, apiKey, model, prompt);
    const actionObj = extractActionJson(assistantText);

    const msgId = 'msg_' + crypto.randomBytes(12).toString('hex');
    const toolCallId = 'call_' + crypto.randomBytes(8).toString('hex');
    let responseContent = [];
    let stopReason = 'end_turn';

    if (actionObj && actionObj.action && actionObj.action !== 'finish') {
      const ccTool = ACTION_TO_CC_TOOL[actionObj.action] || 'Bash';
      stopReason = 'tool_use';
      responseContent = [
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
      responseContent = [{ type: 'text', text: summary }];
      stopReason = 'end_turn';

      logger.debug('流程收尾总结', {
        耗时: `${Date.now() - startTime}ms`,
        总结: summary.slice(0, 200)
      });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

      send('message_start', {
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 150, output_tokens: 150 } }
      });

      let idx = 0;
      for (const block of responseContent) {
        send('content_block_start', {
          type: 'content_block_start',
          index: idx,
          content_block: block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} }
        });

        if (block.type === 'text') {
          send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: block.text } });
        } else {
          send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        }

        send('content_block_stop', { type: 'content_block_stop', index: idx });
        idx++;
      }

      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 250 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      res.json({
        id: msgId,
        type: 'message',
        role: 'assistant',
        model,
        content: responseContent,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 150, output_tokens: 250 }
      });
    }
  } catch (err) {
    logger.error('Claude Code 消息处理异常', err.message);
    res.status(500).json({ error: { type: 'proxy_error', message: err.message } });
  }
});

// 启动
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` Claude Code 智能中介已启动 (端口: ${PORT})`);
  console.log(`======================================================\n`);
});
