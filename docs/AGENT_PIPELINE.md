# Агентный пайплайн — контракт

> Процесс разработки: GitHub + Cursor Cloud + локальный оркестратор в Docker.  
> Продукт (каталог, MongoDB, Ollama) остаётся на машине разработчика.

Полный план этапов: [AGENT_PIPELINE_PLAN.md](./AGENT_PIPELINE_PLAN.md).  
Запуск с нуля: [AGENT_PIPELINE_SETUP.md](./AGENT_PIPELINE_SETUP.md).  
Конституция: [CONSTITUTION.md](./CONSTITUTION.md).

## 1. Целевая схема

```
GitHub          issues, PR, Actions (lint/unit), tags, Releases
Cursor Cloud    Аналитик → Разработчик → Тестировщик → Релиз-менеджер
        ▲
        │ HTTPS API (исходящий с ПК, без туннеля)
        │
Docker (дома)
  orchestrator     поллинг GitHub, вызов Cursor SDK, очередь джоб, UI
  deployer         docker compose каталога (единственный с docker.sock)
  pipeline-ui      очередь, статусы, ссылки на логи (отдельный порт)
Ollama на хосте    GPU, не в compose оркестратора
```

Git — **только GitHub** (`origin`). Локальная Gitea не используется.

## 2. Роли

| Роль | Где | Делает | Не делает |
|------|-----|--------|-----------|
| Аналитик | Cursor Cloud | План в комментарии issue по конституции и MVP | Код, merge, деплой |
| Разработчик | Cursor Cloud | Ветка `issue/<n>-…`, PR | Merge в `main`, деплой |
| Тестировщик | Cloud + GitHub Actions | Ревью diff, unit/lint, баг-issues | Утверждать E2E vision без локального прогона |
| Релиз-менеджер | Cursor Cloud | Changelog, draft Release, запрос апрува | Merge/publish/tag без апрува человека |
| Девопс | Локальный deployer | `compose up` по tag/Release, статус в GitHub | Работать из облака |

Цикл аналитик → разработчик → тестировщик при новых багах, лимит **3** круга разработчика (`fix-round`), затем `needs-human`. Родитель ждёт дочерние bugs и проходит re-QA. **Глубина дерева QA = 1** (дети не плодят внуков). Релиз-менеджер — только у корневой issue (нет `Related to #`).

## 3. Labels и milestone

### Тип (взаимоисключающие)

- `bug`
- `feature`

### Приоритет (взаимоисключающие)

- `p0` … `p3`

### Состояние пайплайна

| Label | Смысл |
|-------|--------|
| `needs-plan` | Ждёт аналитика |
| `ready-for-dev` | План есть, можно кодить |
| `in-dev` | Разработчик работает |
| `in-qa` | Есть PR, ждёт QA или исправления найденных дефектов |
| `qa-in-progress` | Тестировщик проверяет PR |
| `qa-passed` | QA пройден: дефектов нет, можно готовить релиз |
| `ready-for-release` | RM собрал пакет, ждёт апрув |
| `release-approved` | Человек разрешил merge/tag/publish |
| `deployed` | Локальный деплой успешен |
| `deploy-failed` | Локальный деплой упал |
| `needs-human` | Автоматика остановилась |

**Milestone** = версия (`v0.3`) + due date (дата релиза).

Старт аналитика: labels `bug` или `feature` **и** `needs-plan`. После прогона оркестратор снимает `needs-plan` и ставит `ready-for-dev` или `needs-human` (по маркеру `PIPELINE_LABELS:` в ответе агента или при ошибке Cursor).

Старт разработчика: `bug` или `feature` **и** `ready-for-dev`, нет открытого PR `Fixes #N` (или ветки `issue/<n>-…`). При старте оркестратор ставит `in-dev`. Дочерний баг (`Related to #N`): `startingRef` = head открытого PR родителя; после PR оркестратор сменяет base на эту ветку, если Cursor открыл PR в `main`. После PR: снимает `ready-for-dev` и `in-dev`, ставит `in-qa`. Если агент упал или PR нет — `needs-human`. Если PR уже открыт, агент не стартует, только метка `in-qa` (base всё равно поправляется).

Старт тестировщика: `bug` или `feature` **и** `in-qa`, есть открытый PR `Fixes #N`. Перед запуском: `in-qa` → `qa-in-progress`. Агент возвращает номера дефектов в `PIPELINE_BUG_ISSUES` (только блокеры критерия, максимум **2**; nit — комментарий в PR). Если дефектов нет: `qa-in-progress` → `qa-passed`. Если дефекты есть: оркестратор ставит им `bug` + `needs-plan` (сброс джобов ролей на дочерних), пишет в родителя `<!-- pipeline:child-bugs:… -->`, родителя возвращает в `in-qa`. Пока дочерние открыты в пайплайне **или у них открыт PR `Fixes #`** — повторный tester на родителе не стартует; когда все закрыты / `qa-passed` / `needs-human` **и нет открытого Fixes PR** — джоб tester сбрасывается, re-QA. Дочерний `qa-passed` без открытого PR и со смерженным `Fixes` PR — оркестратор закрывает issue (GitHub сам не закрывает merge не в `main`). **Нет открытого PR `Fixes #N` при `in-qa`** → `needs-human` (не вечный skip). На дочернем issue (`Related to #`) новые bugs запрещены (глубина 1); оркестратор не вешает `needs-plan` на внуков и ставит родителю-ребёнку `needs-human`. Больше 2 bug-issues за прогон → `needs-human`, дети не создаются. Ошибка Cursor, протокола или маркировки → `needs-human`. Только `qa-passed` **корневой** issue (нет `Related to #`) допускается к релиз-менеджеру. Дочерний `qa-passed` RM не стартует — ждёт re-QA родителя. CI на PR: GitHub Actions job `ci`; required check на `main` включается ruleset вручную.

**Цикл QA (fix-round):** при каждом старте разработчика в теле issue пишется / увеличивается `fix-round: N` (макс. **3**). Попытка 4-го старта → `needs-human`, облачный разработчик не вызывается. После бага нельзя оставить `ready-for-dev` без нового `needs-plan`.

Старт релиз-менеджера: корневая issue (`bug` или `feature`, в теле **нет** `Related to #`) **и** `qa-passed`, нет `ready-for-release` / `release-approved`. Агент возвращает тег, список PR и changelog-маркеры. Оркестратор: **assignee** = owner репо, request review на перечисленные PR, **Draft** GitHub Release (без publish и без создания git tag до Publish), label `ready-for-release`. Ошибка Cursor / протокола / GitHub → `needs-human`. После `release-approved` merge / Publish / tag делает **человек** (автоmerge вне scope первой волны). Дочерние баги с `qa-passed` в RM не идут.

## 4. Апрув релиза (как RM сообщает человеку)

Облачный агент не пишет в личный чат Cursor. Канал — **GitHub**.

Обязательные действия релиз-менеджера (оркестратор + агент):

1. Label `ready-for-release`, **assignee** — владелец репо (`GITHUB_REPO` owner).
2. Комментарий с чеклистом: состав milestone, ссылки на PR, статус CI, риски, явная фраза что нужен апрув.
3. **Request review** на открытые PR из `PIPELINE_PR_NUMBERS`.
4. **Draft GitHub Release** (без publish) по `PIPELINE_RELEASE_TAG` и телу `PIPELINE_CHANGELOG_*`.

**Апрув человека (зафиксировано):** label `release-approved` на issue. Approve review / Environment `release` — опционально позже, не обязательны для MVP.

До апрува: **нет** merge в `main`, **нет** tag, **нет** Publish Release, **нет** деплоя. Оркестратор не публикует draft и не мержит PR.

Первая волна: после `release-approved` merge в `main` и Publish Release делает человек; агент готовит notes и draft. Автоmerge — только после отдельного решения.

## 5. Оркестратор

- Каталог кода: репозиторий [`multi_agents_development_pipeline`](https://github.com/AlexeyAbretov/multi_agents_development_pipeline) — сервис `pipeline/` (Fastify + TypeScript), compose **отдельный** от продукта.
- Связь с GitHub: **поллинг** (без входящего webhook и без туннеля).
- Опционально позже: self-hosted GitHub Actions runner только для деплоя.
- Секреты оркестратора в `pipeline/.env`, не в git: `GITHUB_TOKEN` (лучше раздельные read vs release), `CURSOR_API_KEY`. Каталог — корневой `.env` (Mongo, Ollama).
- Идемпотентность: одно активное облачное задание на пару `(issue, role)`. При старте оркестратора джобы `running`/`queued` из прошлого процесса удаляются (агент после recreate контейнера уже мёртв).
- В записи джоба обязательно: `cursorAgentId`, `cursorRunId`, URL issue/PR, статус, timestamps.

Контейнер оркестратора **не** монтирует docker.sock. Сокет только у `deployer` (`docker-compose.yml` в репозитории пайплайна, health `http://127.0.0.1:3021/health`).

Деплой: поллинг published GitHub Releases (draft пропускаются). Режим `DEPLOY_MODE=stub` (заглушка) или `compose` (`docker compose -f docker-compose.yml up -d` в checkout продукта, смонтированном через `PRODUCT_WORKSPACE_HOST`). Статус дописывается в тело Release; на open issues с `ready-for-release` / `release-approved` — `deployed` или `deploy-failed`.

**Schedule (P9):** оркестратор раз в `SCHEDULE_INTERVAL_MS` смотрит open milestones с `due_on` = сегодня. Нет tag → комментарий `blocked: no tag` (без compose). Есть tag и нет записи в `deploys.json` → очередь для deployer (один деплой на tag).

Ollama: `host.docker.internal:11434` для приложения каталога, не для оркестратора.

## 6. UI оркестратора и логи

Три журнала, UI их сшивает, полный транскрипт Cursor **не копируется**:

| Источник | Содержание |
|----------|------------|
| Оркестратор | Поллинг, вызовы SDK, ошибки старта |
| Cursor Cloud | Промпт, тулы, ответ агента — по ссылке на `agentId` (`bc-…`) |
| GitHub Actions / Release | CI, review, deploy job |
| Deployer | `compose up`, health |

UI (отдельный порт **`127.0.0.1:3010`**, сервис `pipeline-ui`):

1. Таблица очереди из `GET /api/jobs` (volume `jobs.json`): issue, роль, статус, ссылки GitHub / Cursor.
2. Колонка «ожидает апрува» для `release-manager` + `ready-for-release` — без кнопки апрува в UI.
3. Деплои: `GET /api/deploys`. Полный транскрипт агента — в Cursor по `agentId`.

Порт UI не публиковать в интернет без защиты.

## 7. Что агентам запрещено

- Merge в `main` без `release-approved` / явного «ок» человека (конституция P9).
- Деплой и `docker compose` с облачной VM.
- Утверждать E2E каталога (vision, поиск) без локального прогона.
- Выходить за scope MVP каталога без `needs-human`.
- Коммитить секреты, расширять scope «заодно».

## 8. Промпты

Тексты ролей (создаются на этапе P0 плана, каталог `pipeline/prompts/`):

- `analyst.md`
- `developer.md`
- `tester.md`
- `release-manager.md`

Язык промптов и комментариев в GitHub — **русский**.

## 9. Исключение из P1

Для **процесса** разработки разрешены GitHub и Cursor Cloud (клонирование репо на VM, API).  
Для **продукта** (фото, MongoDB, Ollama, runtime каталога) по-прежнему только локальная машина.

Подробнее: [CONSTITUTION.md](./CONSTITUTION.md) §2, принцип P1.

## 10. Документация в репозитории

Источник правды после merge — файлы в git, не тело PR.

| Кто | Делает |
|-----|--------|
| Аналитик | В плане перечисляет, какие docs править в том же PR |
| Разработчик | Вносит правки: чеклист этапа `[x]`, команды в `AGENTS.md` если изменились; README — только если это шаг этапа (каталог: полный README — этап 10) |
| Тестировщик | Расхождение docs и diff = дефект |
| Человек | Конституция, этот контракт, изменение scope MVP |

Конституцию и этот документ агенты не переписывают без `needs-human`.
