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

// ==========================================
// 1. 结构化日志模块 (带时间、流程、输入增量)
// ==========================================
function getTimestamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').substring(0, 19);
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
// 2. 动态 URL 穿透解析器 (提取动态上游与端点)
// ==========================================
function parseDynamicUpstream(req) {
  // 兼容 express 路径合并，从 originalUrl 中提取真实的 target URL
  let rawPath = req.originalUrl || req.url;
  const [cleanPath, query] = rawPath.split('?');
  
  // 规范化去掉前置斜杠，修复 https:/ -> https://
  let normalized = cleanPath.replace(/^\/+/, '').replace(/(https?):\/+(?!\/)/g, '$1://');
  
  const v1Index = normalized.lastIndexOf('/v1/');
  if (v1Index !== -1) {
    const upstreamBase = normalized.substring(0, v1Index);
    const endpoint = normalized.substring(v1Index) + (query ? `?${query}` : '');
    return { upstreamBase, endpoint };
  }
  
  // 兜底方案
  return {
    upstreamBase: (process.env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    endpoint: cleanPath + (query ? `?${query}` : '')
  };
}

// ==========================================
// 3. 工具映射字典 (脱敏 Pipeline <-> CC原生)
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
// 4. 智能上下文压缩器 (精细化语义压缩)
// ==========================================
function compressHistorySteps(rawSteps) {
  // 仅保留最近 10 轮
  const trimmed = rawSteps.slice(-10);
  if (trimmed.length === 0) return '（当前为初始化阶段，尚无执行历史）';

  // 1. 扫描所有 Read 操作，找出每个文件最后一次读取的 index
  const lastReadIndexMap = new Map();
  trimmed.forEach((step, idx) => {
    if (step.action === 'fs_read' && step.params?.file_path) {
      lastReadIndexMap.set(step.params.file_path, idx);
    }
  });

  // 2. 逐步应用压缩策略
  const formattedLogs = trimmed.map((step, idx) => {
    const stepNum = idx + 1;
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let displayParams = { ...step.params };

    // --- 策略 A: fs_write (源码脱敏，防止几十KB代码反复传递) ---
    if (step.action === 'fs_write') {
      const len = step.params.content ? step.params.content.length : 0;
      displayParams.content = `[源码已成功写入磁盘，长度: ${len} 字符]`;
    }

    // --- 策略 B: fs_replace (长 diff 截断) ---
    if (step.action === 'fs_replace') {
      if (displayParams.old_string && displayParams.old_string.length > 80) {
        displayParams.old_string = displayParams.old_string.slice(0, 40) + '...[略]...' + displayParams.old_string.slice(-30);
      }
      if (displayParams.new_string && displayParams.new_string.length > 80) {
        displayParams.new_string = displayParams.new_string.slice(0, 40) + '...[略]...' + displayParams.new_string.slice(-30);
      }
    }

    // --- 策略 C: fs_read (多重读取去重压缩) ---
    if (step.action === 'fs_read') {
      const filePath = step.params.file_path;
      const lastIdx = lastReadIndexMap.get(filePath);
      if (lastIdx !== undefined && lastIdx !== idx) {
        // 不是最新一次读取，高度压缩
        feedback = `[早期版本文件内容已读取，该文件在后续第 ${lastIdx + 1} 步有最新读取，早期内容在此折叠]`;
      } else {
        // 是最新一次读取，保留足够上下文，超长部分保护性截取
        if (feedback.length > 3000) {
          feedback = feedback.slice(0, 1800) + '\n...[中间部分省略]...\n' + feedback.slice(-1000);
        }
      }
    }

    // --- 策略 D: shell_exec (输出去重与错误保真) ---
    if (step.action === 'shell_exec') {
      const isError = /error|failed|exit code [1-9]|command not found/i.test(feedback);
      if (!isError && feedback.length > 800) {
        // 成功日志精简 (保留头部与尾部摘要)
        feedback = feedback.slice(0, 300) + `\n...[执行通过，流水日志省略 ${feedback.length - 600} 字符]...\n` + feedback.slice(-300);
      } else if (isError && feedback.length > 2500) {
        // 报错保留最核心的 traceback 尾部
        feedback = feedback.slice(-2500);
      }
    }

    // --- 策略 E: net_search / net_fetch 压缩 ---
    if ((step.action === 'net_search' || step.action === 'net_fetch') && feedback.length > 1000) {
      feedback = feedback.slice(0, 800) + `\n...[网络抓取结果超长折叠，共 ${feedback.length} 字符]...`;
    }

    return `--- Step ${stepNum} ---
【执行配置】：
${JSON.stringify({ step_thought: step.step_thought, action: step.action, params: displayParams }, null, 2)}
【本地执行反馈】：
${feedback}`;
  });

  return formattedLogs.join('\n\n');
}

// ==========================================
// 5. 消息解析与增量提取 (用于输入审计)
// ==========================================
function parseMessages(messages = []) {
  let globalTask = '';
  const rawSteps = [];
  let latestTurnInput = null; // 仅限本次增量输入

  // 1. 寻找最初的全局任务
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

  // 2. 提取当前增量输入 (用于调试日志打印)
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    if (typeof lastMsg.content === 'string') {
      latestTurnInput = lastMsg.content;
    } else if (Array.isArray(lastMsg.content)) {
      const toolResults = lastMsg.content.filter(c => c.type === 'tool_result');
      if (toolResults.length > 0) {
        latestTurnInput = toolResults.map(tr => {
          let text = typeof tr.content === 'string' ? tr.content : (tr.content?.map(c => c.text).join('') || '');
          if (text.length > 200) text = text.slice(0, 200) + '...[截断]';
          return `[工具回执 ID:${tr.tool_use_id}]: ${text}`;
        }).join(' | ');
      } else {
        const textItem = lastMsg.content.find(c => c.type === 'text');
        latestTurnInput = textItem ? textItem.text : JSON.stringify(lastMsg.content);
      }
    }
  }

  // 3. 抽取完整的 step 序列
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
          rawSteps.push({
            ...activeStep,
            feedback: out
          });
          activeStep = null;
        }
      }
    }
  }

  return { globalTask, historyLogsText: compressHistorySteps(rawSteps), latestTurnInput };
}

// ==========================================
// 6. 构造抗风控 Pipeline 提示词
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

function extractActionJson(rawText) {
  try {
    const match = rawText.match(/```json\s*([\s\S]*?)\s*```/);
    if (match && match[1]) return JSON.parse(match[1]);
    const looseMatch = rawText.match(/\{[\s\S]*"action"[\s\S]*\}/);
    if (looseMatch) return JSON.parse(looseMatch[0]);
  } catch (e) {
    // 忽略异常，降级处理
  }
  return null;
}

// ==========================================
// 7. 接口: GET */v1/models (动态获取上游模型)
// ==========================================
app.get(/(.*)\/v1\/models$/, async (req, res) => {
  const { upstreamBase } = parseDynamicUpstream(req);
  logger.debug('拉取模型列表', { 目标上游: upstreamBase });

  try {
    const authHeader = req.headers['authorization'] || `Bearer ${req.headers['x-api-key'] || ''}`;
    const targetUrl = `${upstreamBase}/v1/models`;

    const upstreamRes = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Authorization': authHeader,
        'x-api-key': req.headers['x-api-key'] || '',
        'Content-Type': 'application/json'
      }
    });

    if (upstreamRes.ok) {
      const data = await upstreamRes.json();
      return res.json(data);
    }
  } catch (err) {
    logger.error('上游模型拉取失败，启用自适应兜底列表', err.message);
  }

  // 兜底列表，确保 Claude Code 连接时绝不崩溃
  res.json({
    object: 'list',
    data: [
      { id: 'claude-3-7-sonnet-20250219', object: 'model', created: Date.now(), owned_by: 'anthropic' },
      { id: 'claude-3-5-sonnet-20241022', object: 'model', created: Date.now(), owned_by: 'anthropic' }
    ]
  });
});

// ==========================================
// 8. 接口: POST */v1/messages (核心调度与流式回传)
// ==========================================
app.post(/(.*)\/v1\/messages$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseDynamicUpstream(req);
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body;

  // 1. 提取本次增量输入和历史压缩上下文
  const { globalTask, historyLogsText, latestTurnInput } = parseMessages(messages || []);
  
  logger.debug('收到客户端请求', {
    目标上游: upstreamBase,
    模型: model,
    本次增量输入: latestTurnInput || '（初始启动任务）'
  });

  const prompt = buildPrompt(globalTask, historyLogsText);

  try {
    // 2. 向上游发起单轮请求 (模型从 body 动态获取)
    const targetUrl = `${upstreamBase}/v1/messages`;
    const upstreamRes = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-3-7-sonnet-20250219',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      logger.error('上游接口调用失败', { status: upstreamRes.status, body: errText });
      return res.status(upstreamRes.status).send(errText);
    }

    const upstreamData = await upstreamRes.json();
    const assistantText = upstreamData.content?.[0]?.text || '';
    const actionObj = extractActionJson(assistantText);

    // 3. 构建 Claude Code 原生工具调用结构
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

      logger.debug('流程终结或纯文本回复', {
        耗时: `${Date.now() - startTime}ms`,
        总结: summary.slice(0, 300) + (summary.length > 300 ? '...' : '')
      });
    }

    // 4. 流式 (SSE) / 非流式输出适配
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
    logger.error('消息处理管线异常', err.message);
    res.status(500).json({ error: { type: 'proxy_internal_error', message: err.message } });
  }
});

// 启动监听
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(` cc中介已启动 (监听端口: ${PORT})`);
  console.log(`======================================================\n`);
});
