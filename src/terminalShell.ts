export type ShellPart = { data: Uint8Array } | { event: "submitted" | "command" | "prompt" | "input"; command?: string; status?: number; duration?: number };
export interface ShellEditor { request: number; command: string; cursor: number; suggestion: string; commandKnown: boolean }

export class ShellStream {
  private pending: number[] = [];
  push(data: number[], token?: string | null): ShellPart[] {
    if (!token) return data.length ? [{ data: new Uint8Array(data) }] : [];
    const bytes = [...this.pending, ...data];
    const prefix = Array.from(new TextEncoder().encode(`\x1b]777;${token};`));
    const parts: ShellPart[] = [];
    this.pending = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 27) continue;
      let j = 0;
      while (j < prefix.length && i + j < bytes.length && bytes[i + j] === prefix[j]) j++;
      if (i + j === bytes.length && j < prefix.length) {
        if (i > start) parts.push({ data: new Uint8Array(bytes.slice(start, i)) });
        this.pending = bytes.slice(i); return parts;
      }
      if (j !== prefix.length) continue;
      const end = bytes.indexOf(7, i + j);
      if (end < 0 && bytes.length - i < 2 * 1024 * 1024) {
        if (i > start) parts.push({ data: new Uint8Array(bytes.slice(start, i)) });
        this.pending = bytes.slice(i); return parts;
      }
      const value = new TextDecoder().decode(new Uint8Array(bytes.slice(i + j, end < 0 ? i + j : end)));
      let event: ShellPart;
      if (value === "C") event = { event: "command" };
      else if (value === "B") event = { event: "input" };
      else if (value.startsWith("C;") || value.startsWith("S;")) {
        try { event = { event: value[0] === "S" ? "submitted" : "command", command: new TextDecoder().decode(Uint8Array.from(atob(value.slice(2)), char => char.charCodeAt(0))) }; }
        catch { continue; }
      } else if (/^P;\d{1,3}(;\d+(\.\d+)?)?$/.test(value)) {
        const fields = value.split(";");
        event = { event: "prompt", status: Number(fields[1]), ...(fields[2] ? { duration: Number(fields[2]) } : {}) };
      } else continue;
      if (i > start) parts.push({ data: new Uint8Array(bytes.slice(start, i)) });
      parts.push(event);
      i = end; start = end + 1;
    }
    if (start < bytes.length) parts.push({ data: new Uint8Array(bytes.slice(start)) });
    return parts;
  }
  finish(): Uint8Array {
    const data = new Uint8Array(this.pending); this.pending = []; return data;
  }
}

