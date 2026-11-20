import { createRoot } from "react-dom/client";
import { lazy, Suspense, type ComponentType } from "react";
import App from "./App";
import "./styles.css";

const mode = new URLSearchParams(window.location.search).get("prototype");
const loadPrototype = import.meta.env.DEV && mode !== null
  ? import.meta.glob<{ default: ComponentType }>(["./IdePrototype.tsx", "./SearchPrototypeEntry.tsx"])
    [mode === "search" ? "./SearchPrototypeEntry.tsx" : "./IdePrototype.tsx"]
  : undefined;
const Prototype = loadPrototype ? lazy(loadPrototype) : null;
createRoot(document.getElementById("root")!).render(Prototype
  ? <Suspense fallback={<p>Загрузка прототипа…</p>}><Prototype /></Suspense>
  : <App />);
