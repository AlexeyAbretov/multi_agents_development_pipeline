# AGENTS.md — инструкции для AI-агента (пайплайн)

## Проект

Оркестратор агентного процесса: поллинг GitHub Issues целевого продукта → Cursor Cloud → локальный deployer.

## Документы

| Файл | Содержание |
|------|------------|
| [docs/CONSTITUTION.md](docs/CONSTITUTION.md) | Конституция (принципы, запреты) |
| [docs/AGENT_PIPELINE.md](docs/AGENT_PIPELINE.md) | Контракт пайплайна |
| [docs/AGENT_PIPELINE_ARCHITECTURE.md](docs/AGENT_PIPELINE_ARCHITECTURE.md) | Статусная модель, код, точки расширения |
| [docs/AGENT_PIPELINE_PLAN.md](docs/AGENT_PIPELINE_PLAN.md) | Этапы `pipeline/N-…` |
| [docs/AGENT_PIPELINE_SETUP.md](docs/AGENT_PIPELINE_SETUP.md) | Запуск оркестратора |
| [pipeline/README.md](pipeline/README.md) | Логи, UI :3010, локальный npm |
| [.cursor/rules/](.cursor/rules/) | Правила для Cursor |

## Git-workflow

- Один этап пайплайна = одна ветка `pipeline/N-…`
- Merge в `main` **только после явного подтверждения** пользователя
- Не смешивать с ветками `stage/*` продукта

## Команды

```bash
cp .env.example .env
cp pipeline/.env.example pipeline/.env
docker compose up --build -d          # orchestrator :3020, deployer :3021, UI :3010
cd pipeline && npm ci && npm run build && npm test
cd pipeline-ui && npm ci && npm run build
docker compose logs -f orchestrator
docker compose down
```

Локально без Docker (оркестратор): `copy pipeline\.env.local.example pipeline\.env.local` → заполнить секреты → `cd pipeline && npm ci && npm start`. Отладка: VSCode **Orchestrator**. Подробнее: [docs/AGENT_PIPELINE_SETUP.md](docs/AGENT_PIPELINE_SETUP.md) §10.

Целевой продукт настраивается в `pipeline/.env` или `pipeline/.env.local` (`GITHUB_REPO`, `CURSOR_REPO_URL`). Для деплоя — `PRODUCT_WORKSPACE_HOST` в корневом `.env`.
