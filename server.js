import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import dns from 'node:dns/promises';
import { Agent, setGlobalDispatcher } from 'undici';

dotenv.config();

// 1. 网络底座配置：IPv4优先，undici 40分钟超长超时防断开
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
// 1. 结构化增量日志
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
// 2. 动态 URL 穿透解析
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
// 3. Action 与 Claude Code 原生工具适配映射器
// ==========================================
function mapActionToClaudeCodeTool(actionName, rawParams) {
  const normAction = String(actionName || '').trim().toLowerCase();
  const params = rawParams || {};

  // 1. Write: {"file_path", "content"}
  if (normAction === 'fs_write' || normAction === 'write') {
    return {
      name: 'Write',
      arguments: {
        file_path: params.file_path || params.path || 'temp.txt',
        content: params.content !== undefined ? params.content : ''
      }
    };
  }

  // 2. Read: {"file_path", "limit", "offset", "pages"}
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

  // 3. Edit: {"file_path", "old_string", "new_string", "replace_all"}
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

  // 4. Bash: {"command"}
  if (normAction === 'shell_exec' || normAction === 'bash') {
    return {
      name: 'Bash',
      arguments: {
        command: params.command || params.cmd || '',
        ...(params.description ? { description: params.description } : {})
      }
    };
  }

  // 5. AskUserQuestion (严格适配 CC 复杂 schema)
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
        header: params.header || '中介决策确认',
        multiSelect: Boolean(params.multiSelect),
        options: formattedOptions
      }];
    }
    return { name: 'AskUserQuestion', arguments: { questions } };
  }

  // 6. WebSearch: {"query"}
  if (normAction === 'net_search' || normAction === 'websearch') {
    return { name: 'WebSearch', arguments: { query: params.query || '' } };
  }

  // 7. WebFetch: {"url", "prompt"}
  if (normAction === 'net_fetch' || normAction === 'webfetch') {
    return { name: 'WebFetch', arguments: { url: params.url || '', prompt: params.prompt || '提取关键内容' } };
  }

  // 8. Agent: {"description", "prompt"}
  if (normAction === 'subflow_spawn' || normAction === 'agent') {
    return { name: 'Agent', arguments: { description: params.title || params.description || 'Sub-agent task', prompt: params.instructions || params.prompt || '' } };
  }

  // 9. TaskCreate / TaskUpdate
  if (normAction === 'task_entry' || normAction === 'taskcreate' || normAction === 'taskupdate') {
    if (params.action === 'update' || params.taskId) {
      return { name: 'TaskUpdate', arguments: { taskId: params.taskId || params.task_id, status: params.status || 'completed' } };
    }
    return { name: 'TaskCreate', arguments: { subject: params.title || params.subject || '任务', description: params.description || '' } };
  }

  // 10. NotebookEdit
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

  // 11. EnterWorktree
  if (normAction === 'git_worktree' || normAction === 'enterworktree') {
    return { name: 'EnterWorktree', arguments: { name: params.name || 'worktree', path: params.path || '' } };
  }

  // 12. ReportFindings
  if (normAction === 'code_audit' || normAction === 'reportfindings') {
    return { name: 'ReportFindings', arguments: { findings: params.findings || [], level: params.level || 'medium' } };
  }

  // 兜底 Bash
  return { name: 'Bash', arguments: params };
}

// ==========================================
// 4. 对话历史解析与智能压缩引擎（【202609111538修改】：彻底修复队列残留导致复读第一步的Bug）
// ==========================================
function cleanNoise(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/REMINDER:\s*You MUST include the sources[\s\S]*?hyperlinks\./gi, '')
    .replace(/Wasted call\s*—\s*file unchanged[\s\S]*?instead\./gi, '[SUCCESS] 文件未修改，状态已是最新。')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/<context>[\s\S]*?<\/context>/gi, '')
    .trim();
}

// 格式化输出本地执行反馈，防超长溢出并对 todo.md 提供内容保护
function formatLocalFeedback(str, actionName, isTodoFile = false) {
  if (!str) return '[SUCCESS] 操作已执行完成';
  let text = String(str).trim();

  // 若终端反馈已明确成功但缺少 [SUCCESS] 标记，予以补齐
  if (/successfully|created|updated|done|completed/i.test(text) && !text.startsWith('[')) {
    text = `[SUCCESS] ${text}`;
  }

  // 如果是 todo.md 相关操作，完整保留其读写反馈，确保状态链完整
  if (isTodoFile) {
    return text;
  }

  if (actionName === 'fs_read') {
    return text;
  } else if (actionName === 'shell_exec' || actionName === 'Bash') {
    const hasErr = /error|fail|exit code [1-9]|command not found/i.test(text);
    if (!hasErr && text.length > 1200) {
      return text.slice(0, 400) + `\n...[输出流水折叠 ${text.length - 800} 字符]...\n` + text.slice(-400);
    } else if (hasErr && text.length > 3500) {
      return text.slice(-3500);
    }
  } else if (actionName !== 'fs_write' && text.length > 2000) {
    return text.slice(0, 1000) + '\n...[略]...\n' + text.slice(-600);
  }
  return text;
}

/* 【202609111538修改点 1】：重构 compressHistorySteps。
   1. 解决陈旧思考导致模型迷失：从【执行配置】中剥离易导致逻辑死锁的长文 step_thought。
   2. 采用精准提炼的 step_action_summary，客观描述每一轮的具体意图（例：fs_read: todo.md / shell_exec: ls -la）。
*/
function compressHistorySteps(rawSteps) {
  const validSteps = (rawSteps || []).filter(s => s.action && s.action !== 'text_response');
  const trimmed = validSteps.slice(-6);
  if (trimmed.length === 0) {
    return '（当前为初始化阶段，尚无历史记录）';
  }

  const lastReadMap = new Map();
  trimmed.forEach((s, idx) => {
    if (s.action === 'fs_read' && s.params?.file_path) {
      lastReadMap.set(s.params.file_path, idx);
    }
  });

  return trimmed.map((step, idx) => {
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let params = { ...step.params };
    const isTodoFile = params.file_path === 'todo.md' || params.path === 'todo.md' || String(params.file_path || '').endsWith('/todo.md');

    // 1. fs_write 参数精简与 todo 保护
    if (step.action === 'fs_write') {
      if (isTodoFile) {
        params = {
          file_path: params.file_path || 'todo.md',
          content: step.params?.content || ''
        };
      } else {
        const len = step.params?.content ? String(step.params.content).length : 0;
        params = { file_path: step.params?.file_path || 'file' };
        if (len > 0) {
          params.content = `[源码/文档内容已写入，共 ${len} 字符]`;
        }
      }
    }

    // 2. fs_replace 参数精简
    if (step.action === 'fs_replace') {
      if (!isTodoFile) {
        if (params.old_string?.length > 80) {
          params.old_string = params.old_string.slice(0, 30) + '...[略]...' + params.old_string.slice(-20);
        }
        if (params.new_string?.length > 80) {
          params.new_string = params.new_string.slice(0, 30) + '...[略]...' + params.new_string.slice(-20);
        }
      }
    }

    // 3. fs_read 反馈处理（避免前序大文件重复占用上下文）
    if (step.action === 'fs_read') {
      const p = step.params?.file_path;
      if (lastReadMap.get(p) !== idx) {
        feedback = `[早期版本已读取，第 ${lastReadMap.get(p) + 1} 步有最新读取结果，此处折叠]`;
      } else {
        feedback = formatLocalFeedback(feedback, 'fs_read', isTodoFile);
      }
    } else {
      feedback = formatLocalFeedback(feedback, step.action, isTodoFile);
    }

    // 【202609111538修改点】：提取本步真实的意图摘要，不把陈旧思考放进 JSON
    const targetDesc = params.file_path || params.path || (params.command ? params.command.slice(0, 60) : '') || '';
    const stepSummary = step.step_thought && step.step_thought !== '执行当前流水线步骤...' 
      ? step.step_thought 
      : `调度 ${step.action} ${targetDesc ? '-> ' + targetDesc : ''}`.trim();

    return `--- Step ${idx + 1} ---
【执行配置】：
${JSON.stringify({
  action_summary: stepSummary,
  action: step.action,
  params: params
}, null, 2)}
【本地执行反馈】：
${feedback}`;
  }).join('\n\n');
}

/* 【202609111538修改点 2】：深度重构 parseConversation 状态机。
   彻底修复队列同步 Bug（原代码 pendingSteps 与 sequentialPending 脱节导致第 1 步对象死锁残留的问题）。
*/
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

  // 1. 提取全局初始目标
  for (const msg of messages) {
    if (msg.role === 'user') {
      let rawText = '';
      if (typeof msg.content === 'string') rawText = msg.content;
      else if (Array.isArray(msg.content)) {
        rawText = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      }
      const clean = cleanNoise(rawText);
      if (clean && !clean.startsWith('<tool_result') && !clean.includes("Today's date is") && !clean.startsWith('{')) {
        globalTask = clean;
        break;
      }
    }
  }
  if (!globalTask) globalTask = '推进当前目录的todo.md并完成项目构建。';

  // 2. 双向解析与严格有序闭环队列
  // 【202609111538修改点】：使用统一的 pendingStepsList 数组，杜绝 Map 与 Array 状态脱节
  let pendingStepsList = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // ======== 解析 Assistant 调度动作 ========
    if (msg.role === 'assistant') {
      let turnThought = '';

      // 【202609111538修改点】：适配 Claude Code 真实传回格式，不依赖死板的“【思考】：”正则
      if (typeof msg.content === 'string') {
        const clean = cleanNoise(msg.content);
        const tMatch = clean.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|<tool_call>|```|$)/i);
        if (tMatch) {
          turnThought = tMatch[1].trim();
        } else if (!clean.startsWith('{') && !clean.startsWith('<')) {
          // 如果是普通的自然语言思考，取首段核心摘要（80字以内），避免冗长
          turnThought = clean.split('\n')[0].slice(0, 80).trim();
        }
      } else if (Array.isArray(msg.content)) {
        // 合并所有类型为 text 的块作为思考
        const textParts = msg.content
          .filter(c => c.type === 'text' && c.text)
          .map(c => cleanNoise(c.text))
          .filter(t => t && !t.startsWith('{') && !t.startsWith('<'));
        
        if (textParts.length > 0) {
          const combined = textParts.join(' ');
          const tMatch = combined.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|<tool_call>|```|$)/i);
          turnThought = tMatch ? tMatch[1].trim() : combined.split('\n')[0].slice(0, 80).trim();
        }
      }

      // A. Anthropic 原生 tool_use 块
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_use') {
            const mappedAction = CC_TO_ACTION_MAP[p.name] || 'shell_exec';
            pendingStepsList.push({
              id: p.id || '',
              step_thought: turnThought || `调度 ${mappedAction} 执行操作`,
              action: mappedAction,
              params: p.input || {}
            });
          }
        }
      }

      // B. OpenAI tool_calls 兼容
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name || '';
          const mappedAction = CC_TO_ACTION_MAP[fnName] || 'shell_exec';
          let params = {};
          try {
            params = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
          } catch {
            params = {};
          }
          pendingStepsList.push({
            id: tc.id || '',
            step_thought: turnThought || `调度 ${mappedAction} 执行操作`,
            action: mappedAction,
            params
          });
        }
      }

      // C. 文本标签兼容
      if (typeof msg.content === 'string' && msg.content.includes('<tool_call>')) {
        const tcMatch = msg.content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
        if (tcMatch) {
          try {
            const parsed = JSON.parse(cleanLooseJson(tcMatch[1]));
            if (parsed.name) {
              const mappedAction = CC_TO_ACTION_MAP[parsed.name] || 'shell_exec';
              pendingStepsList.push({
                id: '',
                step_thought: turnThought || `调度 ${mappedAction} 执行操作`,
                action: mappedAction,
                params: parsed.arguments || {}
              });
            }
          } catch {}
        }
      }
    }

    // ======== 解析 User / Tool 执行反馈并闭环 ========
    else if (msg.role === 'user' || msg.role === 'tool') {
      // 内部辅助消费函数：【202609111538修改点】：通过单一入口消费，确保出队严格同步，彻底消灭残留复读
      const consumeMatchedStep = (matchId) => {
        if (pendingStepsList.length === 0) return null;
        if (matchId) {
          const foundIdx = pendingStepsList.findIndex(s => s.id === matchId);
          if (foundIdx !== -1) {
            const [item] = pendingStepsList.splice(foundIdx, 1);
            return item;
          }
        }
        // 若没有 ID 或按 ID 未查到，按顺序弹出队列头部
        return pendingStepsList.shift();
      };

      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_result') {
            const outText = typeof p.content === 'string' ? p.content : (p.content?.map(c => c.text).join('\n') || '');
            const matchedStep = consumeMatchedStep(p.tool_use_id);
            if (matchedStep) {
              rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
            }
          }
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        const outText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const matchedStep = consumeMatchedStep(msg.tool_call_id);
        if (matchedStep) {
          rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
        }
      } else if (typeof msg.content === 'string') {
        const text = cleanNoise(msg.content);
        if (text && !text.startsWith("Today's date is") && pendingStepsList.length > 0) {
          const matchedStep = consumeMatchedStep(null);
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
// 5. 强化版抗风控 Prompt (严格模板约束)
// ==========================================
function buildPrompt(globalTask, historyLogsText) {
  return `我们正在维护一个本地自动化工作流引擎。该引擎按流水线（Pipeline）逐步执行任务。每个步骤由你根据历史日志输出一个独立的任务指令块，由外部执行脚本读取并在本地操作系统中执行，执行完毕后会将终端标准输出作为日志反馈给你。

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
1. 拆解规范：当工作流初次启动（无历史记录）时，第一个步骤必须对任务进行极细致的拆解（具体到单文件、单页面或单步骤），输出一个 action 为 "fs_write" 的配置，将任务项全为 [ ] 的 todo.md 写入本地，并将具体情况规划方案等写入本地 readme.md。
2. 单步原则：每个回复只能输出当前唯一步骤的配置，不可合并多个步骤。
3. 终止条件：当且仅当所有待办项均已完成验收时，输出 action 为 "finish" 的收尾配置。
4. 格式严律：【思考】与【调度动作】必须严格按照模板给出，json 代码块中必须为合法 JSON（字符串内部换行必须转义为 \\n，不要打回车换行）。

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
【历史执行记录】：
${historyLogsText}
=======================================================
【当前调度决策】：
请综合【全局目标任务】与【历史执行记录】，评估当前阶段并输出下一步操作：
- 若尚未初始化，输出生成详尽 todo.md 的单一配置。
- 若已有规划正在推进中，结合最新执行反馈输出下一步应执行的单一配置。
- 若所有项已全部完成，输出 finish 配置。
请输出当前步骤的配置：`;
}

// ==========================================
// 6. 核心重构：多模态容错提取与原生工具协议装配
// ==========================================
function safeParseJson(str) {
  if (!str) return null;
  const clean = cleanLooseJson(str);
  try {
    return JSON.parse(clean);
  } catch (e) {
    try {
      // 容错修复：将长文本（如 content）内未转义的真换行符自动转为 \n，防止 JSON.parse 崩溃
      const fixed = clean.replace(/:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (_, p1) => {
        return ': "' + p1.replace(/\r?\n/g, '\\n') + '"';
      });
      return JSON.parse(fixed);
    } catch (e2) {
      return null;
    }
  }
}

function cleanLooseJson(str) {
  return str.replace(/,\s*([}\]])/g, '$1').replace(/\r\n/g, '\n').trim();
}

function scanBalancedJsonObject(text) {
  let depth = 0;
  let inStr = false;
  let quoteChar = '';
  let escape = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const slice = text.slice(start, i + 1);
        const obj = safeParseJson(slice);
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

  // 1. 提取【思考】内容
  const thoughtMatch = rawText.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|```json|```|<tool_call>|$)/i);
  if (thoughtMatch) {
    thought = thoughtMatch[1].trim();
  }

  // 2. 提取【调度动作】指令名称
  const actionMatch = rawText.match(/【调度动作】[：:]\s*([a-zA-Z0-9_]+)/i);
  if (actionMatch) {
    action = actionMatch[1].trim();
  }

  // 3. 提取代码块中的 JSON 参数
  const mdMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let parsedJson = null;
  if (mdMatch) {
    parsedJson = safeParseJson(mdMatch[1]);
  }
  if (!parsedJson) {
    parsedJson = scanBalancedJsonObject(rawText);
  }

  if (parsedJson && typeof parsedJson === 'object') {
    if (parsedJson.action) {
      action = parsedJson.action;
      thought = parsedJson.step_thought || parsedJson.thought || thought;
      params = parsedJson.params || parsedJson.arguments || parsedJson;
      if (params.action) {
        const { action: _a, step_thought: _st, thought: _t, ...rest } = params;
        params = rest;
      }
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

  if (!thought && !action && !Object.keys(params).length) {
    return null;
  }

  return {
    thought: thought || '执行当前流水线步骤...',
    action: action || 'finish',
    params: params || {}
  };
}

// ==========================================
// 7. 上游通信器 (SSE 流式长连接)
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
  } catch (e) {}

  // 2. 回退 chat/completions
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
  const tagOpen = '<' + 'think>';
  const tagClose = '<' + '/think>';

  for await (const chunk of readSSE(chatRes)) {
    if (!chunk || chunk === '[DONE]') continue;
    try {
      const payload = JSON.parse(chunk);
      const delta = payload.choices?.[0]?.delta;
      if (delta) {
        const think = delta.reasoning_content || delta.reasoning || '';
        if (think) {
          thinkingText += think;
          if (onThinkingChunk) onThinkingChunk(think);
        }

        if (delta.content) {
          let piece = delta.content;
          while (piece.length > 0) {
            if (!inThinkTag) {
              const start = piece.indexOf(tagOpen);
              if (start !== -1) {
                fullText += piece.slice(0, start);
                inThinkTag = true;
                piece = piece.slice(start + tagOpen.length);
              } else {
                fullText += piece;
                piece = '';
              }
            } else {
              const end = piece.indexOf(tagClose);
              if (end !== -1) {
                const tPiece = piece.slice(0, end);
                thinkingText += tPiece;
                if (onThinkingChunk) onThinkingChunk(tPiece);
                inThinkTag = false;
                piece = piece.slice(end + tagClose.length);
              } else {
                thinkingText += piece;
                if (onThinkingChunk) onThinkingChunk(piece);
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
// 8. 路由: /v1/models 与 /v1/messages/count_tokens
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

app.post(/(.*)\/v1\/messages\/count_tokens$/, (req, res) => {
  const bodyText = JSON.stringify(req.body || {});
  res.json({ input_tokens: Math.max(1, Math.ceil(bodyText.length / 4)) });
});

// ==========================================
// 9. 核心路由: POST */v1/messages (Claude Code 主通道)
// ==========================================
app.post(/(.*)\/v1\/messages$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = req.headers['x-api-key'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  const { model, messages, stream } = req.body;
  const { globalTask, historyLogsText, latestTurnInput } = parseConversation(messages || []);
  logger.debug('收到 Claude Code 调度请求', {
    '目标上游': upstreamBase,
    '模型': model,
    '本次增量输入': latestTurnInput || '（初始启动任务）'
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

    // 解析动作
    const parsedAction = extractActionAndThought(assistantText);
    let stopReason = 'end_turn';
    let textContent = '';
    let toolBlock = null;

    if (parsedAction && parsedAction.action && parsedAction.action !== 'finish') {
      const mappedTool = mapActionToClaudeCodeTool(parsedAction.action, parsedAction.params);
      stopReason = 'tool_use';
      textContent = parsedAction.thought || `调度 ${mappedTool.name}...`;
      toolBlock = {
        type: 'tool_use',
        id: 'toolu_' + crypto.randomBytes(10).toString('hex'),
        name: mappedTool.name,
        input: mappedTool.arguments
      };
      logger.debug('成功装配 CC 原生工具调用', {
        '耗时': `${Date.now() - startTime}ms`,
        '思考内容': textContent,
        '下发原生工具': mappedTool.name,
        '工具参数': mappedTool.arguments
      });
    } else {
      textContent = parsedAction?.params?.summary || parsedAction?.thought || assistantText;
      stopReason = 'end_turn';
    }

    if (stream) {
      // 1. 发送【思考】文本块 (index: 0 或 1)
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

      // 2. 发送【工具调用】原生结构块 (严格符合 Anthropic Messages 协议)
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

      // 3. 发送带 tool_use 状态的 message_delta (通知终端立即拦截执行工具)
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
    logger.error('Claude Code 消息通道异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

// ==========================================
// 10. OpenWebUI / OpenAI 兼容通道
// ==========================================
app.post(/(.*)\/v1\/chat\/completions$/, async (req, res) => {
  const startTime = Date.now();
  const { upstreamBase } = parseTargetUrl(req);
  const apiKey = (req.headers['authorization'] || '').replace('Bearer ', '') || req.headers['x-api-key'];
  const { model, messages, stream } = req.body;
  const { globalTask, historyLogsText, latestTurnInput } = parseConversation(messages || []);
  logger.debug('收到 OpenAI/ChatCompletions 调度请求', {
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

    const parsedAction = extractActionAndThought(assistantText);
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
      // 1. 发送思考正文
      if (textContent) {
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ delta: { content: textContent, reasoning_content: thinking }, index: 0 }]
        })}\n\n`);
      }
      // 2. 发送标准工具调用块
      if (toolCalls) {
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ delta: { tool_calls: toolCalls }, index: 0 }]
        })}\n\n`);
      }
      // 3. 结束流并指示 finish_reason 为 tool_calls
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
    logger.error('ChatCompletions 消息通道异常', err.message);
    if (!res.headersSent) res.status(500).json({ error: { message: err.message } });
    else res.end();
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` CC Web 智能中介（深度格式兼容修复版）已就绪 (端口: ${PORT})`);
  console.log(` 调试模式: ${IS_DEBUG ? '开启 (DEBUG=true)' : '关闭 (仅错误日志)'}`);
  console.log(`======================================================\n`);
});

server.requestTimeout = 2400000;
server.headersTimeout = 2400000;
server.keepAliveTimeout = 120000;
