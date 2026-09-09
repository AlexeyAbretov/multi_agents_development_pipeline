# Запуск агентного пайплайна с нуля

Конституция: [CONSTITUTION.md](./CONSTITUTION.md).  
Контракт (роли, labels): [AGENT_PIPELINE.md](./AGENT_PIPELINE.md).  
Этапы разработки: [AGENT_PIPELINE_PLAN.md](./AGENT_PIPELINE_PLAN.md).

Сейчас из коробки поднимаются **P0–P12 + UI**: оркестратор, deployer, очередь на `http://127.0.0.1:3010/`.

Checkout **целевого продукта** (каталог, API и т.д.) для оркестратора **не нужен** — Cursor Cloud клонирует его по `CURSOR_REPO_URL`. Для `DEPLOY_MODE=compose` нужен отдельный clone продукта на хосте (`PRODUCT_WORKSPACE_HOST`).

---

## Что должно получиться

1. Контейнер слушает `http://127.0.0.1:3020/health` → `{"status":"ok"}`.
2. На GitHub **целевого продукта** создаёте issue с labels `feature` (или `bug`) **и** `needs-plan`.
3. В течение ~30 с оркестратор стартует Cursor Cloud: снимает `needs-plan`, ставит `in-analysis`, пишет комментарий с `agentId` / `runId`.
4. После ответа аналитика: комментарий со статусом, **отдельный комментарий с текстом плана**, снимается `in-analysis`, ставится `ready-for-dev` или `needs-human`.
5. На `ready-for-dev` стартует разработчик (`in-dev`). После открытого PR `Fixes #N` — `in-qa` (не merge в `main`).
6. На `in-qa` стартует тестировщик (ревью ветки PR). CI: workflow `.github/workflows/ci.yml` **в репозитории продукта**, job `ci`.
7. На `qa-passed` стартует релиз-менеджер → draft Release, assignee owner, request review, `ready-for-release`. Publish / merge — после вашей метки `release-approved`, вручную.
8. После **Publish** Release (не draft) локальный `deployer` пишет статус в тело Release и labels `deployed` / `deploy-failed` (по умолчанию `DEPLOY_MODE=stub`).

Повторный полл ту же пару `(issue, role)` не запускает — состояние в volume `jobs.json`. Деплои — в `deploys.json` того же volume.

---

## 0. Требования

- Docker Desktop (Windows) или Docker Engine + Compose v2.
- Репозиторий **целевого продукта** на **вашем** GitHub (owner), не только collaborator. Cloud Agents видят репо через GitHub App владельца.
- Аккаунт Cursor, у которого в Cloud Agents в **Default Repository** виден репозиторий продукта.
- Регион, где Cursor Cloud Agents разрешены (иначе `Cursor is not available in your region`).
- Исходящий HTTPS с машины: `api.github.com`, API Cursor. Входящий туннель не нужен.

---

## 1. Клон репозитория пайплайна

```powershell
git clone https://github.com/AlexeyAbretov/multi_agents_development_pipeline.git
cd multi_agents_development_pipeline
git checkout main
```

Код оркестратора: `pipeline/`, compose: `docker-compose.yml` в корне.

Для `DEPLOY_MODE=compose` дополнительно клонируйте продукт рядом, например:

```powershell
cd ..
git clone https://github.com/owner/your-product-repo.git
```

---

## 2. Labels на GitHub (репозиторий продукта)

Issues → Labels в **репозитории продукта**. Создайте, если нет (имена **точно** такие):

| Имя | Зачем |
|-----|--------|
| `bug` | тип |
| `feature` | тип |
| `needs-plan` | очередь аналитика |
| `in-analysis` | аналитик работает |
| `ready-for-dev` | план принят, очередь разработчика |
| `in-dev` | разработчик работает |
| `in-qa` | PR ждёт QA или исправления дефектов |
| `qa-in-progress` | тестировщик работает |
| `qa-passed` | QA успешно пройден |
| `ready-for-release` | RM собрал draft, ждёт апрув |
| `release-approved` | человек разрешил merge/Publish (ставит вручную) |
| `deployed` | локальный деплой успешен |
| `deploy-failed` | локальный деплой упал |
| `needs-human` | стоп автоматики |
| `p0` … `p3` | приоритет (по желанию) |

Без этих имён API постановки меток вернёт ошибку.

Шаблон issue — в репозитории **продукта** (если есть).

---

## 3. GitHub PAT (`GITHUB_TOKEN`)

Это **секрет токена**, не номер issue.

1. GitHub (тот же owner, что у **продукта**) → Settings → Developer settings → **Personal access tokens** → Fine-grained.
2. Resource owner — владелец репо продукта. Repository access — **Only select** → ваш продукт.
3. Repository permissions: **Issues → Read and write**, **Pull requests → Read and write** (request review), **Contents → Read and write** (draft Releases). Metadata — Read.
4. Скопируйте значение (`github_pat_...`).

---

## 4. Cursor API (`CURSOR_API_KEY`)

**[cursor.com/dashboard/api](https://cursor.com/dashboard/api)** → API Keys → New API Key.

В `pipeline/.env` — **значение** (`crsr_...` или `cursor_...`).

Тот же аккаунт Cursor:

1. [Integrations](https://cursor.com/dashboard/integrations) → **Connect GitHub** аккаунтом **владельца** репо продукта.
2. GitHub App Cursor: доступ к репозиторию продукта (All или Only select).
3. Cloud Agents → Default Repository — продукт в списке.

`CURSOR_MODEL` по умолчанию `composer-2.5`.

Для разработки **самого пайплайна** добавьте в GitHub App доступ к `multi_agents_development_pipeline`.

---

## 5. Файлы `.env`

```powershell
copy .env.example .env
copy pipeline\.env.example pipeline\.env
```

Корневой `.env` (для compose):

```
PRODUCT_WORKSPACE_HOST=../your-product-repo
```

`pipeline/.env` — секреты и целевой продукт:

```
GITHUB_TOKEN=<секрет PAT>
GITHUB_REPO=owner/your-product-repo
CURSOR_API_KEY=<секрет ключа Cursor>
CURSOR_REPO_URL=https://github.com/owner/your-product-repo
CURSOR_STARTING_REF=main
```

`pipeline/.env` и корневой `.env` в git не коммитить.

---

## 6. Запуск Docker

Из корня репозитория пайплайна:

```powershell
docker compose up --build -d
```

Проверка:

```powershell
Invoke-RestMethod http://127.0.0.1:3020/health
Invoke-RestMethod http://127.0.0.1:3021/health
Start-Process http://127.0.0.1:3010/
docker compose logs -f orchestrator
docker compose logs -f deployer
```

У `orchestrator` **нет** docker.sock. У `deployer` sock есть; при `DEPLOY_MODE=compose` он делает `docker compose -f docker-compose.yml up -d` в `/product` (checkout продукта). По умолчанию `DEPLOY_MODE=stub` — только запись в GitHub без `compose up`.

После правки env:

```powershell
docker compose up -d --force-recreate
```

Остановка:

```powershell
docker compose down
```

Volume `multi_agents_development_pipeline_pipeline_data` (или `<project>_pipeline_data`) хранит `jobs.json`. `down` его **не** удаляет.

**Миграция с monorepo:** если раньше volume назывался `llm_app_dev_pipeline_data`, скопируйте данные или переименуйте volume в SETUP вручную после первого `up` из нового репо.

---

## 7. Первая задача

1. New issue в **репозитории продукта**.
2. Labels: **`feature` или `bug`** + **`needs-plan`**.
3. Ждите ≤ `POLL_INTERVAL_MS` (по умолчанию 30 с).

Подробнее про цикл QA, RM и deploy — см. прежние разделы контракта [AGENT_PIPELINE.md](./AGENT_PIPELINE.md) §3–§4.

---

## 8. Сброс очереди (`jobs.json`)

```powershell
docker compose exec orchestrator rm -f /data/jobs.json
```

Или volume:

```powershell
docker compose down
docker volume rm multi_agents_development_pipeline_pipeline_data
docker compose up -d
```

---

## 9. Частые ошибки

| Симптом | Что делать |
|---------|------------|
| `poll skip: GITHUB_TOKEN or GITHUB_REPO empty` | Ключи в **`pipeline/.env`**; `--force-recreate` |
| `set PRODUCT_WORKSPACE_HOST in .env` | Создайте корневой `.env` из `.env.example` |
| compose failed: no such file | `PRODUCT_WORKSPACE_HOST` указывает на clone продукта с `docker-compose.yml` |
| `Cursor is not available in your region` | Cloud Agents недоступны; оркестратор тут ни при чём |

Кратко про логи и stop: [pipeline/README.md](../pipeline/README.md). UI: `http://127.0.0.1:3010/`.

Промпты ролей: `pipeline/prompts/`.
