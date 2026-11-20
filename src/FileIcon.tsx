import { fileIcon } from "./fileTypes";

export default function FileIcon({ path }: { path: string }) {
  const icon = fileIcon(path);
  return <span className="file-icon" aria-hidden="true" data-file-icon={icon}>
    <img src={`${import.meta.env.BASE_URL}file-icons/${icon}.svg`} alt="" width="18" height="18" />
    {(icon === "react" || icon === "react_ts") && <small>{icon === "react" ? "JS" : "TS"}</small>}
  </span>;
}
