# Сохранить модель проектов и рабочих пространств Orca

Пользователь выбрал модель организации работы Orca: группы объединяют отдельные проекты, Git-пространство относится к одному репозиторию, а пространство общей папки может охватывать несколько вложенных проектов. Внутри пространства поддерживаются несколько независимых сессий и вкладок; сессия не тождественна вкладке, а общая папка не создаёт общей Git-истории. Такая модель позволяет работать и с отдельной веткой, и с несколькими связанными репозиториями без смешивания их историй.

Основания: [рабочие пространства](https://www.onorca.dev/docs/model/worktrees), [группы](https://github.com/stablyai/orca/blob/main/src/shared/project-group-types.ts), [пространства папок](https://github.com/stablyai/orca/blob/main/src/shared/folder-workspaces/folder-workspace-types.ts), [несколько исполнителей](https://github.com/stablyai/orca/blob/main/src/shared/runtime-worktree-contracts.ts).
