# Агентный пайплайн — контракт

> Процесс разработки: GitHub + Cursor Cloud + локальный оркестратор в Docker.  
> Продукт (каталог, MongoDB, Ollama) остаётся на машине разработчика.

Полный план этапов: [AGENT_PIPELINE_PLAN.md](./AGENT_PIPELINE_PLAN.md).  
Запуск с нуля: [AGENT_PIPELINE_SETUP.md](./AGENT_PIPELINE_SETUP.md).  
Конституция: [CONSTITUTION.md](./CONSTITUTION.md).  
Архитектура кода (статусы, файлы, расширение): [AGENT_PIPELINE_ARCHITECTURE.md](./AGENT_PIPELINE_ARCHITECTURE.md).

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
| Тестировщик | Cloud + GitHub Actions | Issue-QA по PR **или** регресс `main` по milestone | Merge, tag, Publish, E2E vision без локального прогона |
| Релиз-менеджер | Cursor Cloud | Changelog + **published** GitHub Release по milestone | Draft, merge в `main`, деплой, релиз без зелёного регресса |
| Девопс | Локальный deployer | `compose up` по tag/Release, статус в GitHub | Работать из облака |

Цикл аналитик → разработчик → тестировщик при новых багах, лимит **3** круга разработчика (`fix-round`), затем `needs-human`. Родитель ждёт дочерние bugs и проходит re-QA. **Глубина дерева QA = 1** (дети не плодят внуков). Релиз-менеджер работает от **milestone**, не от feature/bug issue.

## 3. Labels и milestone

### Тип (взаимоисключающие)

- `bug`
- `feature`
- `regression` (служебная issue регресса `main`, не продукт)

### Приоритет (взаимоисключающие)

- `p0` … `p3`

### Состояние пайплайна

| Label | Смысл |
|-------|--------|
| `needs-plan` | Ждёт аналитика |
| `in-analysis` | Аналитик работает |
| `ready-for-dev` | План есть, можно кодить |
| `in-dev` | Разработчик работает |
| `in-qa` | Есть PR, ждёт QA или исправления найденных дефектов |
| `qa-in-progress` | Тестировщик проверяет PR или регресс `main` |
| `qa-passed` | Issue-QA или регресс `main` пройден (для feature/bug — человек может merge; для регресса — можно RM) |
| `deployed` | Локальный деплой успешен |
| `deploy-failed` | Локальный деплой упал |
| `needs-human` | Автоматика остановилась |

### Milestone = релиз

Один open milestone = один будущий GitHub Release.

| Поле | Правило |
|------|---------|
| title | строго `vN.N.N` (например `v1.2.0`). Иначе оркестратор milestone не трогает |
| due_on | день **Publish** (не T−1). Календарь: `SCHEDULE_TZ` (по умолчанию `Europe/Moscow`) |
| issues | состав версии; к T незакрытое выносит человек в другой milestone |

Плановый: due в будущем. Внеплановый (hotfix): человек создаёт/ставит due **сегодня** — тот же объект, отдельного флага нет.

Два open milestone с due сегодня и валидным title → `needs-human`, RM не стартует.

Старт аналитика: labels `bug` или `feature` **и** `needs-plan`. Перед запуском: `needs-plan` → `in-analysis`. После прогона оркестратор снимает `in-analysis` и ставит `ready-for-dev` или `needs-human` (по маркеру `PIPELINE_LABELS:` в ответе агента или при ошибке Cursor).

Старт разработчика: `bug` или `feature` **и** `ready-for-dev`, нет открытого PR `Fixes #N` (или ветки `issue/<n>-…`). При старте оркестратор ставит `in-dev`. Несколько таких issue стартуют **параллельно** и не ждут окончания других ролей. Дочерний баг (`Related to #N`): `startingRef` = head открытого PR родителя; после PR оркестратор сменяет base на эту ветку, если Cursor открыл PR в `main`. После PR: снимает `ready-for-dev` и `in-dev`, ставит `in-qa`. Если агент упал или PR нет — `needs-human`. Если PR уже открыт, агент не стартует, только метка `in-qa` (base всё равно поправляется).

Старт тестировщика (issue-QA): `bug` или `feature` **и** `in-qa`, есть открытый PR `Fixes #N`. Перед запуском: `in-qa` → `qa-in-progress`. Несколько таких issue стартуют **параллельно** и не ждут окончания разработчика, аналитика, RM или другого тестировщика на другой issue. Агент возвращает номера дефектов в `PIPELINE_BUG_ISSUES` (только блокеры критерия, максимум **2**; nit — комментарий в PR). Если дефектов нет: `qa-in-progress` → `qa-passed`. Если дефекты есть: оркестратор ставит им `bug` + `needs-plan` (сброс джобов ролей на дочерних), пишет в родителя `<!-- pipeline:child-bugs:… -->`, родителя возвращает в `in-qa`. Пока дочерние открыты в пайплайне **или у них открыт PR `Fixes #`** — повторный tester на родителе не стартует; когда все закрыты / `qa-passed` / `needs-human` **и нет открытого Fixes PR** — джоб tester сбрасывается, re-QA. Дочерний `qa-passed` без открытого PR и со смерженным `Fixes` PR — оркестратор закрывает issue (GitHub сам не закрывает merge не в `main`). **Нет открытого PR `Fixes #N` при `in-qa`** → `needs-human` (не вечный skip). На дочернем issue (`Related to #`) новые bugs запрещены (глубина 1); оркестратор не вешает `needs-plan` на внуков и ставит родителю-ребёнку `needs-human`. Больше 2 bug-issues за прогон → `needs-human`, дети не создаются. Ошибка Cursor, протокола или маркировки → `needs-human`. `qa-passed` на `bug`/`feature` **не** стартует RM. CI на PR: GitHub Actions job `ci`; required check на `main` включается ruleset вручную. Merge PR в `main` после issue-`qa-passed` делает **человек**.

**Цикл QA (fix-round):** при каждом старте разработчика в теле issue пишется / увеличивается `fix-round: N` (макс. **3**). Попытка 4-го старта → `needs-human`, облачный разработчик не вызывается. После бага нельзя оставить `ready-for-dev` без нового `needs-plan`.

### Регресс main и релиз-менеджер (schedule)

Календарь: `due_on` milestone в `SCHEDULE_TZ`.

**T−1** (due завтра): оркестратор идемпотентно создаёт служебную issue в этом milestone:

- title: `Регресс vN.N.N`
- labels: `regression` + `in-qa`
- тело: маркер `<!-- pipeline:regression:<milestone_id> -->`

Тестировщик регрессит **`main`** (не PR). Промпт: `tester-regression.md`. Баги регресса — новые корневые `bug` в том же milestone, **без** `Related to #` на regression-issue. Пока они открыты, RM не стартует. После `qa-passed` регресса и due сегодня — старт RM.

**T** (due сегодня):

- регресс ещё не стартовал → тот же протокол **в тот же день** (hotfix);
- регресс `qa-passed`, published Release с этим tag нет, в milestone нет открытых `bug`/`feature` → старт RM на регресс-issue;
- регресс красный / `needs-human` / ещё `qa-in-progress` → RM не стартует; при `needs-human` или открытых work-items после `qa-passed` — комментарий `blocked: no release`, compose не трогать.

Старт RM: labels `regression` **и** `qa-passed`; milestone due сегодня; нет published Release с tag = title. Агент возвращает tag (= title) и changelog. Оркестратор создаёт **published** GitHub Release (`draft: false`, tag создаётся вместе с Release) и закрывает milestone. Ошибка → `needs-human` на регресс-issue.

`qa-passed` на `bug`/`feature` **не** стартует RM.

## 4. Релиз (дата, регресс, Publish)

Облачный агент не пишет в личный чат Cursor. Канал — **GitHub**.

Человек:

1. Создаёт milestone `vN.N.N` с `due_on` (план) **или** due сегодня (hotfix).
2. К T держит в `main` то, что должно войти (merge после issue-`qa-passed`).
3. Незакрытое выносит из milestone. При провале регресса двигает `due_on` или чинит баги.

Оркестратор + RM:

1. Не создаёт draft. Не мержит PR.
2. Tag = title milestone, без «следующего patch по догадке».
3. Тело Release — `PIPELINE_CHANGELOG_*` (merged в `main` с прошлого tag / issues milestone).
4. Стоп (`needs-human` / skip): title ≠ `vN.N.N`; два due сегодня; регресс не `qa-passed`; открытые `bug`/`feature` в milestone; tag/Release уже есть; CI `main` красный.
5. С прошлого published Release в `main` нет новых коммитов (`ahead_by = 0`): GitHub Release **не** создаётся. Оркестратор пишет пометку `<!-- pipeline:nothing-to-release:… -->` (описание milestone + комментарий), закрывает milestone и служебную regression-issue. Первый релиз (нет предыдущего tag) не пропускается.

Деплой по-прежнему только от **published** Release (локальный deployer).

## 5. Оркестратор

- Каталог кода: репозиторий [`multi_agents_development_pipeline`](https://github.com/AlexeyAbretov/multi_agents_development_pipeline) — сервис `pipeline/` (Fastify + TypeScript), compose **отдельный** от продукта. Карта файлов и статусная модель: [AGENT_PIPELINE_ARCHITECTURE.md](./AGENT_PIPELINE_ARCHITECTURE.md).
- Связь с GitHub: **поллинг** (без входящего webhook и без туннеля).
- Опционально позже: self-hosted GitHub Actions runner только для деплоя.
- Секреты оркестратора в `pipeline/.env`, не в git: `GITHUB_TOKEN` (лучше раздельные read vs release), `CURSOR_API_KEY`. Каталог — корневой `.env` (Mongo, Ollama).
- Идемпотентность: одно активное облачное задание на пару `(issue, role)`. Регресс и RM — на служебной regression-issue, не на feature/bug. При старте оркестратора джобы `running`/`queued` из прошлого процесса удаляются (агент после recreate контейнера уже мёртв). Полл **не** ждёт завершения Cursor `run.wait()`: тик только находит работу и стартует агентов. Несколько пар могут быть `running` одновременно. **Разработчик** на `ready-for-dev` и **тестировщик** на `in-qa` стартуют сразу — не дожидаются аналитика, RM или друг друга на другой issue. Повторный тик ту же пару не дублирует (`jobs.json` + in-flight).
- В записи джоба обязательно: `cursorAgentId`, `cursorRunId`, URL issue/PR, статус, timestamps.

Контейнер оркестратора **не** монтирует docker.sock. Сокет только у `deployer` (`docker-compose.yml` в репозитории пайплайна, health `http://127.0.0.1:3021/health`).

Деплой: поллинг published GitHub Releases (draft пропускаются). Режим `DEPLOY_MODE=stub` (заглушка) или `compose` (`docker compose -f docker-compose.yml up -d` в checkout продукта, смонтированном через `PRODUCT_WORKSPACE_HOST`). Статус дописывается в тело Release; на open issues отгруженного milestone — `deployed` или `deploy-failed`.

**Schedule:** оркестратор раз в `SCHEDULE_INTERVAL_MS` смотрит open milestones с title `vN.N.N` (календарь `SCHEDULE_TZ`):
- due завтра / сегодня, в `main` нет коммитов с прошлого tag → закрыть milestone с пометкой «нечего релизить», регресс и RM не стартуют;
- due завтра → регресс (если ещё нет);
- due сегодня → hotfix-регресс или ожидание RM;
- due сегодня, нет published Release и RM не может стартовать (`needs-human` / открытые work-items после регресса) → комментарий `blocked: no release` (без compose).
Есть published tag и нет записи в `deploys.json` → очередь для deployer (один деплой на tag).

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
2. Статусы `tester` (в том числе регресс) и `release-manager` на regression-issue — без кнопки Publish в UI.
3. Деплои: `GET /api/deploys`. Полный транскрипт агента — в Cursor по `agentId`.

Порт UI не публиковать в интернет без защиты.

## 7. Что агентам запрещено

- Merge в `main` (агентам). Merge PR — человек после issue-`qa-passed` (конституция P9).
- Деплой и `docker compose` с облачной VM.
- Утверждать E2E каталога (vision, поиск) без локального прогона.
- Выходить за scope MVP каталога без `needs-human`.
- Коммитить секреты, расширять scope «заодно».

## 8. Промпты

Тексты ролей (создаются на этапе P0 плана, каталог `pipeline/prompts/`):

- `analyst.md`
- `developer.md`
- `tester.md`
- `tester-regression.md`
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
