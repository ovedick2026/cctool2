/* ==========================================================================
 *  adapt.js —— 【逻辑适配与语义压缩层】
 * ========================================================================== */

// ==========================================
// 1. 核心提示词模板（原样严格锁定，一个字未动）
// ==========================================
export function buildPipelinePrompt(globalTask, historyLogsText) {
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
1. 拆解规范：当工作流初次启动（无历史记录）时，先检查本地目录是否有 todo.md 和 readme.md 文件：
- 若都有，检查相关内容是否与任务一致，一致则继续推进todo.md，不一致就算没有；
- 只要有任何一个没有，第一个步骤必须对任务进行极细致的拆解（具体到单文件、单页面或单步骤），输出一个 action 为 "fs_write" 的配置，将任务项全为 [ ] 的 todo.md 写入本地，并将具体情况规划方案等写入本地 readme.md。
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
- 若不清楚任务情况，读取本地 readme.md 内容。
- 若尚未初始化，输出生成详尽 todo.md 的单一配置。
- 若已有规划正在推进中，结合最新执行反馈输出下一步应执行的单一配置。
- 若所有项已全部完成，输出 finish 配置。
请输出当前步骤的配置：`;
}

// ==========================================
// 2. Action 与 Claude Code 原生工具双向映射器
// ==========================================
export const CC_TO_ACTION_MAP = {
  Write: 'fs_write',
  Read: 'fs_read',
  Edit: 'fs_replace',
  Bash: 'shell_exec',
  AskUserQuestion: 'user_prompt',
  WebSearch: 'net_search',
  WebFetch: 'net_fetch',
  Agent: 'subflow_spawn',
  Workflow: 'subflow_spawn',
  TaskCreate: 'task_entry',
  TaskUpdate: 'task_entry',
  NotebookEdit: 'notebook_patch',
  EnterWorktree: 'git_worktree',
  ReportFindings: 'code_audit'
};

export function mapActionToClaudeCodeTool(actionName, rawParams = {}) {
  const normAction = String(actionName || '').trim().toLowerCase();
  const params = rawParams || {};

  // 1. fs_write: {"file_path", "content"}
  if (normAction === 'fs_write' || normAction === 'write') {
    return {
      name: 'Write',
      arguments: {
        file_path: params.file_path || params.path || 'temp.txt',
        content: params.content !== undefined ? params.content : ''
      }
    };
  }

  // 2. fs_read: {"file_path", "limit", "offset"}
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

  // 3. fs_replace: {"file_path", "old_string", "new_string", "replace_all"}
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

  // 4. shell_exec: {"command"}
  if (normAction === 'shell_exec' || normAction === 'bash') {
    return {
      name: 'Bash',
      arguments: {
        command: params.command || params.cmd || '',
        ...(params.description ? { description: params.description } : {})
      }
    };
  }

  // 5. user_prompt: {"question", "options"}
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

  // 6. net_search: {"query"}
  if (normAction === 'net_search' || normAction === 'websearch') {
    return { name: 'WebSearch', arguments: { query: params.query || '' } };
  }

  // 7. net_fetch: {"url", "prompt"}
  if (normAction === 'net_fetch' || normAction === 'webfetch') {
    return {
      name: 'WebFetch',
      arguments: { url: params.url || '', prompt: params.prompt || '提取关键内容' }
    };
  }

  // 8. subflow_spawn: {"title", "instructions"}
  if (normAction === 'subflow_spawn' || normAction === 'agent') {
    return {
      name: 'Agent',
      arguments: {
        description: params.title || params.description || 'Sub-agent task',
        prompt: params.instructions || params.prompt || ''
      }
    };
  }

  // 9. task_entry: {"action", "title", "status"}
  if (normAction === 'task_entry' || normAction === 'taskcreate' || normAction === 'taskupdate') {
    if (params.action === 'update' || params.taskId || params.task_id) {
      return {
        name: 'TaskUpdate',
        arguments: { taskId: params.taskId || params.task_id, status: params.status || 'completed' }
      };
    }
    return {
      name: 'TaskCreate',
      arguments: { subject: params.title || params.subject || '任务', description: params.description || '' }
    };
  }

  // 10. notebook_patch: {"notebook_path", "cell_id", "edit_mode", "new_source"}
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

  // 11. git_worktree: {"action", "path"}
  if (normAction === 'git_worktree' || normAction === 'enterworktree') {
    return {
      name: 'EnterWorktree',
      arguments: { name: params.name || 'worktree', path: params.path || '' }
    };
  }

  // 12. code_audit: {"findings", "level"}
  if (normAction === 'code_audit' || normAction === 'reportfindings') {
    return {
      name: 'ReportFindings',
      arguments: { findings: params.findings || [], level: params.level || 'medium' }
    };
  }

  // 兜底为 Bash
  return { name: 'Bash', arguments: params };
}

// ==========================================
// 3. 高级上下文语义压缩（老代码精髓融合版）
// ==========================================
const CORE_DOCS_REGEX = /(?:^|[/\s"'\`\\])(?:todo|readme)\.(?:md|markdown|txt)(?:[/\s"'\`\\]|$)/i;

export function sanitizeWhitespace(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanNoise(text) {
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

// 老代码精髓：语义错误提取截断
export function smartTruncateLog(text, limit, label = '终端日志') {
  if (text.length <= limit) return text;

  const headSize = Math.max(400, Math.floor(limit * 0.3));
  const tailSize = Math.max(500, Math.floor(limit * 0.4));

  const headPart = text.slice(0, headSize);
  const tailPart = text.slice(-tailSize);
  const middleContent = text.slice(headSize, -tailSize);

  const lines = middleContent.split('\n');
  const errorIndicators = [
    /error/i, /exception/i, /fail/i, /traceback/i, /syntaxerror/i,
    /exit code\s*[1-9]/i, /cannot access/i, /no such file/i
  ];
  const capturedLines = [];

  for (let i = 0; i < lines.length && capturedLines.length < 20; i++) {
    if (errorIndicators.some(reg => reg.test(lines[i]))) {
      capturedLines.push(lines[i].trim());
    }
  }

  const removed = text.length - headSize - tailSize;
  let summary = `\n...[${label}中间输出已折叠 ${removed} 字符`;
  if (capturedLines.length > 0) {
    summary += `，捕获异常信号：\n${capturedLines.slice(0, 8).join('\n')}\n...折叠结束]...\n`;
  } else {
    summary += `]...\n`;
  }

  return `${headPart}${summary}${tailPart}`;
}

export function formatLocalFeedback(str, actionName, stepParams = {}, isLatestStep = false, stepAge = 0) {
  if (!str) return '[SUCCESS] 操作已执行完成';
  let text = sanitizeWhitespace(String(str));

  if (/successfully|created|updated|done|completed/i.test(text) && !text.startsWith('[')) {
    text = `[SUCCESS] ${text}`;
  }

  const cmdStr = String(stepParams.command || stepParams.cmd || '');
  const pathStr = String(stepParams.file_path || stepParams.path || '');

  const isTargetDocFile = CORE_DOCS_REGEX.test(pathStr) || CORE_DOCS_REGEX.test(cmdStr);
  const hasChecklistMarks = /- \[[ xX]\]/m.test(text);
  const isDocContext = isTargetDocFile || hasChecklistMarks;

  // 核心清单文件给予充足配额，避免待办打勾被截断
  if (isDocContext) {
    if (text.length <= 12000) return text;
    return smartTruncateLog(text, 12000, '核心任务/规划文档');
  }

  // 梯度衰减窗口
  let budget = 2500;
  if (isLatestStep) {
    budget = 10000;
  } else if (stepAge <= 2) {
    budget = 5000;
  } else {
    budget = 2000;
  }

  if (text.length > budget) {
    return smartTruncateLog(text, budget, actionName === 'fs_read' ? '文件读取' : '执行结果');
  }

  return text;
}

export function compressHistorySteps(rawSteps, windowSize = 8) {
  const validSteps = (rawSteps || []).filter(s => s.action && s.action !== 'text_response');
  // 滑动窗口：只取最近 N 步，防止历史无限堆叠
  const trimmed = validSteps.slice(-windowSize);
  if (trimmed.length === 0) {
    return '（当前为初始化阶段，尚无历史记录）';
  }

  // 识别最后一次读取，避免重复读同文件占据大篇幅
  const lastReadMap = new Map();
  trimmed.forEach((s, idx) => {
    if (s.action === 'fs_read' && s.params?.file_path) {
      lastReadMap.set(String(s.params.file_path).toLowerCase(), idx);
    }
  });

  const total = trimmed.length;

  return trimmed.map((step, idx) => {
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let params = { ...step.params };
    const filePathStr = String(params.file_path || params.path || '');

    const isTodoFile = /(?:^|[/\\])todo\.(?:md|markdown|txt)$/i.test(filePathStr);
    const isReadmeFile = /(?:^|[/\\])readme\.(?:md|markdown|txt)$/i.test(filePathStr);

    const stepAge = total - 1 - idx;
    const isLatestStep = stepAge === 0;

    // 1. 老代码核心机制：非 todo 的大写入参数骨架化
    if (step.action === 'fs_write') {
      if (isTodoFile) {
        params = { file_path: params.file_path || 'todo.md', content: step.params?.content || '' };
      } else if (isReadmeFile) {
        const contentStr = String(step.params?.content || '');
        if (contentStr.length <= 3000) {
          params = { file_path: params.file_path || 'readme.md', content: contentStr };
        } else {
          params = { file_path: params.file_path || 'readme.md', content: `[规划与规范已写入，共 ${contentStr.length} 字符]` };
        }
      } else {
        const len = step.params?.content ? String(step.params.content).length : 0;
        params = { file_path: params.file_path || 'file' };
        if (len > 0) {
          params.content = `[源码/文档内容已写入，共 ${len} 字符]`;
        }
      }
    }

    // 2. fs_replace 参数收敛
    if (step.action === 'fs_replace' && !isTodoFile && !isReadmeFile) {
      if (params.old_string?.length > 80) {
        params.old_string = params.old_string.slice(0, 35) + '...[略]...' + params.old_string.slice(-25);
      }
      if (params.new_string?.length > 80) {
        params.new_string = params.new_string.slice(0, 35) + '...[略]...' + params.new_string.slice(-25);
      }
    }

    // 3. 重复读取折叠
    // if (step.action === 'fs_read') {
    //   const lowerPath = filePathStr.toLowerCase();
    //   if (lastReadMap.get(lowerPath) !== idx) {
    //     feedback = `[早期版本已读取，第 ${lastReadMap.get(lowerPath) + 1} 步有最新读取，此处折叠]`;
    //   } else {
    //     feedback = formatLocalFeedback(feedback, 'fs_read', params, isLatestStep, stepAge);
    //   }
    // } else {
    //   feedback = formatLocalFeedback(feedback, step.action, params, isLatestStep, stepAge);
    // }

    feedback = formatLocalFeedback(feedback, step.action, params, isLatestStep, stepAge);

    return `--- Step ${idx + 1} ---
【执行配置】：
${JSON.stringify({ action: step.action, params }, null, 2)}
【本地执行反馈】：
${feedback}`;
  }).join('\n\n');
}

// ==========================================
// 4. 会话状态机提取
// ==========================================
export function parseConversation(messages = []) {
  let globalTask = '';
  const rawSteps = [];

  // 1. 提取首个真实用户任务
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
  if (!globalTask) globalTask = '推进当前工作目录下的任务。';

  // 2. 工具调用与反馈配对
  const pendingSteps = new Map();
  const sequentialQueue = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_use') {
            const mappedAction = CC_TO_ACTION_MAP[p.name] || 'shell_exec';
            const stepObj = { id: p.id || '', action: mappedAction, params: p.input || {} };
            if (p.id) pendingSteps.set(p.id, stepObj);
            sequentialQueue.push(stepObj);
          }
        }
      }

      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name || '';
          const mappedAction = CC_TO_ACTION_MAP[fnName] || 'shell_exec';
          let params = {};
          try {
            params = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
          } catch { params = {}; }
          const stepObj = { id: tc.id || '', action: mappedAction, params };
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
        return sequentialQueue.shift() || null;
      };

      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_result') {
            const outText = typeof p.content === 'string' ? p.content : (p.content?.map(c => c.text).join('\n') || '');
            const matchedStep = matchAndPopStep(p.tool_use_id);
            if (matchedStep) rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
          }
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        const outText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const matchedStep = matchAndPopStep(msg.tool_call_id);
        if (matchedStep) rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
      } else if (typeof msg.content === 'string') {
        const text = cleanNoise(msg.content);
        if (text && !text.startsWith("Today's date is") && sequentialQueue.length > 0) {
          const matchedStep = matchAndPopStep(null);
          if (matchedStep) rawSteps.push({ ...matchedStep, feedback: text });
        }
      }
    }
  }

  const historyLogsText = compressHistorySteps(rawSteps);
  return { globalTask, historyLogsText };
}

// ==========================================
// 5. 模型输出容错提取器
// ==========================================
export function safeParseJson(str) {
  if (!str) return null;
  const clean = str.replace(/,\s*([}\]])/g, '$1').replace(/\r\n/g, '\n').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    try {
      // 容错：将字符串内未转义的换行替换为 \n，防止解析崩溃
      const fixed = clean.replace(/:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (_, p1) => {
        return ': "' + p1.replace(/\r?\n/g, '\\n') + '"';
      });
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}

export function scanBalancedJsonObject(text) {
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
        const obj = safeParseJson(text.slice(start, i + 1));
        if (obj) return obj;
        start = -1;
      }
    }
  }
  return null;
}

export function extractActionAndThought(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let thought = '';
  let action = '';
  let params = {};

  // 1. 提取【思考】
  const thoughtMatch = rawText.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|```json|```|<tool_call>|$)/i);
  if (thoughtMatch) thought = thoughtMatch[1].trim();

  // 2. 提取【调度动作】
  const actionMatch = rawText.match(/【调度动作】[：:]\s*([a-zA-Z0-9_]+)/i);
  if (actionMatch) action = actionMatch[1].trim();

  // 3. 提取代码块或平衡 JSON
  const mdMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  let parsedJson = mdMatch ? safeParseJson(mdMatch[1]) : null;
  if (!parsedJson) parsedJson = scanBalancedJsonObject(rawText);

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

  if (!thought && !action && !Object.keys(params).length) return null;

  return {
    thought: thought || '执行当前流水线步骤...',
    action: action || 'finish',
    params: params || {}
  };
}

export function isCompactionRequest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const lastMsg = messages[messages.length - 1];
  const content = typeof lastMsg.content === 'string'
    ? lastMsg.content
    : (Array.isArray(lastMsg.content) ? lastMsg.content.map(c => c.text || '').join(' ') : '');
  return /summary of the conversation so far|summarize the conversation|compact|create a detailed summary/i.test(content);
}
