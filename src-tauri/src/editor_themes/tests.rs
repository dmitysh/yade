use super::*;
use std::io::Write;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

fn package(files: &[(&str, &str)]) -> tempfile::NamedTempFile {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    let mut archive = ZipWriter::new(&mut file);
    for (name, body) in files {
        archive
            .start_file(
                *name,
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
            )
            .unwrap();
        archive.write_all(body.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
    file
}

const MANIFEST: &str = r#"{
    "name": "sample", "publisher": "test", "main": "./never-run.js",
    "contributes": { "themes": [
        { "id": "dark", "label": "%darkLabel%", "uiTheme": "vs-dark", "path": "./themes/dark.json" },
        { "label": "Светлая", "uiTheme": "vs", "path": "./themes/light.json" }
    ] }
}"#;

#[test]
fn imports_all_variants_with_localized_labels_jsonc_and_includes() {
    let file = package(&[
        ("extension/package.json", MANIFEST),
        ("extension/package.nls.json", r#"{"darkLabel":"Тёмная"}"#),
        ("extension/never-run.js", "throw new Error('must not run');"),
        (
            "extension/themes/base.json",
            r##"{
            // Основные цвета наследуются обоими вариантами.
            "colors": {"editor.background":"#101010", "editor.foreground":"#eeeeee",},
            "tokenColors":[{"scope":"keyword", "settings":{"foreground":"#ff0000"}},],
        }"##,
        ),
        (
            "extension/themes/dark.json",
            r##"{"include":"./base.json","colors":{"editor.foreground":"#dddddd"},
            "tokenColors":[{"scope":["string","markup.raw"],"settings":{"foreground":"#00ff00"}}]}"##,
        ),
        (
            "extension/themes/light.json",
            r##"{"include":"base.json","colors":{"editor.background":"#ffffff"}}"##,
        ),
    ]);
    let themes = import(file.path()).unwrap();
    assert_eq!(themes.len(), 2);
    assert_eq!(themes[0].name, "Тёмная");
    assert!(themes[0].dark);
    assert_eq!(themes[0].id, "test.sample:extension/themes/dark.json:dark");
    assert_eq!(themes[0].colors["editor.background"], "#101010");
    assert_eq!(themes[0].colors["editor.foreground"], "#dddddd");
    assert_eq!(themes[0].token_colors.len(), 2);
    assert!(!themes[1].dark);
    assert_eq!(themes[1].colors["editor.background"], "#ffffff");
    assert_eq!(themes[1].token_colors.len(), 1);
}

#[test]
fn imports_external_and_direct_textmate_themes() {
    let textmate = r##"<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>settings</key><array>
          <dict><key>settings</key><dict><key>background</key><string>#ffffff</string><key>foreground</key><string>#222222</string></dict></dict>
          <dict><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#777777</string><key>fontStyle</key><string>italic</string></dict></dict>
        </array></dict></plist>"##;
    let manifest = r#"{"name":"legacy","contributes":{"themes":[
        {"label":"JSON","uiTheme":"vs","path":"themes/theme.json"},
        {"label":"TextMate","uiTheme":"vs","path":"themes/legacy.tmTheme"}]}}"#;
    let file = package(&[
        ("extension/package.json", manifest),
        (
            "extension/themes/theme.json",
            r#"{"tokenColors":"./legacy.tmTheme"}"#,
        ),
        ("extension/themes/legacy.tmTheme", textmate),
    ]);
    let themes = import(file.path()).unwrap();
    assert_eq!(themes[0].token_colors.len(), 2);
    assert_eq!(themes[0].token_colors, themes[1].token_colors);
    assert_eq!(
        themes[0].token_colors[0]["settings"]["background"],
        "#ffffff"
    );
}

#[test]
fn rejects_cycles_missing_files_and_invalid_rules() {
    for (body, expected) in [
        (r#"{"include":"dark.json"}"#, "Циклическое"),
        (r#"{"include":"missing.json"}"#, "недоступен"),
        (
            r#"{"tokenColors":[{"scope":"keyword"}]}"#,
            "Некорректное правило",
        ),
        (r#"{"tokenColors":false}"#, "список"),
    ] {
        let file = package(&[
            ("extension/package.json", MANIFEST),
            ("extension/themes/dark.json", body),
        ]);
        assert!(
            import(file.path()).unwrap_err().contains(expected),
            "{body}"
        );
    }
}

#[test]
fn resources_cannot_escape_the_extension_or_reference_network_paths() {
    for path in [
        "../../../outside.json",
        "/tmp/theme.json",
        "file:///theme.json",
        "https://example.com/theme.json",
        "..\\..\\outside.json",
    ] {
        assert!(
            resource("extension/themes/dark.json", path).is_err(),
            "{path}"
        );
    }
    assert_eq!(
        resource("extension/themes/dark.json", "../common/base.json").unwrap(),
        "extension/common/base.json"
    );
}

#[test]
fn theme_identity_survives_label_changes_without_an_explicit_id() {
    let mut ids = Vec::new();
    for label in ["Светлая", "Новое название"] {
        let manifest = format!(
            r#"{{"name":"sample","contributes":{{"themes":[{{"label":"{label}","path":"theme.json","uiTheme":"vs"}}]}}}}"#
        );
        let file = package(&[
            ("extension/package.json", &manifest),
            ("extension/theme.json", "{}"),
        ]);
        let themes = import(file.path()).unwrap();
        assert_eq!(themes[0].name, label);
        ids.push(themes[0].id.clone());
    }
    assert_eq!(ids[0], ids[1]);
}

#[test]
fn referenced_textmate_file_requires_its_settings() {
    let file = package(&[
        ("extension/package.json", MANIFEST),
        (
            "extension/themes/dark.json",
            r#"{"tokenColors":"invalid.tmTheme"}"#,
        ),
        (
            "extension/themes/invalid.tmTheme",
            r#"<?xml version="1.0"?><plist version="1.0"><dict/></plist>"#,
        ),
    ]);
    assert!(import(file.path())
        .unwrap_err()
        .contains("отсутствуют правила"));
}

#[test]
fn unfamiliar_workbench_colors_do_not_prevent_editor_theme_import() {
    let file = package(&[
        (
            "extension/package.json",
            r#"{"name":"github","contributes":{"themes":[{"label":"GitHub Dark","path":"theme.json"}]}}"#,
        ),
        (
            "extension/theme.json",
            r##"{"colors":{"editor.background":"#0d1117","symbolIcon.constantForeground":["#aff5b4","#7ee787"]}}"##,
        ),
    ]);
    let themes = import(file.path()).unwrap();
    assert_eq!(themes[0].colors["editor.background"], "#0d1117");
    assert!(themes[0].colors["symbolIcon.constantForeground"].is_array());
}

#[test]
fn rejects_oversized_compressed_resources_and_non_theme_packages() {
    let large = " ".repeat(FILE_LIMIT as usize + 1);
    let file = package(&[
        ("extension/package.json", MANIFEST),
        ("extension/themes/dark.json", &large),
    ]);
    assert!(import(file.path()).unwrap_err().contains("4 МиБ"));
    let file = package(&[("extension/package.json", r#"{"name":"not-a-theme"}"#)]);
    assert!(import(file.path())
        .unwrap_err()
        .contains("нет цветовых тем"));
    let file = tempfile::NamedTempFile::new().unwrap();
    assert!(import(file.path())
        .unwrap_err()
        .contains("Некорректный пакет VSIX"));
}
