// 每个站点的配置。网站改版导致失效时，一般只需要改这里。
// 选择器字段都是“候选列表”，按顺序尝试，命中第一个即用。
//   input      输入框
//   sendButton 发送按钮
//   stopButton “停止生成”按钮（出现 = 正在生成）
//   streaming  可选，额外的“正在生成”标记
//   message    一条 AI 回答的根节点（用来计数和定位最后一条）
//   content    回答正文（在 message 内查找）
//   modes      可选，页面上的模式切换（如 ChatGPT 的 聊天/工作）：group 按钮组，按钮用 aria-pressed 表示当前
//   picker     模型菜单：
//     trigger  打开菜单的按钮；menu 弹出层
//     models   { reveal 先点开模型列表的菜单项（可选）, item 模型菜单项, more 含更多模型的子菜单名（可选，正则） }
//     effort   思考强度，三种形态：
//       { type: 'slider',  item, status }  菜单里的滑块：用左右方向键调节，status 读当前档位文字
//       { type: 'submenu', match, item }   菜单里名字匹配 match 的子菜单，里面是各档位
//       { type: 'section', item }          与模型同一个菜单里的另一组选项
//       null                               没有
//   history    按标题查找历史对话：
//     { type: 'chatgpt-api' } / { type: 'claude-api' }  用网站自己的接口列出全部对话并读取内容
//     { type: 'sidebar', item, title, scroller, question }  在侧边栏里找标题，点开后从页面读最后一轮问答

// 大多数网站的弹出菜单遵循 ARIA 规范
const YX_MENU = ['[role="menu"]', '.mat-mdc-menu-panel'];

const YX_SITES = {
  claude: {
    name: 'Claude',
    host: 'claude.ai',
    newChatUrl: 'https://claude.ai/new',
    input: [
      '[data-testid="chat-input"][contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]'
    ],
    sendButton: [
      'button[data-testid="chat-input-send"]',
      'button[aria-label="发送消息"]',
      'button[aria-label*="Send"]'
    ],
    stopButton: [
      'button[data-testid*="stop"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop"]'
    ],
    streaming: ['[data-is-streaming="true"]'],
    message: ['[data-testid="assistant-message"]', 'div[data-is-streaming]'],
    content: ['[data-perf-reply-text]', '.standard-markdown', '.font-claude-response'],
    picker: {
      trigger: ['button[data-testid="model-selector-dropdown"]'],
      menu: YX_MENU,
      models: {
        item: ['[role="menuitemradio"]'],
        more: /更多模型|more models/i
      },
      effort: {
        type: 'submenu',
        match: /努力程度|effort|思考/i,
        item: ['[role="menuitemradio"]']
      }
    },
    history: { type: 'claude-api' }
  },

  chatgpt: {
    name: 'ChatGPT',
    host: 'chatgpt.com',
    newChatUrl: 'https://chatgpt.com/',
    input: [
      '.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      '#prompt-textarea'
    ],
    sendButton: [
      'button[aria-label="发送"]',
      'button[aria-label="Send"]',
      'button[data-testid="send-button"]',
      '#composer-submit-button'
    ],
    stopButton: [
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop"]',
      'button[data-testid="stop-button"]'
    ],
    // 每条回答带 data-talvt-turn-state，生成完是 complete
    streaming: ['[data-talvt-turn-state]:not([data-talvt-turn-state="complete"])'],
    message: ['[data-talvt-turn-state]', 'div[data-message-author-role="assistant"]'],
    content: ['[data-markdown-text-style="assistant-message"]', '.markdown'],
    modes: {
      group: ['[role="group"][aria-label="撰写器模式"]', '[role="group"][aria-label*="mode" i]']
    },
    picker: {
      trigger: ['button[aria-label="选择 ChatGPT 模型"]', 'button[aria-label*="ChatGPT"][aria-haspopup="menu"][aria-label*="模型"]', 'button[aria-label*="model" i][aria-haspopup="menu"]'],
      menu: YX_MENU,
      models: {
        reveal: ['[role="menuitem"][aria-label="选择模型"]', '[role="menuitem"][aria-label*="model" i]'],
        item: ['[role="menuitemradio"]']
      },
      effort: {
        type: 'slider',
        item: ['[role="menuitem"][aria-label="强度"]', '[role="menuitem"][aria-label*="effort" i]', '[role="menuitem"][aria-keyshortcuts*="ArrowLeft"]'],
        status: '[role="status"]'
      }
    },
    history: { type: 'chatgpt-api' }
  },

  gemini: {
    name: 'Gemini',
    host: 'gemini.google.com',
    newChatUrl: 'https://gemini.google.com/app',
    input: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]'
    ],
    sendButton: [
      'button[aria-label="发送"]',
      'button.send-button:not(.stop)',
      'button[aria-label*="Send"]'
    ],
    stopButton: [
      'button.send-button.stop',
      'button[aria-label*="停止"]',
      'button[aria-label*="Stop"]'
    ],
    streaming: [],
    message: ['model-response'],
    content: ['message-content .markdown', '.model-response-text .markdown', 'message-content'],
    picker: {
      trigger: ['button[data-test-id="bard-mode-menu-button"]', 'button[aria-label*="模式选择器"]'],
      menu: YX_MENU,
      models: {
        item: ['[role="menuitem"][data-test-id^="bard-mode-option"]']
      },
      // 同一个菜单分割线下面的“低点 / 中等 / 高点”
      effort: {
        type: 'section',
        item: ['[role="menuitem"]:not([data-test-id^="bard-mode-option"])']
      }
    },
    history: {
      type: 'sidebar',
      item: '[data-test-id="conversation"]',
      title: '.title-text',
      scroller: 'infinite-scroller',
      menuButton: ['button[data-test-id="side-nav-menu-button"]', 'button[aria-label="主菜单"]', 'button[aria-label*="menu" i]'],
      question: ['user-query .query-text-line', 'user-query .query-text']
    }
  }
};
