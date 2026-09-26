# Way Cloud AI Deploy — Fase 1 (MVP): plano

Status: **aguardando aprovação. Nenhum código foi escrito.**
Escopo do prompt: sites estáticos, SPAs com build e PHP simples; as 11 ferramentas da Fase 1; prévia; checkout com Pix e cartão; provisionamento automático; deploy com SSL; CLI básica; `llms.txt`.
🔶 = a validar em teste antes de virar código.

---

## 1. Revisões à Fase 0 (o que mudou ao detalhar)

| Tema | Fase 0 | Fase 1 | Por quê |
|---|---|---|---|
| **Domínio de prévias** | `*.preview.waypreview.com.br` | **`<slug>.waypreview.com.br`** (um nível) | O wildcard universal e gratuito da Cloudflare cobre `*.waypreview.com.br`, e não `*.preview.…`. Some a emissão por DNS-01. O domínio agora é exclusivo de prévias, então o risco de cookies (R15) cai. 🔶 wildcard com proxy no plano da sua conta |
| **Domínio provisório dos sites pagos** | não tratado | **`<slug>.sites.waypreview.com.br`** (DNS-only → 177.11.55.71) | O produto Plesk exige um domínio ao criar a assinatura, e o cliente ainda não tem um. Depois ele troca pelo domínio próprio (Fase 2) |
| **Chave de API do Plesk** | mcp-service guardava | **Não existe no mcp-service.** Só o agente, local no servidor, roda `plesk bin` | Menos segredos e menos superfície. A assinatura é criada pelo módulo Plesk do WHMCS |
| **Chave de API do WHMCS** | mcp-service usava a API externa | **Não existe no mcp-service.** Só HMAC com o addon; o addon usa `localAPI` | Um vazamento do serviço MCP não dá acesso ao WHMCS |
| **Armazenamento** | MinIO | **Cloudflare R2** (bucket novo) em produção; MinIO só no `docker-compose` de dev | Você já usa R2 |
| **Deploy** | agente (Go ou script) | **Agente em Bash** (poll de 5 s, systemd) no MVP | ~150 linhas, sem compilar, fácil de auditar por você antes de instalar como root |

---

## 2. Decisões técnicas

- **Monorepo pnpm**, TypeScript estrito, Node 20. **Fastify** para a API HTTP; **`@modelcontextprotocol/sdk`** com transporte **Streamable HTTP em modo stateless**. O ID da sessão da Way Cloud vai como parâmetro `sessao_id` em cada ferramenta, o que também serve à CLI.
- **PostgreSQL** com migrações SQL numeradas e o driver `postgres`, sem ORM. **BullMQ + Redis** para jobs (varredura, prévia, deploy, verificação, expiração). **Zod** para entradas e saídas.
- **Upload**: `obter_url_upload` devolve uma URL pré-assinada de PUT no R2 (validade 15 min, tamanho máximo). Não há chamada "concluído": `criar_previa` confere se o objeto existe e roda a varredura.
- **Normalização no servidor**: todo zip é validado e **reempacotado em `.tar.gz` limpo** (sem symlinks, sem caminhos absolutos ou com `..`, sem arquivos especiais, sem `.env`). O agente só recebe esse pacote.
- **Varredura (MVP, em TypeScript)**: limites de tamanho, quantidade e razão de descompressão; extensões proibidas (`.exe`, `.dll`, `.so`, `.bat`…); assinaturas de webshell (`eval(base64_decode`, `c99`, `r57` etc.); heurística de phishing (formulário de senha + marca conhecida + domínio divergente). ClamAV como contêiner **opcional** no compose.
- **Detecção de projeto** (função pura sobre o manifesto): `package.json` (Vite/React/Vue/Angular → pasta de saída `dist`/`build`/`out`), `composer.json`/`.php` (versão de PHP), `wp-config.php`/`wp-content` (WordPress → recusa no MVP com mensagem clara), `next start`/Express (Node server → Fase 3), `.sql`, `.env`. Saída: tipo, requisitos, plano recomendado, avisos.
- **Prévia**: worker extrai em volume compartilhado; **Nginx** estático serve `/srv/previews/<slug>`, com `X-Robots-Tag: noindex`, banner injetado por `sub_filter` e fallback de SPA. Job repetido apaga a pasta ao expirar. **Slug aleatório**, sem dados do cliente. Só estático (PHP não executa).
- **Checkout**: página do addon (`_clientarea`, sem login obrigatório 🔶) com token de uso único e validade curta; só o hash fica no banco. Fluxo: valida CPF/CNPJ (PHP + JS em tempo real) → `AddClient` (ou pede login se o e-mail já existe) → `AddOrder` (Pix Efí por padrão; o cliente troca por cartão Iugu na fatura) → `CreateSsoToken` para a fatura. A IA nunca vê esses dados.
- **Provisionamento**: o Speed BR já provisiona no primeiro pagamento. O addon só acompanha: `InvoicePaid` → estado `pago`; `AfterModuleCreate` → `ativo` + webhook; `AfterModuleCreateFailed` → alerta ao admin + `falhou`. Webhooks HMAC-SHA256 com timestamp e nonce (janela de 5 min), nos dois sentidos.
- **Deploy no Plesk (agente local)**: baixa o `.tar.gz` por URL pré-assinada, confere SHA-256 → extrai em `<vhost>/.waycloud/releases/<id>/` → valida (`index.html|php`, tamanho x cota, dono) → `chown` ao usuário da assinatura → **troca de `httpdocs` por dois `mv` na mesma partição** (janela de milissegundos; guarda o anterior como snapshot) → `plesk bin site --update -php_handler_id plesk-php83-fpm` (IDs confirmados no seu servidor) → Let's Encrypt. Se a verificação falhar, o próprio agente desfaz a troca (rollback automático). SPA recebe `.htaccess` com fallback. 🔶 dono/SELinux dos arquivos movidos, comando exato do Let's Encrypt, se o servidor web é Apache ou LiteSpeed.
- **Erros e mensagens**: todas as respostas têm `mensagem_para_usuario` e `proximo_passo` **a partir de templates fixos**; nunca ecoam texto do projeto (prompt injection). Um teste de contrato varre todas as saídas procurando e-mail, CPF, senha, chave.
- **Logs**: JSON com `correlation_id` (sessão → pedido → fatura → serviço → deploy).

---

## 3. Estrutura de arquivos da Fase 1

```
apps/mcp-service/src/
  server.ts                    # Fastify + MCP (Streamable HTTP)
  config.ts                    # env validada com Zod
  mcp/tools/                   # 1 arquivo por ferramenta (11)
    iniciar-sessao.ts  analisar-projeto.ts  listar-planos.ts
    obter-url-upload.ts  enviar-arquivos.ts  criar-previa.ts
    criar-checkout.ts  status-pedido.ts  publicar.ts
    status-deploy.ts  verificar-site.ts
  api/{upload.ts, webhooks-whmcs.ts, agent.ts, health.ts}
  detect/{detect.ts, rules.ts}          # tipo de projeto (função pura)
  scan/{archive.ts, rules.ts, scan.ts}  # zip-safety + varredura + repack
  jobs/{queue.ts, scan.job.ts, preview.job.ts, deploy.job.ts,
        verify.job.ts, expire.job.ts, reconcile.job.ts}
  security/{hmac.ts, tokens.ts, ratelimit.ts, sanitize.ts}
  addon-client.ts                        # chamadas assinadas ao addon
  db/{index.ts, migrations/0001_init.sql, ...}
packages/shared/src/{schemas.ts, errors.ts, messages.pt-br.ts, types.ts}
packages/cli/src/{index.ts, deploy.ts, status.ts, logs.ts, rollback.ts,
                  pack.ts, ignore.ts}
agent/{waycloud-agent.sh, waycloud-agent.service, install.sh, README.md}
whmcs/modules/addons/waycloud_ai/
  waycloud_ai.php              # _config/_activate/_deactivate/_upgrade/_output/_clientarea
  hooks.php  api.php  checkout.php
  lib/{Db.php, Hmac.php, Cpf.php, Checkout.php, McpClient.php}
  templates/{checkout.tpl, admin.tpl}
docs/{llms.txt, fluxo-para-ias.md, fase-0-planejamento.md, fase-1-plano.md}
tests/{unit,integration,e2e,fixtures/}   # ver §5
docker-compose.yml  .env.example  README.md
```

Ferramentas de admin do MVP no addon: mapa tipo→produto, limites, chaves HMAC, lista de sessões/deploys, logs, funil básico. Métricas completas ficam para a Fase 2.

---

## 4. Ordem de entrega (marcos, com revisão sua ao fim de cada um)

| Marco | Entrega | Precisa de você |
|---|---|---|
| **M1** | shared + banco + detecção + varredura + esqueleto das ferramentas, com testes | nada |
| **M2** | Upload (R2) + prévia (Nginx) + expiração; `docker-compose` de dev | bucket R2 novo, DNS `*.waypreview.com.br` |
| **M3** | Addon WHMCS: config, tabelas, checkout, HMAC, hooks | subir o addon no WHMCS; produto oculto de teste |
| **M4** | Ponte pedido/pagamento/provisionamento + `status_pedido` | teste real de Pix (Efí) no produto oculto |
| **M5** | Agente + `publicar`, `status_deploy`, `verificar_site`, rollback | instalar o agente no Plesk (root) |
| **M6** | CLI `npx waycloud` + `llms.txt` (também em `/llms.txt`) + README + `.env.example` — concluído; `logs` e `rollback` da CLI ficam para a Fase 2 | publicar a CLI no npm (conta da Way Cloud) |
| **M7** | E2E completo, endurecimento, checagem dos critérios de aceite | rodada final em produção |

---

## 5. Testes (mapa dos critérios de aceite do MVP)

| Critério | Teste |
|---|---|
| 1. Estático → prévia → pagamento → HTTPS | `e2e`: compose com WHMCS e agente simulados; site de exemplo até a URL final |
| 2. Pago ⇒ provisionado e publicado | `integration`: webhook `service.active` → job de deploy; agente contra um `plesk` falso e um `httpdocs` em diretório temporário |
| 3. Sem pagamento ⇒ sem hospedagem; prévia expira | `integration`: checkout expirado não gera pedido; job de expiração apaga a pasta |
| 4. Sem credencial/dado pessoal nas saídas | `unit`: schemas `.strict()` + varredura de padrões em todas as respostas das 11 ferramentas |
| 5. Deploy com falha ⇒ nada parcial | `integration`: falha injetada em cada etapa do agente; `httpdocs` continua igual ao snapshot |
| 6. Detecção, checkout, hook de pagamento, provisionamento, deploy | Vitest (TS), PHPUnit (CPF/CNPJ, HMAC, mapeamento), teste do agente Bash com `plesk` falso |

---

## 6. O que preciso de você para a Fase 1

**Decisões (respondo com padrão se você disser "use o seu")**
1. **Domínios**: confirma `<slug>.waypreview.com.br` (prévias) e `<slug>.sites.waypreview.com.br` (site pago provisório)? Os registros antigos do waypreview.com.br (A, MX, www, SPF) precisam ser removidos por você quando formos ao ar.
2. **CPF/CNPJ no WHMCS**: onde ele fica hoje (campo personalizado de cliente? qual o nome/ID?) e quais campos de endereço são obrigatórios? A Efí e a Iugu exigem endereço/CEP para Pix/cartão? O cadastro rápido só tem nome, e-mail, CPF/CNPJ, telefone e senha; endereço teria que ser opcional ou preenchido com valor padrão.
3. **Termos**: URLs de Termos de Uso e Política de Privacidade da Way Cloud (para o consentimento LGPD no checkout).
4. **Alertas ao admin**: e-mail para falha de provisionamento/deploy (qual endereço)?
5. **Mapa de planos**: estático/SPA → Speed BR (pid 173); PHP simples → Boost BR (174). WordPress e Node ficam fora do MVP. Confirma?

**Ações suas, no tempo de cada marco**
- M2: criar um bucket R2 novo (`waycloud-ai`) e uma chave só dele; criar o registro DNS `*.waypreview.com.br` (proxied) e um token da Cloudflare de DNS somente dessa zona, se optarmos por automatizar.
- M3: **duplicar** o Speed BR como produto **oculto** ("AI Deploy - Speed") e criar um produto de teste barato; **subir o addon** por zip no cPanel do WHMCS (eu entrego o zip, sem precisar de acesso ao servidor).
- M5: rodar o instalador do agente como root no Plesk (você lê o script antes).

**Como vamos trabalhar**: eu entrego um marco por vez, com testes passando, e você aprova antes do próximo.


---

## 7. Respostas recebidas (2026-09-23)

- **CPF/CNPJ no WHMCS**: dois campos personalizados de cliente: **"Tipo de documento"** (lista `CPF,CNPJ`, exibido no pedido) e **"CPF/CNPJ"** (texto, obrigatório, exibido na fatura). O addon localiza os IDs **pelo nome** em tempo de execução (`tblcustomfields`), sem IDs fixos no código. 🔶 campos de endereço obrigatórios do WHMCS ainda a confirmar no M3.
- **Termos**: https://waycloud.com.br/termos-de-servicos/ e https://waycloud.com.br/politica-de-privacidade/
- **Alertas ao admin**: contato@waycloud.com.br
- **Mapa de planos e domínios**: padrão do plano (estático/SPA → pid 173; PHP simples → pid 174; `<slug>.waypreview.com.br` e `<slug>.sites.waypreview.com.br`).
- **Ajuste técnico**: o pacote normalizado que o agente recebe é um **.zip** re-gerado pelo servidor (caminhos validados, sem symlinks), extraído com `unzip`, em vez de .tar.gz. Mesmo efeito de segurança, menos uma dependência.


---

## 8. M1 concluído (2026-09-23)

**Entregue** (62 testes automatizados; `pnpm test`, `pnpm typecheck`):
- `packages/shared`: esquemas Zod (entrada e saída) das 11 ferramentas, envelope `{ok, codigo, mensagem_para_usuario, proximo_passo, dados}` e todas as mensagens em português como texto fixo.
- `apps/mcp-service`: detecção de tipo de projeto, leitura segura de zip (zip-slip, bomba, tamanho declarado falso), varredura (executáveis, webshell, PHP disfarçado, phishing, `.env` removido), pacote `.zip` determinístico, tokens (256 bits, só o hash no banco), HMAC com janela de 5 min e nonce, sessões de 72 h, migração SQL, servidor MCP Streamable HTTP stateless com as 11 ferramentas registradas. Reais: `iniciar_sessao`, `analisar_projeto`, `listar_planos`. As outras 8 respondem "não disponível" até o marco delas.
- Verificado em Postgres 17 real (contêiner descartável): serviço sobe, migra, atende por MCP e grava.

**Achados durante o M1**
1. O driver de produção (`postgres.js`) recusa `BEGIN/COMMIT` em pool; o PGlite dos testes não acusava. Corrigido com `Db.tx` (transação de verdade) e um teste que roda só com `TEST_DATABASE_URL` (instruções no arquivo).
2. O Windows Defender removeu um arquivo de teste que continha amostras literais de webshell (`Backdoor:JS/Chopper.GG`). As amostras agora são montadas em tempo de execução. O histórico do Defender guarda essa detecção; é falso positivo do meu teste, não uma ameaça.
3. **Premium BR (pid 215) está com preço anual igual ao do Pro BR (R$ 1.078,92) no WHMCS**, provável erro de cadastro. Corrigir antes de ir ao ar.

**Limites conhecidos (marcados no código com `ponytail:`)**: varredura por assinaturas (não é antivírus); phishing só bloqueia quando o formulário posta para outro site; preços dos planos vêm de uma semente (o addon passa a fornecer no M3).

**Próximo: M2** — upload (R2), prévia (Nginx estático), expiração e `docker-compose` de dev. Precisa de você: bucket R2 novo com chave própria e o DNS `*.waypreview.com.br`.


---

## 9. M2 concluído (2026-09-24)

**Entregue** (83 testes automatizados, 3 deles contra o R2 real; `pnpm test`):
- `obter_url_upload`: URL pré-assinada de PUT (15 min) **assinada com o tamanho exato**; o storage recusa qualquer outro tamanho (verificado no R2 e no MinIO: 403 com tamanho errado, 200 com o certo). Limite de 20 uploads por sessão/dia.
- `enviar_arquivos`: upload inline (até 5 MB, 200 arquivos), com varredura e pacote normalizado.
- `criar_previa`: lê o .zip, varre, guarda o pacote limpo, publica só a pasta de saída (`dist/`, `build/`...) e devolve a URL e a expiração (24 h). PHP não tem prévia; SPA sem build, WordPress e projetos reprovados recebem mensagens fixas. Máximo de 3 prévias ativas por sessão; uma sessão nunca publica o upload de outra.
- Prévia servida pelo próprio serviço por Host (`preview-serve.ts`; substituiu o Nginx `preview-edge/`, que exigia um segundo serviço em produção): `X-Robots-Tag: noindex`, banner "Prévia Way Cloud", fallback de SPA por marcador, dotfiles e symlinks nunca servidos, só aceita host `<slug de 10 caracteres>.<domínio>`; após um redeploy apaga o disco, a pasta é refeita do pacote guardado no R2.
- Manutenção a cada 10 min: remove prévias expiradas (pasta e registro), apaga uploads de sessões que nunca compraram (7 dias) e apaga sessões sem pedido 30 dias após expirar (LGPD).
- `docker-compose.yml` (Postgres, MinIO, Nginx, serviço), `Dockerfile` do serviço e `.env.example`. Testado ponta a ponta na pilha real: IA cliente por MCP → upload inline e por URL pré-assinada → prévia aberta pelo Nginx.

**Achados durante o M2**
1. Faltava `.dockerignore`: a imagem copiava o `node_modules` do Windows. Corrigido.
2. A URL pré-assinada assina o host; com MinIO dentro do Docker o cliente precisa de outro endereço. Novo `S3_PUBLIC_ENDPOINT` opcional (no R2 é igual ao endpoint).
3. No R2, o arquivo de segredos tinha o ID de conta errado e valores trocados. Corrigido e reescrito; o token original não ficou em disco.

**Desvio do plano**: sem Redis/BullMQ no M2. A manutenção usa um timer simples (`ponytail:` no código), suficiente para 1 instância. O BullMQ entra no M5, onde o deploy precisa de fila e retentativa.

**Limites conhecidos**: o timer não é seguro com várias réplicas (usar `pg_try_advisory_lock`); o pacote em `uploads/` expira em 7 dias sem pedido (o M5 copia o pacote para um prefixo permanente quando o pedido for pago).

**Próximo: M3** (addon WHMCS: checkout, HMAC, hooks). Precisa de você: duplicar o Speed BR como produto oculto, e subir o addon por zip no cPanel do WHMCS.


---

## 10. M3 concluído (2026-09-24)

**Entregue**
- **Addon WHMCS** (`whmcs/modules/addons/waycloud_ai/`, PHP 8.1): configuração, criação idempotente das tabelas (`_activate`/`_upgrade`), painel admin (diagnóstico, mapa de planos, contratações e eventos, sem dados pessoais), página de checkout (mobile-first, validação de CPF e CNPJ em tempo real, incluindo o CNPJ alfanumérico de 2026), API assinada para o serviço MCP, e hooks `InvoicePaid`, `AfterModuleCreate`, `AfterModuleCreateFailed` e `AfterCronJob`.
- **Fluxo**: link com token de uso único (só o hash é guardado, validade 48 h, um link novo cancela o anterior) → cadastro rápido → `AddClient` (endereço padrão, CPF/CNPJ nos campos personalizados) → `AddOrder` (Pix Efí, domínio provisório `<slug>.sites.waypreview.com.br`) → `CreateSsoToken` para a fatura. Cliente já existente precisa entrar na conta; nunca se anexa pedido a conta alheia. Duplo envio e concorrência criam um único pedido (compare-and-set no banco).
- **Webhooks para o MCP**: fila (outbox) com HMAC-SHA256 + timestamp + nonce e reenvio com backoff pelo cron do WHMCS. Payloads só com IDs, nunca e-mail, CPF, telefone ou senha (há teste para isso).
- **Serviço MCP**: `criar_checkout` (ferramenta 4 de 11 completas na Fase 1), cliente assinado do addon (recusa link fora do host do WHMCS), `ADDON_URL`/`ADDON_HMAC_SECRET`.
- **Ferramentas**: `pnpm build:addon` (zip), `pnpm checkout:dev` (gera link de teste sem o MCP), `pnpm test:php`.

**Verificação** (o que realmente rodou)
- PHP 8.1 (a versão do WHMCS): lint de todos os arquivos, **35 testes** do núcleo com fakes e **14** do contrato do armazenamento, este último rodando o `CapsuleStore` e o `Schema` no query builder real do Laravel (SQLite), que é a base do `Capsule` do WHMCS.
- Node: 92 testes; **6 testes Node ↔ código PHP real** (opt-in `PHP_E2E=1`): assinatura idêntica nas duas linguagens (com acentos), link de checkout, planos, recusa de segredo errado, adulteração, replay e timestamp velho.
- Testes de mutação: removida a trava contra pedido duplicado, um teste falha (o teste original não pegava; foi reescrito para concorrência real).

**Não verificável sem o seu WHMCS** (lista em `docs/whmcs-instalacao.md`, seção 3): nomes exatos de alguns parâmetros de `localAPI` e variáveis dos hooks, CSRF/Smarty na página de addon, exigência de endereço pela Efí/Iugu, e o Plesk aceitar o domínio provisório. O painel de diagnóstico e o roteiro de homologação cobrem cada ponto.

**Ajuste de segurança**: o segredo HMAC fica em campo de texto do addon (não criptografado no banco), como a maioria das chaves de módulos; teto conhecido, migrar para armazenamento cifrado se o acesso ao banco/admin for ampliado.

**Próximo: M4** (ponte pedido → pagamento → provisionamento no serviço MCP): receptor `POST /webhooks/whmcs`, `status_pedido`, planos vindos do addon (o mapa de planos passa a valer também para `listar_planos`; hoje a semente de preços usa os pids públicos).


---

## 11. M4 concluído (2026-09-24)

**Entregue**
- **Receptor de webhooks** `POST /webhooks/whmcs` no serviço MCP: HMAC sobre os bytes exatos recebidos (rota com corpo bruto, isolada da rota `/mcp`), janela de 5 min, nonce contra replay, 401 opaco para qualquer falha de autenticação.
- **Processamento idempotente e transacional**: cada evento traz o id da fila do addon (`webhook_events`); o reenvio com o mesmo id é reconhecido como duplicado. Tudo roda numa transação: se algo falha, nada fica gravado e o addon reenvia depois.
- **Ordem dos eventos**: pedidos só avançam (`aguardando_pagamento` → `pago` → `ativo`/`falhou`); um evento atrasado nunca desfaz o estado nem o rebaixa, mas ainda preenche os IDs. `ativo` e `falhou` são finais. Sessão desconhecida (já apagada) é reconhecida sem reenvio infinito.
- **`status_pedido`**: `sem_pedido`, `aguardando_pagamento`, `pago`, `ativo`, `falhou`, com mensagem em português e intervalo sugerido de consulta (30 s aguardando, 5 s pago, 0 nos estados finais). Falha de provisionamento aparece sem detalhe técnico.
- **`service.active`** grava a assinatura (domínio provisório, servidor `whmcs-<id>`, plano) para o deploy do M5.
- **Planos vindos do addon** (`planCatalog`): preço e pid ficam no WHMCS (cache de 5 min; se o addon cair serve o último bom; sem cache falha em vez de inventar; pausa de 30 s para não travar cada chamada no timeout). Limites de disco e domínios ficam no serviço, por tipo. `listar_planos`, `analisar_projeto` e `criar_checkout` usam esse catálogo. Sem addon configurado (dev) usam a semente.

**Verificação**: 116 testes Node (7 deles exercitam o **código PHP real** nas duas direções: Node→PHP e PHP→Node), 35 + 14 no PHP 8.1. O teste PHP→Node cobre o cenário completo: serviço fora do ar (3 eventos ficam na fila, status 0), depois no ar (3 entregas, 200), aplicados em ordem, `status_pedido` chega a `ativo`.

**Achados**
1. A Cloudflare (regra "Bad Bot") barra requisições **sem User-Agent** ou em **HTTP/1.0**. O cliente do serviço e o do addon sempre enviam User-Agent em HTTP/1.1, então não é preciso exceção de WAF (testado contra o `app.waycloud.com.br`).
2. Meus testes tinham dois erros próprios (relógio falso assinando timestamp no futuro; `spawnSync` travando o servidor no mesmo processo). Ambos corrigidos; o código de produção estava certo.

**Produtos ocultos**: Speed = pid 223, Boost = pid 224 (mapa de planos do addon: estático/SPA → 223, PHP → 224).

**Ainda não feito**: o serviço não está no Easypanel, e o addon não está no WHMCS. Sem os dois, o ciclo completo em produção ainda não roda.


---

## 12. Em produção (2026-09-24)

**No ar**
- **Addon WHMCS 0.3.2** em `app.waycloud.com.br` (conta cPanel `waycloud`), ativado. Tabelas criadas, segredo HMAC gravado, mapa de planos = estático/SPA → pid 223 e PHP → pid 224. Diagnóstico do painel: todos os itens OK.
- **Serviço MCP** no Easypanel, projeto `web-way`, serviços `waycloud-ai-mcp` (a partir do GitHub, `thisisway/waycloud-ai-deploy`, Dockerfile em `apps/mcp-service`) e `waycloud-ai-db` (Postgres 17). Endereço provisório: `https://web-way-waycloud-ai-mcp.fzd763.easypanel.host` (o addon já aponta para ele). O DNS `mcp.waycloud.com.br` fica para depois.
- Teste ponta a ponta pelo MCP público: `iniciar_sessao` → `listar_planos` (preços vindos do WHMCS) → `analisar_projeto` → `enviar_arquivos` (R2) → `criar_previa` → `criar_checkout` (link real) → `status_pedido` (`sem_pedido`).

**Achados que só a produção mostrou**
1. **"Celular" é campo de cliente obrigatório** no seu WHMCS: o cadastro rápido não o preenchia e a primeira compra real falharia. Corrigido (0.3.2), e o diagnóstico agora avisa de qualquer campo obrigatório que o checkout não cubra.
2. O cache do PHP (opcache) mantinha o código antigo porque o zip gravava todas as datas fixas; o empacotamento agora usa a data real.
3. O plano do Easypanel não permite mais de 3 projetos: os serviços ficaram dentro de `web-way`.
4. O PowerShell prefixa 3 bytes (BOM) ao enviar texto por pipe: o segredo foi regravado filtrando só hexadecimal.

**Ainda por fazer**
- Compra real de teste (link -> cadastro -> fatura -> pagamento -> `ativo`).
- Prévias em produção: o Nginx da prévia depende de volume compartilhado, e o Easypanel não garante a permissão de escrita para o usuário do serviço. Proposta: o próprio serviço servir a prévia pelo `Host` (`<slug>.waypreview.com.br`), recriando a pasta a partir do pacote no R2 quando ela sumir num redeploy. Depende do DNS `*.waypreview.com.br`.


**Compra de teste em produção (2026-09-24), ciclo completo validado**
Link do checkout -> cadastro rápido -> `AddClient` (com "Celular") -> `AddOrder` -> login automático (SSO) na fatura #8073 com Pix da Efí (aceitou o endereço padrão "Não informado", CEP 00000-000) -> pagamento simulado com `AddInvoicePayment` (`TESTE-IA-8073`) -> hook `InvoicePaid` -> criação automática da hospedagem no Plesk em 15 s (serviço #1011, servidor 18, `ucyp2gio2l.sites.wayleads.com.br`) -> hooks `AfterModuleCreate` -> 3 eventos (`order.created`, `order.paid`, `service.active`) entregues ao MCP na primeira tentativa -> `status_pedido = ativo`.
Confirmado na prática: nomes de parâmetros de `AddClient`/`AddOrder`/`CreateSsoToken`, variáveis dos hooks (`params.serviceid`, `params.serverid`), CSRF e Smarty na página de addon, atribuição automática do servidor 18 pelo grupo de servidores.
Ainda não exercitado: pagamento real de Pix (confirmação da Efí), cartão pela Iugu, falha de provisionamento (`AfterModuleCreateFailed`).
O serviço #1011 foi mantido ativo para testar o deploy do M5; cancelar ao final.


---

## 13. M5 concluído (2026-09-24): publicar, status_deploy, verificar_site e agente de deploy

**Serviço** (em produção no Easypanel, migração `0003` aplicada)
- `publicar`: só com pedido `ativo`; monta um pacote **só com a pasta do site** (SPA ganha o fallback do histórico em `.htaccess`, a menos que o projeto traga o seu) e enfileira o deploy. A fila é o próprio Postgres (`FOR UPDATE SKIP LOCKED`).
- `status_deploy` (`na_fila`, `enviando`, `validando`, `publicado`, `falhou`, `revertido`, com intervalo de consulta e URL) e `verificar_site` (HTTP, HTTPS, tempo de resposta e links internos quebrados; sem SSRF: só o domínio da assinatura, redirects só dentro do mesmo host). Uma sessão só enxerga os próprios deploys; o código de erro do agente nunca chega à IA.
- API do agente (`/agent/v1`): token por servidor (só o hash é guardado; o token antigo morre ao trocar), `jobs/next`, `package`, `report`, `ping`, e o próprio agente e instalador (o repositório é privado). Transições de estado validadas; um servidor não toca nos jobs de outro. Jobs parados viram `failed` (`agent_timeout` / `agent_unavailable`).

**Agente** (`agent/`, Bash, roda como root no Plesk): valida cada campo do job, confere o SHA-256 antes de extrair, extrai numa pasta privada e sanitiza, **troca o docroot por dois `mv`**, guarda o anterior como snapshot (em pasta root-only fora da área do cliente), ajusta o PHP, faz checagem local e **restaura sozinho** se algo falhar depois da troca. Let's Encrypt é tentado; sem DNS apontado o site fica em HTTP até o certificado sair.

**Verificação**
- 26 testes do serviço + **9 do agente rodando de verdade** num contêiner que imita o Plesk (usuário e grupo do site, `plesk` falso, servidor web por Host): publicação atômica com dono/permissões preservados, hash adulterado, site que responde 500 depois da troca (rollback), pacote sem index, PHP (e recusa do Plesk), poda de snapshots, domínios maliciosos e symlink, token errado e instância única.
- **Mutações**: sem a checagem do hash, sem validar o domínio, sem o rollback e sem recusar symlink, um teste falha em cada caso (o teste do symlink era fraco e foi reforçado).
- shellcheck limpo no agente e no instalador.

**Achados**
1. O agente mandava `Content-Type: application/json` em requisições sem corpo e o Fastify respondia 400: teria quebrado em produção. Corrigido nos dois lados.
2. Minha expressão `jq` do relatório nem compilava no jq 1.6; e uma validação recusaria códigos de erro com números (`sha256_mismatch`). Todos pegos pelo teste real.
3. O Easypanel classifica `updateAppEnv` e `deployAppService` como destrutivos; o env foi enviado completo.

**Pendente**: instalar o agente no Plesk (exige root, com você presente) e validar de verdade: servidor web real (Apache, nginx ou LiteSpeed), `plesk bin site --update` para PHP, comando do Let's Encrypt, comportamento do `.htaccess` do SPA e permissões do `httpdocs` do Plesk.


---

## 14. Troca de domínio e segunda compra de teste (2026-09-25)

- Domínio de prévias e dos sites provisórios: **`waypreview.com.br`** (antes `wayleads.com.br`). Prévias: `<slug>.waypreview.com.br`; sites pagos: `<slug>.sites.waypreview.com.br`. O valor salvo no WHMCS (`sites_domain`) foi atualizado à mão, porque o padrão do código não altera o que já foi gravado; addon 0.3.3.
- DNS na Cloudflare: `*.waypreview.com.br` -> 177.11.55.72 (proxy ligado, prévias) e **`*.sites`** -> 177.11.55.71 (**somente DNS**, sites pagos e Let's Encrypt). Um registro chamado `sites` (sem o asterisco) não cobre os nomes abaixo dele: o wildcard `*` deixa de valer sob um nome que existe.
- Segunda compra de teste feita pelo caminho real do checkout (cliente #750 já logado, sem navegador): pedido 1149, fatura #8079, serviço **#1014** (`wncr7fhrhl.sites.waypreview.com.br`). Publicado pelo agente em 15 s. O serviço antigo **#1011 foi encerrado** (`ModuleTerminate`, com travas). As faturas #8073 e #8079 seguem como pagas (teste) no WHMCS.
- Achado: em PowerShell 5.1, canalizar `byte[]` para um comando externo envia cada byte como uma linha; canalizar a string funciona.

## 15. Prévias em produção (servidas pelo serviço)

O Easypanel só emite certificado curinga com um resolver de DNS (não há um configurado), então o `*.waypreview.com.br` não pode apontar direto para o app. A Origin Rule com troca de Host/SNI é exclusiva do plano Enterprise. Solução, no plano gratuito: um Cloudflare Worker na rota `*.waypreview.com.br/*` (registro `*` com proxy laranja) reescreve o hostname para o domínio do serviço (`web-way-waycloud-ai-mcp.fzd763.easypanel.host`) e guarda o original em `X-Preview-Host`:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const original = url.hostname;
    url.hostname = "web-way-waycloud-ai-mcp.fzd763.easypanel.host";
    const proxied = new Request(url, request);
    proxied.headers.set("X-Preview-Host", original);
    return fetch(proxied);
  },
};
```

O serviço usa `X-Preview-Host` quando presente (`preview-serve.ts`). Quem forjar o cabeçalho só alcança prévias, que já são públicas por slug. `*.sites` continua "DNS only" apontando para o Plesk. Verificado em produção: `https://<slug>.waypreview.com.br` responde 200 com banner e `X-Robots-Tag: noindex`; caminho inexistente responde 404 do serviço. Limite do plano gratuito do Worker: 100 mil requisições por dia.

## 16. Página pública de envio

Para quem usa uma IA sem MCP nem comandos (ChatGPT, Claude.ai, Lovable...): a IA entrega um `.zip` e o cliente o arrasta na página inicial do serviço (`apps/mcp-service/public/`, servida em `/`). A página usa as mesmas ferramentas do MCP (same-origin, `POST /mcp`) e um único endpoint extra, `PUT /web/upload/:uploadId`, que grava o `.zip` no R2 pelo serviço (o navegador nunca fala com o R2, então não há CORS a configurar). Fluxo: enviar → prévia → planos (filtrados pelo tipo do projeto) → pagamento em outra aba → publicação automática → link do site. O estado fica em `localStorage`, então recarregar ou voltar do pagamento continua de onde parou.

- CSP restrita (`script-src 'self'`, sem estilos nem scripts inline, sem recursos externos), verificada por teste; o código da página não usa `innerHTML`.
- `listar_planos` passou a devolver `tipos` (tipos de projeto que o plano atende) para a página não oferecer plano estático a um site PHP.
- Endereço público: o Worker do Cloudflare também atende o domínio raiz (`waypreview.com.br/*`), que o serviço trata como o site (página, `/mcp`, `/llms`), e não como prévia.

## 17. Cadastro dentro da página (versão 0.4.0 do addon)

O cliente não sai mais do `waypreview.com.br` para se cadastrar: a etapa "Seus dados" (nome, e-mail, CPF/CNPJ, telefone, aceite dos termos) faz parte da página. Só o pagamento (Pix ou cartão) continua na fatura do WHMCS, por segurança (cartão) e porque as renovações dependem do módulo de gateway.

- `POST /web/checkout` no serviço (mesma origem): valida a sessão e o plano, limita tentativas (por IP, por sessão e no total) e repassa o formulário ao addon, assinado com HMAC, na ação `register_checkout`. O serviço não guarda, não registra e não devolve dados pessoais; o teste confere todas as tabelas. O IP vem de `X-Real-IP` (o Worker do Cloudflare pode enviá-lo: `proxied.headers.set("X-Real-IP", request.headers.get("cf-connecting-ip"))`).
- Addon: `Checkout::registerFromWeb`. Mesmo fluxo do link do WHMCS (cliente, pedido, fatura, SSO), mas **sem senha**: o cliente é criado com uma senha aleatória e o addon pede ao WHMCS o e-mail para ele definir a sua (`ResetPassword`). Cliente que já existe recebe a orientação de entrar na conta e o link da página do WHMCS para continuar.
- Depois de pagar, a fatura mostra "Voltar para a Way Cloud" (e volta sozinha quando está paga). A página retoma de onde parou (o estado da compra fica no `localStorage`, os dados pessoais nunca) e publica assim que o pedido fica ativo.
- Endereços devolvidos pelo addon (`redirect`, `fallback_url`) precisam estar no mesmo host do WHMCS, senão o serviço recusa.
- Limites conhecidos: os limites de tentativas ficam em memória (zeram ao reiniciar); um desafio anti-robô (Cloudflare Turnstile) é o próximo passo se aparecer cadastro falso.

## 18. HTTPS na publicação (aprendizado do primeiro teste com pagamento)

No primeiro teste com cadastro pela página, o site foi publicado mas o HTTPS não: o Plesk cria o site com "redirecionar HTTP para HTTPS" ligado e sem certificado válido, então o visitante caía num erro de certificado, e a validação do Let's Encrypt (feita pelo próprio Plesk) também falhava por causa desse redirecionamento. O agente agora desliga o redirecionamento até existir o certificado, tenta de novo por até 24 horas com pausas crescentes e avisa o serviço quando sai (`published` -> `published` com `ssl: true`, só nessa direção). A página do cliente mostra "Estamos ativando o HTTPS" e acompanha até ficar pronto.

## 19. Domínio próprio do cliente

Depois de publicado, o cliente pode conectar o domínio dele; o domínio provisório (`<slug>.sites...`) deixa de existir (o domínio do cliente passa a ser o principal do site).

1. **Pedido** (`POST /web/domain`, página): só para quem tem plano ativo e site publicado; o domínio é normalizado (sem `https://`, caminho, `www.`), recusado se for nosso (`waycloud.com.br`, `waypreview.com.br`, o domínio de prévias) ou se já estiver em uso por outro site. A página mostra os registros de DNS a criar: **A** para o IP (resolvido a partir do nome `SITE_TARGET_HOST`, hoje `hospedagem.waycloud.com.br`) ou CNAME/ALIAS para o nome, e **CNAME `www`** para o nome.
2. **DNS**: o serviço confere sozinho (na hora em que o cliente olha e a cada minuto, com pausas crescentes por até 7 dias). Só aprova quando **todos** os registros A do domínio são nossos (um registro antigo em outro lugar dividiria os visitantes).
3. **Troca no Plesk**: o agente renomeia a assinatura (`subscription --update -new-name`), confere pasta e resposta do site, pede o certificado (domínio e `www`) e reporta; qualquer falha reverte o nome (ver `agent/README.md`).
4. **WHMCS**: o serviço avisa o addon (`update_service_domain`, addon 0.5.0), que só aceita serviços criados pelo fluxo de IA; se o WHMCS estiver fora do ar a troca não é desfeita e o aviso é repetido pelo cronômetro do serviço.
5. **Página**: acompanha "aguardando o DNS", "configurando", "ativando o HTTPS" e "pronto", e troca o endereço mostrado para o novo.

Ainda não coberto: venda de domínio (registrar um novo pelo WHMCS), mais de um domínio por site e o retorno ao provisório.
