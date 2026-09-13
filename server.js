import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import dns from 'node:dns/promises';
import { Agent, setGlobalDispatcher } from 'undici';

dotenv.config();

// 1. 网络底座配置
dns.setDefaultResultOrder('ipv4first');
setGlobalDispatcher(
  new Agent({
    headersTimeout: 600000,
    bodyTimeout: 600000,
    connectTimeout: 30000
  })
);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = Number(process.env.PORT || 7860);

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

const logger = {
  info: (stage, details = {}) => {
    console.log(`\n\x1b[36m[${getTimestamp()}]\x1b[0m \x1b[32m【${stage}】\x1b[0m`);
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

// 全局流量探针
app.use((req, res, next) => {
  logger.info('收到网络请求', {
    'Method': req.method,
    'OriginalUrl': req.originalUrl,
    'Client-IP': req.ip,
    'Content-Type': req.headers['content-type']
  });
  next();
});

// ==========================================
// 2. 动态 URL 穿透解析
// ==========================================
function isPrivateOrRestrictedHost(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1') return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(lower)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(lower)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(lower)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(lower)) return true;
  return false;
}

function parseTargetUrl(req) {
  let raw = req.originalUrl.startsWith('/') ? req.originalUrl.slice(1) : req.originalUrl;
  if (!/^https?:\/\//i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch {}
  }

  // 匹配类似 https://xxx.space/v1/chat/completions 或 https://xxx.space/v1/messages
  const v1Match = raw.match(/^(https?:\/\/[^\/]+(?:\/[^\/]+)*?)\/(v1\/(?:messages|chat\/completions|models|messages\/count_tokens))(?:\?(.*))?$/i);
  if (v1Match) {
    try {
      const u = new URL(v1Match[1]);
      if (!isPrivateOrRestrictedHost(u.hostname)) {
        return {
          upstreamBase: v1Match[1].replace(/\/$/, ''),
          endpoint: '/' + v1Match[2],
          fullTarget: v1Match[1].replace(/\/$/, '') + '/' + v1Match[2]
        };
      }
    } catch {}
  }

  const envBase = (process.env.UPSTREAM_BASE_URL || '').replace(/\/$/, '');
  return {
    upstreamBase: envBase,
    endpoint: req.path,
    fullTarget: envBase + req.path
  };
}

// ==========================================
// 3. Action 与 CC 工具映射器
// ==========================================
function mapActionToClaudeCodeTool(actionName, rawParams) {
  const normAction = String(actionName || '').trim().toLowerCase();
  const params = rawParams || {};

  if (normAction === 'fs_write' || normAction === 'write') {
    return {
      name: 'Write',
      arguments: {
        file_path: params.file_path || params.path || 'temp.txt',
        content: params.content !== undefined ? params.content : ''
      }
    };
  }
  if (normAction === 'fs_read' || normAction === 'read') {
    return {
      name: 'Read',
      arguments: {
        file_path: params.file_path || params.path || '',
        ...(params.limit ? { limit: Number(params.limit) } : {}),
        ...(params.offset ? { offset: Number(params.offset) } : {})
      }
    };
  }
  if (normAction === 'fs_replace' || normAction === 'edit') {
    return {
      name: 'Edit',
      arguments: {
        file_path: params.file_path || params.path || '',
        old_string: params.old_string !== undefined ? params.old_string : '',
        new_string: params.new_string !== undefined ? params.new_string : '',
        replace_all: Boolean(params.replace_all)
      }
    };
  }
  if (normAction === 'shell_exec' || normAction === 'bash') {
    return {
      name: 'Bash',
      arguments: {
        command: params.command || params.cmd || '',
        ...(params.description ? { description: params.description } : {})
      }
    };
  }
  if (normAction === 'user_prompt' || normAction === 'askuserquestion') {
    let questions = [];
    if (Array.isArray(params.questions)) {
      questions = params.questions;
    } else {
      const qText = params.question || params.prompt || '请确认下一步操作：';
      const rawOptions = Array.isArray(params.options) ? params.options : ['确认', '取消'];
      const formattedOptions = rawOptions.map(opt => {
        if (typeof opt === 'string') return { label: opt, description: opt };
        return { label: opt.label || '选项', description: opt.description || opt.label || '' };
      });
      questions = [{
        question: qText,
        header: params.header || '决策确认',
        multiSelect: Boolean(params.multiSelect),
        options: formattedOptions
      }];
    }
    return { name: 'AskUserQuestion', arguments: { questions } };
  }
  if (normAction === 'net_search' || normAction === 'websearch') {
    return { name: 'WebSearch', arguments: { query: params.query || '' } };
  }
  if (normAction === 'net_fetch' || normAction === 'webfetch') {
    return { name: 'WebFetch', arguments: { url: params.url || '', prompt: params.prompt || '提取关键内容' } };
  }
  if (normAction === 'subflow_spawn' || normAction === 'agent') {
    return { name: 'Agent', arguments: { description: params.title || params.description || 'Sub-agent task', prompt: params.instructions || params.prompt || '' } };
  }
  if (normAction === 'task_entry' || normAction === 'taskcreate' || normAction === 'taskupdate') {
    if (params.action === 'update' || params.taskId) {
      return { name: 'TaskUpdate', arguments: { taskId: params.taskId || params.task_id, status: params.status || 'completed' } };
    }
    return { name: 'TaskCreate', arguments: { subject: params.title || params.subject || '任务', description: params.description || '' } };
  }
  if (normAction === 'notebook_patch' || normAction === 'notebookedit') {
    return {
      name: 'NotebookEdit',
      arguments: {
        notebook_path: params.notebook_path || '',
        cell_id: params.cell_id || '',
        edit_mode: params.edit_mode || 'replace',
        new_source: params.new_source || ''
      }
    };
  }
  if (normAction === 'git_worktree' || normAction === 'enterworktree') {
    return { name: 'EnterWorktree', arguments: { name: params.name || 'worktree', path: params.path || '' } };
  }
  if (normAction === 'code_audit' || normAction === 'reportfindings') {
    return { name: 'ReportFindings', arguments: { findings: params.findings || [], level: params.level || 'medium' } };
  }
  return { name: 'Bash', arguments: params };
}

// ==========================================
// 4. 智能历史压缩
// ==========================================
const CORE_DOCS_REGEX = /(?:^|[/\s"'\`\\])(?:todo|readme)\.(?:md|markdown|txt)(?:[/\s"'\`\\]|$)/i;

function sanitizeWhitespace(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanNoise(text) {
  if (!text || typeof text !== 'string') return '';
  const cleaned = text
    .replace(/REMINDER:\s*You MUST include the sources[\s\S]*?hyperlinks\./gi, '')
    .replace(/Wasted call\s*—\s*file unchanged[\s\S]*?instead\./gi, '[SUCCESS] 文件未修改，状态已是最新。')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<context>[\s\S]*?<\/context>/gi, '');
  return sanitizeWhitespace(cleaned);
}

function smartTruncateLog(text, limit, label = '终端日志') {
  if (text.length <= limit) return text;
  const headSize = Math.max(400, Math.floor(limit * 0.35));
  const tailSize = Math.max(500, Math.floor(limit * 0.45));
  const headPart = text.slice(0, headSize);
  const tailPart = text.slice(-tailSize);
  const middleContent = text.slice(headSize, -tailSize);

  const lines = middleContent.split('\n');
  const errorIndicators = [/error/i, /exception/i, /fail/i, /traceback/i, /exit code\s*[1-9]/i, /cannot access/i, /no such file/i];
  const capturedLines = [];

  for (let i = 0; i < lines.length && capturedLines.length < 25; i++) {
    if (errorIndicators.some(reg => reg.test(lines[i]))) {
      capturedLines.push(lines[i].trim());
    }
  }

  const removed = text.length - headSize - tailSize;
  let summary = `\n...[${label}中间折叠 ${removed} 字符`;
  if (capturedLines.length > 0) {
    summary += `，提炼关键异常信号：\n${capturedLines.slice(0, 8).join('\n')}\n...折叠结束]...\n`;
  } else {
    summary += `]...\n`;
  }
  return `${headPart}${summary}${tailPart}`;
}

function formatStepSmartFeedback(action, params, rawFeedback, isLatestStep, stepAge) {
  const normAction = (action || '').toLowerCase();
  let text = sanitizeWhitespace(String(rawFeedback || ''));

  if (normAction === 'user_prompt' || normAction === 'askuserquestion') {
    return `【用户决策确认】:
- 询问内容: ${params.question || JSON.stringify(params.questions || params)}
- 用户明确输入/所选选项: ${text || '（用户未补充额外说明，已按默认提交）'}
【调度注意】：必须严格尊重上述用户的明确选择，继续推进下一步。`;
  }

  const cmdStr = String(params.command || params.cmd || '');
  const pathStr = String(params.file_path || params.path || '');
  const isTargetDocFile = CORE_DOCS_REGEX.test(pathStr) || CORE_DOCS_REGEX.test(cmdStr);
  const hasChecklistMarks = /- \[[ xX]\]/m.test(text);

  if (isTargetDocFile || hasChecklistMarks) {
    if (text.length <= 25000) return text;
    return smartTruncateLog(text, 25000, '核心任务/设计文档清单');
  }

  if (normAction === 'net_search' || normAction === 'net_fetch' || normAction === 'websearch' || normAction === 'webfetch') {
    const pureText = text.replace(/<script[\s\S]*?<\/script>/gi, '')
                         .replace(/<style[\s\S]*?<\/style>/gi, '')
                         .replace(/<[^>]+>/g, ' ')
                         .replace(/\s{2,}/g, ' ');
    const budget = isLatestStep ? 4000 : 1500;
    return pureText.length > budget ? smartTruncateLog(pureText, budget, '网页/检索结果') : pureText;
  }

  if (normAction === 'task_entry' || normAction === 'taskcreate' || normAction === 'taskupdate') {
    return `[任务管理同步] ${params.action === 'update' ? `更新任务[ID: ${params.taskId || params.task_id}]状态为: ${params.status || 'completed'}` : `创建任务: ${params.title || params.subject}`}。执行结果: ${text || '成功'}`;
  }

  if (normAction === 'git_worktree' || normAction === 'enterworktree') {
    return `[工作区切换] 当前已进入工作区路径: ${params.path || params.name || '默认'}。反馈: ${text}`;
  }

  if (normAction === 'code_audit' || normAction === 'reportfindings') {
    return text.length > 5000 ? smartTruncateLog(text, 5000, '审查报告与缺陷清单') : text;
  }

  if (normAction === 'shell_exec' || normAction === 'bash') {
    if (/successfully|done|created|installed/i.test(text) && !text.includes('error') && text.length > 2000 && !isLatestStep) {
      return `[SUCCESS] 终端命令执行完成，核心产物已就绪。\n` + text.slice(-400);
    }
    const budget = isLatestStep ? 12000 : (stepAge <= 2 ? 5000 : 2000);
    return text.length > budget ? smartTruncateLog(text, budget, '终端命令输出') : text;
  }

  if (normAction === 'fs_read' || normAction === 'read') {
    const budget = isLatestStep ? 12000 : (stepAge <= 2 ? 5000 : 2000);
    return text.length > budget ? smartTruncateLog(text, budget, '代码/文本读取') : text;
  }

  const defaultBudget = isLatestStep ? 8000 : 2000;
  return text.length > defaultBudget ? smartTruncateLog(text, defaultBudget, '执行反馈') : text;
}

function compressHistorySteps(rawSteps) {
  const validSteps = (rawSteps || []).filter(s => s.action && s.action !== 'text_response');
  const trimmed = validSteps.slice(-10);
  if (trimmed.length === 0) {
    return '（当前为初始化阶段，尚无历史记录）';
  }

  const lastReadMap = new Map();
  trimmed.forEach((s, idx) => {
    if (s.action === 'fs_read' && s.params?.file_path) {
      lastReadMap.set(String(s.params.file_path).toLowerCase(), idx);
    }
  });

  const total = trimmed.length;

  return trimmed.map((step, idx) => {
    let rawFeedback = step.feedback || '[SUCCESS] 执行完成';
    let params = { ...step.params };
    const filePathStr = String(params.file_path || params.path || '');
    const isTodoFile = /(?:^|[/\\])todo\.(?:md|markdown|txt)$/i.test(filePathStr);
    const isReadmeFile = /(?:^|[/\\])readme\.(?:md|markdown|txt)$/i.test(filePathStr);

    const stepAge = total - 1 - idx;
    const isLatestStep = stepAge === 0;

    if (step.action === 'fs_write') {
      if (isTodoFile) {
        params = { file_path: params.file_path || 'todo.md', content: step.params?.content || '' };
      } else if (isReadmeFile) {
        const contentStr = String(step.params?.content || '');
        params = {
          file_path: params.file_path || 'readme.md',
          content: contentStr.length <= 4000 ? contentStr : `[项目规划与设计规范已写入，共 ${contentStr.length} 字符]`
        };
      } else {
        const len = step.params?.content ? String(step.params.content).length : 0;
        params = { file_path: params.file_path || 'file', ...(len > 0 ? { content: `[源码/文档内容已写入，共 ${len} 字符]` } : {}) };
      }
    }

    if (step.action === 'fs_read') {
      const lowerPath = filePathStr.toLowerCase();
      if (lastReadMap.get(lowerPath) !== idx) {
        rawFeedback = `[早期版本已读取，第 ${lastReadMap.get(lowerPath) + 1} 步有最新读取结果，此处折叠]`;
      }
    }

    const smartFeedback = formatStepSmartFeedback(step.action, params, rawFeedback, isLatestStep, stepAge);

    return `--- Step ${idx + 1} ---
【执行配置】：
${JSON.stringify({ action: step.action, params }, null, 2)}
【本地执行反馈】：
${smartFeedback}`;
  }).join('\n\n');
}

function parseConversation(messages = []) {
  let globalTask = '';
  const rawSteps = [];

  const CC_TO_ACTION_MAP = {
    Write: 'fs_write', Read: 'fs_read', Edit: 'fs_replace', Bash: 'shell_exec',
    WebSearch: 'net_search', WebFetch: 'net_fetch', AskUserQuestion: 'user_prompt',
    Agent: 'subflow_spawn', Workflow: 'subflow_spawn', TaskCreate: 'task_entry',
    TaskUpdate: 'task_entry', NotebookEdit: 'notebook_patch', EnterWorktree: 'git_worktree',
    ReportFindings: 'code_audit'
  };

  for (const msg of messages) {
    if (msg.role === 'user') {
      let rawText = '';
      if (typeof msg.content === 'string') rawText = msg.content;
      else if (Array.isArray(msg.content)) {
        rawText = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      }
      const clean = cleanNoise(rawText);
      if (clean && !clean.startsWith('<tool_result') && !clean.includes("Today's date is") && !clean.startsWith('{') && clean.length > 5) {
        globalTask = clean;
        break;
      }
    }
  }
  if (!globalTask) globalTask = '推进当前工作目录下的任务。';

  const pendingSteps = new Map();
  const sequentialQueue = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_use') {
            const stepObj = { id: p.id || '', action: CC_TO_ACTION_MAP[p.name] || 'shell_exec', params: p.input || {} };
            if (p.id) pendingSteps.set(p.id, stepObj);
            sequentialQueue.push(stepObj);
          }
        }
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let params = {};
          try {
            params = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
          } catch {}
          const stepObj = { id: tc.id || '', action: CC_TO_ACTION_MAP[tc.function?.name] || 'shell_exec', params };
          if (tc.id) pendingSteps.set(tc.id, stepObj);
          sequentialQueue.push(stepObj);
        }
      }
    } else if (msg.role === 'user' || msg.role === 'tool') {
      const matchAndPopStep = (toolCallId) => {
        if (toolCallId && pendingSteps.has(toolCallId)) {
          const step = pendingSteps.get(toolCallId);
          pendingSteps.delete(toolCallId);
          const qIdx = sequentialQueue.findIndex(s => s.id === toolCallId);
          if (qIdx !== -1) sequentialQueue.splice(qIdx, 1);
          return step;
        }
        return null;
      };

      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_result') {
            const outText = typeof p.content === 'string' ? p.content : (p.content?.map(c => c.text).join('\n') || '');
            const matchedStep = matchAndPopStep(p.tool_use_id) || sequentialQueue.shift();
            if (matchedStep) rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
          }
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        const outText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const matchedStep = matchAndPopStep(msg.tool_call_id) || sequentialQueue.shift();
        if (matchedStep) rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
      } else if (typeof msg.content === 'string') {
        const text = cleanNoise(msg.content);
        if (text && !text.startsWith("Today's date is") && sequentialQueue.length > 0) {
          const matchedStep = sequentialQueue.shift();
          if (matchedStep) {
            rawSteps.push({ ...matchedStep, feedback: text });
          }
        }
      }
    }
  }

  const historyLogsText = compressHistorySteps(rawSteps);
  const latestTurnInput = rawSteps.length > 0 ? rawSteps[rawSteps.length - 1].feedback : '（初始启动任务）';
  return { globalTask, historyLogsText, latestTurnInput };
}

// ==========================================
// 5. Prompt 构建器
// ==========================================
function buildPrompt(globalTask, historyLogsText) {
  return `我们正在维护一个本地自动化流水线。该引擎按流水线逐步执行任务。每个步骤由你根据历史日志输出一个独立的任务指令块，由外部执行脚本读取并在本地操作系统中执行，执行完毕后会将终端标准输出作为日志反馈给你。

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

【流水线推进严律】：
1. 用户意志绝对优先：若历史记录中包含【用户决策确认】，必须严格服从用户的选项继续推进，绝不可反复询问同一问题！
2. 拆解规范：无历史记录启动时，检查 todo.md 和 readme.md。若无，必须首步通过 fs_write 规划写入详细 todo.md。
3. 单步原则：每个回复只能输出当前唯一步骤的配置，绝不可合并多个步骤。
4. 终止条件：当且仅当所有待办项均已完成验收时，输出 action 为 "finish" 的收尾配置。
5. 格式严律：【思考】与【调度动作】必须严格按照模板给出，json 代码块中必须为合法 JSON（换行必须使用 \\n 转义）。

【强制返回格式模板示例】:
【思考】: 说明当前步骤的意图与判断分析...
【调度动作】: fs_write
\`\`\`json
{
  "file_path": "todo.md",
  "content": "# 任务清单\\n- [ ] 步骤一\\n- [ ] 步骤二"
}
\`\`\`

=======================================================
【全局目标任务】：
${globalTask}
=======================================================
【历史执行记录（含用户明确决策与状态）】：
${historyLogsText}
=======================================================
请结合上述上下文与用户意图，输出当前应执行的唯一步骤配置：`;
}

// ==========================================
// 6. 安全容错 JSON 解析
// ==========================================
function safeParseJson(str) {
  if (!str) return null;
  const clean = str.replace(/,\s*([}\]])/g, '$1').trim();
  try {
    return JSON.parse(clean);
  } catch {
    let inString = false;
    let escaped = false;
    let res = '';
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (c === '"' && !escaped) inString = !inString;
      if (inString && (c === '\n' || c === '\r')) {
        res += c === '\n' ? '\\n' : '';
      } else {
        res += c;
      }
      escaped = (c === '\\' && !escaped);
    }
    try {
      return JSON.parse(res);
    } catch {
      return null;
    }
  }
}

function scanBalancedJsonObject(text) {
  let depth = 0;
  let inStr = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const obj = safeParseJson(text.slice(start, i + 1));
        if (obj) return obj;
        start = -1;
      }
    }
  }
  return null;
}

function extractActionAndThought(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let thought = '';
  let action = '';
  let params = {};

  const thoughtMatch = rawText.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|```json|```|<tool_call>|$)/i);
  if (thoughtMatch) thought = thoughtMatch[1].trim();

  const actionMatch = rawText.match(/【调度动作】[：:]\s*([a-zA-Z0-9_]+)/i);
  if (actionMatch) action = actionMatch[1].trim();

  const mdMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let parsedJson = mdMatch ? safeParseJson(mdMatch[1]) : null;
  if (!parsedJson) parsedJson = scanBalancedJsonObject(rawText);

  if (parsedJson && typeof parsedJson === 'object') {
    if (parsedJson.action) {
      action = parsedJson.action;
      thought = parsedJson.step_thought || parsedJson.thought || thought;
      params = parsedJson.params || parsedJson.arguments || parsedJson;
      delete params.action;
    } else if (action) {
      params = parsedJson;
    } else if (parsedJson.file_path && parsedJson.content !== undefined) {
      action = 'fs_write';
      params = parsedJson;
    } else if (parsedJson.command) {
      action = 'shell_exec';
      params = parsedJson;
    } else if (parsedJson.file_path && parsedJson.old_string !== undefined) {
      action = 'fs_replace';
      params = parsedJson;
    } else if (parsedJson.file_path) {
      action = 'fs_read';
      params = parsedJson;
    }
  }

  if (!thought && !action && !Object.keys(params).length) return null;

  return {
    thought: thought || '执行当前流水线步骤...',
    action: action || 'finish',
    params: params || {}
  };
}

// ==========================================
// 7. 上游通信（详细打印网络与报错细节）
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

async function fetchUpstreamStream(targetBase, apiKey, model, prompt, signal) {
  logger.info('准备向上游发起请求', {
    '目标Base': targetBase,
    'Model': model,
    'API-Key前缀': apiKey ? apiKey.slice(0, 8) + '...' : '（无）',
    'Prompt长度': prompt.length
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Accept': 'text/event-stream, application/json'
  };

  // 1. Anthropic 通道尝试
  try {
    const targetUrl = `${targetBase}/v1/messages`;
    logger.info('尝试 Anthropic 通道', { URL: targetUrl });
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'claude-3-7-sonnet-20250219',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
        stream: true
      }),
      signal
    });

    if (res.ok) {
      logger.info('Anthropic 通道连接成功，开始读取 SSE 流');
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
      logger.info('Anthropic 通道流读取完毕', { 正文长度: fullText.length, 思考长度: thinkingText.length });
      return { text: fullText, thinking: thinkingText };
    }

    const errText = await res.text();
    logger.info('Anthropic 通道未成功响应，降级尝试 OpenAI', { HTTP状态: res.status, 响应: errText.slice(0, 300) });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    logger.error('Anthropic 通道异常', e.message);
  }

  // 2. OpenAI 降级通道
  const chatUrl = `${targetBase}/v1/chat/completions`;
  logger.info('尝试 OpenAI 通道', { URL: chatUrl });
  const chatRes = await fetch(chatUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'claude-3-7-sonnet-20250219',
      messages: [{ role: 'user', content: prompt }],
      stream: true
    }),
    signal
  });

  if (!chatRes.ok) {
    const errText = await chatRes.text();
    logger.error('OpenAI 通道亦宣告失败', { HTTP状态: chatRes.status, 响应: errText });
    throw new Error(`上游全部失败: HTTP ${chatRes.status} - ${errText}`);
  }

  logger.info('OpenAI 通道握手成功，开始读取流');
  let fullText = '';
  let thinkingText = '';

  for await (const chunk of readSSE(chatRes)) {
    if (!chunk || chunk === '[DONE]') continue;
    try {
      const payload = JSON.parse(chunk);
      const delta = payload.choices?.[0]?.delta;
      if (delta) {
        if (delta.reasoning_content || delta.reasoning) {
          thinkingText += (delta.reasoning_content || delta.reasoning);
        }
        if (delta.content) {
          fullText += delta.content;
        }
      }
    } catch {}
  }
  logger.info('OpenAI 通道流读取完毕', { 正文长度: fullText.length });
  return { text: fullText, thinking: thinkingText };
}

// ==========================================
// 8. Messages 处理管道 (Claude Code 原生)
// ==========================================
async function handleMessages(req, res) {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body || {};

  logger.info('命中 Messages 处理管道', {
    '解析上游Base': upstreamBase,
    'Model': model,
    'Messages轮数': Array.isArray(messages) ? messages.length : 0,
    'Stream模式': Boolean(stream)
  });

  const abortCtrl = new AbortController();
  req.on('close', () => {
    logger.info('客户端提前断开连接');
    abortCtrl.abort();
  });

  const isCompacting = Boolean(Array.isArray(messages) && messages.length > 0 && 
    /summary of the conversation|summarize|compact/i.test(JSON.stringify(messages[messages.length - 1])));

  const { globalTask, historyLogsText } = parseConversation(messages || []);
  const msgId = 'msg_' + crypto.randomBytes(12).toString('hex');
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

    heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 5000);
  }

  try {
    const prompt = isCompacting
      ? `请对以下流水线历史提供紧凑的阶段性总结：\n\n【全局任务】：${globalTask}\n\n【执行历史】：\n${historyLogsText}`
      : buildPrompt(globalTask, historyLogsText);

    const { text: assistantText } = await fetchUpstreamStream(
      upstreamBase,
      apiKey,
      model,
      prompt,
      abortCtrl.signal
    );

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    let stopReason = 'end_turn';
    let textContent = '';
    let toolBlock = null;

    if (isCompacting) {
      textContent = assistantText.replace(/【思考】[\s\S]*?(?=【调度动作】|$)/gi, '').trim() || '流水线历史已压缩。';
      stopReason = 'end_turn';
    } else {
      const parsedAction = extractActionAndThought(assistantText);
      logger.info('模型输出提取结果', { parsedAction });

      if (parsedAction && parsedAction.action && parsedAction.action !== 'finish') {
        const mappedTool = mapActionToClaudeCodeTool(parsedAction.action, parsedAction.params);
        stopReason = 'tool_use';
        const targetDesc = mappedTool.arguments?.file_path || mappedTool.arguments?.command || '';
        textContent = `调度 ${mappedTool.name} ${targetDesc ? '-> ' + targetDesc : ''}`.slice(0, 80);

        toolBlock = {
          type: 'tool_use',
          id: 'toolu_' + crypto.randomBytes(10).toString('hex'),
          name: mappedTool.name,
          input: mappedTool.arguments
        };
      } else {
        textContent = parsedAction?.params?.summary || parsedAction?.thought || assistantText;
        stopReason = 'end_turn';
      }
    }

    if (stream) {
      if (textContent) {
        sendSSE('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        sendSSE('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: textContent } });
        sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      }

      if (toolBlock) {
        sendSSE('content_block_start', {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: toolBlock.id, name: toolBlock.name, input: {} }
        });
        sendSSE('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolBlock.input) }
        });
        sendSSE('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        blockIndex++;
      }

      sendSSE('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 300 } });
      sendSSE('message_stop', { type: 'message_stop' });
      res.end();
      logger.info('SSE 流发送完成', { 耗时: `${Date.now() - startTime}ms` });
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
    if (err.name === 'AbortError') return;
    logger.error('Claude Code 消息通道异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
}

// ==========================================
// 9. 【关键补齐】：Chat Completions 处理管道 (OpenAI 协议)
// ==========================================
async function handleChatCompletions(req, res) {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '') || req.headers['x-api-key'];
  const { model, messages, stream } = req.body || {};

  logger.info('命中 ChatCompletions 处理管道', {
    '解析上游Base': upstreamBase,
    'Model': model,
    'Stream模式': Boolean(stream)
  });

  const abortCtrl = new AbortController();
  req.on('close', () => {
    logger.info('客户端提前断开连接');
    abortCtrl.abort();
  });

  const { globalTask, historyLogsText } = parseConversation(messages || []);
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
      abortCtrl.signal
    );

    if (heartbeatTimer) clearInterval(heartbeatTimer);

    const parsedAction = extractActionAndThought(assistantText);
    const completionId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    const callId = 'call_' + crypto.randomBytes(8).toString('hex');
    let toolCalls = null;
    let finishReason = 'stop';
    let textContent = '';

    if (parsedAction && parsedAction.action && parsedAction.action !== 'finish') {
      const mappedTool = mapActionToClaudeCodeTool(parsedAction.action, parsedAction.params);
      finishReason = 'tool_calls';
      textContent = parsedAction.thought || `调度 ${mappedTool.name}...`;
      toolCalls = [{
        index: 0,
        id: callId,
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
      res.write(`data: ${JSON.stringify({ id: completionId, choices: [{ delta: { role: 'assistant' }, index: 0 }] })}\n\n`);

      if (textContent || thinking) {
        res.write(`data: ${JSON.stringify({ id: completionId, choices: [{ delta: { content: textContent, reasoning_content: thinking }, index: 0 }] })}\n\n`);
      }

      if (toolCalls) {
        res.write(`data: ${JSON.stringify({ id: completionId, choices: [{ delta: { tool_calls: toolCalls }, index: 0 }] })}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ id: completionId, choices: [{ delta: {}, finish_reason: finishReason, index: 0 }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      logger.info('ChatCompletions SSE 发送完毕', { 耗时: `${Date.now() - startTime}ms` });
    } else {
      res.json({
        id: completionId,
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
    if (err.name === 'AbortError') return;
    logger.error('ChatCompletions 通道异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
}

// ==========================================
// 10. 智能路由分发中心
// ==========================================
app.use((req, res, next) => {
  const url = req.originalUrl;

  // 1. 响应根路径与健康探活
  if (req.method === 'GET' && (url === '/' || url === '/v1' || url === '/v1/' || url.startsWith('/health'))) {
    logger.info('响应根路径/健康探活', { URL: url });
    return res.status(200).json({
      status: 'ok',
      message: 'Claude Code Agent Proxy is running',
      version: '1.0.0'
    });
  }

  // 2. Models 路由
  if (req.method === 'GET' && /\/v1\/models(?:\?.*)?$/i.test(url)) {
    const { upstreamBase } = parseTargetUrl(req);
    logger.info('响应 Models 请求', { upstreamBase });
    return (async () => {
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
    })();
  }

  // 3. Token 计数路由
  if (req.method === 'POST' && /\/v1\/messages\/count_tokens(?:\?.*)?$/i.test(url)) {
    logger.info('响应 Count Tokens 请求');
    const bodyText = JSON.stringify(req.body || {});
    const estimatedTokens = Math.ceil(bodyText.length / 3.8);
    return res.json({ input_tokens: estimatedTokens });
  }

  // 4. Claude Code /v1/messages 核心通道
  if (req.method === 'POST' && /\/v1\/messages(?:\?.*)?$/i.test(url)) {
    return handleMessages(req, res);
  }

  // 5. 【核心接入】：OpenAI 兼容 /v1/chat/completions 通道
  if (req.method === 'POST' && /\/v1\/chat\/completions(?:\?.*)?$/i.test(url)) {
    return handleChatCompletions(req, res);
  }

  // 6. 未匹配路由兜底
  next();
});

// 404 兜底告警探针
app.use((req, res) => {
  logger.error('未匹配到任何内部路由！(404)', {
    Method: req.method,
    URL: req.originalUrl,
    提示: '请检查请求 URL 是否带有非标准的 /v1 路径'
  });
  res.status(404).json({
    error: {
      message: `中介未找到对应路由: ${req.method} ${req.originalUrl}`
    }
  });
});

process.on('uncaughtException', (err) => logger.error('UncaughtException', err.message));
process.on('unhandledRejection', (err) => logger.error('UnhandledRejection', err));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` 🚀 CC Web 全链路可视化智能中介已就绪 (端口: ${PORT})`);
  console.log(` 支持: /v1/messages (Claude) 以及 /v1/chat/completions (OpenAI)`);
  console.log(` 支持: URL 前缀动态穿透 (/https://xxx/v1/...)`);
  console.log(`======================================================\n`);
});

server.requestTimeout = 600000;
server.headersTimeout = 600000;
server.keepAliveTimeout = 60000;
