# Way Cloud AI Deploy

Assistentes de IA (Claude, ChatGPT, Cursor, Lovable, Bolt...) publicam o site do cliente na hospedagem da Way Cloud: prévia grátis, pagamento por Pix ou cartão no navegador, provisionamento automático no WHMCS e deploy com HTTPS no Plesk.

```
IA do cliente --MCP--> serviço MCP --HMAC--> addon do WHMCS (cadastro, pedido, fatura)
CLI npx waycloud --MCP--> serviço MCP <--pull-- agente nos servidores Plesk (deploy, SSL, rollback)
```

Todo texto para o cliente está em português do Brasil. Código e commits em inglês.

## O que tem aqui

| Pasta | O quê |
|---|---|
| `apps/mcp-service` | Serviço MCP (TypeScript, Fastify, Streamable HTTP sem estado): 11 ferramentas, prévias, fila de deploy, rotas do agente |
| `packages/shared` | Schemas Zod das ferramentas, envelope de resposta e catálogo de mensagens pt-BR |
| `packages/cli` | CLI `npx waycloud` (deploy, plans, checkout, status) |
| `whmcs/modules/addons/waycloud_ai` | Addon do WHMCS (PHP): checkout, provisionamento, webhooks assinados |
| `agent` | Agente de deploy (bash) que roda em cada servidor Plesk, e o instalador |
| `docs` | `llms.txt` (guia para IAs), plano das fases, instalação do addon |
| `tests` | Testes unitários e de integração; PHP e agente rodam em Docker |

## Rodar localmente

Precisa de Node 22+, pnpm e Docker.

```bash
pnpm install
docker compose up --build        # Postgres, MinIO (no lugar do R2) e o serviço
```

- MCP: `http://localhost:13000/mcp`
- Guia para IAs: `http://localhost:13000/llms.txt`
- Prévias: `http://<slug>.localhost:13000`
- Console do MinIO: `http://localhost:19001` (waycloud / waycloud-dev-secret)

Sem `ADDON_URL`/`ADDON_HMAC_SECRET` os planos vêm de uma lista de exemplo e o checkout fica indisponível. Todas as variáveis estão comentadas em `.env.example`.

Para conectar uma IA, adicione um conector MCP remoto apontando para `/mcp`. Sem MCP, use a CLI:

```bash
WAYCLOUD_URL=http://localhost:13000/mcp npx waycloud deploy ./meu-site
```

## CLI

```
waycloud deploy [pasta]                      compacta, envia, cria a prévia e, com plano ativo, publica
waycloud plans                               planos e preços
waycloud checkout --plano <pid> [--ciclo mensal|anual]
waycloud status                              pedido, último deploy e verificação do site
```

Respeita `.gitignore` e `.waycloudignore` (mesma sintaxe); nunca envia `.env`, `.git` nem `node_modules`; mantém `dist`/`build`/`out` mesmo quando ignorados. O estado da sessão fica em `.waycloud/session.json` (já excluído do envio). `logs` e `rollback` chegam na próxima fase.

## Testes

```bash
pnpm test                                   # unitários e integração (Postgres embutido, sem Docker)
pnpm typecheck
PHP_E2E=1 AGENT_E2E=1 pnpm test            # inclui o addon PHP e o agente em Docker
TEST_DATABASE_URL=... TEST_S3_ENDPOINT=... pnpm test   # inclui Postgres e S3 reais (variáveis no topo de postgres-driver.test.ts e s3-storage.test.ts)
```

## Produção

- **Serviço MCP:** imagem de `apps/mcp-service/Dockerfile` (contexto na raiz do repositório), com Postgres e Cloudflare R2. Variáveis em `.env.example`.
- **Prévias:** o próprio serviço serve `<slug>.waypreview.com.br` por Host. No Cloudflare, o registro `*` fica com proxy e um Worker repassa ao serviço (`docs/fase-1-plano.md`, seção 15).
- **Addon do WHMCS:** `pnpm build:addon` gera `dist/waycloud_ai-<versão>.zip`. Instalação e homologação em `docs/whmcs-instalacao.md`.
- **Agente nos servidores Plesk:** instalador servido pelo serviço, ver `agent/README.md`.

## Segurança em resumo

O MCP não guarda credenciais do WHMCS (só um segredo HMAC com o addon). A IA nunca vê dados pessoais nem de pagamento. Arquivos do cliente são tratados como dado, e as respostas das ferramentas só usam mensagens fixas. Uploads passam por limites de zip e varredura; o agente valida hash e tamanho, troca a pasta do site de forma atômica e volta sozinho para a versão anterior se a verificação falhar.
