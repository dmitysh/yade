import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon, IdeDialog } from "./Ide";
import ExecutorSettings from "./ExecutorSettings";
import SettingsSelect from "./SettingsSelect";
import MessageContent from "./MessageContent";
import { defaultAppearance, fontSizes, monoFonts, scales, textFonts, useAppearance } from "./appearance";
import type { Appearance } from "./appearance";
import { importEditorTheme } from "./editorThemes";
import type { Session, Workspace } from "./types";
import ShortcutSettings from "./ShortcutSettings";
import NotificationSettings from "./NotificationSettings";

function Preview() {
  const { appearance, theme } = useAppearance();
  return <aside className="appearance-preview" aria-label="Предпросмотр внешнего вида">
    <div className="appearance-preview-heading"><h2>Предпросмотр</h2><span>{appearance.scale}%</span></div>
    <div className="appearance-preview-card">
      <section className="appearance-preview-interface"><h3>Интерфейс</h3><div><Icon name="project" /><span>Мой проект</span><Icon name="more" /></div></section>
      <section className="appearance-preview-chat"><h3>Чат</h3><strong>Вы</strong><MessageContent body="Как запустить проект?" />
        <MessageContent body={"Откройте терминал и выполните команду:\n\n```sh\nnpm run dev\n```"} />
      </section>
      <section className={`appearance-preview-editor ${appearance.wrapCode ? "wrap-code" : ""}`}><h3>Редактор</h3><pre><code>
        <span><i>1</i><span style={theme.syntax.keyword}>function</span>{" "}<span style={theme.syntax.function}>greet</span>{"(name) {"}</span>
        <span><i>2</i>{"  "}<span style={theme.syntax.keyword}>return</span>{" "}<span style={theme.syntax.string}>{"`Привет, ${name}!`;"}</span></span>
        <span><i>3</i>{"}"}</span><span><i>4</i><span style={theme.syntax.function}>greet</span>{"("}<span style={theme.syntax.string}>{"\"Мир\""}</span>{");"}</span>
      </code></pre></section>
      <section className="appearance-preview-terminal"><h3>Терминал</h3><pre>$ npm run dev</pre><pre className="preview-success">Готово за 240 мс</pre></section>
    </div>
    <p className="appearance-preview-note"><Icon name="info" />Предпросмотр учитывает тему редактора, шрифты, размеры и масштаб.</p>
  </aside>;
}

function AppearancePage() {
  const { appearance, themes, error, update } = useAppearance();
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  async function importThemes() {
    setImporting(true); setImportError("");
    try {
      const path = await open({ title: "Импортировать тему VS Code", multiple: false, directory: false, filters: [{ name: "Темы VS Code", extensions: ["vsix"] }] });
      if (typeof path !== "string") return;
      const values = await invoke<unknown[]>("import_editor_themes", { path });
      if (!Array.isArray(values) || !values.length) throw new Error("В пакете нет цветовых тем.");
      const imported = values.map(importEditorTheme);
      const themes = [...appearance.editorThemes.filter(theme => !imported.some(item => item.id === theme.id)), ...imported];
      if (themes.length > 256) throw new Error("Можно сохранить не больше 256 тем.");
      update({ editorThemes: themes });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally { setImporting(false); }
  }
  const fields = [
    { key: "interfaceFont", sizeKey: "interfaceFontSize", title: "Шрифт интерфейса", sizeLabel: "Размер шрифта интерфейса", description: "Навигация, меню и элементы управления", fonts: textFonts },
    { key: "chatFont", sizeKey: "chatFontSize", title: "Шрифт чата", sizeLabel: "Размер шрифта чата", description: "Сообщения и ответы в разговоре", fonts: textFonts },
    { key: "editorFont", sizeKey: "editorFontSize", title: "Шрифт редактора", sizeLabel: "Размер шрифта редактора", description: "Код и текстовые файлы", fonts: monoFonts },
    { key: "terminalFont", sizeKey: "terminalFontSize", title: "Шрифт терминала", sizeLabel: "Размер шрифта терминала", description: "Команды и вывод терминала", fonts: monoFonts },
  ] as const;
  return <>
    <div className="settings-scroll">
      <header className="appearance-heading"><h1>Внешний вид</h1><p>Тема редактора, шрифты и масштаб.</p></header>
      <div className="appearance-content">
        <div className="appearance-controls">
          <section aria-labelledby="appearance-theme"><h2 id="appearance-theme">Тема редактора</h2>
            <div className="appearance-row">
              <div className="appearance-row-label">Цветовая тема<span>Код и сравнение версий</span></div>
              <div className="appearance-font-select appearance-theme-select"><SettingsSelect label="Цветовая тема редактора"
                value={appearance.editorTheme} placeholder="Исходная тема Yade" disabled={importing}
                choices={themes.map(theme => ({ value: theme.id, label: theme.name }))}
                change={value => update({ editorTheme: value })} /></div>
            </div>
            <div className="appearance-theme-import"><button type="button" disabled={importing} onClick={() => void importThemes()}>
              <Icon name="download" />{importing ? "Импорт темы…" : "Импортировать тему VS Code…"}
            </button><span>Пакеты .vsix</span></div>
            {importError && <p className="error" role="alert">{importError}</p>}
          </section>
          <section aria-labelledby="appearance-fonts"><h2 id="appearance-fonts">Шрифты</h2>
            {fields.map(field => <div className="appearance-row" key={field.key}>
              <div className="appearance-row-label">{field.title}<span>{field.description}</span></div>
              <div className="appearance-font-controls"><div className="appearance-font-select" style={{ fontFamily: field.fonts[appearance[field.key] as keyof typeof field.fonts]?.family }}>
                <SettingsSelect label={field.title} value={appearance[field.key] === defaultAppearance[field.key] ? null : appearance[field.key]}
                  placeholder={field.fonts[defaultAppearance[field.key] as keyof typeof field.fonts].name}
                  choices={Object.entries(field.fonts).filter(([key]) => key !== defaultAppearance[field.key]).map(([value, font]) => ({ value, label: font.name }))}
                  change={value => update({ [field.key]: value ?? defaultAppearance[field.key] } as Partial<Appearance>)} />
              </div><div className="appearance-size-select"><SettingsSelect label={field.sizeLabel}
                value={appearance[field.sizeKey] === defaultAppearance[field.sizeKey] ? null : String(appearance[field.sizeKey])}
                placeholder={`${defaultAppearance[field.sizeKey]} pt`}
                choices={fontSizes.filter(size => size !== defaultAppearance[field.sizeKey]).map(size => ({ value: String(size), label: `${size} pt` }))}
                change={value => update({ [field.sizeKey]: Number(value ?? defaultAppearance[field.sizeKey]) })} /></div></div>
            </div>)}
          </section>
          <section aria-labelledby="appearance-scale"><h2 id="appearance-scale">Масштаб</h2><div className="appearance-row">
            <div className="appearance-row-label">Общий масштаб интерфейса<span>Размер всех элементов приложения</span></div>
            <div className="appearance-font-select"><SettingsSelect label="Общий масштаб интерфейса" value={appearance.scale === defaultAppearance.scale ? null : String(appearance.scale)} placeholder={`${defaultAppearance.scale}%`}
              choices={scales.filter(scale => scale !== defaultAppearance.scale).map(scale => ({ value: String(scale), label: `${scale}%` }))}
              change={value => update({ scale: Number(value ?? defaultAppearance.scale) })} /></div>
          </div></section>
          <section aria-labelledby="appearance-display"><h2 id="appearance-display">Отображение</h2>
            <div className="appearance-row"><label htmlFor="wrap-code">Отображение кода<span id="wrap-code-description">Переносить длинные строки</span></label>
              <div className="appearance-toggle"><span>{appearance.wrapCode ? "Включено" : "Выключено"}</span>
                <button id="wrap-code" type="button" role="switch" aria-label="Переносить длинные строки" aria-describedby="wrap-code-description" aria-checked={appearance.wrapCode}
                  onClick={() => update({ wrapCode: !appearance.wrapCode })}><span /></button>
              </div>
            </div>
            <div className="appearance-row"><div className="appearance-row-label" id="chat-display-label">Отображение чата<span>Форматирование сообщений</span></div>
              <div className="appearance-segment" role="group" aria-labelledby="chat-display-label">
                {[["formatted", "Форматированный"], ["source", "Исходный"]].map(([value, label]) => <button key={value} type="button" aria-pressed={appearance.chatFormat === value}
                  onClick={() => update({ chatFormat: value as Appearance["chatFormat"] })}>{label}</button>)}
              </div>
            </div>
          </section>
        </div>
        <Preview />
      </div>
    </div>
    <footer className="appearance-footer">{error ? <p role="alert" className="error"><Icon name="info" />{error}</p>
      : <p role="status"><Icon name="check" />Изменения применяются сразу</p>}</footer>
  </>;
}

export default function AppearanceSettings({ workspace, session, close }: { workspace?: Workspace; session?: Session; close: () => void }) {
  const [page, setPage] = useState("appearance");
  return <IdeDialog title="Настройки" className="appearance-dialog" close={close}>
    <div className="settings-layout">
      <aside className="settings-sidebar"><h2>Настройки</h2><nav aria-label="Разделы настроек">
        <button aria-current={page === "appearance" ? "page" : undefined} onClick={() => setPage("appearance")}><Icon name="palette" />Внешний вид</button>
        <button aria-current={page === "executors" ? "page" : undefined} onClick={() => setPage("executors")}><Icon name="prompt" />Исполнители</button>
        <button aria-current={page === "notifications" ? "page" : undefined} onClick={() => setPage("notifications")}><Icon name="bell" />Уведомления</button>
        <button aria-current={page === "shortcuts" ? "page" : undefined} onClick={() => setPage("shortcuts")}><Icon name="keyboard" />Горячие клавиши</button>
      </nav><p><Icon name="monitor" /><span>{page !== "executors" ? <>Для всех проектов<br />на этом устройстве</> : <>Для выбранного<br />пространства или сессии</>}</span></p></aside>
      <main className="settings-main">
        <button className="ide-icon-button settings-close" aria-label="Закрыть настройки" onClick={close}><Icon name="close" /></button>
        {page === "appearance" && <AppearancePage />}
        {page === "executors" && <div className="settings-scroll"><ExecutorSettings key={workspace?.id + ":" + session?.id} workspace={workspace} session={session} /></div>}
        {page === "notifications" && <NotificationSettings />}
        {page === "shortcuts" && <ShortcutSettings />}
      </main>
    </div>
  </IdeDialog>;
}
