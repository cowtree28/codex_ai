// 아주 작은 마크다운 렌더러. HTML을 직접 넣지 않고 React 요소로만 만들어 안전하다.
// 지원: # 제목, - 목록, 1. 목록, > 인용, ``` 코드 블록, **굵게**, *기울임*, `코드`, [글](주소), [[노트 링크]]
function inline(text, onLink, keyBase) {
  const parts = [];
  const pattern = /(\[\[([^\[\]\n]+)\]\]|\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let match;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const key = `${keyBase}-${index++}`;
    const target = match[2] ? match[2].trim() : ""; // 반복문 변수는 바뀌므로 링크 대상을 따로 잡아 둔다.
    if (match[2]) parts.push(<button key={key} type="button" className="wiki-link" onClick={() => onLink(target)}>{match[2]}</button>);
    else if (match[3]) parts.push(<strong key={key}>{match[3]}</strong>);
    else if (match[4]) parts.push(<em key={key}>{match[4]}</em>);
    else if (match[5]) parts.push(<code key={key}>{match[5]}</code>);
    else if (match[6]) parts.push(<a key={key} href={match[7]} target="_blank" rel="noreferrer noopener">{match[6]}</a>);
    last = pattern.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function Markdown({ text, onLink }) {
  const lines = (text || "").split("\n");
  const blocks = [];
  let list = null;
  let code = null;
  const flush = () => { if (list) { blocks.push(list); list = null; } };
  lines.forEach((line, i) => {
    if (code) {
      if (line.startsWith("```")) { blocks.push(<pre key={`c${i}`}><code>{code.join("\n")}</code></pre>); code = null; }
      else code.push(line);
      return;
    }
    if (line.startsWith("```")) { flush(); code = []; return; }
    const heading = line.match(/^(#{1,3})\s+(.*)/);
    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const numbered = line.match(/^\s*\d+\.\s+(.*)/);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [], key: `l${i}` }; }
      list.items.push(<li key={`i${i}`}>{inline((bullet || numbered)[1], onLink, `i${i}`)}</li>);
      return;
    }
    flush();
    if (heading) { const Tag = `h${heading[1].length + 2}`; blocks.push(<Tag key={`h${i}`}>{inline(heading[2], onLink, `h${i}`)}</Tag>); }
    else if (line.startsWith("> ")) blocks.push(<blockquote key={`q${i}`}>{inline(line.slice(2), onLink, `q${i}`)}</blockquote>);
    else if (line.trim()) blocks.push(<p key={`p${i}`}>{inline(line, onLink, `p${i}`)}</p>);
  });
  flush();
  if (code) blocks.push(<pre key="c-end"><code>{code.join("\n")}</code></pre>);
  return <div className="markdown">{blocks.map((block) => block.items ? (block.ordered ? <ol key={block.key}>{block.items}</ol> : <ul key={block.key}>{block.items}</ul>) : block)}</div>;
}
