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
 *     100% 都在本文件完成。**不要修改 server.js**，除非要改的确实是网络
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
 * ========================================================================== */

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
 * ========================================================================== */

/** 所有预设共用的协议硬约束。改格式规则改这里，改行为风格改各个预设。 */

export const PROTOCOL_RULES = ``;

export const PROMPT_PRESETS = [
  {
    id: "todo-single-step",
    label: "流水线调度模式",
    hint: "按流水线逐步调度：输出【思考】+【调度动作】指令块，由外部脚本执行后回传日志",
    text: `我们正在维护一个本地自动化工作流引擎。该引擎按流水线（Pipeline）逐步执行任务。每个步骤由你根据历史日志输出一个独立的任务指令块，由外部执行脚本读取并在本地操作系统中执行，执行完毕后会将终端标准输出作为日志反馈给你。

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
\${globalTask}
=======================================================
【历史执行记录】：
\${historyLogsText}
=======================================================
【当前调度决策】：
请综合【全局目标任务】与【历史执行记录】，评估当前阶段并输出下一步操作：
- 若不清楚任务情况，读取本地 readme.md 内容。
- 若尚未初始化，输出生成详尽 todo.md 的单一配置。
- 若已有规划正在推进中，结合最新执行反馈输出下一步应执行的单一配置。
- 若所有项已全部完成，输出 finish 配置。
请输出当前步骤的配置：`
  }
];

export const DEFAULT_PROMPT_ID = "todo-single-step";

export function getPreset(id) {
  return (
    PROMPT_PRESETS.find((preset) => preset.id === id) ||
    PROMPT_PRESETS.find((preset) => preset.id === DEFAULT_PROMPT_ID) ||
    PROMPT_PRESETS[0]
  );
}

/* ==========================================================================
 *  第二部分：可调参数
 *  ------------------------------------------------------------------------
 *  这里每一项在网页「调参」面板里都有对应控件。加一项就自动多一个控件。
 *  改默认值改这里；临时试值在网页上改。
 * ========================================================================== */

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
 * @returns {string} 完整 system 提示词（无工具时返回空串）
 */
export function renderToolPrompt(tools, toolChoice, options = {}) {
  if (!tools.length) return "";

  const tuning = options.tuning || DEFAULT_TUNING;
  const template = String(options.promptText || getPreset(DEFAULT_PROMPT_ID).text);

  const rendered = template
    .replaceAll("{{tools}}", JSON.stringify(compactTools(tools, tuning)))
    .replaceAll("{{force_tool_instruction}}", buildForceInstruction(toolChoice));

  return rendered.includes("{{protocol_rules}}")
    ? rendered.replaceAll("{{protocol_rules}}", PROTOCOL_RULES)
    : `${rendered}\n\n${PROTOCOL_RULES}`;
}

function buildForceInstruction(toolChoice) {
  const forcedName =
    toolChoice && typeof toolChoice === "object"
      ? toolChoice.name || toolChoice.function?.name || ""
      : "";

  if (forcedName) {
    return `本轮必须调用工具：${forcedName}`;
  }

  if (
    toolChoice === "required" ||
    toolChoice?.type === "any" ||
    toolChoice?.type === "required"
  ) {
    return "本轮必须调用至少一个工具。";
  }

  return "【通用强约束】：只要 TODO.md 中还有未完成项，本轮必须且只能输出一个 <tool_call>。严禁输出任何自然语言对话或假装完成的通知！";
}

/** 把工具定义瘦身后再塞进提示词，避免 schema 把上下文撑爆。 */
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
 *  第四部分：上下文压缩（结构化与语义感知）
 *  ------------------------------------------------------------------------
 *  输入输出都是 Conversation 中间表示，由 server.js 的协议层构造：
 *
 *    Conversation = { system: string, messages: Msg[] }
 *    Msg  = { role: "user" | "assistant", parts: Part[] }
 *    Part = { kind:"text",        text }
 *         | { kind:"thinking",    text }
 *         | { kind:"tool_call",   id, name, args }
 *         | { kind:"tool_result", id, name, text }
 *         | { kind:"image" }
 *
 *  【本层核心原则】：
 *  1. 物理滑动窗口：保留首条锚点任务与最近 N 轮成对交互，深层老历史彻底丢弃。
 *  2. 边界合法性保护：杜绝孤儿 tool_result 与角色连续冲突，始终成对。
 *  3. 绝不在 JSON 中间下刀，保持 <tool_call> 结构完好，避免模型破损模仿。
 *  4. 排版安全规整：统一 \r\n，安全折叠多余连续空行，不破坏转义符。
 *  5. 命令日志语义萃取：确保保留命令、Exit Code、Traceback、关键报错行。
 *  6. 读写感知与分段保护：同一文件的不同分段读取（offset/range）互补保留，
 *     只有文件后续被写入改写，或完全相同的片段重复读取时才判定为陈旧。
 *  7. 梯度衰减：最新工作区全保真，越往历史越进行骨架化。
 * ========================================================================== */

const NOOP_LOG = () => {};

/**
 * 物理裁剪过早的历史轮次，仅保留初始锚点和最近 N 轮交互，
 * 确保消息角色交替合法、工具调用与结果成对，彻底解决上下文单调上涨问题。
 */
function pruneDeepHistory(messages, tuning, log) {
  if (!Array.isArray(messages) || messages.length <= 2) {
    return messages;
  }

  // 1 轮 = 1 次交互 (一问一答算 1 次，即 2 条消息)，按参数配置计算保留条数
  const keepTurns = Math.max(1, tuning.keepRecentMessages || 12);
  const targetRecentCount = keepTurns * 2;

  // 未超过保留窗口 + 初始锚点时，不做物理剔除
  if (messages.length <= targetRecentCount + 1) {
    return messages;
  }

  // 计算初始切分点
  let cutIndex = messages.length - targetRecentCount;

  // 边界保护 1：避免孤儿 tool_result
  // 若 cutIndex 处包含 tool_result，说明前置 tool_call 在前面，向前回退成对包含
  while (cutIndex > 1) {
    const parts = messages[cutIndex]?.parts || [];
    const hasToolResult = parts.some((p) => p?.kind === "tool_result");
    if (!hasToolResult) break;
    cutIndex--;
  }

  // 边界保护 2：协议角色严格交替
  // 确保裁切后的第一条是 assistant（或其他与锚点交替的角色），防止连续两个 user 导致 API 报错
  const anchorRole = messages[0]?.role || "user";
  if (cutIndex > 1 && messages[cutIndex]?.role === anchorRole) {
    cutIndex--;
  }

  if (cutIndex <= 1) {
    return messages;
  }

  const droppedCount = cutIndex - 1;
  const droppedTurns = Math.max(1, Math.round(droppedCount / 2));

  // 将折叠说明合并到 messages[0] 末尾，既保证提示直达，又绝不产生连续同 role 消息
  const anchor = messages[0];
  const foldNotice = {
    kind: "text",
    text: `\n\n[系统提示：更早的 ${droppedTurns} 轮工具排查历史已折叠，请结合当前文件状态与 TODO.md 进度直接继续执行]`
  };

  const modifiedAnchor = {
    ...anchor,
    parts: [...(anchor.parts || []), foldNotice]
  };

  const keptMessages = [modifiedAnchor, ...messages.slice(cutIndex)];

  log("info", "history.pruned", {
    originalCount: messages.length,
    prunedCount: droppedCount,
    prunedTurns: droppedTurns,
    retainedCount: keptMessages.length
  });

  return keptMessages;
}

/**
 * @param {Conversation} convo
 * @param {object} tuning
 * @param {(level:string, message:string, data?:object)=>void} log
 * @returns {Conversation}
 */
export function compressHistory(convo, tuning = DEFAULT_TUNING, log = NOOP_LOG) {
  const rawMessages = Array.isArray(convo?.messages) ? convo.messages : [];
  const charsBeforeRaw = rawMessages.reduce(
    (sum, m) => sum + measureParts(m?.parts),
    0
  );

  // 0. 先执行物理滑动窗口：保留首条锚点与最近 N 轮对话
  const messages = pruneDeepHistory(rawMessages, tuning, log);
  const total = messages.length;

  const stats = {
    total,
    prunedMessages: rawMessages.length - total,
    keptIntact: 0,
    droppedThinking: 0,
    summarizedToolCalls: 0,
    truncatedToolResults: 0,
    truncatedTexts: 0,
    supersededReads: 0,
    collapsedOldMessages: 0,
    charsBefore: charsBeforeRaw,
    charsAfter: 0
  };

  // 1. 全局读写状态预扫描：识别每个文件的最后修改轮次，以及分段读取签名
  const fileStateMap = analyzeFileOperations(messages);

  // 梯度窗口划分：
  // Tier 1 (最近 3 条): 绝对高保真工作区（正在进行的单步交互）
  // Tier 2 (4 ~ 10 条): 近期上下文（适度精简，保护未失效文件读取）
  // Tier 3 (10 条之前): 历史背景区（骨架化写操作，仅留报错与状态）
  const tier1Start = Math.max(0, total - 3);
  const tier2Start = Math.max(0, total - Math.max(4, tuning.keepRecentMessages || 12));

  const compressed = messages.map((msg, index) => {
    const parts = Array.isArray(msg?.parts) ? msg.parts : [];

    const isTier1 = index >= tier1Start;
    const isTier2 = index >= tier2Start && !isTier1;
    const isTier3 = index < tier2Start;

    if (isTier1) stats.keptIntact++;

    const next = [];

    for (const part of parts) {
      if (!part) continue;

      // ── 思维链（Thinking）处理 ──
      if (part.kind === "thinking") {
        if (tuning.dropThinkingInHistory) {
          stats.droppedThinking++;
          continue;
        }
        next.push(part);
        continue;
      }

      // ── 普通文本（Text）处理 ──
      if (part.kind === "text") {
        let text = sanitizeWhitespace(String(part.text || ""));
        const limit = isTier1 ? 0 : isTier2 ? tuning.textMaxChars : Math.min(1200, tuning.textMaxChars);

        if (limit > 0 && text.length > limit) {
          stats.truncatedTexts++;
          text = middleTruncate(text, limit, "历史对话");
        }
        next.push({ ...part, text });
        continue;
      }

      // ── 工具调用（Tool Call）处理 ──
      if (part.kind === "tool_call") {
        // Tier 3 历史中的写文件操作进行骨架化（只留路径和精简占位，节省成千上万字符）
        if (isTier3 && isWriteTool(part.name) && part.args) {
          stats.summarizedToolCalls++;
          next.push({
            ...part,
            args: skeletonizeWriteArgs(part.args)
          });
          continue;
        }

        const rendered = renderToolCall(part);
        if (
          !isTier1 &&
          tuning.toolCallSummaryOverChars > 0 &&
          rendered.length > tuning.toolCallSummaryOverChars
        ) {
          stats.summarizedToolCalls++;
          const argLimit = isTier3
            ? Math.min(150, tuning.toolCallArgValueMaxChars)
            : tuning.toolCallArgValueMaxChars;

          next.push({
            ...part,
            args: elideLongArgValues(part.args, argLimit)
          });
          continue;
        }

        next.push(part);
        continue;
      }

      // ── 工具结果（Tool Result）处理 ──
      if (part.kind === "tool_result") {
        let text = sanitizeWhitespace(String(part.text || ""));

        // A. 检查是否为已失效的文件读取（该文件后续已被编辑覆盖，或同范围已重复读取）
        if (!isTier1 && isStaleFileRead(part, index, fileStateMap)) {
          stats.supersededReads++;
          const summary = `[文件内容已在后续操作中更新或重复读取，历史片段已折叠 (${text.length} 字符)]`;
          next.push({ ...part, text: summary });
          continue;
        }

        // B. 梯度容量上限
        let maxChars = tuning.toolResultMaxChars;
        if (isTier1) {
          maxChars = Math.max(tuning.toolResultMaxChars, 24000);
        } else if (isTier2) {
          maxChars = Math.min(tuning.toolResultMaxChars, 6000);
        } else {
          maxChars = Math.min(tuning.toolResultMaxChars, 2000);
        }

        if (maxChars > 0 && text.length > maxChars) {
          stats.truncatedToolResults++;
          text = smartTruncateLog(text, maxChars, "执行结果");
        }

        next.push({ ...part, text });
        continue;
      }

      next.push(part);
    }

    return { ...msg, parts: next };
  });

  stats.charsAfter = compressed.reduce((sum, msg) => sum + measureParts(msg.parts), 0);
  const result = { ...convo, messages: compressed };

  // 兜底机制：总字符数仍超预算时，从深层历史开始折叠
  if (tuning.maxTotalChars > 0 && stats.charsAfter > tuning.maxTotalChars) {
    result.messages = shrinkToBudgetSafely(
      compressed,
      tier1Start,
      tuning.maxTotalChars,
      stats
    );
  }

  log("info", "context.trim", {
    ...stats,
    savedChars: stats.charsBefore - stats.charsAfter,
    keepRecentMessages: tuning.keepRecentMessages
  });

  return result;
}

/* ---------------------------- 文件感知与分段读取 ---------------------------- */

/**
 * 预分析对话中的文件读写生命周期。
 * 考虑每次读一部分的情况（通过 offset / limit / lines 区分分段）。
 */
function analyzeFileOperations(messages) {
  const files = new Map();

  for (let i = 0; i < messages.length; i++) {
    const parts = messages[i]?.parts || [];

    for (const part of parts) {
      if (part.kind === "tool_call") {
        const path = extractFilePath(part.args);
        if (!path) continue;

        if (!files.has(path)) {
          files.set(path, { lastWriteIndex: -1, reads: [] });
        }
        const record = files.get(path);

        if (isWriteTool(part.name)) {
          record.lastWriteIndex = i;
        } else if (isReadTool(part.name)) {
          const sliceKey = extractSliceKey(part.args);
          record.reads.push({ index: i, sliceKey, id: part.id });
        }
      }
    }
  }

  return files;
}

function extractFilePath(args) {
  if (!args || typeof args !== "object") return "";
  const p = args.file_path || args.path || args.filePath || args.file || args.target;
  return typeof p === "string" ? p.trim() : "";
}

function extractSliceKey(args) {
  if (!args || typeof args !== "object") return "full";
  const offset = args.offset ?? args.start ?? args.start_line ?? args.line_start ?? "";
  const limit = args.limit ?? args.length ?? args.end ?? args.end_line ?? "";
  if (offset === "" && limit === "") return "full";
  return `range:${offset}-${limit}`;
}

function isReadTool(name) {
  const n = String(name || "").toLowerCase();
  return (
    n === "read" ||
    n === "readfile" ||
    n === "read_file" ||
    n === "view" ||
    n === "cat"
  );
}

function isWriteTool(name) {
  const n = String(name || "").toLowerCase();
  return (
    n === "write" ||
    n === "writefile" ||
    n === "write_file" ||
    n === "edit" ||
    n === "editfile" ||
    n === "edit_file" ||
    n === "replace" ||
    n === "patch"
  );
}

/**
 * 判定某个 tool_result 是否为已过时或被改写的文件内容
 */
function isStaleFileRead(resultPart, msgIndex, fileStateMap) {
  const partName = String(resultPart.name || "");
  const hasReadName = isReadTool(partName);

  // 兼容保护：若 resultPart 未携带 name，但其 id 曾对应读取调用，也视为读取
  let isKnownReadId = false;
  if (!hasReadName && resultPart.id) {
    for (const info of fileStateMap.values()) {
      if (info.reads.some((r) => r.id === resultPart.id)) {
        isKnownReadId = true;
        break;
      }
    }
  }

  if (!hasReadName && !isKnownReadId) return false;

  for (const [, info] of fileStateMap.entries()) {
    if (info.lastWriteIndex > msgIndex) {
      const readRef = info.reads.find(
        (r) => r.index === msgIndex || (resultPart.id && r.id === resultPart.id)
      );
      if (readRef) return true;
    }

    const readIndices = info.reads.filter(
      (r) => r.index === msgIndex || (resultPart.id && r.id === resultPart.id)
    );

    for (const currentRead of readIndices) {
      const hasLaterIdenticalRead = info.reads.some(
        (later) => later.index > msgIndex && later.sliceKey === currentRead.sliceKey
      );
      if (hasLaterIdenticalRead) return true;
    }
  }

  return false;
}

function skeletonizeWriteArgs(args) {
  if (!args || typeof args !== "object") return args;
  const nextArgs = { ...args };

  const targetField = ["content", "new_content", "replacement", "patch", "text"].find(
    (field) => typeof nextArgs[field] === "string" && nextArgs[field].length > 400
  );

  if (targetField) {
    const len = nextArgs[targetField].length;
    nextArgs[targetField] = `/* [历史写入内容已折叠，共 ${len} 字符] */`;
  }

  return nextArgs;
}

/* ---------------------------- 日志语义萃取与格式处理 ---------------------------- */

export function sanitizeWhitespace(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

export function smartTruncateLog(text, limit, label = "日志") {
  if (text.length <= limit) return text;

  const headSize = Math.max(300, Math.floor(limit * 0.25));
  const tailSize = Math.max(400, Math.floor(limit * 0.3));

  const headPart = text.slice(0, headSize);
  const tailPart = text.slice(-tailSize);
  const middleContent = text.slice(headSize, -tailSize);

  const middleSignals = extractLogSignals(middleContent, limit - headSize - tailSize);

  if (middleSignals) {
    return `${headPart}\n\n...[${label}中间输出已折叠，提取关键信息如下]...\n${middleSignals}\n...[折叠结束]...\n\n${tailPart}`;
  }

  const removed = text.length - headSize - tailSize;
  return `${headPart}\n\n...[${label}已省略 ${removed} 字符]...\n\n${tailPart}`;
}

function extractLogSignals(middleText, budget) {
  if (budget <= 300 || !middleText) return "";

  const lines = middleText.split("\n");
  const errorIndicators = [
    /error/i,
    /exception/i,
    /fail/i,
    /traceback/i,
    /syntaxerror/i,
    /assertionerror/i,
    /panic/i,
    /fatal/i,
    /exit code\s*[1-9]/i,
    /status\s*[1-9]/i
  ];

  const matchedLineIndices = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (errorIndicators.some((regex) => regex.test(line))) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length - 1, i + 3);
      for (let j = start; j <= end; j++) matchedLineIndices.add(j);
    }
    if (matchedLineIndices.size > 80) break;
  }

  if (matchedLineIndices.size === 0) return "";

  const selectedLines = Array.from(matchedLineIndices)
    .sort((a, b) => a - b)
    .map((idx) => lines[idx]);

  const extracted = selectedLines.join("\n").trim();
  return extracted.length > budget ? extracted.slice(0, budget) + "\n..." : extracted;
}

export function middleTruncate(text, limit, label) {
  if (text.length <= limit) return text;

  const head = Math.floor(limit * 0.6);
  const tail = Math.max(0, limit - head);

  const headPart = text.slice(0, head);
  const tailPart = tail > 0 ? text.slice(-tail) : "";
  const removed = text.length - head - tail;

  return `${headPart}\n...[${label}已省略 ${removed} 字符]...\n${tailPart}`;
}

/* ---------------------------- 预算硬控制与折叠 ---------------------------- */

function shrinkToBudgetSafely(messages, protectFrom, budget, stats) {
  const result = [...messages];
  let current = result.reduce((sum, msg) => sum + measureParts(msg.parts), 0);

  for (let index = 0; index < protectFrom && current > budget; index++) {
    const parts = result[index]?.parts || [];
    if (!parts.length) continue;

    const before = measureParts(parts);
    const collapsed = [
      {
        kind: "text",
        text: `[更早的历史已折叠：${describeParts(parts)}]`
      }
    ];

    result[index] = { ...result[index], parts: collapsed };
    current -= before - measureParts(collapsed);
    stats.collapsedOldMessages++;
  }

  if (current > budget) {
    for (let index = 0; index < protectFrom && current > budget; index++) {
      const parts = result[index]?.parts || [];
      for (let p = 0; p < parts.length; p++) {
        if (parts[p].kind === "tool_result" && parts[p].text.length > 500) {
          const before = parts[p].text.length;
          parts[p].text = middleTruncate(parts[p].text, 500, "超长历史结果");
          current -= before - parts[p].text.length;
        }
      }
    }
  }

  stats.charsAfter = current;
  return result;
}

function describeParts(parts) {
  const names = parts
    .map((part) =>
      part?.kind === "tool_call"
        ? `调用 ${part.name}`
        : part?.kind === "tool_result"
          ? "工具结果"
          : "文本"
    )
    .filter(Boolean);

  return names.join("、") || "空";
}

function elideLongArgValues(args, limit) {
  const walk = (value) => {
    if (typeof value === "string") {
      return value.length <= limit
        ? value
        : `${value.slice(0, limit)}…[已省略 ${value.length - limit} 字]…`;
    }

    if (Array.isArray(value)) return value.map(walk);

    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, walk(item)])
      );
    }

    return value;
  };

  return walk(args ?? {});
}

export function measureParts(parts) {
  let sum = 0;
  for (const part of parts || []) {
    if (!part) continue;
    if (part.kind === "tool_call") sum += renderToolCall(part).length;
    else sum += String(part.text || "").length;
  }
  return sum;
}

/* ==========================================================================
 *  第五部分：把 Conversation 渲染成上游能看懂的纯文本消息
 *  ------------------------------------------------------------------------
 *  这里定义的就是模型眼里的"工具协议长什么样"，和提示词是一套东西，
 *  改了这里必须同步改 PROTOCOL_RULES，否则模型看到的示例和实际不一致。
 * ========================================================================== */

export function renderToolCall(part) {
  return `<tool_call>\n${JSON.stringify({
    name: part.name,
    arguments: part.args || {}
  })}\n</tool_call>`;
}

export function renderToolResult(part) {
  return `[TOOL RESULT ${part.id || ""}]\n${part.text || ""}`;
}

/**
 * Conversation -> OpenAI /chat/completions 的 messages 数组
 * @returns {Array<{role:string, content:string}>}
 */
export function renderConversation(convo, tuning = DEFAULT_TUNING, log = NOOP_LOG) {
  const out = [];
  let skipped = 0;

  for (const msg of convo?.messages || []) {
    const chunks = [];

    for (const part of msg?.parts || []) {
      if (!part) continue;

      if (part.kind === "tool_call") {
        chunks.push(renderToolCall(part));
      } else if (part.kind === "tool_result") {
        chunks.push(renderToolResult(part));
      } else if (part.kind === "image") {
        chunks.push("[Image omitted]");
      } else if (part.kind === "thinking") {
        // 正常情况下压缩阶段已经丢掉了；这里兜底，绝不把思维链回传上游
        continue;
      } else {
        chunks.push(String(part.text || ""));
      }
    }

    let content = chunks.filter(Boolean).join("\n").trim();

    // assistant 伪造 [TOOL RESULT] / [Assistant]: 时，从伪造点斩断
    if (msg.role === "assistant") {
      content = cutHallucinatedResult(content);
    }

    if (!content) {
      skipped++;
      continue;
    }

    out.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content
    });
  }

  if (skipped) {
    log("debug", "render.skipped_empty", { skipped });
  }

  return out;
}

/** assistant 自己编造 [TOOL RESULT] 时，把编造部分及之后全部切掉。 */
export function cutHallucinatedResult(text) {
  const source = String(text || "");
  const index = source.search(/\[TOOL RESULT|\[Assistant\]:/i);
  return index >= 0 ? source.slice(0, index).trim() : source;
}

/** 清掉 Claude Code 注入的、对上游无意义的包裹标签。 */
export function stripClientNoise(text) {
  // 【本次修改】：委托新版 cleanNoise（含 REMINDER sources 清理、Wasted call → [SUCCESS] 改写、
  // task-notification / context 标签清理），完成 new 降噪规则向 old 渲染管线的挂接。
  return cleanNoise(text);
}

/* ==========================================================================
 *  第六部分：防死循环
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
 * ========================================================================== */

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
 *  第八部分：从模型纯文本里抠出工具调用
 *  ------------------------------------------------------------------------
 *  整个项目最脏也最关键的地方。支持的畸形形态：
 *    a) 标准     <tool_call>{"name":"X","arguments":{...}}</tool_call>
 *    b) 无闭合   <tool_call>{"name":"X","arguments":{...}}        （stop 序列吃掉了闭合标签）
 *    c) 裸 JSON  {"name":"X","arguments":{...}}                   （没有任何标签）
 *    d) 内联名   <tool_call>X{"file_path":"..."}</tool_call>
 *    e) 平铺参数 {"name":"X","file_path":"..."}                   （arguments 被摊平）
 *    f) GLM 风格 <arg_key>file_path</arg_key><arg_value>...</arg_value>
 *    g) markdown ```json {"name":...} ```
 *    h) 字符串里有裸换行/未转义引号的破 JSON
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
    const tool = getToolByName(declaredName, tools);

    const recovered =
      candidate.kind === "tagged"
        ? recoverTaggedToolCall(candidate.raw, declaredName, tool)
        : candidate.kind === "xml"
          ? recoverXmlToolCall(candidate.raw, declaredName, tool)
          : recoverMalformedToolCall(candidate.raw, candidate.inlineName, tool);

    if (!recovered) {
      rejected.push({ reason: "unparsable", declaredName, raw: clip(candidate.raw) });
      continue;
    }

    const normalized = normalizeParsedCall(recovered, tools);

    if (!normalized) {
      rejected.push({
        reason: "unknown_tool",
        declaredName: recovered.name || declaredName,
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

      // 照样放行：Claude Code 会返回参数校验错误，模型下一轮据此改正。
      // 比静默丢弃强得多——静默丢弃的表现就是"模型不调用工具"。
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
    // 【new 协议接入 4c】：标准 tool_call 全部解析失败时，回退到【调度动作】json 块解析
    // （new 流水线协议：模型输出【思考】+【调度动作】+json 参数块 → 经 mapActionToClaudeCodeTool 映射为 CC tool_use）
    const scheduling = extractActionAndThought(source);
    if (scheduling && scheduling.action) {
      const mappedCall = mapActionToClaudeCodeTool(scheduling.action, scheduling.params);
      if (mappedCall && mappedCall.name) {
        log("info", "extract.scheduling_action", {
          action: scheduling.action,
          tool: mappedCall.name,
          thought: scheduling.thought || ""
        });
        return {
          content: scheduling.thought || "",
          toolCalls: [
            {
              id: makeId(),
              name: mappedCall.name,
              arguments: mappedCall.arguments || {}
            }
          ],
          rejected
        };
      }
    }

    const visible =
      firstAttemptStart >= 0
        ? source.slice(0, expandToolCallStart(source, firstAttemptStart))
        : source;

    if (firstAttemptStart >= 0) {
      log("error", "extract.all_rejected", {
        candidates: candidates.length,
        rejected: rejected.length,
        hint: "模型确实尝试调用了工具但全部解析失败——展开下面的 rejected 看原因"
      });
    }

    return { content: cleanResidualTags(visible), toolCalls: [], rejected };
  }

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

function clip(text, limit = 600) {
  const source = String(text || "");
  return source.length > limit ? `${source.slice(0, limit)}…` : source;
}

function cleanResidualTags(text) {
  return String(text || "")
    .replace(/<\/?(tool_call|invoke|function|function_calls|parameter)[^>]*>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

function defaultMakeId() {
  return `toolu_${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

/* ---------------------------- 候选片段收集 -------------------------------- */

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
  //
  // ⚠️ 标识符必须写成 {0,63} 而不是 *。写 * 会让正则在长文本上灾难性回溯：
  //    实测 8000 字符的纯文本要跑 22 秒 CPU，模型写个大文件就能把进程挂死。
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
  //     deepseek / 各种 Claude 蒸馏模型很爱输出这个，哪怕提示词里要求的是 JSON。
  //     可能外面套着 <tool_call>，也可能套着 <function_calls>，也可能什么都不套。
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
  //
  // ⚠️ 这个 indexOf 前置判断不是优化，是必需的正确性护栏。
  //    没有 </arg_key> 时下面的正则会对每个起始位置做 O(n×160) 回溯，
  //    整体 O(n²)；去掉这个 if 会让服务在写大文件时直接卡死。
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

/* ---------------------------- 各形态的恢复 -------------------------------- */

function indexOfCaseless(text, needle, from) {
  return text.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/**
 * 解析 Anthropic XML 风格的调用：
 *   <invoke name="Bash"><parameter name="command">ls -la</parameter></invoke>
 *
 * 用 indexOf 逐段扫描而不是一个大正则，原因有二：
 *   1. 参数值里经常有换行、引号、代码、甚至尖括号，正则很难写对；
 *   2. 惰性量词 + 收尾分支在长文本上会灾难性回溯（见 collectToolCallCandidates 的注释）。
 */
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

    // 值的结束点：最近的 </parameter>；没有就退到 </invoke>；再没有就到结尾（被截断了）
    const closeParam = indexOfCaseless(raw, "</parameter", valueStart);
    const closeInvoke = indexOfCaseless(raw, "</invoke", valueStart);

    let end = raw.length;
    if (closeParam >= 0) end = closeParam;
    if (closeInvoke >= 0 && closeInvoke < end) end = closeInvoke;

    args[key] = coerceXmlParamValue(raw.slice(valueStart, end), key, tool);
  }

  return Object.keys(args).length ? { name: canonicalName, arguments: args } : null;
}

/** XML 里的值全是字符串，按 schema 声明的类型还原成 number / boolean / 对象。 */
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

    // (e) arguments 被摊平：{"name":"Read","file_path":"/a"}
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

/** (h) JSON 彻底坏掉时，按 schema 里的字段名逐个把值抠出来。 */
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

  // 非字符串值（数字 / 布尔 / 对象 / 数组）
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

/* ------------------------- 工具名解析 / 参数校验 --------------------------- */

export function normalizeToolNameKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_.\-:/]+/g, "");
}

/** 模型常把 Read 写成 read / read_file / Read-File，这里做模糊归一。 */
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

/**
 * 清掉模型在代码/SVG 里误加的 markdown 标记。
 * 典型症状：写出来的 HTML 里 URL 变成 [http://x](http://x)，页面就废了。
 */
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

/* ----------------------------- JSON 工具函数 ------------------------------ */

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

/** 把切割点从 JSON / <invoke> 起点前移到最外层的包裹标签，避免残留半个标签。 */
function expandToolCallStart(text, callStart) {
  let earliest = callStart;

  for (const tag of ["<tool_call", "<function_calls"]) {
    const tagStart = text.toLowerCase().lastIndexOf(tag, earliest);
    if (tagStart < 0) continue;

    const tagEnd = text.indexOf(">", tagStart);
    if (tagEnd < 0 || tagEnd >= earliest) continue;

    // 标签和调用之间只有空白才认为它们是一体的
    if (!text.slice(tagEnd + 1, earliest).trim()) earliest = tagStart;
  }

  return earliest;
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

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ==========================================================================
 *  第九部分：stop 序列
 * ========================================================================== */

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
 *  第十二部分：old 中介调度动作适配 + 本地日志降噪（自 new/server.js 逐字迁入）
 * ========================================================================== */

/**
 * 调度动作名 → Claude Code 原生工具 的适配映射器。
 * 【本次修改】：自 new/server.js 的 mapActionToClaudeCodeTool 全部分支逐字迁入。
 */
export function mapActionToClaudeCodeTool(actionName, rawParams) {
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

/**
 * 入站日志降噪。new 版新增：REMINDER sources 清理、Wasted call → [SUCCESS] 改写、
 * task-notification / context 标签清理。自 new/server.js 的 cleanNoise 逐字迁入。
 */
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

/**
 * 日志中间智能折叠（new 版：保留前后文 + 提取报错行，含 cannot access / no such file 信号）。
 * 注意：adapt.js 压缩管线内部已有一个同名 smartTruncateLog（"执行结果"标签版），
 * 为避免命名冲突此处以 Verbose 后缀迁入，函数体与 new/server.js 逐字一致。
 */
export function smartTruncateLogVerbose(text, limit, label = '终端日志') {
  if (text.length <= limit) return text;

  const headSize = Math.max(500, Math.floor(limit * 0.35));
  const tailSize = Math.max(600, Math.floor(limit * 0.45));

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
  let summary = `\n...[${label}中间输出已折叠 ${removed} 字符`;
  if (capturedLines.length > 0) {
    summary += `，提取关键异常信号：\n${capturedLines.slice(0, 8).join('\n')}\n...折叠结束]...\n`;
  } else {
    summary += `]...\n`;
  }

  return `${headPart}${summary}${tailPart}`;
}


/* ======================================================================== */
/* 【new 协议层】(4c) 逐字迁入自 cc工具中介new/server.js —— 仅挂导出，函数体一字未改 */
/* ======================================================================== */

const CORE_DOCS_REGEX = /(?:^|[/\s"'\`\\])(?:todo|readme)\.(?:md|markdown|txt)(?:[/\s"'\`\\]|$)/i;

function formatLocalFeedback(str, actionName, stepParams = {}, isLatestStep = false, stepAge = 0) {
  if (!str) return '[SUCCESS] 操作已执行完成';
  let text = sanitizeWhitespace(String(str));

  if (/successfully|created|updated|done|completed/i.test(text) && !text.startsWith('[')) {
    text = `[SUCCESS] ${text}`;
  }

  const cmdStr = String(stepParams.command || stepParams.cmd || '');
  const pathStr = String(stepParams.file_path || stepParams.path || '');

  // 判定是否为核心文档读取或带待办清单语法 (- [ ] / - [x])
  const isTargetDocFile = CORE_DOCS_REGEX.test(pathStr) || CORE_DOCS_REGEX.test(cmdStr);
  const hasChecklistMarks = /- \[[ xX]\]/m.test(text);
  const isDocContext = isTargetDocFile || hasChecklistMarks;

  // 核心文档/待办清单给予 20,000 字符超高预算，确保清单不被腰斩
  if (isDocContext) {
    if (text.length <= 20000) return text;
    return smartTruncateLog(text, 20000, '核心任务/设计文档');
  }

  // 梯度动态预算：最新步（Tier 1）15000 字符，近序步 6000 字符，远期步 2500 字符
  let budget = 3000;
  if (isLatestStep) {
    budget = 15000;
  } else if (stepAge <= 2) {
    budget = 6000;
  } else {
    budget = 2500;
  }

  if (actionName === 'fs_read') {
    if (text.length > budget) return smartTruncateLog(text, budget, '文件读取');
  } else if (actionName === 'shell_exec' || actionName === 'Bash') {
    if (text.length > budget) return smartTruncateLog(text, budget, '命令输出');
  } else if (actionName !== 'fs_write' && text.length > budget) {
    return smartTruncateLog(text, budget, '执行反馈');
  }

  return text;
}

// 【本次修改】：彻底移除执行配置中的 step_thought，杜绝模型复读第一步思维；支持核心文档写入保护
function compressHistorySteps(rawSteps) {
  const validSteps = (rawSteps || []).filter(s => s.action && s.action !== 'text_response');
  const trimmed = validSteps.slice(-6);
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
    let feedback = step.feedback || '[SUCCESS] 执行完成';
    let params = { ...step.params };
    const filePathStr = String(params.file_path || params.path || '');

    // 大小写不敏感识别
    const isTodoFile = /(?:^|[/\\])todo\.(?:md|markdown|txt)$/i.test(filePathStr);
    const isReadmeFile = /(?:^|[/\\])readme\.(?:md|markdown|txt)$/i.test(filePathStr);

    const stepAge = total - 1 - idx;
    const isLatestStep = stepAge === 0;

    // 1. fs_write 参数骨架化
    if (step.action === 'fs_write') {
      if (isTodoFile) {
        // todo.md 完整保留，供后续打勾参考
        params = {
          file_path: params.file_path || 'todo.md',
          content: step.params?.content || ''
        };
      } else if (isReadmeFile) {
        const contentStr = String(step.params?.content || '');
        if (contentStr.length <= 4000) {
          params = { file_path: params.file_path || 'readme.md', content: contentStr };
        } else {
          params = { file_path: params.file_path || 'readme.md', content: `[项目规划与设计规范已写入，共 ${contentStr.length} 字符]` };
        }
      } else {
        const len = step.params?.content ? String(step.params.content).length : 0;
        params = { file_path: params.file_path || 'file' };
        if (len > 0) {
          params.content = `[源码/文档内容已写入，共 ${len} 字符]`;
        }
      }
    }

    // 2. fs_replace 参数精简
    if (step.action === 'fs_replace') {
      if (!isTodoFile && !isReadmeFile) {
        if (params.old_string?.length > 100) {
          params.old_string = params.old_string.slice(0, 40) + '...[略]...' + params.old_string.slice(-30);
        }
        if (params.new_string?.length > 100) {
          params.new_string = params.new_string.slice(0, 40) + '...[略]...' + params.new_string.slice(-30);
        }
      }
    }

    // 3. fs_read 重复读取折叠
    if (step.action === 'fs_read') {
      const lowerPath = filePathStr.toLowerCase();
      if (lastReadMap.get(lowerPath) !== idx) {
        feedback = `[早期版本已读取，第 ${lastReadMap.get(lowerPath) + 1} 步有最新读取结果，此处折叠]`;
      } else {
        feedback = formatLocalFeedback(feedback, 'fs_read', params, isLatestStep, stepAge);
      }
    } else {
      feedback = formatLocalFeedback(feedback, step.action, params, isLatestStep, stepAge);
    }

    // 【核心改动】：仅保留 action 与 params，绝不输出任何 step_thought
    return `--- Step ${idx + 1} ---
【执行配置】：
${JSON.stringify({
  action: step.action,
  params: params
}, null, 2)}
【本地执行反馈】：
${feedback}`;
  }).join('\n\n');
}

// 【本次修改】：单一队列同步解析，彻底防止多轮步骤与反馈错位
export function parseConversation(messages = []) {
  let globalTask = '';
  const rawSteps = [];

  const CC_TO_ACTION_MAP = {
    Write: 'fs_write', Read: 'fs_read', Edit: 'fs_replace', Bash: 'shell_exec',
    WebSearch: 'net_search', WebFetch: 'net_fetch', AskUserQuestion: 'user_prompt',
    Agent: 'subflow_spawn', Workflow: 'subflow_spawn', TaskCreate: 'task_entry',
    TaskUpdate: 'task_entry', NotebookEdit: 'notebook_patch', EnterWorktree: 'git_worktree',
    ReportFindings: 'code_audit'
  };

  // 1. 提取全局任务
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
  if (!globalTask) globalTask = '推进当前工作目录下的任务推进。';

  // 2. 状态机解析
  const pendingSteps = new Map();
  const sequentialQueue = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p.type === 'tool_use') {
            const mappedAction = CC_TO_ACTION_MAP[p.name] || 'shell_exec';
            const stepObj = {
              id: p.id || '',
              action: mappedAction,
              params: p.input || {}
            };
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
          } catch {
            params = {};
          }
          const stepObj = {
            id: tc.id || '',
            action: mappedAction,
            params
          };
          if (tc.id) pendingSteps.set(tc.id, stepObj);
          sequentialQueue.push(stepObj);
        }
      }

      if (typeof msg.content === 'string' && msg.content.includes('<tool_call>')) {
        const tcMatch = msg.content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
        if (tcMatch) {
          try {
            const parsed = JSON.parse(cleanLooseJson(tcMatch[1]));
            if (parsed.name) {
              const mappedAction = CC_TO_ACTION_MAP[parsed.name] || 'shell_exec';
              sequentialQueue.push({
                id: '',
                action: mappedAction,
                params: parsed.arguments || {}
              });
            }
          } catch {}
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
            if (matchedStep) {
              rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
            }
          }
        }
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        const outText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const matchedStep = matchAndPopStep(msg.tool_call_id);
        if (matchedStep) {
          rawSteps.push({ ...matchedStep, feedback: cleanNoise(outText) });
        }
      } else if (typeof msg.content === 'string') {
        const text = cleanNoise(msg.content);
        if (text && !text.startsWith("Today's date is") && sequentialQueue.length > 0) {
          const matchedStep = matchAndPopStep(null);
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
