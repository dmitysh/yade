import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { fileIcon, fileType } from "./fileTypes";

const matrix: [string, string][] = [
  ["Go", "main.go"], ["Rust", "main.rs"],
  ["JavaScript", "app.js app.mjs app.cjs"],
  ["TypeScript", "app.ts app.mts app.cts app.d.ts app.d.mts app.d.cts"],
  ["JSX", "app.jsx"], ["TSX", "app.tsx"], ["Python", "app.py app.pyw app.pyi"],
  ["Java", "Main.java"], ["Kotlin", "main.kt main.kts"], ["C", "main.c main.h"],
  ["C++", "main.cpp main.cc main.cxx main.c++ main.hpp main.hh main.hxx main.h++"],
  ["C#", "main.cs"], ["PHP", "index.php index.phtml"], ["Ruby", "main.rb Gemfile Rakefile"],
  ["Swift", "main.swift"], ["Dart", "main.dart"], ["Lua", "main.lua"],
  ["Shell", "run.sh run.bash run.zsh run.ksh .profile .bashrc .bash_profile .zshrc .zprofile"],
  ["PowerShell", "run.ps1 run.psm1 run.psd1"], ["HTML", "index.html index.htm"],
  ["CSS", "style.css"], ["Sass", "style.sass"], ["SCSS", "style.scss"], ["LESS", "style.less"], ["Vue", "App.vue"],
  ["JSON", "data.json package.json package-lock.json"],
  ["JSONC", "data.jsonc tsconfig.json tsconfig.app.json jsconfig.json jsconfig.test.json"],
  ["YAML", "data.yaml data.yml compose.yaml pnpm-lock.yaml"],
  ["TOML", "config.toml Cargo.toml Cargo.lock Pipfile"],
  ["Properties files", "config.ini config.properties .editorconfig .gitconfig .gitmodules"],
  ["Env", ".env .env.local .env.production.local production.env"],
  ["Markdown", "README.md README.markdown README.mkd"], ["XML", "data.xml data.xsd data.xsl data.xslt"],
  ["SVG", "image.svg"], ["SQL", "query.sql"], ["ProtoBuf", "message.proto"],
  ["Dockerfile", "Dockerfile Dockerfile.dev app.dockerfile"], ["CMake", "CMakeLists.txt app.cmake"],
  ["Nginx", "nginx.conf nginx.prod.conf prod.nginx.conf"], ["diff", "change.diff change.patch"],
  ["text", "go.mod go.sum go.work go.work.sum yarn.lock Makefile makefile GNUmakefile app.mk .gitignore .gitattributes LICENSE COPYING NOTICE main.tf main.tfvars data.csv data.tsv file.txt app.log unknown.conf unknown.file README"],
];

test.each(matrix.flatMap(([id, names]) => names.split(" ").map(name => ({ id, name }))))("$name → $id, имя важнее строки интерпретатора", ({ id, name }) => {
  expect(fileType(`project/${name}`, "#!/usr/bin/env python3\n").id).toBe(id === "text" && ["unknown.conf", "unknown.file", "README"].includes(name) ? "Python" : id);
  expect(fileType(`project/${name}`).id).toBe(id);
});

test.each(["sh", "bash", "zsh", "python", "python3", "node"]) ("известный интерпретатор %s без выполнения файла", interpreter => {
  const expected = interpreter.startsWith("python") ? "Python" : interpreter === "node" ? "JavaScript" : "Shell";
  for (const line of [`#!/usr/bin/${interpreter}`, `#!/usr/bin/env ${interpreter}`, `#!/bin/${interpreter} -e`]) {
    expect(fileType("tools/run", `${line}\n`).id).toBe(expected);
    expect(fileType("tools/run", `\uFEFF${line}\r\n`).id).toBe(expected);
  }
  expect(fileType("tools/run", `\n#!/usr/bin/env ${interpreter}`).id).toBe("text");
});

test("неизвестный интерпретатор и совпадение в середине строки не выбирают режим", () => {
  for (const line of ["#!/usr/bin/env perl", "#!/usr/bin/python30", "#!/usr/bin/env nodejs", "text #!/bin/bash"]) {
    expect(fileType("run", line).id).toBe("text");
  }
});

test.each([
  ["go.work.sum", "go-mod"], ["package.json", "nodejs"], ["package-lock.json", "nodejs"], ["pnpm-lock.yaml", "nodejs"], ["yarn.lock", "nodejs"],
  ["Cargo.toml", "rust"], ["Cargo.lock", "rust"], ["Makefile", "makefile"], ["test.mk", "makefile"],
  [".gitignore", "git"], [".gitmodules", "git"], ["LICENSE.md", "license"], ["COPYING", "license"], ["main.tf", "terraform"],
  ["data.csv", "table"], ["file.txt", "document"], ["file.log", "log"], ["photo.png", "image"], ["photo.jpg", "image"],
  ["book.pdf", "pdf"], ["file.tar.gz", "zip"], ["font.woff2", "font"], ["app.exe", "exe"], ["data.sqlite3", "database"],
  ["unknown", "document"], ["main.ts", "typescript"], ["App.jsx", "react"], ["App.tsx", "react_ts"],
])("%s получает иконку %s, SVG есть в локальной поставке", (path, icon) => {
  expect(fileIcon(`src/${path}`)).toBe(icon);
  const svg = readFileSync(`public/file-icons/${icon}.svg`, "utf8");
  expect(svg).toContain("<svg");
  expect(svg).not.toMatch(/<script|<foreignObject|https?:\/\/(?!www\.w3\.org\/)/);
});

test("иконки всей матрицы существуют локально вместе с лицензией", () => {
  for (const [, names] of matrix) for (const name of names.split(" ")) {
    expect(existsSync(`public/file-icons/${fileIcon(name)}.svg`), name).toBe(true);
  }
  expect(readFileSync("public/licenses/Material-Icon-Theme-LICENSE.txt", "utf8")).toContain("Material Extensions");
});
