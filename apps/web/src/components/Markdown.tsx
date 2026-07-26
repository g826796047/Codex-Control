import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ breaks: true, gfm: true });

export function Markdown({ children }: { children: string }) {
  const html = DOMPurify.sanitize(marked.parse(children, { async: false }) as string, { USE_PROFILES: { html: true } });
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

