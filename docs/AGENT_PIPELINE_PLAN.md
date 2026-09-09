# План: агентный пайплайн

> Пошаговая реализация процесса: GitHub → облачные агенты → локальный деплой.  
> Контракт (labels, роли, релиз, UI): [AGENT_PIPELINE.md](./AGENT_PIPELINE.md).

Это **отдельный трек** от MVP каталога. Ветки не пересекаются:

| Трек | Ветки | Документ |
|------|--------|----------|
| Каталог | `stage/N-…` | [MVP_PLAN.md](./MVP_PLAN.md) |
| Пайплайн | `pipeline/N-…` | этот файл |

Merge в `main` — только после явного подтверждения пользователя (как в [CONSTITUTION.md §3](./CONSTITUTION.md#3-git-workflow)).

## Git-workflow пайплайна

1. Перед этапом: `git checkout main` → `git pull` → `git checkout -b pipeline/N-…`
2. Коммиты только в ветке этапа
3. Push → чеклист «Проверка»
4. Merge в `main` по команде «мержим» / «этап готов» / «ok»
5. Следующий этап — новая ветка от обновлённого `main`

| Этап | Ветка |
|------|--------|
| P0 | `pipeline/0-github-contract` |
| P1 | `pipeline/1-orchestrator-skeleton` |
| P2 | `pipeline/2-github-cursor` |
| P3 | `pipeline/3-analyst` |
| P4 | `pipeline/4-developer` |
| P5 | `pipeline/5-tester` |
| P6 | `pipeline/6-release-manager` |
| P7 | `pipeline/7-local-devops` |
| P8 | `pipeline/8-qa-loop` |
| P9 | `pipeline/9-schedule-status` |
| UI | `pipeline/ui-jobs` (после P2, можно параллельно с P3+) |
| P10 | `pipeline/10-qa-loop-hardening` |
| P11 | `pipeline/11-stacked-child-prs` |
| P12 | `pipeline/12-extract-repo` |
| P13 | `pipeline/13-parallel-developers` |
| P14 | `pipeline/14-calendar-releases` |
| P15 | `pipeline/15-empty-release-skip` |

## Обзор

```
P0  Контракт GitHub + правила агентов     ~2ч
P1  Оркестратор-скелет в Docker           ~3ч
P2  Поллинг GitHub + вызов Cursor Cloud   ~4ч
P3  Аналитик                              ~2ч
P4  Разработчик (PR)                      ~3ч
P5  Тестировщик (CI + агент)              ~3ч
P6  Релиз-менеджер (без автоmerge)        ~2ч
P7  Девопс: deployer + локальный compose  ~3ч
P8  Цикл багов + лимит итераций           ~2ч
P9  Дата релиза (cron) + статусы          ~2ч
P10 Защита QA-цикла (глубина, RM, Fixes)  ~2ч
P11 Stacked child PR + re-QA + close     ~2ч
P12 Вынос в отдельный репозиторий        ~3ч
P13 Параллельный разработчик и QA        ~2ч
P14 Календарный релиз (milestone, published) ~4ч
P15 Пустой релиз: закрыть milestone          ~1ч
UI  Таблица джоб и логи орка              ~3ч  (после P2)
                                        ────
                                        ~43ч
```

Оценка без отладки биллинга Cursor и без полноценного E2E Ollama.

### В scope первой волны

Issue → план → PR → issue-QA → merge человеком в `main` → milestone due → регресс `main` → published Release → локальный `docker compose` каталога. Поллинг GitHub. UI очереди после P2.

### Вне scope первой волны

Публичная Gitea, Cloudflare Tunnel, webhook на оркестратор, автоmerge в `main` без апрува, E2E vision на каждый PR, Slack/Telegram, деплой на VPS, UI каталога в том же приложении что орк.

---

## P0: Контракт GitHub и промпты

**Ветка:** `pipeline/0-github-contract`

**Цель:** GitHub — единственный git remote для агентов; labels и документы совпадают.

### Шаги

1. `origin` = GitHub (уже). Gitea не используется пайплайном.
2. Завести labels из [AGENT_PIPELINE.md](./AGENT_PIPELINE.md) §3.
3. Issue template: цель, критерий готовности, связь с этапом MVP каталога если задача про продукт.
4. Ruleset на `main`: PR обязателен, без force push; required checks — с P5.
5. Документы `AGENT_PIPELINE.md` / этот план (этот этап).
6. Промпты `pipeline/prompts/{analyst,developer,tester,release-manager}.md`.

### Проверка

- [ ] Issue с milestone создаётся, нужные labels есть в репо
- [ ] Прямой push в `main` запрещён (если ruleset уже включён)
- [ ] Документы связаны из README и конституции

---

## P1: Оркестратор в Docker

**Ветка:** `pipeline/1-orchestrator-skeleton`

**Цель:** сервис `pipeline/` (Fastify + TS), compose отдельный от каталога.

### Шаги

1. Каталог `pipeline/` в monorepo (workspaces согласовать с будущими `frontend`/`backend` каталога).
2. `docker-compose.pipeline.yml`: `orchestrator`, **без** docker.sock.
3. `GET /health`.
4. `.env.example`: `GITHUB_TOKEN`, `GITHUB_REPO`, `CURSOR_API_KEY`, интервал поллинга.
5. Структурные логи: `issue`, `role`, `agentId`, `runId`.

### Проверка

- [x] `docker compose -f docker-compose.pipeline.yml up` → `/health` = 200
- [x] Секреты не в git

---

## P2: Поллинг GitHub + Cursor SDK

**Ветка:** `pipeline/2-github-cursor`

**Цель:** только исходящие запросы, без туннеля.

### Шаги

1. Поллинг issues (`since`, фильтр labels).
2. Идемпотентность `(issue, role)` — SQLite/JSON volume или маркер в комментарии `<!-- pipeline:job:... -->`.
3. `@cursor/sdk`: явно `cloud: { repos: [...] }`, не local по умолчанию.
4. Сохранение `agentId` / `runId` в БД и комментарий issue.
5. Различать ошибку старта SDK и `run.status === error`.

### Проверка

- [x] Label `needs-plan` → старт агента, комментарий с id (нужны `GITHUB_TOKEN` и `CURSOR_API_KEY` в `.env`)
- [x] Повторный полл не создаёт второго агента на ту же пару

---

## P3: Аналитик

**Ветка:** `pipeline/3-analyst`

### Шаги

1. Триггер: open issue с `bug` или `feature` **и** `needs-plan`, без `ready-for-dev` / `in-analysis` / `needs-human`.
2. Промпт: конституция, MVP_PLAN, маркер `PIPELINE_LABELS:` в последней строке.
3. Перед запуском: снять `needs-plan`, поставить `in-analysis`. Успех: снять `in-analysis`, поставить `ready-for-dev`. Иначе: снять `in-analysis`, поставить `needs-human` (в т.ч. при ошибке Cursor).

### Проверка

- [x] Тестовая feature → план на русском, `ready-for-dev`
- [x] Задача вне MVP (auth, photo search) → отказ, не реализация

---

## P4: Разработчик

**Ветка:** `pipeline/4-developer`

### Шаги

1. Триггер: `ready-for-dev`, нет открытого PR `Fixes #N`.
2. Ветка `issue/<n>-short`, `autoCreatePR` или PR руками агента.
3. Labels: `in-dev` → после PR `in-qa`.
4. Запрет merge и деплоя в промпте.

Задачи **каталога** по-прежнему идут в `stage/N-…`, если это этап MVP продукта. Пайплайнные баги/фичи продукта после MVP — `issue/<n>-…`. Не смешивать имена веток двух треков без явной пометки в issue.

### Проверка

- [ ] Issue с планом → ветка + PR
- [ ] `main` не изменился
- [ ] Повторный полл не стартует второго разработчика; уже открытый PR → `in-qa` без агента

---

## P5: Тестировщик

**Ветка:** `pipeline/5-tester`

### Шаги

1. GitHub-hosted Actions на PR: lint, `tsc`, unit (когда появятся в каталоге). Required check для `main`.
2. Облачный тестировщик: `in-qa` → `qa-in-progress`; diff, чеклист, баг-issues с тем же milestone; без дефектов → `qa-passed`, с дефектами → обратно `in-qa`.
3. E2E Ollama — слот после P7, не в этом этапе.
4. В промпте: не утверждать E2E без локального прогона.

### Проверка

- [ ] Красный CI блокирует merge (после включения ruleset)
- [ ] Дырявый PR → issue от тестировщика → оркестратор ставит `bug` + `needs-plan`
- [ ] `in-qa` без открытого PR не стартует облачного тестировщика
- [ ] Нет `PIPELINE_BUG_ISSUES` / маркировка упала → родительская issue получает `needs-human`
- [ ] `PIPELINE_BUG_ISSUES: none` + успешный verdict → `qa-passed`

---

## P6: Релиз-менеджер

**Ветка:** `pipeline/6-release-manager`

### Шаги

1. Триггер: `qa-passed` (тип `bug`/`feature`); итог пакета — label `ready-for-release`.
2. Changelog-маркеры агента → draft Release, assignee owner, request review (см. контракт §4).
3. Merge/tag/publish — только после `release-approved`; в MVP делает человек.
4. Колонка «ожидает апрува» в UI — когда появится UI (вне этого этапа).

### Проверка

- [ ] Без апрува код создаёт только **draft** Release; Publish и git tag не вызываются
- [ ] После ручного `release-approved` + Publish человеком — Release с телом из changelog агента

---

## P7: Девопс локальный

**Ветка:** `pipeline/7-local-devops`

### Шаги

1. Сервис `deployer` в `docker-compose.pipeline.yml` (порт `3021`, отдельный от орка).
2. Триггер: поллинг **published** Release (не draft; pre-release ок).
3. `DEPLOY_MODE=stub` (по умолчанию) или `compose` → `docker compose` каталога (сейчас mongo). Ollama не в compose.
4. Только `deployer` с docker.sock (Docker Desktop: `/var/run/docker.sock`).
5. Результат: запись в тело Release + labels `deployed` / `deploy-failed` на open issues с `ready-for-release` / `release-approved`.
6. Идемпотентность: `deploys.json` + маркер `<!-- pipeline:deploy:ID -->` в теле Release.

### Проверка

- [ ] Тестовый published (или pre-release) Release → лог deployer, блок в теле Release
- [ ] У `orchestrator` нет docker.sock; `docker ps` только из `deployer`

---

## P8: Цикл QA

**Ветка:** `pipeline/8-qa-loop`

### Шаги

1. Баг тестировщика → `bug` + `needs-plan` (аналитик → разработчик → QA); джобы `(issue, role)` сбрасываются для нового круга.
2. `fix-round: N` в теле issue: +1 при каждом старте разработчика; при `N >= 3` следующий старт → `needs-human` (4-й круг не кодит).
3. Разработчик после бага только через новый план (`needs-plan`), без «висящего» `ready-for-dev`.
4. Родитель с `in-qa` ждёт дочерние bugs (`<!-- pipeline:child-bugs:… -->`); когда все закрыты/`qa-passed`/`needs-human` — сброс джоба tester и повторное QA.
5. Несколько дочерних bugs с `needs-plan` и одним `Related to #parent` — analyst стартует **параллельно** в одном poll-tick (идемпотентность `(issue, role)` сохраняется).

### Проверка

- [ ] Три старта разработчика по issue → на четвёртом `needs-human`, агент не стартует
- [ ] После закрытия дочерних багов родитель снова уходит в tester
- [x] Два+ sibling child bugs с одним parent → параллельный analyst в одном poll-tick

---

## P9: Дата релиза и наблюдаемость

**Ветка:** `pipeline/9-schedule-status`

### Шаги

1. Cron оркестратора (`SCHEDULE_INTERVAL_MS`, ~1 ч): open milestone due сегодня.
2. Нет tag / Release → комментарий `blocked: no tag` на issues milestone; compose не трогать.
3. Есть tag, ещё нет записи в `deploys.json` → `deploy-requests.json` → deployer (идемпотентно).
4. Краткий `pipeline/README.md`: логи, stop полла, schedule.

### Проверка

- [ ] Due сегодня без tag → комментарий, без compose
- [ ] С tag → один деплой на несколько тиков cron / poll

---

## P10: Защита QA-цикла

**Ветка:** `pipeline/10-qa-loop-hardening`

**Цель:** не давать дереву багов и «тихому» `in-qa` без PR подвесить родителя; не собирать draft Release на дочерних issues.

### Шаги

1. `roleForLabels`: RM только если в теле нет `Related to #`.
2. `in-qa` без открытого PR `Fixes #N` → `needs-human` + комментарий (не skip).
3. Тестировщик: максимум 2 blocker-issue; на дочернем (`Related to #`) новые bugs → `needs-human`, внуки не создаются.
4. Промпты tester / developer / RM / analyst; контракт `AGENT_PIPELINE.md` §3.

### Проверка

- [x] Unit: child `qa-passed` не даёт роль `release-manager`
- [x] Unit: `classifyTesterBugHandoff` — внук и >2 bugs
- [x] `npm test` в `pipeline/` зелёный

---

## P11: Stacked child PR и закрытие после merge

**Ветка:** `pipeline/11-stacked-child-prs`

**Цель:** дочерний фикс идёт в ветку родителя, не в `main`; re-QA родителя ждёт merge детского PR; после merge issue закрывается; зависшие джобы после recreate контейнера сбрасываются.

### Шаги

1. Developer с `Related to #N`: `startingRef` = head PR родителя; после PR — retarget base на эту ветку.
2. Re-QA родителя блокируется, пока у ребёнка открыт `Fixes` PR.
3. Дочерний `qa-passed` + смерженный PR + нет открытого PR → close issue.
4. Старт оркестратора: удалить `running`/`queued` джобы.

### Проверка

- [x] Unit: open PR ребёнка блокирует re-QA при `qa-passed`
- [x] Unit: `shouldCloseMergedChildIssue` только для детей со смерженным PR
- [x] `npm test` в `pipeline/` зелёный

---

## P12: Вынос в отдельный репозиторий

**Ветка:** `pipeline/12-extract-repo`

**Цель:** код оркестратора и deployer живёт в `multi_agents_development_pipeline`; продукт (каталог) не содержит `pipeline/` и не зависит от пайплайна.

### Шаги

1. Создать репозиторий `multi_agents_development_pipeline`, перенести `pipeline/`, `pipeline-ui/`, compose, docs процесса.
2. Deployer: `PRODUCT_WORKSPACE_HOST` → mount checkout продукта в `/product`; убрать mount корня monorepo.
3. В каталоге продукта — stub-ссылки на внешний репо; CI без шага pipeline tsc.

### Проверка

- [x] `docker compose up --build -d` в новом репо → `/health` = 200, UI `:3010`
- [x] `npm test` в `pipeline/` зелёный
- [x] Каталог собирается без `pipeline/` в репозитории
- [x] `DEPLOY_MODE=compose` + `PRODUCT_WORKSPACE_HOST` → compose **продукта**, не пайплайна

---

## P13: Параллельный разработчик и тестировщик

**Ветка:** `pipeline/13-parallel-developers`

**Цель:** разработчик с `ready-for-dev` и тестировщик с `in-qa` стартуют сразу, не дожидаясь `run.wait()` аналитика, RM или друг друга.

### Шаги

1. Полл-тик не держит lock на время облачного агента: тик только листинг GitHub + старт джоб.
2. Несколько `ready-for-dev` / `in-qa` — параллельно; разработчик и тестировщик в очереди dispatch раньше аналитика и RM.
3. In-flight `(issue, role)` + `jobs.json` — второй агент на ту же пару не стартует.
4. Контракт `AGENT_PIPELINE.md` §3 / §5.

### Проверка

- [x] Unit: `selectJobsToLaunch` — developer при in-flight analyst/tester всё равно в запуске
- [x] Unit: занятый developer не мешает другому `ready-for-dev`
- [x] Unit: tester при in-flight analyst/developer всё равно в запуске
- [x] Unit: занятый tester не мешает другому `in-qa`
- [x] `npm test` в `pipeline/` зелёный

---

## P14: Календарный релиз

**Ветка:** `pipeline/14-calendar-releases`

**Цель:** RM публикует Release по дате milestone; draft и per-issue RM убрать.

### Шаги

1. Конституция P4/P9 и контракт §3–4.
2. `tagFromMilestoneTitle` — только `vN.N.N`; календарь `SCHEDULE_TZ`.
3. Schedule: due завтра / сегодня → regression-issue + tester-regression / RM.
4. `roleForLabels`: `qa-passed` на bug/feature **не** даёт `release-manager`; RM только с `regression` + `qa-passed` + due сегодня.
5. Published Release вместо draft; закрытие milestone.
6. Промпты `release-manager.md`, `tester-regression.md`.
7. Удалить использование `ready-for-release` / `release-approved`.
8. Deployer: labels на issues milestone, не на ready-for-release.

### Проверка

- [x] Unit: feature `qa-passed` не стартует RM; `regression` + `qa-passed` даёт RM
- [x] Unit: title `v0.3` не является release-tag; `v1.2.0` является
- [x] Unit: `decideReleaseGate` — not-due-today / open-work / duplicate-due
- [x] `npm test` в `pipeline/` зелёный

---

## P15: Пустой релиз не публиковать

**Ветка:** `pipeline/15-empty-release-skip`

**Цель:** если с прошлого published tag в `main` нет коммитов — не создавать GitHub Release, закрыть milestone с пометкой.

### Шаги

1. Compare GitHub `previousTag...main`; `ahead_by <= 0` → пусто.
2. Schedule на T−1/T: закрыть milestone (описание + комментарий), не стартовать регресс/RM.
3. Первый релиз (нет предыдущего tag) не пропускать.
4. Контракт §4.

### Проверка

- [x] Unit: `isEmptySincePreviousRelease` / `previousReleaseTag`
- [x] Unit: `decideReleaseGate` → `nothing-to-release`
- [x] `npm test` в `pipeline/` зелёный

---

## UI: очередь джоб и логи

**Ветка:** `pipeline/ui-jobs`
**После:** P2 (нужны записи джоб). Можно параллельно с P3+.

### Шаги

1. Сервис `pipeline-ui` (React + Vite + TS + Tailwind), порт `127.0.0.1:3010`.
2. API оркестратора: `GET /api/jobs`, `GET /api/deploys` (данные из volume, не docker logs).
3. Таблица: issue, роль, UI-статус (`queued` / `running` / `waiting-approval` / `failed` / `finished`), ссылки GitHub и Cursor.
4. Полный транскрипт — ссылка на Cursor (`agentId`); Publish релиза — RM по milestone, не кнопка в UI.
5. Compose: `pipeline-ui` + nginx proxy `/api` → orchestrator.

### Проверка

- [ ] Джоб из `jobs.json` виден в таблице со ссылками
- [ ] UI слушает только `127.0.0.1:3010`

---

## Порядок относительно каталога

| Ситуация | Действие |
|----------|----------|
| Нужен работающий каталог | `stage/0`–`stage/10`; P7 — заглушка до compose каталога |
| Нужен процесс агентов | P0–P6 на документационном репо; P7 когда есть compose продукта |
| Параллельно | Не смешивать `stage/*` и `pipeline/*` в одной ветке |

P5/P7 полноценно оживают после scaffold каталога (`stage/0`) и появления тестов.

## Риски

- ПК выключен: PR в облаке возможны, деплой и локальный E2E — нет.
- Windows + docker.sock / named pipe — проверить на P7.
- Два GitHub token: чтение issues vs merge/release.
- Облачный тестировщик без E2E не закрывает vision.

## Backlog пайплайна (не делать без запроса)

- Автоmerge в `main`
- Telegram/почта при ошибке релиза / `needs-human`
- Webhook + туннель вместо поллинга
- Вынос Ollama в Docker / деплой на VPS
