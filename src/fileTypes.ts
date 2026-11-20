export interface FileType {
  id: string;
  label: string;
  icon: string;
  extensions: string[];
  filename?: RegExp;
  aliases?: string[];
}

export const fileTypes: FileType[] = [
  { id: "Go", label: "Go", icon: "go", extensions: ["go"] },
  { id: "Rust", label: "Rust", icon: "rust", extensions: ["rs"] },
  { id: "JavaScript", label: "JavaScript", icon: "javascript", extensions: ["js", "mjs", "cjs"], aliases: ["js", "node", "ecmascript"] },
  { id: "TypeScript", label: "TypeScript", icon: "typescript", extensions: ["ts", "mts", "cts"], aliases: ["ts"] },
  { id: "JSX", label: "JSX", icon: "react", extensions: ["jsx"] },
  { id: "TSX", label: "TSX", icon: "react_ts", extensions: ["tsx"] },
  { id: "Python", label: "Python", icon: "python", extensions: ["py", "pyw", "pyi"], aliases: ["py", "python3"] },
  { id: "Java", label: "Java", icon: "java", extensions: ["java"] },
  { id: "Kotlin", label: "Kotlin", icon: "kotlin", extensions: ["kt", "kts"] },
  { id: "C", label: "C", icon: "c", extensions: ["c", "h"] },
  { id: "C++", label: "C++", icon: "cpp", extensions: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx", "h++"], aliases: ["cpp", "cxx"] },
  { id: "C#", label: "C#", icon: "csharp", extensions: ["cs"], aliases: ["csharp", "cs"] },
  { id: "PHP", label: "PHP", icon: "php", extensions: ["php", "phtml"] },
  { id: "Ruby", label: "Ruby", icon: "ruby", extensions: ["rb"], filename: /^(Gemfile|Rakefile)$/i, aliases: ["rb"] },
  { id: "Swift", label: "Swift", icon: "swift", extensions: ["swift"] },
  { id: "Dart", label: "Dart", icon: "dart", extensions: ["dart"] },
  { id: "Lua", label: "Lua", icon: "lua", extensions: ["lua"] },
  { id: "Shell", label: "sh / Bash / Zsh", icon: "console", extensions: ["sh", "bash", "zsh", "ksh"], filename: /^\.(profile|bashrc|bash_profile|zshrc|zprofile)$/i, aliases: ["sh", "bash", "zsh", "ksh"] },
  { id: "PowerShell", label: "PowerShell", icon: "powershell", extensions: ["ps1", "psm1", "psd1"], aliases: ["ps1", "pwsh"] },
  { id: "HTML", label: "HTML", icon: "html", extensions: ["html", "htm"] },
  { id: "CSS", label: "CSS", icon: "css", extensions: ["css"] },
  { id: "Sass", label: "Sass", icon: "sass", extensions: ["sass"] },
  { id: "SCSS", label: "SCSS", icon: "sass", extensions: ["scss"] },
  { id: "LESS", label: "Less", icon: "less", extensions: ["less"] },
  { id: "Vue", label: "Vue", icon: "vue", extensions: ["vue"] },
  { id: "JSON", label: "JSON", icon: "json", extensions: ["json"] },
  { id: "JSONC", label: "JSONC", icon: "json", extensions: ["jsonc"], filename: /^(tsconfig|jsconfig)(\..+)?\.json$/i },
  { id: "YAML", label: "YAML", icon: "yaml", extensions: ["yaml", "yml"], aliases: ["yml"] },
  { id: "TOML", label: "TOML", icon: "toml", extensions: ["toml"], filename: /^(Cargo\.lock|Pipfile)$/i },
  { id: "Properties files", label: "INI и свойства", icon: "settings", extensions: ["ini", "properties"], filename: /^\.(editorconfig|gitconfig|gitmodules)$/i, aliases: ["ini", "properties"] },
  { id: "Env", label: "Переменные окружения", icon: "tune", extensions: ["env"], filename: /^\.env(?:\..+)?$/i, aliases: ["dotenv", "env"] },
  { id: "Markdown", label: "Markdown", icon: "markdown", extensions: ["md", "markdown", "mkd"], aliases: ["md"] },
  { id: "XML", label: "XML", icon: "xml", extensions: ["xml", "xsd", "xsl", "xslt"] },
  { id: "SVG", label: "SVG (XML)", icon: "svg", extensions: ["svg"] },
  { id: "SQL", label: "SQL", icon: "database", extensions: ["sql"] },
  { id: "ProtoBuf", label: "Protocol Buffers", icon: "proto", extensions: ["proto"], aliases: ["proto", "protobuf"] },
  { id: "Dockerfile", label: "Dockerfile", icon: "docker", extensions: ["dockerfile"], filename: /^Dockerfile(?:\..+)?$/i, aliases: ["docker"] },
  { id: "CMake", label: "CMake", icon: "cmake", extensions: ["cmake"], filename: /^CMakeLists\.txt$/i },
  { id: "Nginx", label: "Nginx", icon: "nginx", extensions: ["nginx.conf"], filename: /^nginx(?:\..+)?\.conf$/i },
  { id: "diff", label: "Различия версий", icon: "git", extensions: ["diff", "patch"], aliases: ["patch"] },
  { id: "text", label: "Обычный текст", icon: "document", extensions: ["txt", "log", "tf", "tfvars", "csv", "tsv", "mk"], filename: /^(go\.(mod|sum|work|work\.sum)|yarn\.lock|Makefile|GNUmakefile|\.gitignore|\.gitattributes|LICENSE|COPYING|NOTICE)$/i },
];

const extensions = fileTypes.flatMap(type => type.extensions.map(extension => ({ type, extension })))
  .sort((a, b) => b.extension.length - a.extension.length);

export function fileType(path: string, body = ""): FileType {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const special = fileTypes.find(type => type.filename?.test(name));
  if (special) return special;
  const lower = name.toLowerCase();
  const byExtension = extensions.find(({ extension }) => lower.endsWith(`.${extension}`));
  if (byExtension) return byExtension.type;
  const interpreter = /^\uFEFF?#!\s*(?:\S*\/)?(sh|bash|zsh|python3?|node)(?:\s|$)/.exec(body)?.[1]
    ?? /^\uFEFF?#!\s*\/usr\/bin\/env\s+(sh|bash|zsh|python3?|node)(?:\s|$)/.exec(body)?.[1];
  if (interpreter) return fileTypes.find(type => type.id === (interpreter.startsWith("python") ? "Python" : interpreter === "node" ? "JavaScript" : "Shell"))!;
  return fileTypes[fileTypes.length - 1];
}

const iconNames: [RegExp, string][] = [
  [/^go\.(mod|sum|work|work\.sum)$/i, "go-mod"],
  [/^(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i, "nodejs"],
  [/^Cargo\.(toml|lock)$/i, "rust"],
  [/^(Makefile|GNUmakefile)$|\.mk$/i, "makefile"],
  [/^\.(gitignore|gitattributes|gitmodules|gitconfig)$/i, "git"],
  [/^(LICENSE(?:\..+)?|COPYING|NOTICE)$/i, "license"],
  [/\.(tf|tfvars)$/i, "terraform"],
  [/\.(csv|tsv)$/i, "table"],
  [/\.log$/i, "log"],
  [/\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|heic)$/i, "image"],
  [/\.pdf$/i, "pdf"],
  [/\.(zip|gz|bz2|xz|tar|tgz|7z|rar|zst)$/i, "zip"],
  [/\.(woff2?|ttf|otf|eot)$/i, "font"],
  [/\.(exe|dll|so|dylib|app|dmg|bin|o|a|wasm)$/i, "exe"],
  [/\.(db|sqlite3?|mdb)$/i, "database"],
];

export function fileIcon(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return iconNames.find(([pattern]) => pattern.test(name))?.[1] ?? fileType(path).icon;
}
