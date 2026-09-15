# Пайплайн: оркестратор и deployer

Контракт: [`docs/AGENT_PIPELINE.md`](../docs/AGENT_PIPELINE.md).  
Архитектура (`pipeline/src`, статусы, расширение): [`docs/AGENT_PIPELINE_ARCHITECTURE.md`](../docs/AGENT_PIPELINE_ARCHITECTURE.md).  
Запуск с нуля: [`docs/AGENT_PIPELINE_SETUP.md`](../docs/AGENT_PIPELINE_SETUP.md).

## Сервисы

```powershell
# из корня репозитория multi_agents_development_pipeline
cp .env.example .env
cp pipeline/.env.example pipeline/.env
docker compose up --build -d
```

| Сервис | Порт | Назначение |
|--------|------|------------|
| `orchestrator` | `ORCHESTRATOR_PORT` | Поллинг issues → Cursor Cloud; schedule; API `/api/jobs` |
| `deployer` | `DEPLOYER_PORT` | Поллинг published Release; API `/api/deploys`; docker.sock |
| `pipeline-ui` | `PIPELINE_UI_PORT` | Таблица джоб и деплоев |

Номера — [`ports.env`](./ports.env). Health: `/health` у оркестратора и deployer. UI проксирует `/api/jobs` → orchestrator, `/api/deploys` → deployer (имена сервисов резолвятся на каждый запрос, чтобы после recreate не было 502).

## Логи

```powershell
docker compose logs -f orchestrator
docker compose logs -f deployer
```

Ищите: `poll tick`, `developer dispatch`, `tester dispatch`, `skip in-flight job`, `schedule tick`, `deploy poll tick`, `blocked: no release`, `deploy start`.

## Остановить полл

```powershell
docker compose stop orchestrator deployer pipeline-ui
# или полностью:
docker compose down
```

Volume `pipeline_data` хранит `jobs.json`, `deploys.json`, `schedule-state.json` — `down` его не удаляет.

## Schedule (P14)

- `SCHEDULE_INTERVAL_MS` (по умолчанию 3600000) и `SCHEDULE_TZ` (по умолчанию `Europe/Moscow`) в `pipeline/.env`.
- Milestone title = tag (`v1.2.0`): due завтра → служебная issue регресса `main`; due сегодня без регресса → hotfix (регресс в тот же день).
- С прошлого tag в `main` нет коммитов → milestone закрывается с пометкой «нечего релизить», Release не создаётся.
- Due сегодня, нет published Release и RM не может стартовать → комментарий `blocked: no release`, compose **не** трогаем.
- Deployer сам смотрит published Releases (без очереди от schedule).

## Локальный запуск (без Docker)

Нужен Node ≥ 22. Не держите одновременно контейнеры и локальные процессы на тех же портах.

```powershell
cd pipeline
copy .env.local.example .env.local   # DATA_DIR=./data, PROMPTS_DIR=./prompts
npm ci
npm run build
npm start                 # ORCHESTRATOR_PORT
npm run start:deployer    # DEPLOYER_PORT (второй терминал)
```

VSCode: **Orchestrator**, **Deployer** или **Orchestrator + Deployer**. UI: `cd pipeline-ui && npm run dev` (прокси из `ports.env`).

Подробнее: [`docs/AGENT_PIPELINE_SETUP.md`](../docs/AGENT_PIPELINE_SETUP.md) §10.
