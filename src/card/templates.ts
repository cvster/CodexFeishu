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

  return shell('📂 工作目录', elements);
}

/** First-run card sent proactively into a newly created workspace group. */
export function newChatWorkspaceCard(
  chatName: string,
  current: string | undefined,
  named: Record<string, string>,
): object {
  const quickSwitches = Object.entries(named).slice(0, 5);
  const elements: object[] = [
    {
      tag: 'markdown',
      content:
        `🎉 **${escapeMd(chatName)} 已创建**\n\n` +
        '这个群已绑定独立 Codex 会话。可以在下面修改工作目录。\n\n' +
        '**使用方法**\n' +
        '- 当前只有你和机器人时，直接发送任务即可，无需 @。\n' +
        '- 邀请其他同事后，请使用 `@机器人 + 任务内容`，例如：`@机器人 帮我检查这个项目`。',
    },
    { tag: 'hr' },
    {
      tag: 'form',
      name: 'workspace_setup_form',
      elements: [
        {
          tag: 'input',
          name: 'cwd',
          label: { tag: 'plain_text', content: '工作目录（绝对路径）' },
          placeholder: { tag: 'plain_text', content: 'C:\\path\\to\\project' },
          ...(current ? { default_value: current } : {}),
          required: true,
        },
        {
          tag: 'button',
          name: 'workspace_submit',
          text: { tag: 'plain_text', content: '保存目录并开启新会话' },
          type: 'primary',
          form_action_type: 'submit',
          behaviors: [{ type: 'callback', value: { cmd: 'cd.form' } }],
        },
      ],
    },
  ];

  if (quickSwitches.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: '**快捷工作目录**' });
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: quickSwitches.map(([name, path]) => ({
        tag: 'column',
        width: 'auto',
        elements: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: name },
            type: path === current ? 'primary' : 'default',
            behaviors: [{ type: 'callback', value: { cmd: 'cd.apply', arg: path } }],
          },
        ],
      })),
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: '💡 之后可随时发送 `/cd <绝对路径>` 或 `/ws list` 调整工作目录。',
  });

  return {
    schema: '2.0',
    config: { summary: { content: '新群工作目录设置' } },
    body: { elements },
  };
}

/** Creation form shown in DM before a workspace group exists. */
export function newChatCreationCard(defaultName: string, defaultCwd?: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '创建 Codex 工作群' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '🚀 **创建 Codex 工作群**\n\n' +
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
      { text: '🆕 新会话', value: { cmd: 'new' }, style: 'primary' },
      { text: '🔁 恢复会话', value: { cmd: 'resume' } },
      { text: '📂 工作目录', value: { cmd: 'ws.list' } },
      { text: '💡 帮助', value: { cmd: 'help' } },
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
        '- `/new` `/reset` — 清空当前 chat 的会话',
        '- `/new chat [name]` — 新建群+新会话，自动拉你进群',
        '- 私聊发送“新建会话” — 打开傻瓜式建群卡片',
        '- `/resume [N]` — 列出并恢复历史会话（最多 N 条）',
        '- `/cd <path>` — 切换工作目录（会重置 session）',
        '- `/ws list|save <name>|use <name>|remove <name>` — 工作目录',
        '- `/account` — 查看当前应用；`/account change` 换 appId/secret 并重连',
        '- `/config` — 调整偏好、访问控制和 lark-cli 身份策略',
        '- `/status` — 当前状态',
        '- `/stop` — 结束当前正在跑的任务（也可点卡片底部 ⏹ 终止 按钮）',
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
      { text: '🆕 新会话', value: { cmd: 'new' } },
    ]),
  ]);
}

function escapeMd(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

function escapeCode(s: string): string {
  return s.replace(/`/g, "'");
}
