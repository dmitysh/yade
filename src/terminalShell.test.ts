import { expect, test } from "vitest";
import { ShellStream } from "./terminalShell";

test("маркеры оболочки распознаются при любом разделении байтов UTF-8 и OSC", () => {
  const bytes = [...new TextEncoder().encode("до\x1b]777;secret;C\x07вывод\x1b]777;secret;P;130\x07после")];
  for (let split = 0; split <= bytes.length; split++) {
    const stream = new ShellStream();
    const parts = [...stream.push(bytes.slice(0, split), "secret"), ...stream.push(bytes.slice(split), "secret")];
    const data = parts.flatMap(part => "data" in part ? [...part.data] : []);
    expect(new TextDecoder().decode(new Uint8Array(data))).toBe("довыводпосле");
    expect(parts.filter(part => "event" in part)).toEqual([{ event: "command" }, { event: "prompt", status: 130 }]);
  }
});

test("чужие и незавершённые последовательности не становятся событиями оболочки", () => {
  const stream = new ShellStream();
  const text = "\x1b]777;other;P;0\x07\x1b]2;title\x07\x1b]777;secret;P;";
  const parts = stream.push([...new TextEncoder().encode(text)], "secret");
  const bytes = [...parts.flatMap(part => "data" in part ? [...part.data] : []), ...stream.finish()];
  expect(parts.every(part => "data" in part)).toBe(true);
  expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe(text);
});

test("команда и длительность передаются в событии без зависимости от последующих команд", () => {
  const command = "printf 'привет'\nfalse";
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(command)));
  const stream = new ShellStream();
  const parts = stream.push([...new TextEncoder().encode(`\x1b]777;t;C;${encoded}\x07\x1b]777;t;P;1;120.500\x07\x1b]777;t;B\x07`)], "t");
  expect(parts).toEqual([{ event: "command", command }, { event: "prompt", status: 1, duration: 120.5 }, { event: "input" }]);
});

