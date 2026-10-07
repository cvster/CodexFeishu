import { modelLabel, supportedModels } from '../agent/models';
import { CODEX_STANDARD_REASONING_VALUES } from '../../packages/codex-core/src/models';

interface ButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
}

function button(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    value: spec.value,
  };
}

function divMd(content: string): object {
  return { tag: 'div', text: { tag: 'lark_md', content } };
}

function actions(buttons: ButtonSpec[]): object {
  return { tag: 'action', actions: buttons.map(button) };
}

function cardKitButton(spec: ButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    behaviors: [{ type: 'callback', value: spec.value }],
  };
}

function cardKitButtonRow(buttons: ButtonSpec[]): object {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: 'small',
    columns: buttons.map((spec) => ({
      tag: 'column',
      width: 'auto',
      elements: [cardKitButton(spec)],
    })),
  };
}

const HR: object = { tag: 'hr' };

function shell(title: string, elements: object[]): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function workspacesCard(current: string | undefined, named: Record<string, string>): object {
  const entries = Object.entries(named);
  const elements: object[] = [];

  elements.push(divMd(`当前 cwd：\`${escapeCode(current ?? '(未设置)')}\``));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('暂无命名工作目录。'));
    elements.push(
      divMd('💡 发送 `/ws save <name>` 把当前 cwd 存为命名工作目录'),
    );
  } else {
    elements.push(HR);
    entries.forEach(([name, path], i) => {
      const marker = path === current ? '  ← 当前' : '';
      elements.push(divMd(`**${escapeMd(name)}** → \`${escapeCode(path)}\`${marker}`));
      elements.push(
        actions([
          { text: '切换到此处', value: { cmd: 'ws.use', name }, style: 'primary' },
          { text: '删除', value: { cmd: 'ws.remove', name }, style: 'danger' },
        ]),
      );
      if (i < entries.length - 1) elements.push(HR);
    });
  }

  elements.push(HR);
  elements.push(actions([{ text: '返回任务控制台', value: { cmd: 'panel' } }]));

  return shell('📂 工作目录', elements);
}

/** First-run card sent proactively into a newly created workspace group. */
export function newChatWorkspaceCard(
  chatName: string,
  binding?: { threadId: string; existing: boolean },
): object {
  const bindingText = binding?.existing
    ? `这个群已绑定现有 Codex 会话 \`${binding.threadId.slice(0, 8)}…\`，可以直接继续原对话。`
    : '这个群已绑定独立 Codex 会话，发送第一条任务时会自动创建会话。';
  const elements: object[] = [
    {
      tag: 'markdown',
      content:
        `🎉 **${escapeMd(chatName)} 已创建**\n\n` +
        `${bindingText}\n\n` +
        '**使用方法**\n' +
        '- 当前只有你和机器人时，直接发送任务即可，无需 @。\n' +
        '- 邀请其他同事后，请使用 `@机器人 + 任务内容`，例如：`@机器人 帮我检查这个项目`。',
    },
  ];

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content:
      '💡 需要调整工作目录时，请打开任务控制台并选择“工作目录”。\n\n' +
      '任务全部完成后，可发送“终止任务”，或点击下面的按钮归档会话并解散群。',
  });
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '打开任务控制台' },
    type: 'primary',
    behaviors: [{ type: 'callback', value: { cmd: 'panel' } }],
  });
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '终止任务' },
    type: 'danger',
    behaviors: [{ type: 'callback', value: { cmd: 'finish' } }],
  });

  return {
    schema: '2.0',
    config: { summary: { content: '新群工作目录设置' } },
    body: { elements },
  };
}

export interface TaskPanelInfo {
  agentKind: 'claude' | 'codex';
  chatName: string;
  chatMode: 'p2p' | 'group' | 'topic';
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  cwd?: string;
  sessionId?: string;
  activeRun: boolean;
  groupCount?: number;
  sessionCount?: number;
}

/** Click-first home screen for the common task and session operations. */
export function taskPanelCard(info: TaskPanelInfo): object {
  const session = info.sessionId ? `\`${info.sessionId.slice(0, 8)}…\`` : '尚未建立';
  const status = info.activeRun ? '运行中' : info.sessionId ? '等待任务' : '新会话';
  const scopeLabel = info.chatMode === 'p2p' ? '机器人私聊' : info.chatName;
  const model = modelLabel(info.agentKind, info.model);
  return {
    schema: '2.0',
    config: { summary: { content: 'Codex 任务控制台' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
        `💬 **群/范围**：${escapeMd(scopeLabel)}`,
        `🤖 **模型**：${escapeMd(model)}${info.agentKind === 'codex' ? ` · ${info.reasoningEffort}` : ''}`,
        `📁 **工作目录**：\`${escapeCode(info.cwd ?? '(未设置)')}\``,
        `🔗 **会话**：${session}`,
        `🟢 **状态**：${status}`,
        ...(info.chatMode === 'p2p'
          ? [
              `👥 **工作群**：${info.groupCount ?? 0}`,
              `🗂️ **可管理会话**：${info.sessionCount ?? '点击查看'}`,
            ]
          : []),
          ].join('\n'),
        },
        { tag: 'hr' },
        cardKitButtonRow([
          ...(info.chatMode === 'p2p'
            ? [
                { text: '工作群', value: { cmd: 'panel.groups' }, style: 'primary' } satisfies ButtonSpec,
                { text: '现有会话', value: { cmd: 'panel.sessions' }, style: 'primary' } satisfies ButtonSpec,
                { text: '新建会话', value: { cmd: 'panel.new' } } satisfies ButtonSpec,
              ]
            : [{ text: '新建会话', value: { cmd: 'panel.new' }, style: 'primary' } satisfies ButtonSpec]),
          { text: '模型与推理', value: { cmd: 'config' } },
          { text: '工作目录', value: { cmd: 'ws.list' } },
        ]),
        cardKitButtonRow([
          { text: '刷新状态', value: { cmd: 'panel.refresh' } },
          { text: '停止当前运行', value: { cmd: 'panel.stop' } },
          ...(info.chatMode === 'p2p'
            ? [
                { text: '新建空白群', value: { cmd: 'new.chat.setup' } } satisfies ButtonSpec,
                { text: '恢复到私聊', value: { cmd: 'resume' } } satisfies ButtonSpec,
              ]
            : [{ text: '终止任务', value: { cmd: 'finish' }, style: 'danger' } satisfies ButtonSpec]),
        ]),
      ],
    },
  };
}

export function newSessionConfirmationCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '确认新建会话' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '当前会话将结束，工作目录保持不变。下一条任务会建立一个全新的 Codex 会话。',
        },
        { tag: 'hr' },
        cardKitButtonRow([
          { text: '确认新建', value: { cmd: 'panel.new-confirm' }, style: 'primary' },
          { text: '返回控制台', value: { cmd: 'panel.refresh' } },
        ]),
      ],
    },
  };
}

/** Destructive confirmation shown before archiving the session and dissolving the group. */
export function finishTaskConfirmationCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '确认终止 Codex 任务' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚠️ **请选择终止方式**\n\n' +
            '- **仅终止会话**：停止运行并归档当前 Codex 会话，保留群和工作目录；下一条消息会开启新会话。\n' +
            '- **归档并解散群**：永久解散当前飞书群；Codex 会话记录会保留在归档中，可稍后重新建群继续。',
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '仅终止会话（保留群）' },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { cmd: 'finish.archive' } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '归档并解散群（保留记录）' },
          type: 'danger',
          // Keep finish.confirm compatible with confirmation cards that were
          // already delivered before the two-option UI was introduced.
          behaviors: [{ type: 'callback', value: { cmd: 'finish.confirm' } }],
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '返回任务控制台' },
          behaviors: [{ type: 'callback', value: { cmd: 'panel' } }],
        },
      ],
    },
  };
}

export interface ManagedGroupCardEntry {
  token: string;
  name: string;
  cwd?: string;
  threadId?: string;
}

export interface ExistingSessionCardEntry {
  token: string;
  title: string;
  preview: string;
  cwd: string;
  threadId: string;
  relTime: string;
}

/** Second-level page listing Feishu work groups managed by the bridge. */
export function managedGroupsCard(entries: ManagedGroupCardEntry[], page: number, hasMore: boolean): object {
  const elements: object[] = [
    {
      tag: 'markdown',
      content: '👥 **工作群管理**\n\n选择一个群查看其绑定会话，并执行归档或解散操作。解散群不会删除 Codex 会话记录。',
    },
    { tag: 'hr' },
  ];
  if (entries.length === 0) {
    elements.push({ tag: 'markdown', content: '暂无工作群。可以返回控制台新建空白群，或从现有会话创建群。' });
  }
  for (const entry of entries) {
    elements.push({
      tag: 'markdown',
      content:
        `**${escapeMd(entry.name)}**\n` +
        `会话：${entry.threadId ? `\`${entry.threadId.slice(0, 8)}…\`` : '尚未建立'} · ` +
        `目录：\`${escapeCode(entry.cwd ?? '(未设置)')}\``,
    });
    elements.push(cardKitButtonRow([
      { text: '管理此群', value: { cmd: 'panel.group', arg: entry.token }, style: 'primary' },
    ]));
    elements.push({ tag: 'hr' });
  }
  elements.push(cardKitButtonRow([
    ...(page > 0 ? [{ text: '上一页', value: { cmd: 'panel.groups', arg: String(page - 1) } } satisfies ButtonSpec] : []),
    ...(hasMore ? [{ text: '下一页', value: { cmd: 'panel.groups', arg: String(page + 1) } } satisfies ButtonSpec] : []),
    { text: '返回控制台', value: { cmd: 'panel.refresh' } },
  ]));
  return { schema: '2.0', config: { summary: { content: 'Codex 工作群管理' } }, body: { elements } };
}

/** Second-level page listing existing local Codex sessions. */
export function existingSessionsCard(entries: ExistingSessionCardEntry[], page: number, hasMore: boolean): object {
  const elements: object[] = [
    {
      tag: 'markdown',
      content: '🗂️ **现有 Codex 会话**\n\n可以直接为历史会话创建飞书工作群，原会话 ID 和上下文保持不变。',
    },
    { tag: 'hr' },
  ];
  if (entries.length === 0) elements.push({ tag: 'markdown', content: '没有找到可管理的 Codex 会话。' });
  for (const entry of entries) {
    elements.push({
      tag: 'markdown',
      content:
        `**${escapeMd(entry.title)}**\n${escapeMd(entry.preview)}\n` +
        `\`${entry.threadId.slice(0, 8)}…\` · ${escapeMd(entry.relTime)}\n` +
        `📁 \`${escapeCode(entry.cwd)}\``,
    });
    elements.push(cardKitButtonRow([
      { text: '为此会话建群', value: { cmd: 'panel.session-group', arg: entry.token }, style: 'primary' },
      { text: '归档会话', value: { cmd: 'panel.session-archive', arg: entry.token }, style: 'danger' },
    ]));
    elements.push({ tag: 'hr' });
  }
  elements.push(cardKitButtonRow([
    ...(page > 0 ? [{ text: '上一页', value: { cmd: 'panel.sessions', arg: String(page - 1) } } satisfies ButtonSpec] : []),
    ...(hasMore ? [{ text: '下一页', value: { cmd: 'panel.sessions', arg: String(page + 1) } } satisfies ButtonSpec] : []),
    { text: '返回控制台', value: { cmd: 'panel.refresh' } },
  ]));
  return { schema: '2.0', config: { summary: { content: '现有 Codex 会话' } }, body: { elements } };
}

export function managedGroupDetailCard(entry: ManagedGroupCardEntry): object {
  return {
    schema: '2.0',
    config: { summary: { content: `管理 ${entry.name}` } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            `👥 **${escapeMd(entry.name)}**\n\n` +
            `🔗 会话：${entry.threadId ? `\`${entry.threadId}\`` : '尚未建立'}\n` +
            `📁 目录：\`${escapeCode(entry.cwd ?? '(未设置)')}\`\n\n` +
            '归档并解散后，群会永久删除，但 Codex 会话记录仍保留，可从“现有会话”再次创建群。',
        },
        { tag: 'hr' },
        cardKitButtonRow([
          { text: '归档并解散（保留记录）', value: { cmd: 'panel.group-finish', arg: entry.token }, style: 'danger' },
          { text: '返回工作群', value: { cmd: 'panel.groups', arg: '0' } },
        ]),
      ],
    },
  };
}

export function panelConfirmationCard(input: {
  title: string;
  description: string;
  confirmText: string;
  confirmCmd: string;
  token: string;
  backCmd: string;
}): object {
  return {
    schema: '2.0',
    config: { summary: { content: input.title } },
    body: {
      elements: [
        { tag: 'markdown', content: `⚠️ **${escapeMd(input.title)}**\n\n${escapeMd(input.description)}` },
        { tag: 'hr' },
        cardKitButtonRow([
          { text: input.confirmText, value: { cmd: input.confirmCmd, arg: input.token }, style: 'danger' },
          { text: '取消', value: { cmd: input.backCmd, arg: input.token } },
        ]),
      ],
    },
  };
}

/** Creation form shown in DM before a workspace group exists. */
export function newChatCreationCard(
  defaultName: string,
  defaultCwd?: string,
  model = 'gpt-5.6-sol',
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' = 'high',
): object {
  return {
    schema: '2.0',
    config: { summary: { content: '创建 Codex 工作群' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '🚀 **创建 Codex 工作群**\n\n' +
            '机器人私聊仅用于创建工作群；创建后请在群里与 Codex 交互。\n\n' +
            '每个群拥有独立会话和工作目录。提交后会自动建群、拉你入群并发送工作区卡片。',
        },
        { tag: 'hr' },
        {
          tag: 'form',
          name: 'new_chat_form',
          elements: [
            {
              tag: 'input',
              name: 'group_name',
              label: { tag: 'plain_text', content: '群名称' },
              default_value: defaultName,
              placeholder: { tag: 'plain_text', content: '例如：支付模块开发' },
              required: true,
            },
            {
              tag: 'select_static',
              name: 'model',
              label: { tag: 'plain_text', content: '模型' },
              initial_option: model,
              options: supportedModels('codex').map((option) => ({
                text: { tag: 'plain_text', content: option.label },
                value: option.value,
              })),
            },
            {
              tag: 'select_static',
              name: 'reasoning_effort',
              label: { tag: 'plain_text', content: '推理程度' },
              initial_option: reasoningEffort,
              options: CODEX_STANDARD_REASONING_VALUES.map((value) => ({
                text: { tag: 'plain_text', content: value },
                value,
              })),
            },
            {
              tag: 'input',
              name: 'cwd',
              label: { tag: 'plain_text', content: '工作目录（绝对路径）' },
              ...(defaultCwd ? { default_value: defaultCwd } : {}),
              placeholder: { tag: 'plain_text', content: 'C:\\path\\to\\project' },
              required: true,
            },
            {
              tag: 'button',
              name: 'create_chat_submit',
              text: { tag: 'plain_text', content: '创建并开启会话' },
              type: 'primary',
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: { cmd: 'new.chat.form' } }],
            },
          ],
        },
      ],
    },
  };
}

export interface StatusInfo {
  profileName: string;
  cwd?: string;
  sessionId?: string;
  emptySessionText?: string;
  sessionStale: boolean;
  agentName: string;
  runtimeAccess: {
    label: string;
    value: string;
  };
  larkCliStatus?: 'app' | 'user-ready' | 'user-missing' | 'check-failed';
  activeRun: boolean;
  activeScopes?: string[];
  activeCommentScopes?: string[];
  queue?: { active: number; waiting: number; cap: number };
  ownerState: string;
  /** Session scope (= chatId or chatId:threadId in topic groups). */
  scope: string;
  /** Chat mode — used to label scope. */
  chatMode: 'p2p' | 'group' | 'topic';
}

export function statusCard(info: StatusInfo): object {
  const sessionLine = info.sessionId
    ? `\`${info.sessionId.slice(0, 8)}…\`${info.sessionStale ? ' ⚠️ 旧 cwd，下一条会新建' : ''}`
    : (info.emptySessionText ?? '(无)');
  // For topic groups, surface that the scope is per-topic so the user
  // knows /cd / /new only affect this topic.
  const scopeLine =
    info.chatMode === 'topic'
      ? `\`${escapeCode(info.scope)}\` _（话题独立 session）_`
      : `\`${escapeCode(info.scope)}\``;
  const cwdLine = info.cwd ? `\`${escapeCode(info.cwd)}\`` : '(未设置)';
  const queueLine = info.queue
    ? `${info.queue.active}/${info.queue.cap} active, ${info.queue.waiting} waiting`
    : 'unknown';
  const lines = [
    `🧭 **scope**: ${scopeLine}`,
    `🧩 **profile**: ${escapeMd(info.profileName)}`,
    `📁 **cwd**: ${cwdLine}`,
    `🔗 **session**: ${sessionLine}`,
    `🤖 **agent**: ${escapeMd(info.agentName)}`,
    `🛡 **${escapeMd(info.runtimeAccess.label)}**: ${escapeMd(info.runtimeAccess.value)}`,
    ...(info.larkCliStatus ? [`🔐 **lark-cli**: ${info.larkCliStatus}`] : []),
    `🏃 **active run**: ${info.activeRun ? 'yes' : 'no'}`,
    ...(info.activeScopes && info.activeScopes.length > 0
      ? [
          `🏃 **active scopes**: ${info.activeScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    ...(info.activeCommentScopes && info.activeCommentScopes.length > 0
      ? [
          `📝 **comment runs**: ${info.activeCommentScopes.map((scope) => `\`${escapeCode(scope)}\``).join(', ')}`,
        ]
      : []),
    `🚦 **queue**: ${queueLine}`,
    `👤 **owner API**: ${escapeMd(info.ownerState)}`,
  ];
  return shell('📊 当前状态', [
    divMd(lines.join('\n')),
    HR,
    actions([
      { text: '🚀 新建工作群', value: { cmd: 'new.chat.setup' }, style: 'primary' },
      { text: '🆕 新会话', value: { cmd: 'panel.new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '任务控制台', value: { cmd: 'panel' } },
    ]),
  ]);
}

export interface ResumeEntry {
  sessionId: string;
  displayId?: string;
  preview: string;
  relTime: string;
  lineCount?: number;
  detail?: string;
  current?: boolean;
}

export function resumeCard(cwd: string, entries: ResumeEntry[]): object {
  const elements: object[] = [];
  elements.push(divMd(`当前 cwd：\`${escapeCode(cwd)}\``));
  elements.push(actions([{ text: '返回任务控制台', value: { cmd: 'panel' } }]));

  if (entries.length === 0) {
    elements.push(HR);
    elements.push(divMd('此 cwd 下没有历史会话。'));
    return shell('🔁 恢复历史会话', elements);
  }

  elements.push(HR);
  entries.forEach((e, i) => {
    const marker = e.current ? '  ← 当前' : '';
    const detail = e.detail ?? `${e.lineCount ?? 0} 条`;
    const displayId = e.displayId ?? e.sessionId;
    elements.push(
      divMd(
        `**${i + 1}.** ${escapeMd(e.preview)}${marker}\n\`${displayId.slice(0, 8)}…\` · ${e.relTime} · ${escapeMd(detail)}`,
      ),
    );
    elements.push(
      actions([
        {
          text: e.current ? '已是当前会话' : '▸ 恢复此会话',
          value: { cmd: 'resume.use', arg: e.sessionId },
          style: e.current ? 'default' : 'primary',
        },
      ]),
    );
    if (i < entries.length - 1) elements.push(HR);
  });

  return shell('🔁 恢复历史会话', elements);
}

export function helpCard(agentName = 'Agent'): object {
  const escapedAgentName = escapeMd(agentName);
  return shell('💡 使用帮助', [
    divMd(
      [
        '**命令列表**',
        '',
        '- “打开控制台” — 打开全点击式任务控制台',
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- 私聊发送“新建会话” — 打开傻瓜式建群卡片',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部“停止”按钮）',
        '- “终止任务”或 `/finish` — 归档当前 Codex 会话，可选择保留或解散群',
        '- `/stop comment:<scopeHash>` — 管理员停止云文档评论任务',
        '- `/timeout [N|off|default]` — 当前 session 的探活分钟数,`/config` 改全局默认',
        '- `/timeout comment:<scopeHash> N` — 管理员设置云文档评论任务探活',
        '- `/ps` — 列出本机所有 bot,标识当前正在回复的那个',
        '- `/exit <id|#>` — 关掉指定 bot(用 `/ps` 看 id/序号)',
        '- `/reconnect` — 强制重连 WebSocket(网络抖动后 bot 没反应时用)',
        `- \`/doctor [描述]\` — 把日志和描述交给 ${escapedAgentName} 自助诊断`,
        '- `/help` — 本帮助',
        '',
        `其他内容直接交给 ${escapedAgentName}。`,
      ].join('\n'),
    ),
    HR,
    actions([
      { text: '📊 状态', value: { cmd: 'status' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '🆕 新会话', value: { cmd: 'panel.new' } },
      { text: '任务控制台', value: { cmd: 'panel' }, style: 'primary' },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
