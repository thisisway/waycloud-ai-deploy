# Way Cloud AI Deploy — Fase 0: Planejamento

Status: **aguardando aprovação**. Nenhum código foi escrito.
Legenda: 🔶 = precisa ser validado em homologação/documentação oficial antes de implementar. Não tenho certeza do comportamento exato desses pontos e não vou supor.

---

## 1. Arquitetura e justificativa

```
                        ┌─────────────────────────────────────────────┐
 [IA do cliente] ──MCP──▶│ mcp-service (Node 20, Streamable HTTP)       │
 [CLI npx waycloud]─HTTPS▶│  ├─ ferramentas MCP + API REST (/upload)     │
                        │  ├─ PostgreSQL (sessões, projetos, deploys)  │
                        │  ├─ Redis + BullMQ (prévia, deploy, SSL)     │
                        │  └─ Storage S3-compatível (zips, snapshots)  │
                        └───────┬─────────────────────┬────────────────┘
                     API externa│ HMAC (ida e volta)  │ jobs assinados (pull)
                                ▼                     ▼
                     ┌──────────────────┐   ┌───────────────────────────┐
 [Navegador do  ───▶ │ WHMCS            │   │ waycloud-agent (1 por      │
  cliente]           │  addon waycloud_ai│   │ servidor Plesk)            │
  checkout/Pix       │  (checkout, hooks)│   │  └─ Plesk CLI/REST local   │
                     │  módulo Plesk     │──▶│ Plesk (assinaturas)        │
                     └──────────────────┘   └───────────────────────────┘
                                             [Nginx de prévias] *.preview.…
```

Decisões e por quê:

| Decisão | Justificativa |
|---|---|
| **Fonte de verdade dividida**: mcp-service manda em sessão/projeto/upload/deploy; addon manda em cliente/pedido/fatura/serviço | Evita duplicar estado financeiro fora do WHMCS e estado de deploy dentro dele. Os dois se ligam por `session_id` ↔ `service_id`. |
| **Addon ↔ serviço só por HMAC-SHA256 + timestamp + nonce** (nos dois sentidos) | Exigido no prompt; o nonce evita replay. |
| **Checkout token criado pelo addon** (MCP pede via chamada assinada) | O addon serve a página e precisa validar o token; guardar só o hash lá elimina uma chamada de volta na hora do cadastro. |
| **PostgreSQL** para o serviço | JSONB para manifesto/relatórios, bom com BullMQ/Redis ao lado. MySQL também serve; diga se prefere. |
| **Storage S3-compatível** (MinIO em dev, R2/S3/Backblaze em prod) | URL pré-assinada nativa; zips não passam pelo processo Node. |
| **Prévias fora do Plesk de produção**, em Nginx estático dedicado com certificado wildcard | Ver §5 e pergunta P5. O prompt sugere assinatura Plesk; recomendo mudar por isolamento e por simplicidade de expiração. |
| **Agente de deploy por servidor Plesk**, modelo *pull* | Ver §5. |
| **Sessão anônima = bearer secret** (≥128 bits, só o hash no banco) | Aceitável no MVP, mas com riscos sérios após o pagamento (R1). |

---

## 2. Modelo de dados

### 2.1 Addon WHMCS (banco do WHMCS, via Capsule, prefixo `mod_waycloud_`)

| Tabela | Colunas principais |
|---|---|
| `mod_waycloud_plan_map` | `id`, `project_type` (static/spa/php/wordpress/node), `pid`, `priority`, `active` |
| `mod_waycloud_checkouts` | `id`, `token_hash` (unique), `session_id`, `pid`, `billing_cycle`, `status` (novo/usado/expirado/cancelado), `client_id` null, `order_id` null, `invoice_id` null, `service_id` null, `expires_at`, `created_at` |
| `mod_waycloud_services` | `service_id` (PK), `session_id`, `plesk_server_id`, `plesk_subscription_id` null, `primary_domain` null, `provisioned_at`, `deploy_token_hash` null (ver P8) |
| `mod_waycloud_events` | `id`, `correlation_id`, `type`, `ref_type`, `ref_id`, `payload_json` (sem PII), `created_at` |
| `mod_waycloud_nonces` | `nonce` (PK), `seen_at` (limpeza por cron) |
| `mod_waycloud_settings` | chave/valor: URL do MCP, segredo HMAC (criptografado), limites, textos de consentimento LGPD |

Config do módulo (`tbladdonmodules`): segredos e limites simples. Métricas do funil saem de `mod_waycloud_events` + consulta ao mcp-service.

### 2.2 Serviço MCP (PostgreSQL próprio)

| Tabela | Colunas principais |
|---|---|
| `sessions` | `id` (uuid interno), `token_hash`, `ip_hash`, `user_agent`, `created_at`, `expires_at`, `state` |
| `projects` | `id`, `session_id`, `manifest_json`, `detected_type`, `requirements_json`, `recommended_pid`, `warnings_json` |
| `uploads` | `id`, `project_id`, `storage_key`, `sha256`, `size_bytes`, `source` (presigned/inline/cli), `scan_status`, `scan_report_json`, `created_at` |
| `previews` | `id`, `project_id`, `upload_id`, `slug` (unique), `url`, `expires_at`, `status`, `removed_at` |
| `checkout_refs` | `session_id`, `checkout_id` (do addon), `pid`, `cycle`, `created_at` (espelho sem PII) |
| `orders` | `session_id`, `whmcs_order_id`, `whmcs_invoice_id`, `whmcs_service_id`, `status` (aguardando_pagamento/pago/provisionando/ativo/falhou), `updated_at` |
| `plesk_servers` | `id`, `label`, `base_url`, `api_key_enc`, `agent_id`, `agent_pubkey`, `capacity`, `active` |
| `subscriptions` | `whmcs_service_id`, `plesk_server_id`, `plesk_subscription_id`, `primary_domain`, `php_version`, `plan_pid` |
| `deploys` | `id`, `subscription_id`, `upload_id`, `release_id`, `status` (na_fila/enviando/validando/publicado/falhou/revertido), `error_code`, `started_at`, `finished_at` |
| `releases` | `id`, `subscription_id`, `path`, `sha256`, `created_at`, `is_current` (mantém os últimos N) |
| `verifications` | `deploy_id`, `http_status`, `ssl_ok`, `broken_links_json`, `ttfb_ms` |
| `env_vars` (Fase 2) | `subscription_id`, `name`, `value_enc` |
| `abuse_reports` | `id`, `preview_id`, `reason`, `reporter_hash`, `status` |
| `audit_log` | `id`, `correlation_id`, `actor` (sessão/sistema/admin), `action`, `meta_json`, `created_at` |
| `webhook_nonces` | igual ao addon |

Redis: filas BullMQ, contadores de rate limit (IP / sessão / e-mail-hash).
Retenção (LGPD): sessões sem checkout, prévias e uploads não pagos apagados no prazo configurado; `audit_log` sem PII.

---

## 3. Estrutura de pastas

```
/
├─ apps/
│  └─ mcp-service/
│     └─ src/{mcp/tools,api,jobs,detect,scan,whmcs,plesk,security,db}/
├─ packages/
│  ├─ cli/                 # npx waycloud (deploy, status, logs, rollback)
│  └─ shared/              # schemas Zod, tipos, códigos de erro, mensagens pt-BR
├─ agent/                  # waycloud-agent (deploy nos servidores Plesk)
├─ whmcs/modules/addons/waycloud_ai/
│  ├─ waycloud_ai.php  hooks.php  checkout.php  lib/  templates/
├─ preview-edge/           # config do Nginx de prévias
├─ docs/{llms.txt, fase-0-planejamento.md, ...}
├─ tests/                  # mocks de WHMCS e Plesk + e2e do fluxo de pagamento→deploy
├─ docker-compose.yml  .env.example  README.md
```

Monorepo com pnpm workspaces. Testes: Vitest no TS, PHPUnit mínimo no addon (só lógica pura: CPF/CNPJ, HMAC, mapeamento).

---

## 4. Chamadas a WHMCS e Plesk

### 4.1 WHMCS

| Uso | Chamada / hook | Origem | Validar |
|---|---|---|---|
| Criar cliente | `AddClient` | localAPI (addon) | 🔶 campos obrigatórios da versão instalada, tratamento de e-mail duplicado |
| Achar cliente existente | `GetClientsDetails` / `GetClients` | localAPI | 🔶 busca por e-mail |
| Login do cliente já existente | `ValidateLogin` | localAPI | 🔶 fluxo com 2FA |
| Criar pedido | `AddOrder` | localAPI | 🔶 `paymentmethod`, `noemail`, `noinvoice`, campo personalizado com `session_id` |
| Aceitar/provisionar | `AcceptOrder` (`autosetup`) + `ModuleCreate` | localAPI | 🔶 se o "setup automático no pagamento" do produto basta ou se precisa forçar |
| Consultar fatura | `GetInvoice` | localAPI + externa | 🔶 |
| Listar serviços | `GetClientsProducts` | localAPI | 🔶 |
| Login automático | `CreateSsoToken` | localAPI | 🔶 destino `sso:custom_redirect` para a fatura |
| Consultar domínio (Fase 2) | `DomainWhois` | externa | 🔶 depende do registrar |
| Pagamento aprovado | hook `InvoicePaid` (e/ou `OrderPaid`) | addon | 🔶 qual dispara primeiro com Pix; idempotência |
| Serviço criado | hook `AfterModuleCreate` | addon | 🔶 como obter o ID da assinatura Plesk (`tblhosting.username`/`domain`) |
| Falha de provisionamento | hook `AfterModuleCreateFailed` | addon | 🔶 confirmar que o nome existe nesta versão |
| Pedido criado no carrinho | `AfterShoppingCartCheckout` | addon | só se o cliente também comprar fora do fluxo; talvez desnecessário |
| API externa | credenciais de API + roles + IP liberado | mcp-service | 🔶 permissões mínimas por role |

### 4.2 Plesk

Chave `X-API-Key` por servidor. Regra: **o mcp-service não fala com o Plesk diretamente para operações de arquivo ou execução de comandos.** Só o agente, localmente, executa CLI. O REST remoto fica para consultas.

| Operação | Via | Validar |
|---|---|---|
| Consultar assinatura/domínio | REST `GET /api/v2/domains`, `/clients` | 🔶 campos retornados |
| Criar assinatura de prévia | (descartado no meu desenho; ver §5) | — |
| Versão/handler do PHP | CLI (`plesk bin domain --update … -php_handler_id`) | 🔶 sintaxe e IDs de handler (`plesk-php83-fpm`…) |
| Alterar docroot | CLI (`plesk bin site --update … -www-root`) | 🔶 |
| Criar banco + usuário (Fase 2) | REST `/api/v2/databases` ou CLI `database --create` | 🔶 qual cobre criação de usuário |
| Criar e-mail (Fase 2) | CLI `mail --create` ou REST | 🔶 senha gerada no servidor e enviada por e-mail ao cliente |
| Let's Encrypt | CLI da extensão (`plesk bin extension --exec letsencrypt …`) | 🔶 comando exato, exigência de DNS apontado, limite de emissão |
| SSL wildcard das prévias | fora do Plesk (Certbot DNS-01 no Nginx de prévias) | 🔶 API do seu provedor de DNS |
| Subdomínio de prévia | não se aplica (Nginx wildcard) | — |
| Ler logs de erro (Fase 2) | agente lê `/var/www/vhosts/system/<dominio>/logs/` | 🔶 caminho no seu SO/versão |
| Variáveis de ambiente (Fase 2) | PHP: arquivo `.env`/config fora do docroot, gravado pelo agente | 🔶 Node (Fase 3) usa a extensão Node.js |
| Extensões Git / Node.js / WP Toolkit (Fase 3) | CLI de cada extensão | 🔶 tudo |

Não vou inventar endpoints além dos acima; todos os itens 🔶 têm que passar por teste em homologação antes de virarem código.

---

## 5. Envio de arquivos ao Plesk: recomendação

**Recomendo (b): um agente pequeno por servidor Plesk, em modelo pull.**

| Critério | (a) SFTP com usuário da assinatura | (b) Agente de deploy |
|---|---|---|
| Segurança | Precisa guardar credencial SFTP por assinatura no mcp-service; a superfície é a porta 22 | Sem credencial de cliente fora do servidor; o agente só faz conexões de saída (HTTPS) e valida assinatura dos jobs |
| Deploy atômico | Difícil: sem checksum server-side, sem hook de validação, troca de diretório precisa de comandos extras | Baixa o zip por URL pré-assinada, confere SHA-256, extrai em `releases/<id>/`, valida, troca o link ou docroot, chama Plesk CLI (PHP, SSL) |
| Rollback | Manual | Trocar o link para o release anterior |
| Desempenho | Bom | Bom, e o zip não passa pelo mcp-service |
| Manutenção | Nenhuma extra | Um binário/script a versionar e atualizar em N servidores |

Detalhes de desenho:
- Agente em Go (binário único) ou script; roda como serviço systemd, executa comandos da assinatura via `sudo -u <usuario_da_assinatura>` para manter permissões corretas.
- Jobs assinados (Ed25519 ou HMAC por servidor), com ID e expiração.
- Layout por assinatura: `.../releases/<id>/`, `current -> releases/<id>`, mantendo os últimos N (P7).
- 🔶 Ponto crítico a validar: o Plesk aceitar o docroot apontando para um symlink (`FollowSymLinks`/`SymLinksIfOwnerMatch`, `open_basedir`). Alternativa: trocar o `www-root` por release via CLI (troca atômica só no nível de configuração, com recarga do servidor web).
- SFTP fica como plano B para servidores onde não se possa instalar o agente.

**Prévia**: proponho um Nginx dedicado, com wildcard, servindo `/srv/previews/<slug>/` só de arquivos estáticos, `X-Robots-Tag: noindex`, banner injetado, sem PHP. Expiração é um job que apaga a pasta. Motivo: prévia é código não pago e não confiável; não deve rodar no mesmo Plesk de produção. Para PHP/WordPress a prévia não executa (mostra só captura ou aviso), ou vira Fase 2 em sandbox. Ver P5.

---

## 6. Riscos e mitigações

| # | Risco | Mitigação |
|---|---|---|
| R1 | **Session ID é o bearer de um site pago.** Ele fica no contexto/log da IA; quem o tiver pode publicar na hospedagem depois do pagamento | Publicar só arquivos da própria sessão; snapshot + rollback; e-mail ao cliente a cada deploy; opção de "código de vínculo" mostrado só no navegador ao final do checkout; OAuth 2.1 na Fase 3 |
| R2 | Abuso das prévias (phishing, malware, spam) | Prévia só estática no MVP; varredura antes; limites por IP/sessão; rate limit; canal de denúncia; expiração curta; `noindex` |
| R3 | Prompt injection via conteúdo do projeto | Respostas das ferramentas usam mensagens fixas em template; nunca ecoar texto do projeto; nomes de arquivo sanitizados e truncados |
| R4 | Fraude com cartão | Antifraude do gateway/MaxMind, revisão manual configurável; provisionamento de cartão pode aguardar aprovação |
| R5 | Provisionamento não dispara ou dispara duas vezes | Idempotência por `invoice_id`; reconciliação periódica (cron) entre WHMCS e mcp-service |
| R6 | Deploy parcial | Extrair em `releases/<id>`, validar (arquivos, `index`, tamanho), só então trocar; rollback automático se a verificação falhar |
| R7 | Zip malicioso (zip-slip, bomba, symlinks) | Limites de tamanho/quantidade/profundidade, rejeitar caminhos absolutos e `..`, ignorar symlinks, extrair só no agente com usuário sem privilégios |
| R8 | Vazamento de segredos (`.env`, chaves) | Detectar e excluir `.env`/chaves do pacote, avisar o cliente; nunca logar conteúdo |
| R9 | Segredos do Plesk/WHMCS/HMAC | Cofre/env, chave Plesk criptografada, rotação; chave WHMCS com role mínima e IP fixo |
| R10 | Let's Encrypt falha (DNS não aponta, limite de emissão) | Usar `verificar_dns` antes; na primeira publicação usar subdomínio temporário da Way Cloud com SSL; fila com retry |
| R11 | Dados pessoais no MCP/logs | Zod estrito nas saídas, testes que falham se encontrarem e-mail/CPF/senha; sanitização de logs |
| R12 | Sem consentimento LGPD/retenção clara | Texto no checkout, finalidade registrada, job de exclusão, política publicada |
| R13 | Dependência da API do WHMCS mudar por versão | Testes de contrato contra homologação; camada `whmcs/` isolada |
| R14 | Um servidor Plesk cai ou lota | Escolha do servidor por capacidade; falha alerta admin |

---

## 7. Perguntas antes da Fase 1

**Ambiente (os campos [PREENCHER])**
- P1. Versão do WHMCS e do PHP? Versão do Plesk, SO, quantos servidores?
- P2. Qual gateway (Asaas/Efí/Mercado Pago/Pagar.me)? Há ambiente de homologação com Pix?
- P3. Lista de planos: `pid`, disco, tráfego, bancos, e-mails, ciclos, preços. Qual plano cobre cada tipo de projeto?
- P4. Domínios: de prévias (wildcard DNS já existe? qual provedor de DNS tem API para DNS-01?) e da API/MCP.

**Decisões**
- P5. **Prévia**: aceita Nginx dedicado e estático (recomendado) em vez de assinatura Plesk? PHP/WordPress terão prévia no MVP? (Recomendo não.)
- P6. Validade da sessão (sugestão 72h), limite inline (sugestão 5 MB), tamanho máximo do zip (sugestão 50 MB) e validade da prévia (sugestão 24 h)?
- P7. Quantos snapshots manter (sugestão 5)?
- P8. Precisamos de **deploy token** no MVP, ou basta a sessão vinculada ao serviço até o OAuth (Fase 3)? (Recomendo dispensar no MVP, ver R1.)
- P9. Banco do serviço: PostgreSQL (recomendado) ou MySQL? Onde hospedar Redis e storage (mesma VPS? Cloudflare R2/S3?) e onde roda o mcp-service?
- P10. Agente de deploy aprovado (§5)? Posso instalar software nos servidores Plesk?
- P11. Antifraude: usar o do gateway, MaxMind no WHMCS, ou revisão manual para cartão de primeira compra?
- P12. E-mails transacionais: usar o SMTP/templates do WHMCS ou outro serviço?
- P13. Nome do produto no catálogo: um produto WHMCS por plano com campo personalizado `session_id`, ou produto oculto só para o fluxo de IA?

**Próximo passo sugerido**: você responde P1 a P13 (ou diz "use suas sugestões" onde quiser), e eu monto o plano de arquivos detalhado da Fase 1.


---

## 8. Dados levantados (2026-09-23)

- **WHMCS** (app.waycloud.com.br, atrás da Cloudflare): servidor do WHMCS é cPanel/WHM 11.138 em AlmaLinux 9.8 (177.11.55.69, 20 CPUs, 11 GB RAM). Versão do WHMCS e do PHP: **pendente** (a role de API atual não permite `WhmcsDetails`).
- **API do WHMCS**: identifier/secret funcionam; só `GetProducts` está liberado na role. A API só aceita a chamada vinda do IPv4 (160.20.204.32); por IPv6 o WHMCS recusa.
- **Plesk**: servidor de clientes em 177.11.55.71 (SSH na porta 108, ainda sem acesso; painel 8443 acessível).
- **Catálogo**: 90 produtos; 16 com módulo Plesk/PleskExtended (pids 173, 174, 175, 215, 120, 152, 153, 171, 18, 19, 151, 20, 116, 117, 118, 218). Moedas BRL e USD. Módulo dos demais: cpanel (12), marketconnect (14), wayn8n (4), vps (2).
- **Pendente**: qual grupo/servidor do WHMCS aponta para o Plesk 177.11.55.71 (P3), gateway de pagamento (P2), domínios de prévia e MCP (P4).

**Atualização (mesmo dia)**
- WHMCS **8.13.1** (API confirmada). PHP do WHMCS: pendente. `GetPaymentMethods` ainda bloqueada na role.
- **Plesk (id 18, srv-br.inneedcloud.com.br, 177.11.55.71)**: Plesk **18.0.76** em AlmaLinux 9.8, 16 CPUs, 31 GB RAM, disco 660 GB (31% usado), 39 serviços ativos no WHMCS. SSH na porta **42837**, usuário `claudeaudit` sem sudo (não acessa `plesk bin`). Handlers PHP instalados: 5.6, 7.0–7.4, 8.0–8.5. Apache (httpd) em uso pelo Plesk; `nginx` não está no PATH do usuário. Status no WHMCS: **inativo** (precisa ativar para provisionamento automático).
- **Decisão do cliente**: usar apenas o Plesk id 18 por enquanto. Servidores 11 (AWS Genesis) e 16 (SRV ATOS) estão sem serviços e podem ser removidos pelo admin do WHMCS.
- **Ainda sem acesso root ao Plesk**: assinaturas, handlers e extensões (Let's Encrypt, Git, Node.js, WP Toolkit) só se veem com `plesk bin` (root) ou chave de API.


---

## 9. Decisões tomadas (2026-09-23) — respostas às perguntas do §7

| # | Decisão | Origem |
|---|---|---|
| P1 | WHMCS 8.13.1 / PHP 8.1. Plesk 18.0.76, AlmaLinux 9.8. **Um único servidor Plesk no MVP**: SRV Plesk - BR (id 18, 177.11.55.71, SSH porta 42837) | cliente |
| P2 | **Pix: Efí** (módulo `efipix`). **Cartão: Iugu** (módulo `iugucartao`) | cliente |
| P3 | Planos candidatos (grupo 33, "BR"): 173 Speed R$ 35,90, 174 Boost R$ 55,90, 175 Pro R$ 99,90, 215 Premium R$ 195,90. Proposta de mapa: estático/SPA → Speed; PHP simples → Boost; WordPress → Pro; projetos grandes → Premium. 🔶 validar que esses produtos apontam para o servidor 18 e os limites reais de cada um | sugestão |
| P4 | Prévias: `*.preview.waycloud.com.br`. MCP/API: `mcp.waycloud.com.br`. DNS na Cloudflare (wildcard SSL por DNS-01 com token da Cloudflare, quando chegar a hora) | sugestão |
| P5 | Prévia em Nginx dedicado, **estático, sem PHP**, fora do Plesk de produção. PHP/WordPress só rodam depois do pagamento | sugestão |
| P6 | Sessão 72 h; upload inline 5 MB; zip 50 MB; prévia expira em 24 h | sugestão |
| P7 | 5 snapshots por assinatura | sugestão |
| P8 | Sem deploy token no MVP; a sessão vinculada ao serviço basta. Mitigação do R1: e-mail ao cliente a cada deploy + rollback | sugestão |
| P9 | PostgreSQL. mcp-service, Redis, Postgres, MinIO e Nginx de prévias em **uma VM dedicada** (Proxmox da Way Cloud) com Docker. Cloudflare R2 no lugar do MinIO só se o volume pedir | sugestão |
| P10 | Agente de deploy no Plesk (instalado com o cliente presente, pois exige root) | sugestão |
| P11 | Antifraude do gateway (Iugu) + revisão manual configurável para cartão de primeira compra; Pix libera na hora | sugestão |
| P12 | E-mails transacionais pelos templates do WHMCS no MVP | sugestão |
| P13 | **Opção B**: cópias ocultas dos planos para o fluxo da IA + um produto de teste barato para homologar em produção sem afetar o catálogo | sugestão |

### Ainda pendente (depende do cliente)
1. Acesso root ao Plesk: chave de API (`plesk bin secret_key`) ou sudo limitado, para validar os itens 🔶.
2. Confirmação da VM onde roda o mcp-service e criação dos registros DNS na Cloudflare.
3. Confirmar no WHMCS que o servidor 18 está no grupo de servidores dos produtos (a API devolve `active: false`, significado do campo 🔶).
4. Remover o usuário `claudeaudit` dos dois servidores ao final.


---

## 10. Atualização: validações feitas (2026-09-23)

**Plesk 18.0.76 (chave de API REST, somente leitura)**
- `GET /api/v2/server` e `POST /api/v2/cli/{comando}/call` funcionam com `X-API-Key`. Confirmado: `extension --list`, `php_handler --list`, `subscription --list` (74 assinaturas). O corpo do POST é `{"params":["--list"]}`. ✅ (deixa de ser 🔶 para chamadas de leitura via CLI)
- Extensões instaladas: git, nodejs, laravel, composer, wp-toolkit, letsencrypt, cloudflaredns, ssh-terminal, cloudlinux-os, imunify360, firewall, site-import, log-browser, s3-backup, ruby. Fases 2/3 (Git, Node.js, WordPress, Laravel) já têm o que precisam.
- Handlers PHP do Plesk: 7.4, 8.0, 8.1, 8.2, 8.3, 8.4 (fpm, fastcgi e fpm-dedicated; cgi desabilitado). Não há 8.5 no Plesk (existe no diretório do SO, sem handler).
- 🔶 A descrição do plano cita LiteSpeed, mas o processo web visto foi o `httpd`. Validar qual servidor web atende as assinaturas antes de definir a troca atômica de docroot.

**WHMCS**
- Dois grupos de servidores ("Servidores Plesk" e "Plesk"), ambos só com SRV Plesk - BR, preenchimento "menos cheio". O produto Speed BR (pid 173) usa módulo Plesk, grupo "Servidores Plesk", Service Plan "WP Speed", IPv4 compartilhado.
- 🔶 Ainda não visto: opção de provisionamento automático do produto (fim da aba "Configurações do Módulo").

**Easypanel (177.11.55.72)** — hospedará o mcp-service, Postgres e Redis em um projeto novo (`waycloud-ai`). Já existem projetos de produção nesse Easypanel; nada foi criado. Cloudflare R2 já é usado em outros projetos: usar um **bucket novo** para uploads/snapshots no lugar do MinIO.

**Novo risco R15 — prévias em subdomínio do domínio principal.** JavaScript enviado por um estranho e servido em `*.preview.waycloud.com.br` pode gravar cookies com escopo `.waycloud.com.br` e interferir em `app.waycloud.com.br` (WHMCS, área do cliente). Mitigação recomendada: **domínio separado para prévias** (registrável, fora do waycloud.com.br). Alterar P4 conforme a resposta do cliente.

**Decisões adicionais (2026-09-23)**
- Provisionamento: o Speed BR (pid 173) já está em "configurar automaticamente ao receber o primeiro pagamento". Fluxo `InvoicePaid` → provisionamento automático confirmado nas configurações; ainda 🔶 validar em teste que o Pix (Efí) dispara esse caminho.
- **P4 revisado — domínio de prévias: `*.preview.waypreview.com.br`** (escolha do cliente). Diferente do waycloud.com.br, o waypreview.com.br não hospeda o WHMCS. Situação atual do domínio: DNS na Cloudflare (mesmos nameservers do waycloud), site no ar (A 177.53.143.53, servidor cPanel "Server PRO BR") e e-mail próprio (MX/SPF). **Risco residual R15**: cookies gravados por uma prévia com escopo `.waypreview.com.br` podem afetar o site e a área de login do próprio wayleads. Aceito enquanto o waypreview.com.br não tiver login/sessão sensível; migrar para um domínio exclusivo de prévias se isso mudar.
- 🔶 Certificado: o wildcard universal da Cloudflare cobre só `*.waypreview.com.br`, não `*.preview.waypreview.com.br`. Usar registro DNS-only (nuvem cinza) e emitir o wildcard por DNS-01 (Let's Encrypt) com token da Cloudflare restrito à zona waypreview.com.br (permissão só DNS:Edit). Confirmar como o Traefik do Easypanel (campo `wildcard` nos domínios) faz DNS-01.
