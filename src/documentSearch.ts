import {
  closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search, SearchQuery, selectMatches, setSearchQuery,
} from "@codemirror/search";
import { runScopeHandlers, type EditorView, type Panel } from "@codemirror/view";
import "./documentSearch.css";

const options = [
  ["caseSensitive", "Aa", "Учитывать регистр"],
  ["wholeWord", "W", "Слово целиком"],
  ["regexp", ".*", "Регулярное выражение"],
] as const;
const countLimit = 1000;

function documentSearchPanel(view: EditorView): Panel {
  const document = view.dom.ownerDocument;
  function input(label: string, placeholder = label) {
    const field = document.createElement("input");
    field.placeholder = placeholder;
    field.setAttribute("aria-label", label);
    field.autocomplete = "off";
    field.spellcheck = false;
    return field;
  }

  function button(label: string, text: string, run: () => void) {
    const control = document.createElement("button");
    control.type = "button";
    control.setAttribute("aria-label", label);
    control.title = label;
    control.textContent = text;
    control.addEventListener("click", run);
    return control;
  }

  const dom = document.createElement("section");
  dom.className = "cm-document-search";
  dom.setAttribute("aria-label", "Поиск в документе");
  const searchRow = document.createElement("div");
  const replaceRow = document.createElement("div");
  searchRow.className = replaceRow.className = "cm-document-search-row";
  const searchField = input("Найти в документе");
  searchField.setAttribute("main-field", "true");
  const replaceField = input("Заменить", "Заменить на");
  const field = document.createElement("div");
  field.className = "cm-document-search-field";
  const filters = document.createElement("div");
  filters.className = "cm-document-search-filters";
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "Параметры поиска");
  const status = document.createElement("span");
  status.className = "cm-document-search-status";
  status.setAttribute("role", "status");

  let query = getSearchQuery(view.state);
  let replacing = false;
  let matches: { from: number; to: number }[] = [];
  function commit(changes: Partial<SearchQuery>) {
    const next = new SearchQuery({ ...query, ...changes });
    if (!next.eq(query)) view.dispatch({ effects: setSearchQuery.of(next) });
  }

  const previous = button("Назад", "↑", () => findPrevious(view));
  const next = button("Далее", "↓", () => findNext(view));
  const select = button("Выделить все совпадения", "Все", () => selectMatches(view));
  const clear = button("Очистить запрос", "×", () => { commit({ search: "" }); searchField.focus(); });
  const toggleReplace = button("Показать замену", "›", () => {
    replacing = !replacing;
    showReplace();
    (replacing ? replaceField : searchField).focus();
  });
  toggleReplace.className = "cm-document-search-toggle";
  const close = button("Закрыть поиск", "×", () => closeSearchPanel(view));
  const replace = button("Заменить", "Заменить", () => replaceNext(view));
  const replaceEvery = button("Заменить все", "Заменить все", () => replaceAll(view));
  const filterButtons = options.map(([key, text, label]) => button(label, text, () => commit({ [key]: !query[key] })));
  filters.append(...filterButtons);
  field.append(searchField, clear, filters);

  const actions = document.createElement("div");
  actions.className = "cm-document-search-actions";
  actions.append(status, previous, next, select, close);
  searchRow.append(toggleReplace, field, actions);
  replaceRow.append(replaceField, replace, replaceEvery);
  dom.append(searchRow, replaceRow);

  function showReplace() {
    toggleReplace.hidden = view.state.readOnly;
    replaceRow.hidden = view.state.readOnly || !replacing;
    toggleReplace.setAttribute("aria-expanded", String(!replaceRow.hidden));
    const label = replaceRow.hidden ? "Показать замену" : "Скрыть замену";
    toggleReplace.setAttribute("aria-label", label);
    toggleReplace.title = label;
  }

  function syncQuery() {
    if (searchField.value !== query.search) searchField.value = query.search;
    if (replaceField.value !== query.replace) replaceField.value = query.replace;
    clear.hidden = !query.search;
    filterButtons.forEach((control, index) => control.setAttribute("aria-pressed", String(query[options[index][0]])));
    searchField.setAttribute("aria-invalid", String(!!query.search && !query.valid));
  }

  function collectMatches() {
    matches = [];
    if (!query.valid) return;
    const cursor = query.getCursor(view.state);
    // shortcut: счётчик показывает 1000+ для частых совпадений. Точный подсчёт потребует фонового обхода.
    for (let match = cursor.next(); !match.done && matches.length <= countLimit; match = cursor.next()) matches.push(match.value);
  }

  function showMatches() {
    const { from, to } = view.state.selection.main;
    const count = matches.length;
    const current = count <= countLimit ? matches.findIndex(match => match.from === from && match.to === to) + 1 : 0;
    const label = !query.search ? "" : !query.valid ? "Некорректное выражение" : !count ? "Нет совпадений"
      : current ? `${current} из ${count}` : `Совпадений: ${count > countLimit ? `${countLimit}+` : count}`;
    if (status.textContent !== label) status.textContent = label;
    for (const control of [previous, next, replace, replaceEvery]) control.disabled = !count;
    select.disabled = !count || count > countLimit;
  }

  searchField.addEventListener("input", () => commit({ search: searchField.value }));
  replaceField.addEventListener("input", () => commit({ replace: replaceField.value }));
  dom.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (runScopeHandlers(view, event, "search-panel")) {
      event.preventDefault();
    } else if (event.target === searchField && !event.metaKey && !event.ctrlKey && !event.altKey
      && (event.key === "Enter" || (!event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")))) {
      event.preventDefault();
      (event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? findPrevious : findNext)(view);
    } else if (event.key === "Enter" && event.target === replaceField) {
      event.preventDefault();
      replaceNext(view);
    }
  });

  syncQuery();
  showReplace();
  collectMatches();
  showMatches();
  return {
    dom, top: true,
    mount() { searchField.focus(); searchField.select(); },
    update(update) {
      const next = getSearchQuery(update.state);
      const queryChanged = next !== query;
      if (queryChanged) {
        query = next;
        syncQuery();
      }
      if (update.startState.readOnly !== update.state.readOnly) showReplace();
      if (queryChanged || update.docChanged) collectMatches();
      if (queryChanged || update.docChanged || update.selectionSet) showMatches();
    },
  };
}

export const documentSearch = search({ createPanel: documentSearchPanel });
