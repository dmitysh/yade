import { useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppearance } from "./appearance";
import { openFileLink, resolveFileLink, type FileLinks } from "./fileLinks";

export default function MessageContent({ body, workspacePath, fileWorkspaces, openFile }: { body: string } & FileLinks) {
  const { appearance } = useAppearance();
  const [error, setError] = useState("");
  const local = (href: string) => workspacePath && openFile ? resolveFileLink(href, workspacePath, fileWorkspaces) : null;
  return appearance.chatFormat === "source" ? <pre className="message-source">{body}</pre>
    : <div className="message-formatted"><Markdown remarkPlugins={[remarkGfm]} urlTransform={(url, key) => key === "href" && local(url) ? url : defaultUrlTransform(url)} components={{
      table: ({ node: _node, ...props }) => <div className="message-table" role="region" aria-label="Таблица" tabIndex={0}><table {...props} /></div>,
      a: ({ node: _node, href, ...props }) => {
        const link = href ? local(href) : null;
        return link ? <a {...props} href={href} onClick={event => {
          event.preventDefault(); setError("");
          void openFileLink(link, openFile!).catch(reason => setError(String(reason)));
        }} /> : <a {...props} href={href} target="_blank" rel="noreferrer" />;
      },
    }}>{body}</Markdown>{error && <p role="alert" className="error">{error}</p>}</div>;
}
