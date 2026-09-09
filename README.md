# Multi Agents Development Pipeline

Локальный оркестратор агентного процесса разработки: GitHub Issues → Cursor Cloud (аналитик, разработчик, тестировщик, релиз-менеджер) → локальный deployer.

Репозиторий **независим** от целевого продукта. Связь только через конфигурацию: `GITHUB_REPO`, `CURSOR_REPO_URL`, `PRODUCT_WORKSPACE_HOST` (для деплоя).

## Быстрый старт

```bash
git clone https://github.com/AlexeyAbretov/multi_agents_development_pipeline.git
cd multi_agents_development_pipeline
cp .env.example .env
cp pipeline/.env.example pipeline/.env
# Заполните pipeline/.env: GITHUB_TOKEN, GITHUB_REPO (продукт), CURSOR_API_KEY
# В .env: PRODUCT_WORKSPACE_HOST=../path-to-product-checkout
docker compose up --build -d
curl -s http://127.0.0.1:3020/health
```

UI очереди: http://127.0.0.1:3010/

## Документация

| Файл | Содержание |
|------|------------|
| [docs/CONSTITUTION.md](docs/CONSTITUTION.md) | Конституция (принципы, git-workflow, запреты) |
| [docs/AGENT_PIPELINE.md](docs/AGENT_PIPELINE.md) | Контракт (labels, роли, апрув) |
| [docs/AGENT_PIPELINE_SETUP.md](docs/AGENT_PIPELINE_SETUP.md) | Запуск с нуля |
| [docs/AGENT_PIPELINE_PLAN.md](docs/AGENT_PIPELINE_PLAN.md) | Этапы `pipeline/N-…` |
| [pipeline/README.md](pipeline/README.md) | Логи, stop полла, schedule |
| [AGENTS.md](AGENTS.md) | Команды для AI-агента |

## Тесты

```bash
cd pipeline && npm ci && npm run build && npm test
```
