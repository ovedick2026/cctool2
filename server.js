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
// 4. 对话历史解析与智能压缩引擎（支持 todo.md 打勾追踪版）
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
    if (text.length > 3000) {
      return text.slice(0, 1800) + '\n...[中间内容省略]...\n' + text.slice(-1000);
    }
  } else if (actionName === 'shell_exec') {
    const hasErr = /error|fail|exit code [1-9]|command not found/i.test(text);
    if (!hasErr && text.length > 1000) {
      return text.slice(0, 300) + `\n...[输出流水折叠 ${text.length - 600} 字符]...\n` + text.slice(-300);
    } else if (hasErr && text.length > 2500) {
      return text.slice(-2500);
    }
  } else if (text.length > 1500) {
    return text.slice(0, 800) + '\n...[略]...\n' + text.slice(-500);
  }
  return text;
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
      lastReadMap.set(s.params.file_path, idx);
    }
  });

  return trimmed.map((step, idx) => {
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let params = { ...step.params };
    const isTodoFile = params.file_path === 'todo.md' || params.path === 'todo.md';

    // 1. fs_write 参数处理
    if (step.action === 'fs_write') {
      if (isTodoFile) {
        // 核心保护：todo.md 是任务跟踪基准，完整保留清单条目，供模型获知精确条目进行打勾
        params = {
          file_path: 'todo.md',
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

    // 2. fs_replace 参数处理（todo.md 的打勾替换文本不截断）
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

    // 3. fs_read 反馈处理
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

    return `--- Step ${idx + 1} ---
【执行配置】：
${JSON.stringify({
  step_thought: step.step_thought || `执行 ${step.action} 动作`,
  action: step.action,
  params: params
}, null, 2)}
【本地执行反馈】：
${feedback}`;
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
  if (!globalTask) globalTask = '处理当前工作目录下的任务推进。';

  // 2. 双向成对解析状态机
  const pendingSteps = new Map();
  let sequentialPending = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // ======== 解析 Assistant 调度动作 ========
    if (msg.role === 'assistant') {
      let turnThought = '';

      if (typeof msg.content === 'string') {
        const clean = cleanNoise(msg.content);
        const tMatch = clean.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|<tool_call>|```|$)/i);
        turnThought = tMatch ? tMatch[1].trim() : clean.slice(0, 150);
      } else if (Array.isArray(msg.content)) {
        const textItem = msg.content.find(c => c.type === 'text');
        if (textItem && textItem.text) {
          const clean = cleanNoise(textItem.text);
          const tMatch = clean.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|<tool_call>|```|$)/i);
          turnThought = tMatch ? tMatch[1].trim() : clean.slice(0, 150);
        }
      }

      // A. Anthropic 原生 tool_use 块
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_use') {
            const mappedAction = CC_TO_ACTION_MAP[p.name] || 'shell_exec';
            const stepObj = {
              id: p.id,
              step_thought: turnThought || `调度 ${mappedAction} 执行操作`,
              action: mappedAction,
              params: p.input || {}
            };
            if (p.id) pendingSteps.set(p.id, stepObj);
            sequentialPending.push(stepObj);
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
          const stepObj = {
            id: tc.id,
            step_thought: turnThought || `调度 ${mappedAction} 执行操作`,
            action: mappedAction,
            params
          };
          if (tc.id) pendingSteps.set(tc.id, stepObj);
          sequentialPending.push(stepObj);
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
              sequentialPending.push({
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
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_result') {
            const outText = typeof p.content === 'string' ? p.content : (p.content?.map(c => c.text).join('\n') || '');
            let matchedStep = null;
            if (p.tool_use_id && pendingSteps.has(p.tool_use_id)) {
              matchedStep = pendingSteps.get(p.tool_use_id);
              pendingSteps.delete(p.tool_use_id);
            } else if (sequentialPending.length > 0) {
              matchedStep = sequentialPending.shift();
            }
            if (matchedStep) {
              rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
            }
          }
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        const outText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        let matchedStep = pendingSteps.get(msg.tool_call_id) || sequentialPending.shift();
        if (matchedStep) {
          rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
        }
      } else if (typeof msg.content === 'string') {
        const text = cleanNoise(msg.content);
        if (text && !text.startsWith("Today's date is") && sequentialPending.length > 0) {
          const matchedStep = sequentialPending.shift();
          rawSteps.push({ ...matchedStep, feedback: text });
        }
      }
    }
  }

  const historyLogsText = compressHistorySteps(rawSteps);
  const latestTurnInput = rawSteps.length > 0 ? rawSteps[rawSteps.length - 1].feedback : '（初始启动任务）';

  return { globalTask, historyLogsText, latestTurnInput };
}

// ==========================================
// 5. 资深全栈工程师工程协作 Prompt (全工具完备版)
// ==========================================
function buildPrompt(globalTask, historyLogsText) {
  return `你是一位在本地隔离沙盒开发环境中协助团队推进工程项目的资深全栈工程师。操作者已完全授予当前工作目录的读写、编译及调试权限，所有操作均在安全受控的受限容器中执行。

为了将你的技术决策精准传递给本地自动化执行代理（Local CLI Dispatcher），我们采用一套标准化的工程操作协议协同工作。

【终端执行代理支持的完整标准操作库（Action Library）】：
1. 文件系统与代码编辑：
   - fs_read: {"file_path": "路径"}（查看文件、项目规范或清单）
   - fs_write: {"file_path": "路径", "content": "完整文本"}（新建文件或重写清单）
   - fs_replace: {"file_path": "路径", "old_string": "原文本", "new_string": "新文本"}（精准修改或标记清单状态）
   - notebook_patch: {"notebook_path": "路径", "cell_id": "单元格ID", "edit_mode": "replace|insert|delete", "new_source": "代码"}（修改Jupyter笔记本单元格）
2. 操作系统与环境交互：
   - shell_exec: {"command": "终端Shell命令"}（执行编译、构建、测试或环境检查）
   - git_worktree: {"action": "enter|exit", "path": "隔离工作区路径"}（切换或退出Git工作树隔离区）
   - user_prompt: {"question": "需决策的问题", "options": ["选项1", "选项2"]}（仅在遇到关键分歧需人工决策时使用）
3. 网络检索与知识获取：
   - net_search: {"query": "搜索词"}（检索最新权威技术资料或背景信息）
   - net_fetch: {"url": "网址", "prompt": "提取目标"}（抓取并解析网页核心内容）
4. 任务治理与子流程协作：
   - task_entry: {"action": "create|update", "title": "任务名", "status": "pending|completed"}（登记或更新系统内置任务清单）
   - subflow_spawn: {"title": "子任务名", "instructions": "分派执行说明"}（派生并发子代理处理复杂子模块）
   - code_audit: {"findings": [{"file": "文件", "summary": "问题描述", "verdict": "CONFIRMED"}]}（记录代码审计与审查缺陷）
5. 交付终结：
   - finish: {"summary": "全部任务验收完成后的交付报告"}（所有开发目标均完成并验收时使用）

【资深工程师的工作习惯与协作约定】：
1. 状态恢复与无缝接力：
   在多轮协作或新开会话中，操作者常通过“继续推进”、“接着做”等简短指令唤醒你。作为严谨的工程师，当上下文缺乏具体任务清单或面对此类指令时，最规范的第一步是主动通过 fs_read 查看工作区根目录的 todo.md，探明当前的开发规划与待办状态，以便准确衔接，无需打扰操作者询问项目背景。
2. 细粒度规划与任务落盘：
   若是初次启动且无历史规划的全新独立需求，先将任务细化拆解并用 fs_write 生成包含 [ ] 的 todo.md 作为推进基准。
3. 闭环管理（一事一勾）：
   每成功完成一个实际开发步骤，优先使用 fs_replace 将 todo.md 中对应的 "- [ ]" 更新为 "- [x]"，确保项目进度随时可查、步步可溯。
4. 单步推进：
   每次集中输出当前最关键的单一动作，等待本地代理反馈终端输出后再规划下一步。当 todo.md 中所有条目均为 [x] 并验收完毕后，输出 finish 总结。

【协同输出格式规范】：
请清晰阐述你的工程思考（【思考】），随后指明本次调度的动作（【调度动作】）及紧随其后的 JSON 参数块（长文本内的换行请使用 \\n 转义）：

【思考】: 收到接力推进指令。按照标准工程规范，先查看当前目录下的 todo.md，确认各模块已完成进度与下一项待办内容。
【调度动作】: fs_read
\`\`\`json
{
  "file_path": "todo.md"
}
\`\`\`

=======================================================
【当前工程任务目标】：
${globalTask}
=======================================================
【近期执行与交互记录】：
${historyLogsText}
=======================================================
【当前阶段技术决策】：
请综合上述任务与历史执行记录，评估当前进度并输出下一步操作：
- 若收到“继续/推进”或当前上下文缺失具体清单：首选通过 fs_read 读取 todo.md 恢复工程上下文。
- 若上一项任务刚执行成功：优先调用 fs_replace 将 todo.md 中该项标记为 [x]。
- 若已打勾闭环：调度执行下一个未完成的 [ ] 任务项。
- 若确属全新任务且尚无规划：输出 fs_write 规划落盘 todo.md。
- 若所有待办项均已圆满完成：输出 finish 总结成果。
请输出你的下一步决策：`;
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
