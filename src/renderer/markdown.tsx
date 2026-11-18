// Small, safe Markdown renderer: builds elements directly (no innerHTML).
import type { ComponentChildren } from 'preact';

type OpenLink = (url: string) => void;

function inline(text: string, open: OpenLink): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>)]+)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong>{inline(m[2].slice(2, -2), open)}</strong>);
    else if (m[3]) out.push(<em>{inline(m[3].slice(1, -1), open)}</em>);
    else {
      const url = m[5] ?? m[6];
      out.push(
        <a href={url} title={url} onClick={(e) => (e.preventDefault(), open(url))}>
          {m[4] ?? url}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, open }: { text: string; open: OpenLink }) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ComponentChildren[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (line.trimStart().startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre><code>{body.join('\n')}</code></pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)![0].length + 2, 6);
      const Tag = `h${level}` as 'h3';
      blocks.push(<Tag>{inline(line.replace(/^#+\s*/, ''), open)}</Tag>);
      i++;
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const items: ComponentChildren[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(<li>{inline(item, open)}</li>);
      }
      blocks.push(ordered ? <ol>{items}</ol> : <ul>{items}</ul>);
    } else if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote>{inline(body.join(' '), open)}</blockquote>);
    } else if (line.includes('|') && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? '')) {
      const row = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(row(lines[i++]));
      blocks.push(
        <table>
          <thead><tr>{head.map((c) => <th>{inline(c, open)}</th>)}</tr></thead>
          <tbody>{rows.map((r) => <tr>{r.map((c) => <td>{inline(c, open)}</td>)}</tr>)}</tbody>
        </table>,
      );
    } else {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*([-*•]|\d+[.)])\s+|>|\s*```)/.test(lines[i])) body.push(lines[i++]);
      blocks.push(<p>{inline(body.join('\n'), open)}</p>);
    }
  }
  return <div class="md">{blocks}</div>;
}
