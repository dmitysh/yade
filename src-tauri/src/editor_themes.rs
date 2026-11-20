use crate::store::Result;
use serde::Serialize;
use serde_json::{Map, Value};
use std::{collections::HashMap, fs::File, io::Read, path::Path};
use zip::ZipArchive;

const FILE_LIMIT: u64 = 4 * 1024 * 1024;
const TOTAL_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub dark: bool,
    pub colors: Map<String, Value>,
    pub token_colors: Vec<Value>,
}

struct Package {
    archive: ZipArchive<File>,
    files: HashMap<String, Value>,
    bytes: usize,
}

impl Package {
    fn read(&mut self, path: &str) -> Result<Value> {
        if let Some(value) = self.files.get(path) {
            return Ok(value.clone());
        }
        let mut file = self
            .archive
            .by_name(path)
            .map_err(|e| format!("Файл темы {path} недоступен: {e}"))?;
        if file.size() > FILE_LIMIT {
            return Err(format!("Файл темы {path} превышает 4 МиБ."));
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(FILE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        self.bytes += bytes.len();
        if bytes.len() as u64 > FILE_LIMIT || self.bytes > TOTAL_LIMIT {
            return Err("Файлы темы превышают допустимый размер.".into());
        }
        let value: Value = if path.to_ascii_lowercase().ends_with(".tmtheme") {
            plist::from_bytes(&bytes).map_err(|e| format!("Некорректная тема {path}: {e}"))?
        } else {
            let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
            jsonc_parser::parse_to_serde_value(
                text.trim_start_matches('\u{feff}'),
                &Default::default(),
            )
            .map_err(|e| format!("Некорректный файл темы {path}: {e}"))?
        };
        if !value.is_object() {
            return Err(format!("Файл темы {path} должен содержать объект."));
        }
        self.files.insert(path.into(), value.clone());
        Ok(value)
    }

    fn theme(&mut self, path: &str, stack: &mut Vec<String>) -> Result<Theme> {
        if stack.len() >= 32 || stack.iter().any(|item| item == path) {
            return Err(format!(
                "Циклическое или слишком глубокое включение файлов темы: {path}"
            ));
        }
        stack.push(path.into());
        let value = self.read(path)?;
        let mut theme = match value.get("include") {
            Some(Value::String(include)) => self.theme(&resource(path, include)?, stack)?,
            None => Theme::default(),
            _ => return Err(format!("Некорректное включение файла темы: {path}")),
        };
        if let Some(colors) = value.get("colors") {
            let colors = colors
                .as_object()
                .ok_or("Поле colors должно содержать объект.")?;
            theme.colors.extend(colors.clone());
        }
        let tokens = match value.get("tokenColors") {
            Some(Value::String(file)) => Some(
                self.read(&resource(path, file)?)?
                    .get("settings")
                    .cloned()
                    .ok_or("В файле TextMate отсутствуют правила подсветки.")?,
            ),
            Some(tokens) => Some(tokens.clone()),
            None => value.get("settings").cloned(),
        };
        if let Some(tokens) = tokens {
            let tokens = tokens
                .as_array()
                .ok_or("Правила подсветки должны содержать список.")?;
            if tokens.iter().any(|token| {
                !token.is_object() || !token.get("settings").is_some_and(Value::is_object)
            }) {
                return Err("Некорректное правило подсветки темы.".into());
            }
            theme.token_colors.extend(tokens.iter().cloned());
        }
        if theme.token_colors.len() > 16384 || theme.colors.len() > 2048 {
            return Err("В теме слишком много правил оформления.".into());
        }
        stack.pop();
        Ok(theme)
    }
}

fn resource(from: &str, relative: &str) -> Result<String> {
    let relative = relative.replace('\\', "/");
    if relative.starts_with('/')
        || relative.contains(':')
        || relative.contains('\0')
        || relative.len() > 4096
    {
        return Err("Файлы темы должны находиться внутри пакета расширения.".into());
    }
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.len() > 1 => {
                parts.pop();
            }
            ".." => return Err("Файл темы выходит за пределы пакета расширения.".into()),
            part => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}

pub fn import(path: &Path) -> Result<Vec<Theme>> {
    let file = File::open(path).map_err(|e| format!("Не удалось открыть пакет тем: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err("Выберите файл VSIX размером не больше 64 МиБ.".into());
    }
    let archive = ZipArchive::new(file).map_err(|e| format!("Некорректный пакет VSIX: {e}"))?;
    if archive.len() > 20000 {
        return Err("В пакете расширения слишком много файлов.".into());
    }
    let mut package = Package {
        archive,
        files: HashMap::new(),
        bytes: 0,
    };
    let manifest = package.read("extension/package.json")?;
    let definitions = manifest
        .pointer("/contributes/themes")
        .and_then(Value::as_array)
        .filter(|themes| !themes.is_empty() && themes.len() <= 128)
        .ok_or("В расширении нет цветовых тем или их больше 128.")?;
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .ok_or("В пакете отсутствует имя расширения.")?;
    let publisher = manifest
        .get("publisher")
        .and_then(Value::as_str)
        .unwrap_or("");
    let labels = if package
        .archive
        .file_names()
        .any(|name| name.is_ok_and(|name| name == "extension/package.nls.json"))
    {
        package.read("extension/package.nls.json")?
    } else {
        Value::Null
    };
    let mut themes = Vec::new();
    let mut output_size = 0;
    for definition in definitions {
        let path = definition
            .get("path")
            .and_then(Value::as_str)
            .ok_or("В описании темы отсутствует путь.")?;
        let path = resource("extension/package.json", path)?;
        let mut theme = package.theme(&path, &mut Vec::new())?;
        let label = definition
            .get("label")
            .and_then(Value::as_str)
            .or_else(|| definition.get("id").and_then(Value::as_str))
            .unwrap_or(name);
        let label = label
            .strip_prefix('%')
            .and_then(|key| key.strip_suffix('%'))
            .and_then(|key| labels.get(key))
            .and_then(Value::as_str)
            .unwrap_or(label);
        theme.name = label.chars().take(200).collect();
        theme.id = format!(
            "{publisher}.{name}:{path}:{}",
            definition.get("id").and_then(Value::as_str).unwrap_or("")
        );
        theme.dark = match definition
            .get("uiTheme")
            .and_then(Value::as_str)
            .unwrap_or("vs-dark")
        {
            "vs" | "hc-light" => false,
            "vs-dark" | "hc-black" => true,
            _ => return Err("Неизвестный базовый тип темы VS Code.".into()),
        };
        output_size += serde_json::to_vec(&theme).map_err(|e| e.to_string())?.len();
        if output_size > TOTAL_LIMIT {
            return Err("Суммарный размер тем превышает 32 МиБ.".into());
        }
        themes.push(theme);
    }
    Ok(themes)
}

#[cfg(test)]
mod tests;
