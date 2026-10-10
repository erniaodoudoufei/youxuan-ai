// 内容脚本和对比页共用：把网页上的回答节点清洗成安全的 HTML，并转成 Markdown 文本。

const YX_KEEP = new Set([
  'P', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
  'PRE', 'CODE', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'BLOCKQUOTE',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'A', 'SUP', 'SUB', 'KBD'
]);
const YX_DROP = new Set([
  'SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'IMG', 'NOSCRIPT', 'IFRAME', 'INPUT',
  'TEXTAREA', 'SELECT', 'FORM', 'TEMPLATE', 'OBJECT', 'EMBED', 'CANVAS',
  'VIDEO', 'AUDIO', 'MATH', 'LINK', 'META'
]);

// 公式（KaTeX）换成 $...$ 原文，否则只剩一堆乱码文字
function yxReplaceMath(root) {
  root.querySelectorAll('.katex').forEach((k) => {
    const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (!tex) return;
    const display = !!k.closest('.katex-display');
    k.replaceWith(document.createTextNode(display ? `\n$$${tex}$$\n` : `$${tex}$`));
  });
}

// 只保留白名单标签、去掉所有属性（链接只留 http/https 的 href），返回 HTML 字符串
function yxSanitize(root) {
  const out = document.createElement('div');
  const walk = (src, dst) => {
    for (const n of src.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        dst.appendChild(document.createTextNode(n.nodeValue));
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.tagName.toUpperCase();
        if (YX_DROP.has(tag) || n.getAttribute('aria-hidden') === 'true') continue;
        if (YX_KEEP.has(tag)) {
          const el = document.createElement(tag.toLowerCase());
          if (tag === 'A') {
            const href = n.getAttribute('href') || '';
            if (/^https?:\/\//i.test(href)) {
              el.setAttribute('href', href);
              el.setAttribute('target', '_blank');
              el.setAttribute('rel', 'noopener noreferrer');
            }
          }
          // 代码块里常混着“语言名 / 复制”之类的头部，只保留 <code> 本体
          const codes = tag === 'PRE' ? n.querySelectorAll('code') : [];
          if (codes.length) codes.forEach((c) => walk(c, el.appendChild(document.createElement('code'))));
          else walk(n, el);
          dst.appendChild(el);
        } else {
          // 不认识的标签（div/span/自定义元素）：去掉外壳，保留内容
          const block = /^(DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN|FIGURE)$/.test(tag);
          if (block && dst.lastChild && dst.lastChild.nodeType === Node.TEXT_NODE) {
            dst.appendChild(document.createElement('br'));
          }
          walk(n, dst);
        }
      }
    }
  };
  walk(root, out);
  return out.innerHTML;
}

// 已清洗的 HTML → Markdown（给裁判提示词和“复制”按钮用）
function yxToMarkdown(html) {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstChild;
  const inline = (node) => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) { s += n.nodeValue; continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const t = n.tagName;
      if (t === 'BR') s += '\n';
      else if (t === 'CODE') s += '`' + n.textContent + '`';
      else if (t === 'STRONG' || t === 'B') s += '**' + inline(n) + '**';
      else if (t === 'EM' || t === 'I') s += '*' + inline(n) + '*';
      else if (t === 'A') s += n.getAttribute('href') ? `[${inline(n)}](${n.getAttribute('href')})` : inline(n);
      else if (/^(P|H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE|HR)$/.test(t)) s += '\n' + block(n, '') + '\n';
      else s += inline(n);
    }
    return s;
  };
  const block = (n, indent) => {
    const t = n.tagName;
    if (/^H[1-6]$/.test(t)) return '#'.repeat(+t[1]) + ' ' + inline(n).trim();
    if (t === 'P') return inline(n).trim();
    if (t === 'HR') return '---';
    if (t === 'PRE') return '```\n' + n.textContent.replace(/\n$/, '') + '\n```';
    if (t === 'BLOCKQUOTE') return blocks(n, '').split('\n').map((l) => '> ' + l).join('\n');
    if (t === 'UL' || t === 'OL') {
      let i = 0;
      return [...n.children].filter((c) => c.tagName === 'LI').map((li) => {
        const mark = t === 'OL' ? `${++i}. ` : '- ';
        // 嵌套缩进由下面的 replace 统一加
        const body = blocks(li, '').trim().replace(/\n\s*\n/g, '\n');
        return indent + mark + body.replace(/\n/g, '\n' + indent + '   ');
      }).join('\n');
    }
    if (t === 'TABLE') {
      const rows = [...n.querySelectorAll('tr')].map((tr) =>
        '| ' + [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |');
      if (rows.length) {
        const cols = n.querySelector('tr').children.length;
        rows.splice(1, 0, '|' + ' --- |'.repeat(cols));
      }
      return rows.join('\n');
    }
    return inline(n).trim();
  };
  const blocks = (node, indent) => {
    const parts = [];
    let buf = '';
    for (const n of node.childNodes) {
      const isBlock = n.nodeType === Node.ELEMENT_NODE &&
        /^(P|H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE|HR)$/.test(n.tagName);
      if (isBlock) {
        if (buf.trim()) parts.push(buf.trim());
        buf = '';
        parts.push(block(n, indent));
      } else {
        const wrap = document.createElement('span');
        wrap.appendChild(n.cloneNode(true));
        buf += inline(wrap);
      }
    }
    if (buf.trim()) parts.push(buf.trim());
    return parts.join('\n\n');
  };
  return blocks(root, '').replace(/\n{3,}/g, '\n\n').trim();
}
