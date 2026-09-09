# Пайплайн: оркестратор и deployer

Контракт: [`docs/AGENT_PIPELINE.md`](../docs/AGENT_PIPELINE.md).  
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
| `orchestrator` | `127.0.0.1:3020` | Поллинг issues → Cursor Cloud; schedule; API `/api/jobs` |
| `deployer` | `127.0.0.1:3021` | Published Release + очередь `deploy-requests.json`; docker.sock |
| `pipeline-ui` | `127.0.0.1:3010` | Таблица джоб и деплоев (прокси `/api` → orchestrator) |

Health: `/health` на 3020/3021. UI: http://127.0.0.1:3010/ (прокси `/api` → оркестратор; nginx резолвит имя сервиса на каждый запрос, чтобы после recreate оркестратора не было 502).

## Логи

```powershell
docker compose logs -f orchestrator
docker compose logs -f deployer
```

Ищите: `poll tick`, `developer dispatch`, `tester dispatch`, `skip in-flight job`, `schedule tick`, `deploy poll tick`, `blocked: no tag`, `queued deploy request`.

## Остановить полл

```powershell
docker compose stop orchestrator deployer pipeline-ui
# или полностью:
docker compose down
```

Volume `pipeline_data` хранит `jobs.json`, `deploys.json`, `deploy-requests.json`, `schedule-state.json` — `down` его не удаляет.

## Schedule (P9)

- `SCHEDULE_INTERVAL_MS` (по умолчанию 3600000) в `pipeline/.env`.
- Milestone **due сегодня**, title = tag (`v0.3`): нет tag → комментарий `blocked: no tag`, compose **не** трогаем.
- Есть tag и ещё не в `deploys.json` → запись в `deploy-requests.json`; deployer выполняет один раз (идемпотентно на нескольких тиках).
