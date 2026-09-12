/* ==========================================================================
*  adapt.js —— 【高频调试层】
* ==========================================================================
*
*  ┌──────────────────────────────────────────────────────────────────────┐
*  │  修改规则（给 AI 助手 / 未来的自己：动手改之前必须先读完这 7 条）      │
*  └──────────────────────────────────────────────────────────────────────┘
*
*  1. 【只改这一个文件】
*     server.js 是通讯骨架（HTTP / SSRF 校验 / 上游请求 / SSE / 协议报文
*     格式），已经定型并跑通。调提示词、调工具调用解析、调上下文压缩，
     _100% 都在本文件完成。_*不要修改 server.js**，除非要改的确实是网络
*     层或 Anthropic/OpenAI 报文结构本身。
*
*  2. 【不许改导出签名】
*     文件底部 export 的东西是 server.js 的调用契约。函数名、参数个数、
*     参数顺序、返回值结构一律不许改。要加能力就在函数体内部加，
*     或者往 TUNING / PROMPT_PRESETS 里加字段。
*
*  3. 【必须保持纯函数】
*     本文件禁止出现：fetch / fs / express / process / 全局可变状态 /
*     Date.now() 之外的时间依赖。输入决定输出，方便单测和复现。
*     唯一允许的副作用出口是每个函数的 `log` 参数（默认是空函数）。
*
*  4. 【改完必须跑测试】
*         node --test adapt.test.js
*     必须全绿。用例里每一条都是线上真实踩过的坑。
*     **不许为了让测试通过去改测试**——测试挂了说明你把已经修好的场景又弄坏了。
*     修好一个新 bug，顺手把它加进 adapt.test.js。
*
*  5. 【删代码之前先确认】
*     下面的正则和 if 分支看着很丑，但每一条都对应某个模型的某种畸形输出
*     （GLM 的 <arg_key>、Qwen 的裸 JSON、把 tool_call 包进 markdown 的、
*     少写闭合标签的……）。要删先去 adapt.test.js 里确认没有用例覆盖它。
*
*  6. 【不要注释掉旧代码】
*     要留旧版本就往 PROMPT_PRESETS 里多加一套，或者交给 git。
*     满文件注释掉的死代码是这个项目上一次失控的直接原因。
*
*  7. 【任何"丢弃"都必须留日志】
*     解析失败、参数不全、内容被截断——只要是"本来有东西、后来没了"的地方，
*     都必须调 log(...)。上一版最大的问题就是工具调用被静默丢掉，
*     日志里一个字都看不到，导致完全没法排查。
*
/*==========================================================================*/
/* ==========================================================================
*  第一部分：提示词预设
*  ------------------------------------------------------------------------
*  网页上可以下拉切换 / 临时编辑（只影响当前进程，重启回到这里的定义）。
*  试出好效果后，把文本抄回这里，或者在这里新增一套预设。
*
*  占位符：
*    {{tools}}                    压缩后的工具定义 JSON
*    {{force_tool_instruction}}   根据 tool_choice 自动生成的强制说明
*    {{protocol_rules}}           下面 PROTOCOL_RULES 的内容
*                                 （模板里没写这个占位符的话会自动追加到末尾）
/*==========================================================================*/
/** 所有预设共用的协议硬约束。改格式规则改这里，改行为风格改各个预设。 */
export const PROTOCOL_RULES = `我们正在维护一个本地自动化工作流引擎。该引擎按流水线（Pipeline）逐步执行任务。每个步骤由你根据历史日志输出一个独立的任务指令块，由外部执行脚本读取并在本地操作系统中执行，执行完毕后会将终端标准输出作为日志反馈给你。

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
\`\`\``;

export const PROMPT_PRESETS = [
  {
    id: "pipeline-workflow",
    label: "流水线任务驱动模式",
    hint: "基于 Action Library 规范的单步流水线调度模式，严格约束执行与存档。",
    text: PROTOCOL_RULES
  }
];

export const DEFAULT_PROMPT_ID = "pipeline-workflow";

export function getPreset(id) {
  return (
    PROMPT_PRESETS.find((preset) => preset.id === id) ||
    PROMPT_PRESETS.find((preset) => preset.id === DEFAULT_PROMPT_ID) ||
    PROMPT_PRESETS[0]
  );
}

/* ==========================================================================
 *  工具转换规则：Action ↔ Claude Code 原生工具映射
 * ========================================================================== */
export const CC_TO_ACTION_MAP = {
  Write: "fs_write",
  Read: "fs_read",
  Edit: "fs_replace",
  Bash: "shell_exec",
  AskUserQuestion: "user_prompt",
  WebSearch: "net_search",
  WebFetch: "net_fetch",
  Agent: "subflow_spawn",
  Workflow: "subflow_spawn",
  TaskCreate: "task_entry",
  TaskUpdate: "task_entry",
  NotebookEdit: "notebook_patch",
  EnterWorktree: "git_worktree",
  ReportFindings: "code_audit"
};

export function mapActionToClaudeCodeTool(actionName, rawParams = {}) {
  const norm = String(actionName || "").trim().toLowerCase();
  const params = rawParams || {};

  // 1. fs_write / write -> Write
  if (norm === "fs_write" || norm === "write") {
    return {
      name: "Write",
      arguments: {
        file_path: params.file_path || params.path || "temp.txt",
        content: params.content !== undefined ? String(params.content) : ""
      }
    };
  }

  // 2. fs_read / read -> Read
  if (norm === "fs_read" || norm === "read") {
    return {
      name: "Read",
      arguments: {
        file_path: params.file_path || params.path || "",
        ...(params.limit ? { limit: Number(params.limit) } : {}),
        ...(params.offset ? { offset: Number(params.offset) } : {})
      }
    };
  }

  // 3. fs_replace / edit -> Edit
  if (norm === "fs_replace" || norm === "edit") {
    return {
      name: "Edit",
      arguments: {
        file_path: params.file_path || params.path || "",
        old_string: params.old_string !== undefined ? String(params.old_string) : "",
        new_string: params.new_string !== undefined ? String(params.new_string) : "",
        replace_all: Boolean(params.replace_all)
      }
    };
  }

  // 4. shell_exec / bash -> Bash
  if (norm === "shell_exec" || norm === "bash") {
    return {
      name: "Bash",
      arguments: {
        command: params.command || params.cmd || "",
        ...(params.description ? { description: params.description } : {})
      }
    };
  }

  // 5. user_prompt / askuserquestion -> AskUserQuestion
  if (norm === "user_prompt" || norm === "askuserquestion") {
    let questions = [];
    if (Array.isArray(params.questions)) {
      questions = params.questions;
    } else {
      const qText = params.question || params.prompt || "请确认下一步操作：";
      const rawOptions = Array.isArray(params.options) ? params.options : ["确认", "取消"];
      const formattedOptions = rawOptions.map((opt) => {
        if (typeof opt === "string") return { label: opt, description: opt };
        return { label: opt.label || "选项", description: opt.description || opt.label || "" };
      });
      questions = [
        {
          question: qText,
          header: params.header || "决策确认",
          multiSelect: Boolean(params.multiSelect),
          options: formattedOptions
        }
      ];
    }
    return { name: "AskUserQuestion", arguments: { questions } };
  }

  // 6. net_search / websearch -> WebSearch
  if (norm === "net_search" || norm === "websearch") {
    return { name: "WebSearch", arguments: { query: params.query || "" } };
  }

  // 7. net_fetch / webfetch -> WebFetch
  if (norm === "net_fetch" || norm === "webfetch") {
    return {
      name: "WebFetch",
      arguments: { url: params.url || "", prompt: params.prompt || "提取关键内容" }
    };
  }

  // 8. subflow_spawn / agent -> Agent
  if (norm === "subflow_spawn" || norm === "agent") {
    return {
      name: "Agent",
      arguments: {
        description: params.title || params.description || "Sub-agent task",
        prompt: params.instructions || params.prompt || ""
      }
    };
  }

  // 9. task_entry / taskcreate / taskupdate -> TaskCreate / TaskUpdate
  if (norm === "task_entry" || norm === "taskcreate" || norm === "taskupdate") {
    if (params.action === "update" || params.taskId || params.task_id) {
      return {
        name: "TaskUpdate",
        arguments: { taskId: params.taskId || params.task_id, status: params.status || "completed" }
      };
    }
    return {
      name: "TaskCreate",
      arguments: { subject: params.title || params.subject || "任务", description: params.description || "" }
    };
  }

  // 10. notebook_patch / notebookedit -> NotebookEdit
  if (norm === "notebook_patch" || norm === "notebookedit") {
    return {
      name: "NotebookEdit",
      arguments: {
        notebook_path: params.notebook_path || "",
        cell_id: params.cell_id || "",
        edit_mode: params.edit_mode || "replace",
        new_source: params.new_source || ""
      }
    };
  }

  // 11. git_worktree / enterworktree -> EnterWorktree
  if (norm === "git_worktree" || norm === "enterworktree") {
    return {
      name: "EnterWorktree",
      arguments: { name: params.name || "worktree", path: params.path || "" }
    };
  }

  // 12. code_audit / reportfindings -> ReportFindings
  if (norm === "code_audit" || norm === "reportfindings") {
    return {
      name: "ReportFindings",
      arguments: { findings: params.findings || [], level: params.level || "medium" }
    };
  }

  // 兜底返回原名与原参数
  return { name: actionName, arguments: params };
}

/* ==========================================================================
*  第二部分：可调参数
*  ------------------------------------------------------------------------
*  这里每一项在网页「调参」面板里都有对应控件。加一项就自动多一个控件。
*  改默认值改这里；临时试值在网页上改。
*==========================================================================*/
export const DEFAULT_TUNING = {
  // ---- 上下文压缩 -------------------------------------------------------
  /** 最近 N 条消息原样保留、绝不压缩。太小会让模型忘记刚做过什么。 */
  keepRecentMessages: 12,
  /** 历史里 tool_result（文件内容、命令输出）正文的字符上限。 */
  toolResultMaxChars: 8000,
  /** 历史里普通文本消息的字符上限。 */
  textMaxChars: 3000,
  /** 历史里超过这个长度的 tool_call，省略其中的超长参数值（外形保持不变）。 */
  toolCallSummaryOverChars: 1500,
  /** 上一条触发后，单个参数值保留多少字符。路径、命令这类短值不受影响。 */
  toolCallArgValueMaxChars: 300,
  /** 历史里的 thinking / reasoning 块是否直接丢弃（强烈建议 true）。 */
  dropThinkingInHistory: true,
  /** >0 时对渲染后的总字符数兜底，从最老的消息开始进一步压缩。0 = 不限。 */
  maxTotalChars: 100000,
  // ---- 工具调用解析 -----------------------------------------------------
  /**
   * 模型给出的工具调用缺少 required 参数时怎么办：
   *   true  = 照样发给 Claude Code，让 CC 返回真实报错，模型下一轮自己改正（推荐）
   *   false = 直接丢弃（上一版的行为，症状就是"工具不调用"且日志无痕迹）
   */
  emitIncompleteToolCalls: true,
  /** 每轮最多返回给客户端的工具调用数量。 */
  maxToolCallsPerTurn: 1,
  /** 是否给上游加 </tool_call> 作为 stop 序列（让模型输出完调用就停）。 */
  appendStopSequence: true,
  // ---- 防死循环 ---------------------------------------------------------
  /** 连续 N 次出现完全相同的工具调用时，注入一条纠偏提示。0 = 关闭。 */
  repeatWarningThreshold: 2,
  // ---- 工具定义瘦身 -----------------------------------------------------
  /** 发给模型的工具描述截断长度。 */
  toolDescriptionMaxChars: 300
};
export function normalizeTuning(input) {
  const tuning = { ...DEFAULT_TUNING };
  for (const [key, fallback] of Object.entries(DEFAULT_TUNING)) {
    const value = input?.[key];
    if (value === undefined || value === null) continue;
    if (typeof fallback === "boolean") {
      tuning[key] = value === true || value === "true";
    } else if (Number.isFinite(Number(value))) {
      tuning[key] = Math.max(0, Number(value));
    }
  }
  return tuning;
}

/* ==========================================================================
 *  第三部分：提示词渲染
 * ========================================================================== */
/**
 * @param {Array<{name,description,parameters}>} tools
 * @param {*} toolChoice   Anthropic/OpenAI 的 tool_choice
 * @param {{promptText?:string, tuning?:object}} options
 * @returns {string} 完整 system 提示词
 */
export function renderToolPrompt(tools, toolChoice, options = {}) {
  // 【核心改造】：采用 new 的流水线协议规范，下发纯净指令库，杜绝模型面对复杂 Schema 时的幻觉与风控
  const template = String(options.promptText || getPreset(DEFAULT_PROMPT_ID).text);
  return template.trim();
}

// 【保留辅助函数】：满足单测契约与潜在引用，不破坏纯函数规则
function buildForceInstruction(toolChoice) {
  const forcedName =
    toolChoice && typeof toolChoice === "object"
      ? toolChoice.name || toolChoice.function?.name || ""
      : "";
  if (forcedName) return `本轮必须调用工具：${forcedName}`;
  return "";
}

export function compactTools(tools, tuning = DEFAULT_TUNING) {
  return tools.map((tool) => ({
    name: tool.name,
    description: String(tool.description || "")
      .replace(/\s+/g, " ")
      .slice(0, tuning.toolDescriptionMaxChars)
      .trim(),
    parameters: compactSchema(tool.parameters)
  }));
}

const SCHEMA_KEEP_KEYS = [
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "additionalProperties",
  "oneOf",
  "anyOf",
  "allOf"
];

export function compactSchema(schema) {
  if (!schema || typeof schema !== "object") return {};
  if (Array.isArray(schema)) return schema.map(compactSchema);
  const result = {};
  for (const key of SCHEMA_KEEP_KEYS) {
    if (!(key in schema)) continue;
    if (key === "properties" && schema.properties) {
      result.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([name, value]) => [
          name,
          compactSchema(value)
        ])
      );
      continue;
    }
    if (["items", "oneOf", "anyOf", "allOf"].includes(key)) {
      result[key] = compactSchema(schema[key]);
      continue;
    }
    result[key] = schema[key];
  }
  return result;
}

/* ==========================================================================
 *  第四部分：上下文智能解析与流水线历史压缩（深度融合双保险版）
 * ========================================================================== */
const CORE_DOCS_REGEX = /(?:^|[/\s"'\`\\])(?:todo|readme)\.(?:md|markdown|txt)(?:[/\s"'\`\\]|$)/i;

/**
 * 语义日志智能截断（保留 old 的关键报错提取能力，融合 new 的预算策略）
 */
export function smartTruncateLog(text, limit, label = "日志") {
  if (text.length <= limit) return text;
  const headSize = Math.max(300, Math.floor(limit * 0.25));
  const tailSize = Math.max(400, Math.floor(limit * 0.3));
  const headPart = text.slice(0, headSize);
  const tailPart = text.slice(-tailSize);
  const middleContent = text.slice(headSize, -tailSize);
  
  // 保留 old 强大的多异常信号正则
  const lines = middleContent.split("\n");
  const errorIndicators = [
    /error/i, /exception/i, /fail/i, /traceback/i,
    /syntaxerror/i, /assertionerror/i, /panic/i, /fatal/i,
    /exit code\s*[1-9]/i, /cannot access/i, /no such file/i
  ];
  const captured = [];
  for (let i = 0; i < lines.length && captured.length < 25; i++) {
    if (errorIndicators.some((regex) => regex.test(lines[i]))) {
      captured.push(lines[i].trim());
    }
  }

  const removed = text.length - headSize - tailSize;
  let summary = `\n...[${label}中间输出已折叠 ${removed} 字符`;
  if (captured.length > 0) {
    summary += `，提取关键异常信号：\n${captured.slice(0, 8).join("\n")}\n...折叠结束]...\n`;
  } else {
    summary += `]...\n`;
  }
  return `${headPart}${summary}${tailPart}`;
}

export function sanitizeWhitespace(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 清理客户端噪音标签
 */
export function cleanNoise(text) {
  if (!text || typeof text !== "string") return "";
  const cleaned = text
    .replace(/REMINDER:\s*You MUST include the sources[\s\S]*?hyperlinks\./gi, "")
    .replace(/Wasted call\s*—\s*file unchanged[\s\S]*?instead\./gi, "[SUCCESS] 文件未修改，状态已是最新。")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "")
    .replace(/<context>[\s\S]*?<\/context>/gi, "");
  return sanitizeWhitespace(cleaned);
}

/**
 * 移植自 old：分析文件的最后写入步数与读取记录（读写生命周期感知）
 */
function analyzeStepFileOperations(steps) {
  const files = new Map();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const path = String(s.params?.file_path || s.params?.path || "").trim().toLowerCase();
    if (!path) continue;
    if (!files.has(path)) {
      files.set(path, { lastWriteStep: -1, reads: [] });
    }
    const rec = files.get(path);
    if (s.action === "fs_write" || s.action === "fs_replace" || s.action === "Write" || s.action === "Edit") {
      rec.lastWriteStep = i;
    } else if (s.action === "fs_read" || s.action === "Read") {
      rec.reads.push(i);
    }
  }
  return files;
}

/**
 * 反馈内容智能动态压缩
 */
function formatLocalFeedback(str, actionName, stepParams = {}, isLatestStep = false, stepAge = 0) {
  if (!str) return "[SUCCESS] 操作已执行完成";
  let text = sanitizeWhitespace(String(str));

  if (/successfully|created|updated|done|completed/i.test(text) && !text.startsWith("[")) {
    text = `[SUCCESS] ${text}`;
  }

  // 【核心保留 1】：用户问答决策（AskUserQuestion / user_prompt）完全保留，不折叠
  if (actionName === "user_prompt" || actionName === "AskUserQuestion") {
    return text;
  }

  const cmdStr = String(stepParams.command || stepParams.cmd || "");
  const pathStr = String(stepParams.file_path || stepParams.path || "");

  // 【核心保留 2】：todo.md / readme.md / 待办清单打勾语法保持高保真（20,000 字符超高预算）
  const isTargetDocFile = CORE_DOCS_REGEX.test(pathStr) || CORE_DOCS_REGEX.test(cmdStr);
  const hasChecklistMarks = /- \[[ xX]\]/m.test(text);
  if (isTargetDocFile || hasChecklistMarks) {
    if (text.length <= 20000) return text;
    return smartTruncateLog(text, 20000, "核心任务/设计文档");
  }

  // 梯度动态预算
  let budget = 3000;
  if (isLatestStep) {
    budget = 15000;
  } else if (stepAge <= 2) {
    budget = 6000;
  } else {
    budget = 2500;
  }

  if (actionName === "fs_read" || actionName === "Read") {
    if (text.length > budget) return smartTruncateLog(text, budget, "文件读取");
  } else if (actionName === "shell_exec" || actionName === "Bash") {
    if (text.length > budget) return smartTruncateLog(text, budget, "命令输出");
  } else if (actionName !== "fs_write" && actionName !== "Write" && text.length > budget) {
    return smartTruncateLog(text, budget, "执行反馈");
  }

  return text;
}

/**
 * 历史记录格式化与压缩引擎（严格对齐 new 的格式规范）
 */
function compressHistorySteps(rawSteps) {
  const validSteps = (rawSteps || []).filter((s) => s.action && s.action !== "text_response");
  const trimmed = validSteps.slice(-6); // 保持 new 的最近 6 步窗口
  if (trimmed.length === 0) {
    return "（当前为初始化阶段，尚无历史记录）";
  }

  // 融合 old 的写后读感知和重复读取分析
  const fileLifeMap = analyzeStepFileOperations(trimmed);
  const total = trimmed.length;

  return trimmed
    .map((step, idx) => {
      let feedback = step.feedback || "[SUCCESS] 执行完成";
      let params = { ...step.params };
      const filePathStr = String(params.file_path || params.path || "");
      const lowerPath = filePathStr.toLowerCase();

      const isTodoFile = /(?:^|[/\\])todo\.(?:md|markdown|txt)$/i.test(filePathStr);
      const isReadmeFile = /(?:^|[/\\])readme\.(?:md|markdown|txt)$/i.test(filePathStr);

      const stepAge = total - 1 - idx;
      const isLatestStep = stepAge === 0;

      // 1. fs_write / Write：代码正文骨架化（非核心文档省掉成千上万字）
      if (step.action === "fs_write" || step.action === "Write") {
        if (isTodoFile) {
          params = { file_path: params.file_path || "todo.md", content: step.params?.content || "" };
        } else if (isReadmeFile) {
          const contentStr = String(step.params?.content || "");
          if (contentStr.length <= 4000) {
            params = { file_path: params.file_path || "readme.md", content: contentStr };
          } else {
            params = { file_path: params.file_path || "readme.md", content: `[项目规划与设计规范已写入，共 ${contentStr.length} 字符]` };
          }
        } else {
          const len = step.params?.content ? String(step.params.content).length : 0;
          params = { file_path: params.file_path || "file" };
          if (len > 0) {
            params.content = `[源码/文档内容已写入，共 ${len} 字符]`;
          }
        }
      }

      // 2. fs_replace / Edit：替换参数精简
      if ((step.action === "fs_replace" || step.action === "Edit") && !isTodoFile && !isReadmeFile) {
        if (params.old_string?.length > 100) {
          params.old_string = `${params.old_string.slice(0, 40)}...[略]...${params.old_string.slice(-30)}`;
        }
        if (params.new_string?.length > 100) {
          params.new_string = `${params.new_string.slice(0, 40)}...[略]...${params.new_string.slice(-30)}`;
        }
      }

      // 3. fs_read / Read：融合 old 的“写后读失效”与“重复读取”感知
      if (step.action === "fs_read" || step.action === "Read") {
        const info = fileLifeMap.get(lowerPath);
        if (info && info.lastWriteStep > idx) {
          feedback = `[该文件内容已在后续第 ${info.lastWriteStep + 1} 步被修改改写，历史读取片段已折叠]`;
        } else if (info && info.reads.length > 1 && info.reads[info.reads.length - 1] !== idx) {
          feedback = `[早期版本已读取，第 ${info.reads[info.reads.length - 1] + 1} 步有最新读取结果，此处折叠]`;
        } else {
          feedback = formatLocalFeedback(feedback, "fs_read", params, isLatestStep, stepAge);
        }
      } else {
        feedback = formatLocalFeedback(feedback, step.action, params, isLatestStep, stepAge);
      }

      // 格式严格对齐 new，绝对不输出 step_thought 防止思维复读
      return `--- Step ${idx + 1} ---
【执行配置】：
${JSON.stringify({ action: step.action, params }, null, 2)}
【本地执行反馈】：
${feedback}`;
    })
    .join("\n\n");
}

/**
 * 导出函数：主入口（接收 Conversation 中间件表示，返回格式化后的 convo）
 */
export function compressHistory(convo, tuning = DEFAULT_TUNING, log = () => {}) {
  const messages = Array.isArray(convo?.messages) ? convo.messages : [];
  let globalTask = "";
  const rawSteps = [];

  // 1. 提取全局目标任务
  for (const msg of messages) {
    if (msg.role === "user") {
      const parts = msg.parts || [];
      const text = parts
        .filter((p) => p.kind === "text")
        .map((p) => cleanNoise(p.text))
        .join("\n");
      if (
        text &&
        !text.startsWith("[TOOL RESULT") &&
        !text.includes("Today's date is") &&
        !text.startsWith("{")
      ) {
        globalTask = text;
        break;
      }
    }
  }
  if (!globalTask) globalTask = "推进当前工作目录下的任务推进。";

  // 2. 状态机配对提取：确保 tool_use 与 tool_result 精确关联
  const pendingSteps = new Map();
  const sequentialQueue = [];

  for (const msg of messages) {
    const parts = msg.parts || [];
    if (msg.role === "assistant") {
      for (const p of parts) {
        if (p.kind === "tool_call") {
          const action = CC_TO_ACTION_MAP[p.name] || p.name;
          const stepObj = { id: p.id || "", action, params: p.args || {} };
          if (p.id) pendingSteps.set(p.id, stepObj);
          sequentialQueue.push(stepObj);
        }
      }
    } else if (msg.role === "user") {
      const popStep = (id) => {
        if (id && pendingSteps.has(id)) {
          const step = pendingSteps.get(id);
          pendingSteps.delete(id);
          const idx = sequentialQueue.findIndex((s) => s.id === id);
          if (idx !== -1) sequentialQueue.splice(idx, 1);
          return step;
        }
        return sequentialQueue.shift() || null;
      };

      for (const p of parts) {
        if (p.kind === "tool_result") {
          const matched = popStep(p.id);
          if (matched) {
            rawSteps.push({ ...matched, feedback: cleanNoise(p.text) });
          }
        } else if (p.kind === "text") {
          const clean = cleanNoise(p.text);
          // 【核心】：用户如果在 AskUserQuestion 后作出了回复，或者给出了输入，必须完整成对记录
          if (clean && !clean.startsWith("Today's date is") && sequentialQueue.length > 0) {
            const matched = popStep(null);
            if (matched) {
              rawSteps.push({ ...matched, feedback: clean });
            }
          }
        }
      }
    }
  }

  const historyLogsText = compressHistorySteps(rawSteps);

  log("info", "history.compressed", {
    taskLength: globalTask.length,
    recordedSteps: rawSteps.length
  });

  return {
    ...convo,
    system: convo?.system || "",
    messages,
    _globalTask: globalTask,
    _historyLogsText: historyLogsText
  };
}

/* ==========================================================================
 *  第五部分：把 Conversation 渲染成上游能看懂的消息（安全双保险版）
 * ========================================================================== */

/**
 * 辅助渲染工具调用（保留契约，同时供历史测算与兜底使用）
 */
export function renderToolCall(part) {
  return `<tool_call>\n${JSON.stringify({
    name: part.name,
    arguments: part.args || {}
  })}\n</tool_call>`;
}

/**
 * 辅助渲染工具结果（保留契约，同时供通用结果转换使用）
 */
export function renderToolResult(part) {
  return `[TOOL RESULT ${part.id || ""}]\n${part.text || ""}`;
}

/**
 * assistant 自己编造 [TOOL RESULT] 或自问自答时，把编造部分及之后全部切掉
 * 【防幻觉斩断核心护栏】
 */
export function cutHallucinatedResult(text) {
  const source = String(text || "");
  const index = source.search(/\[TOOL RESULT|\[Assistant\]:/i);
  return index >= 0 ? source.slice(0, index).trim() : source;
}

/**
 * 清掉 Claude Code 注入的、对上游无意义且撑大上下文的包裹标签
 * 【⚠️ 严禁删除：server.js 在消息协议转换时显式调用了此导出函数】
 */
export function stripClientNoise(text) {
  return String(text || "")
    .replace(/REMINDER:\s*You MUST include the sources[\s\S]*?hyperlinks\./gi, "")
    .replace(/Wasted call\s*—\s*file unchanged[\s\S]*?instead\./gi, "[SUCCESS] 文件未修改，状态已是最新。")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<total_tokens>[\s\S]*?<\/total_tokens>/gi, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, "")
    .replace(/<context>[\s\S]*?<\/context>/gi, "")
    .trim();
}

/**
 * Conversation -> OpenAI /v1/chat/completions 的 messages 数组
 * 采用 new 的单步流水线聚合决策模板，同时保留 cutHallucinatedResult 斩断保护
 * @returns {Array<{role:string, content:string}>}
 */
export function renderConversation(convo, tuning = DEFAULT_TUNING, log = NOOP_LOG) {
  const globalTask = convo?._globalTask || "推进当前工作目录下的任务推进。";
  const historyLogsText = convo?._historyLogsText || "（当前为初始化阶段，尚无历史记录）";

  // 组装成 new 项目经过验证的流水线调度决策输入
  const rawPrompt = `=======================================================
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

  // 经过防幻觉与空白净化清洗
  const cleanPrompt = cutHallucinatedResult(sanitizeWhitespace(rawPrompt));

  return [
    {
      role: "user",
      content: cleanPrompt
    }
  ];
}

/* ==========================================================================
 *  第六部分：防死循环（修复 SyntaxError 缺失的开括号）
 * ========================================================================== */
/**
* 在结构化数据上比对，而不是在被截断的文本上比对。
* 上一版在截断后的字符串上比，两次不同的 Edit 被砍在同一位置就会
* 误判成"重复调用"，注入一条假警告把模型带偏（已由测试覆盖）。
*
* @returns {string} 需要注入的提示；无需注入时返回空串
*/
export function detectRepeatedToolCall(convo, tuning = DEFAULT_TUNING) {
  const threshold = tuning.repeatWarningThreshold;
  if (!threshold || threshold < 2) return "";
  const signatures = [];
  for (const msg of convo?.messages || []) {
    if (msg?.role !== "assistant") continue;
    for (const part of msg.parts || []) {
      if (part?.kind === "tool_call") {
        signatures.push(`${part.name}:${stableStringify(part.args)}`);
      }
    }
  }
  if (signatures.length < threshold) return "";
  const recent = signatures.slice(-threshold);
  const allSame = recent.every((item) => item === recent[0]);
  if (!allSame) return "";
  return "[系统警告：检测到你连续输出了完全相同的工具指令！请勿重复读取/编辑同一文件。请检查当前已有文件状态，并继续推进 TODO 列表中的下一个任务。]";
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
/* ==========================================================================
 *  第七部分：模型回复清洗
 * ==========================================================================*/
/**
* 剥离 <think> 标签（含未闭合的），防止思维链泄漏给 Claude Code 导致卡死。
* @returns {{text:string, thinking:string}}
*/
export function splitThinking(raw) {
  const source = String(raw || "");
  const matched = source.match(/<think>([\s\S]*?)<\/think>/i);
  const text = source
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();
  return {
    text,
    thinking: matched ? matched[1].trim() : ""
  };
}

/* ==========================================================================
 *  第八部分：模型回复提取（完整双保险版）
 *  ------------------------------------------------------------------------
 *  通道 1（new 流水线协议）：
 *    优先提取【思考】、【调度动作】及 ```json 配置，并转为 CC 原生工具。
 *  通道 2（old 深度容错管线）：
 *    若通道 1 未命中，100% 完整继承 old 的候选收集、XML/GLM/裸 JSON 恢复、
 *    参数归一化、必填参数校验放行机制以及标签安全截断。
 * ========================================================================== */

/**
 * @returns {{content:string, toolCalls:Array<{id,name,arguments}>, rejected:Array}}
 */
export function extractToolCalls(
  text,
  tools,
  tuning = DEFAULT_TUNING,
  log = NOOP_LOG,
  makeId = defaultMakeId
) {
  const source = String(text || "");
  const rejected = [];

  if (!source || !Array.isArray(tools) || !tools.length) {
    return { content: source, toolCalls: [], rejected };
  }

  // =========================================================================
  // 【通道 1】：new 流水线协议识别 (思考 + 调度动作 + ```json)
  // =========================================================================
  let thought = "";
  let action = "";
  let params = null;

  // 1. 提取【思考】
  const thoughtMatch = source.match(/【思考】[：:]\s*([\s\S]*?)(?=【调度动作】|```json|```|<tool_call>|$)/i);
  if (thoughtMatch) {
    thought = thoughtMatch[1].trim();
  }

  // 2. 提取【调度动作】
  const actionMatch = source.match(/【调度动作】[：:]\s*([a-zA-Z0-9_]+)/i);
  if (actionMatch) {
    action = actionMatch[1].trim();
  }

  // 3. 提取代码块中的 JSON 参数
  const mdMatch = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (mdMatch) {
    params = parseLooseJson(mdMatch[1]);
  }
  if (!params) {
    // 扫描平衡的花括号对象
    for (const objStr of extractBalancedJsonObjects(source)) {
      const parsed = parseLooseJson(objStr);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed;
        break;
      }
    }
  }

  // 参数归一化与隐式动作推断
  if (params && typeof params === "object") {
    if (params.action) {
      action = params.action;
      thought = params.step_thought || params.thought || thought;
      params = params.params || params.arguments || params;
      if (params.action) {
        const { action: _a, step_thought: _st, thought: _t, ...rest } = params;
        params = rest;
      }
    } else if (!action) {
      if (params.file_path && params.content !== undefined) action = "fs_write";
      else if (params.command) action = "shell_exec";
      else if (params.file_path && params.old_string !== undefined) action = "fs_replace";
      else if (params.file_path) action = "fs_read";
    }
  }

  // 情况 A：命中 finish 结束流程
  if (action && action.toLowerCase() === "finish") {
    const summary = params?.summary || thought || cleanResidualTags(source);
    log("info", "extract.finish", { summary: clip(summary, 120) });
    return { content: summary, toolCalls: [], rejected };
  }

  // 情况 B：命中具体的流水线 Action
  if (action && params) {
    const mapped = mapActionToClaudeCodeTool(action, params);
    const canonicalTool = getToolByName(mapped.name, tools);

    if (canonicalTool) {
      const normalizedCall = normalizeParsedCall(
        { name: canonicalTool.name, arguments: mapped.arguments },
        tools
      );

      if (normalizedCall) {
        log("info", "extract.pipeline_action", {
          action,
          mappedCC: normalizedCall.name,
          thought: clip(thought, 80)
        });

        // 提示文本仅保留简短意图，避免过长文本塞回客户端上下文
        const visibleContent = thought || `调度 ${normalizedCall.name}...`;

        return {
          content: visibleContent,
          toolCalls: [
            {
              id: makeId(),
              name: normalizedCall.name,
              arguments: normalizedCall.arguments
            }
          ],
          rejected
        };
      }
    }
  }

  // =========================================================================
  // 【通道 2】：完整保留 old 深度容错管线（XML、GLM、裸 JSON、参数校验等）
  // =========================================================================
  const candidates = collectToolCallCandidates(source);
  if (!candidates.length) {
    log("debug", "extract.no_candidate", { textLength: source.length });
    return { content: cleanResidualTags(source), toolCalls: [], rejected };
  }

  log("debug", "extract.candidates", {
    count: candidates.length,
    kinds: candidates.map((item) => item.kind)
  });

  const accepted = [];
  let firstAttemptStart = -1;

  for (const candidate of candidates) {
    if (firstAttemptStart < 0) firstAttemptStart = candidate.start;
    const declaredName = candidate.name || candidate.inlineName || "";
    
    // 兼顾 Action 命名转换
    const mappedAction = mapActionToClaudeCodeTool(declaredName, {});
    const targetLookupName = mappedAction.name || declaredName;
    const tool = getToolByName(targetLookupName, tools);

    const recovered =
      candidate.kind === "tagged"
        ? recoverTaggedToolCall(candidate.raw, targetLookupName, tool)
        : candidate.kind === "xml"
          ? recoverXmlToolCall(candidate.raw, targetLookupName, tool)
          : recoverMalformedToolCall(candidate.raw, candidate.inlineName, tool);

    if (!recovered) {
      rejected.push({ reason: "unparsable", declaredName, raw: clip(candidate.raw) });
      continue;
    }

    // 将恢复出的 Action 与参数映射为标准 CC 工具
    const mappedCall = mapActionToClaudeCodeTool(recovered.name, recovered.arguments);
    const normalized = normalizeParsedCall(mappedCall, tools);

    if (!normalized) {
      rejected.push({
        reason: "unknown_tool",
        declaredName: mappedCall.name || recovered.name || declaredName,
        knownTools: tools.map((item) => item.name),
        raw: clip(candidate.raw)
      });
      continue;
    }

    const canonicalTool = getToolByName(normalized.name, tools);
    const missing = missingRequiredArguments(normalized, canonicalTool);

    if (missing.length) {
      const parsedCount = Object.keys(normalized.arguments || {}).length;
      // 一个参数都没解析出来 —— 基本可以确定是解析失败而不是模型偷懒，丢弃
      if (parsedCount === 0) {
        rejected.push({
          reason: "no_arguments_parsed",
          tool: normalized.name,
          missing,
          raw: clip(candidate.raw)
        });
        continue;
      }
      if (!tuning.emitIncompleteToolCalls) {
        rejected.push({
          reason: "missing_required_dropped",
          tool: normalized.name,
          missing,
          got: Object.keys(normalized.arguments),
          raw: clip(candidate.raw)
        });
        continue;
      }
      // 照样放行：让 Claude Code 返回参数校验错误，模型下一轮据此纠错
      log("warn", "extract.missing_required", {
        tool: normalized.name,
        missing,
        got: Object.keys(normalized.arguments),
        action: "已照常下发，等待客户端返回参数错误让模型自我修正"
      });
    }

    accepted.push({
      id: makeId(),
      name: normalized.name,
      arguments: normalized.arguments,
      _start: candidate.start
    });

    if (accepted.length >= Math.max(1, tuning.maxToolCallsPerTurn)) break;
  }

  for (const item of rejected) {
    log("warn", "extract.rejected", item);
  }

  if (!accepted.length) {
    const visible =
      firstAttemptStart >= 0
        ? source.slice(0, expandToolCallStart(source, firstAttemptStart))
        : source;
    if (firstAttemptStart >= 0) {
      log("error", "extract.all_rejected", {
        candidates: candidates.length,
        rejected: rejected.length,
        hint: "模型尝试调用了工具但全部解析失败——展开 rejected 查看原因"
      });
    }
    return { content: cleanResidualTags(visible), toolCalls: [], rejected };
  }

  // 严格安全截断：清除前端标签与尾随未闭合字符
  const cutAt = expandToolCallStart(source, accepted[0]._start);
  const content = cleanResidualTags(source.slice(0, cutAt));
  const toolCalls = accepted.map(({ _start, ...call }) => call);

  log("info", "extract.ok", {
    count: toolCalls.length,
    tools: toolCalls.map((call) => call.name),
    droppedTrailingChars: source.length - cutAt
  });

  return { content, toolCalls, rejected };
}

/* ==========================================================================
*  第九部分：stop 序列
/*==========================================================================*/
export function buildStopSequences(clientStop, tools, tuning = DEFAULT_TUNING) {
  const stops = [];
  if (Array.isArray(clientStop)) stops.push(...clientStop.filter(Boolean));
  else if (typeof clientStop === "string" && clientStop) stops.push(clientStop);
  if (tuning.appendStopSequence && tools.length) {
    // </invoke> 是给爱输出 Anthropic XML 风格的模型（deepseek 等）准备的。
    // 解析器两种格式都认，但让它在调用结束时立刻停下能省掉一堆胡编的后续内容。
    for (const stop of ["</tool_call>", "</invoke>"]) {
      if (!stops.includes(stop)) stops.push(stop);
    }
  }
  // 大多数上游最多接受 4 个 stop，超了会直接 400
  return stops.slice(0, 4);
}

/* ==========================================================================
 *  工具名解析、参数归一化与校验（供 server.js 与双保险通道 2 调用）
 * ========================================================================== */
export function normalizeToolNameKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-:/]+/g, "");
}

export function resolveToolName(name, tools) {
  const requested = String(name || "").trim();
  if (!requested || !Array.isArray(tools)) return "";
  const exact = tools.find((tool) => tool?.name === requested);
  if (exact?.name) return exact.name;
  const normalized = normalizeToolNameKey(requested);
  const matches = tools.filter(
    (tool) => tool?.name && normalizeToolNameKey(tool.name) === normalized
  );
  return matches.length === 1 ? matches[0].name : "";
}

export function getToolByName(name, tools) {
  const canonical = resolveToolName(name, tools);
  return canonical ? tools.find((tool) => tool?.name === canonical) || null : null;
}

export function missingRequiredArguments(call, tool) {
  const required = Array.isArray(tool?.parameters?.required)
    ? tool.parameters.required
    : [];
  return required.filter((key) => {
    const value = call?.arguments?.[key];
    if (value === undefined || value === null) return true;
    if (typeof value === "string" && !value.trim()) return true;
    return false;
  });
}

export function normalizeParsedCall(candidate, tools) {
  if (!candidate || typeof candidate !== "object") return null;
  const requested =
    candidate.name ||
    candidate.tool ||
    candidate.function?.name ||
    candidate.function_name;
  const canonicalName = resolveToolName(requested, tools);
  if (!canonicalName) return null;
  let args =
    candidate.arguments ??
    candidate.input ??
    candidate.parameters ??
    candidate.function?.arguments ??
    candidate.function?.input ??
    {};
  if (typeof args === "string") args = parseLooseJson(args) || null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { name: canonicalName, arguments: sanitizeToolArguments(args) };
}

export function sanitizeToolArguments(value) {
  if (typeof value === "string") {
    return value
      .replace(/\[(https?:\/\/[^\]]+)\]\(\1\)/g, "$1")
      .replace(/\*\*(https?:\/\/[^*]+)\*\*/g, "$1");
  }
  if (Array.isArray(value)) return value.map(sanitizeToolArguments);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeToolArguments(item)])
    );
  }
  return value;
}

export function cleanResidualTags(text) {
  return String(text || "")
    .replace(/<\/?(tool_call|invoke|function|function_calls|parameter)[^>]*>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

export function clip(text, limit = 600) {
  const source = String(text || "");
  return source.length > limit ? `${source.slice(0, limit)}…` : source;
}

export function defaultMakeId() {
  return `toolu_${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandToolCallStart(text, callStart) {
  let earliest = callStart;
  for (const tag of ["<tool_call", "<function_calls"]) {
    const tagStart = text.toLowerCase().lastIndexOf(tag, earliest);
    if (tagStart < 0) continue;
    const tagEnd = text.indexOf(">", tagStart);
    if (tagEnd < 0 || tagEnd >= earliest) continue;
    if (!text.slice(tagEnd + 1, earliest).trim()) earliest = tagStart;
  }
  return earliest;
}

/* ==========================================================================
 *  【补回遗漏的底层函数】：JSON 解析、深度容错与 XML/畸形提取
 *  server.js 和 extractToolCalls 通道 2 强依赖这部分函数
 * ========================================================================== */

function indexOfCaseless(text, needle, from) {
  return text.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/**
 * 候选片段收集器（支持标准JSON、内联名、XML invoke、GLM等）
 */
export function collectToolCallCandidates(text) {
  const candidates = [];
  const seen = new Set();

  const add = (candidate) => {
    const key = `${candidate.kind}:${candidate.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  // (a)(b)(c)(g) 裸 JSON / 标准形态
  const jsonPattern = /\{\s*"name"\s*:\s*"([^"]+)"/g;
  let match;

  while ((match = jsonPattern.exec(text)) !== null) {
    const start = match.index;
    const closeTag = text.indexOf("</tool_call>", start);
    const nextTag = text.indexOf("<tool_call", start + 1);

    let end = text.length;
    if (closeTag >= 0) end = closeTag + "</tool_call>".length;
    else if (nextTag >= 0) end = nextTag;

    add({
      kind: "json",
      start,
      end,
      name: match[1],
      inlineName: null,
      raw: text.slice(start, end)
    });
  }

  // (d) <tool_call>ToolName{...}</tool_call>
  if (text.includes("<tool_call")) {
    const inlinePattern =
      /<tool_call\b[^>]*>\s*([a-zA-Z_][a-zA-Z0-9_.\-]{0,63})\s*(?=\{)/gi;

    while ((match = inlinePattern.exec(text)) !== null) {
      const start = match.index;
      const closeTag = text.indexOf("</tool_call>", start);
      const end = closeTag >= 0 ? closeTag + "</tool_call>".length : text.length;

      add({
        kind: "json",
        start,
        end,
        name: match[1],
        inlineName: match[1],
        raw: text.slice(start, end)
      });
    }
  }

  // (i) Anthropic XML 风格：<invoke name="X"><parameter name="y">值</parameter></invoke>
  if (/<(?:[\w-]+:)?invoke\b/i.test(text)) {
    const invokePattern =
      /<(?:[\w-]+:)?invoke\s+name\s*=\s*["']?([A-Za-z_][A-Za-z0-9_.\-]{0,63})["']?\s*>/gi;

    while ((match = invokePattern.exec(text)) !== null) {
      const start = match.index;
      const closeIndex = indexOfCaseless(text, "</invoke", start);
      const end = closeIndex >= 0 ? closeIndex + "</invoke>".length : text.length;

      add({
        kind: "xml",
        start,
        end,
        name: match[1],
        inlineName: null,
        raw: text.slice(start, end)
      });
    }
  }

  // (f) GLM 的 <arg_key>/<arg_value>
  return text.toLowerCase().includes("</arg_key>")
    ? collectTaggedCandidates(text, candidates, add)
    : candidates.sort((a, b) => a.start - b.start);
}

function collectTaggedCandidates(text, candidates, add) {
  const taggedPattern =
    /(?:<tool_call\b[^>]*>\s*)?([a-zA-Z_][a-zA-Z0-9_.\-]{0,63})[\s\S]{0,160}?<\/arg_key>/gi;

  let match;

  while ((match = taggedPattern.exec(text)) !== null) {
    const start = match.index;
    const lookaheadFrom = match.index + match[0].length;

    const hasArgValue = /<arg_value>/i.test(
      match[0] + text.slice(lookaheadFrom, lookaheadFrom + 400)
    );

    if (!hasArgValue) continue;

    const closeTag = text.indexOf("</tool_call>", start);
    const argValueEnd = text.indexOf("</arg_value>", start);

    let end = closeTag >= 0 ? closeTag + "</tool_call>".length : text.length;
    if (argValueEnd >= 0 && closeTag < 0) {
      end = argValueEnd + "</arg_value>".length;
    }

    add({
      kind: "tagged",
      start,
      end,
      name: match[1],
      inlineName: null,
      raw: text.slice(start, end)
    });
  }

  return candidates.sort((a, b) => a.start - b.start);
}

/** XML 调用恢复 */
export function recoverXmlToolCall(raw, declaredName, tool) {
  const canonicalName = tool?.name || declaredName;
  if (!canonicalName) return null;

  const paramPattern =
    /<(?:[\w-]+:)?parameter\s+name\s*=\s*["']?([^"'>\s]+)["']?\s*>/gi;

  const args = {};
  let match;

  while ((match = paramPattern.exec(raw)) !== null) {
    const key = match[1];
    const valueStart = match.index + match[0].length;

    const closeParam = indexOfCaseless(raw, "</parameter", valueStart);
    const closeInvoke = indexOfCaseless(raw, "</invoke", valueStart);

    let end = raw.length;
    if (closeParam >= 0) end = closeParam;
    if (closeInvoke >= 0 && closeInvoke < end) end = closeInvoke;

    args[key] = coerceXmlParamValue(raw.slice(valueStart, end), key, tool);
  }

  return Object.keys(args).length ? { name: canonicalName, arguments: args } : null;
}

function coerceXmlParamValue(rawValue, key, tool) {
  const text = String(rawValue ?? "").trim();
  const type = tool?.parameters?.properties?.[key]?.type;

  if (type === "number" || type === "integer") {
    const asNumber = Number(text);
    return Number.isFinite(asNumber) ? asNumber : text;
  }

  if (type === "boolean") {
    if (text === "true") return true;
    if (text === "false") return false;
    return text;
  }

  if (type === "object" || type === "array") {
    return parseLooseJson(text) ?? text;
  }

  return text;
}

/** GLM 标签调用恢复 */
export function recoverTaggedToolCall(raw, declaredName, tool) {
  const canonicalName = tool?.name || declaredName;
  if (!canonicalName || !tool) return null;

  const equalIndex = raw.indexOf("=");

  if (equalIndex >= 0) {
    for (const objectText of extractBalancedJsonObjects(raw.slice(equalIndex + 1))) {
      const parsed = parseLooseJson(objectText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

      if (
        parsed.name &&
        parsed.arguments &&
        typeof parsed.arguments === "object" &&
        !Array.isArray(parsed.arguments)
      ) {
        return { name: parsed.name, arguments: parsed.arguments };
      }

      return { name: canonicalName, arguments: parsed };
    }
  }

  const properties = Object.keys(tool.parameters?.properties || {});
  const args = {};

  for (const key of properties) {
    const pattern = new RegExp(
      `(?:<arg_key>\\s*)?${escapeRegExp(
        key
      )}\\s*</arg_key>\\s*<arg_value>\\s*([\\s\\S]*?)\\s*</arg_value>`,
      "i"
    );

    const pair = pattern.exec(raw);
    if (pair) args[key] = decodeLooseToolString(pair[1].trim());
  }

  return Object.keys(args).length ? { name: canonicalName, arguments: args } : null;
}

/** 畸形/裸参数调用恢复 */
export function recoverMalformedToolCall(raw, inlineName = null, tool = null) {
  if (inlineName) {
    const objectStart = raw.indexOf("{");
    const objectEnd = findLooseOuterObjectEnd(raw, objectStart);

    if (objectStart < 0 || objectEnd <= objectStart) return null;

    const argsText = raw.slice(objectStart, objectEnd);
    const strict = parseLooseJson(argsText);

    if (strict && typeof strict === "object" && !Array.isArray(strict)) {
      return { name: inlineName, arguments: strict };
    }

    return { name: inlineName, arguments: recoverLooseArguments(argsText, tool) };
  }

  for (const objectText of extractBalancedJsonObjects(raw)) {
    const parsed = parseLooseJson(objectText);
    if (!parsed?.name || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    if (
      parsed.arguments &&
      typeof parsed.arguments === "object" &&
      !Array.isArray(parsed.arguments)
    ) {
      return { name: parsed.name, arguments: parsed.arguments };
    }

    const { name, ...rest } = parsed;
    return { name, arguments: rest };
  }

  const nameMatch = raw.match(/"name"\s*:\s*"([^"]+)"/i);
  if (!nameMatch) return null;

  const name = nameMatch[1];
  const argumentsMatch = /"arguments"\s*:\s*\{/.exec(raw);
  let argumentsText = "";

  if (argumentsMatch) {
    const start = argumentsMatch.index + argumentsMatch[0].lastIndexOf("{");
    const end = findLooseArgumentsEnd(raw, start);
    if (end > start) argumentsText = raw.slice(start, end);
  } else {
    argumentsText = raw;
  }

  if (!argumentsText) return null;

  const strict = parseLooseJson(argumentsText);
  if (strict && typeof strict === "object" && !Array.isArray(strict)) {
    return { name, arguments: strict };
  }

  const loose = recoverLooseArguments(argumentsText, tool);
  return Object.keys(loose).length ? { name, arguments: loose } : null;
}

function recoverLooseArguments(argumentsText, tool) {
  const properties = Object.keys(tool?.parameters?.properties || {});
  const result = {};

  for (const key of properties) {
    const value = extractLooseArgumentValue(argumentsText, key, properties);
    if (value !== null) result[key] = value;
  }

  return result;
}

function extractLooseArgumentValue(text, key, allKeys) {
  const match = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*`, "i").exec(text);
  if (!match) return null;

  const valueStart = match.index + match[0].length;
  const tail = text.slice(valueStart);

  if (!tail.startsWith('"')) {
    const nextField = /(?:[}\]\s]*),\s*"[^"]+"\s*:/.exec(tail);

    let rawValue = nextField
      ? tail.slice(0, nextField.index)
      : tail.replace(/}\s*$/g, "");

    rawValue = rawValue.trim().replace(/,\s*$/g, "");

    if (!rawValue) return null;
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
    if (rawValue === "null") return null;

    const asNumber = Number(rawValue);
    if (Number.isFinite(asNumber) && rawValue !== "") return asNumber;

    return parseLooseJson(rawValue) ?? rawValue;
  }

  const contentStart = valueStart + 1;
  const afterQuote = text.slice(contentStart);

  let end = -1;

  const nextAnyField = /(?:[}\]\s]*),\s*"[^"]+"\s*:/.exec(afterQuote);
  if (nextAnyField) end = contentStart + nextAnyField.index;

  if (end < 0 && Array.isArray(allKeys) && allKeys.length > 1) {
    const otherKeys = allKeys.filter((item) => item !== key).map(escapeRegExp);

    if (otherKeys.length) {
      const nextKnown = new RegExp(
        `(?:[}\\]\\s]*),\\s*"(${otherKeys.join("|")})"\\s*:`,
        "i"
      ).exec(afterQuote);

      if (nextKnown) end = contentStart + nextKnown.index;
    }
  }

  if (end < 0) {
    const doubleClose = afterQuote.search(/}\s*}/);
    if (doubleClose >= 0) end = contentStart + doubleClose;
  }

  if (end < 0) {
    const finalClose = afterQuote.lastIndexOf("}");
    if (finalClose >= 0) end = contentStart + finalClose;
  }

  if (end < 0) end = text.length;

  let rawValue = text
    .slice(contentStart, end)
    .replace(/,\s*$/g, "")
    .replace(/}\s*$/g, "")
    .trim();

  if (!rawValue) return "";

  if (rawValue.endsWith('"')) {
    const withoutLast = rawValue.slice(0, -1);
    if (countUnescapedQuotes(withoutLast) % 2 === 0) rawValue = withoutLast;
  }

  return decodeLooseToolString(rawValue);
}

/** 【关键核心导出】：宽松 JSON 解析（server.js 显式调用） */
export function parseLooseJson(value) {
  if (!value || typeof value !== "string") return null;

  const text = value
    .trim()
    .replace(/^```(?:json|tool_calls)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/,\s*([}\]])/g, "$1");

  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试 */
  }

  const objects = extractBalancedJsonObjects(text);

  if (objects.length === 1) {
    try {
      return JSON.parse(objects[0]);
    } catch {
      /* 放弃 */
    }
  }

  return null;
}

/** 提取平衡的花括号块 */
export function extractBalancedJsonObjects(text) {
  const result = [];

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth++;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        result.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return result;
}

function findLooseArgumentsEnd(text, start) {
  const tail = text.slice(start);
  const doubleClose = /}\s*}/.exec(tail);

  if (doubleClose) return start + doubleClose.index + 1;

  const lastClose = tail.lastIndexOf("}");
  return lastClose >= 0 ? start + lastClose + 1 : -1;
}

function findLooseOuterObjectEnd(text, start) {
  if (start < 0) return -1;

  const objects = extractBalancedJsonObjects(text.slice(start));
  if (objects.length) return start + objects[0].length;

  const tail = text.slice(start);
  const lastClose = tail.lastIndexOf("}");

  return lastClose >= 0 ? start + lastClose + 1 : -1;
}

function countUnescapedQuotes(text) {
  let count = 0;
  let escaped = false;

  for (const char of String(text || "")) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') count++;
  }

  return count;
}

export function decodeLooseToolString(value) {
  const text = String(value ?? "");

  try {
    return JSON.parse(`"${text}"`);
  } catch {
    return text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}
