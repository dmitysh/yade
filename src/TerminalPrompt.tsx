import { Icon } from "./Ide";

export interface TerminalLocation { cwd: string; home?: string; branch?: string }

export function TerminalPrompt({ cwd, home, branch }: TerminalLocation) {
  const path = home && (cwd === home || cwd.startsWith(home + "/")) ? "~" + cwd.slice(home.length) : cwd;
  return <span className="terminal-context">
    <span className="terminal-context-path" title={cwd}><Icon name="project" /><span>{path}</span></span>
    {branch && <span className="terminal-context-branch" title={branch}><Icon name="git" /><span>{branch}</span></span>}
  </span>;
}

export function TerminalCommand({ command, known = false }: { command: string; known?: boolean }) {
  const match = known && command.match(/^(\s*)(\S+)([\s\S]*)$/);
  return <code className="terminal-command-line">{match ? <>{match[1]}<span className="terminal-executable">{match[2]}</span>{match[3]}</> : command}</code>;
}
