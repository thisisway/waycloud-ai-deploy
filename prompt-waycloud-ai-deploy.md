# Prompt: Desenvolvimento do módulo "Way Cloud AI Deploy"

> Cole este prompt em um agente de código (Claude Code, Cursor etc.) na raiz de um repositório vazio. Substitua os campos marcados com **[PREENCHER]** antes de usar.

---

## 1. Seu papel

Você é um engenheiro de software sênior especializado em WHMCS, Plesk, APIs REST, Model Context Protocol (MCP) e segurança de aplicações. Vai projetar e implementar, em fases, um sistema completo de venda e publicação de sites a partir de assistentes de IA para a empresa de hospedagem **Way Cloud** (Brasil).

Regras de trabalho:

- **Não escreva todo o código de uma vez.** Comece pela Fase 0 (planejamento) e só avance quando eu aprovar.
- Antes de cada fase, apresente o plano de arquivos, decisões técnicas e dúvidas. Faça perguntas quando algo for ambíguo, em vez de supor.
- Quando não tiver certeza sobre o comportamento exato de uma API (WHMCS, Plesk, gateway de pagamento, SDK de MCP), **diga isso explicitamente** e proponha como validar (consulta à documentação oficial, teste em ambiente de homologação). Não invente endpoints ou parâmetros.
- Todo texto voltado ao cliente final deve estar em **português do Brasil**. Código, nomes de variáveis e commits podem ficar em inglês.
- Escreva testes automatizados para a lógica crítica (pagamento → provisionamento → deploy).

---

## 2. Contexto do negócio

A Way Cloud vende hospedagem de sites. Cada vez mais clientes criam sites com IA (Claude, ChatGPT, Cursor, Lovable, Bolt etc.) e não sabem como colocá-los no ar. O objetivo é:

1. O cliente adiciona o **conector MCP da Way Cloud** na IA que usa (ou roda `npx waycloud deploy`).
2. Pede algo como "publica meu site na Way Cloud".
3. A IA analisa o projeto, recomenda um plano, publica uma **prévia grátis temporária** e gera um **link de checkout**.
4. O cliente faz **cadastro rápido** e paga via **Pix ou cartão** no navegador.
5. Com o pagamento aprovado, o WHMCS **provisiona automaticamente** a hospedagem no Plesk.
6. A IA **publica o site** na hospedagem definitiva, ativa SSL e entrega a URL.

Meta: o menor número possível de passos entre "tenho um site feito com IA" e "meu site está no ar e pago".

---

## 3. Ambiente existente

- **WHMCS**: versão [PREENCHER, ex.: 8.x], PHP [PREENCHER]
- **Plesk**: versão [PREENCHER, ex.: Obsidian 18.x], sistema [PREENCHER, ex.: AlmaLinux / Ubuntu], quantidade de servidores [PREENCHER]
- **Módulo de provisionamento**: módulo Plesk nativo do WHMCS
- **Gateway de pagamento**: [PREENCHER: Asaas / Efí / Mercado Pago / Pagar.me], já integrado ao WHMCS com Pix e cartão
- **Produtos de hospedagem** (IDs do WHMCS): [PREENCHER: lista de planos com pid, limites de disco, tráfego, bancos, e-mails]
- **Domínio para prévias**: [PREENCHER, ex.: preview.waycloud.com.br], com DNS wildcard
- **Domínio da API/MCP**: [PREENCHER, ex.: mcp.waycloud.com.br]

---

## 4. Arquitetura

Proponha e justifique a arquitetura. A referência esperada é:

```
[IA do cliente] --MCP (Streamable HTTP)--> [Serviço MCP / API Way Cloud] --API--> [WHMCS]
       |                                             |                               |
   [CLI npx]  --HTTPS-->  [Endpoint de upload]       +------API REST/CLI------> [Plesk]
                                                     |
                                              [Fila de jobs + BD próprio]
```

### 4.1 Componentes

1. **Addon module WHMCS** (`modules/addons/waycloud_ai/`), em PHP:
   - `waycloud_ai.php` com `_config`, `_activate`, `_deactivate`, `_upgrade`, `_output` (painel admin).
   - `hooks.php` com os hooks de pedido e pagamento.
   - Tabelas próprias criadas via Capsule (`WHMCS\Database\Capsule`).
   - Painel admin: mapeamento "tipo de projeto → produto", limites de prévia, chaves de API, lista de sessões/deploys, logs e métricas do funil.
   - Página de checkout simplificada (cadastro rápido), acessível por link com token.

2. **Serviço MCP + API** (TypeScript, Node 20+, SDK oficial `@modelcontextprotocol/sdk`):
   - Transporte **Streamable HTTP** para conectores remotos.
   - Expõe as ferramentas descritas na seção 6.
   - Conversa com a API do WHMCS e com a API do Plesk.
   - Endpoint HTTPS de upload de arquivos (URL pré-assinada, com prazo curto).
   - Fila de jobs (ex.: BullMQ + Redis) para deploy, prévia, SSL e verificações.
   - Banco próprio (MySQL ou PostgreSQL), separado do banco do WHMCS.

3. **CLI** (`npx waycloud`), pacote npm:
   - `waycloud deploy`, `waycloud status`, `waycloud logs`, `waycloud rollback`.
   - Compacta o projeto respeitando `.gitignore` e um `.waycloudignore`, detecta a pasta de build, envia e acompanha o status.
   - Funciona em qualquer agente capaz de rodar comandos, mesmo sem suporte a MCP.

4. **Documentação para IAs**:
   - `llms.txt` e uma página de docs que explicam o fluxo, as ferramentas e as mensagens a serem mostradas ao usuário.

Entregue também `docker-compose.yml` para desenvolvimento local, `.env.example` e README de instalação.

---

## 5. Fluxo principal (detalhado)

1. **Sessão**: a IA chama `iniciar_sessao`. O serviço cria uma sessão anônima com ID aleatório (mínimo 128 bits), válida por [PREENCHER, ex.: 72h].
2. **Análise**: a IA envia um manifesto do projeto (lista de arquivos, tamanhos, conteúdo de `package.json`, `composer.json`, presença de `.env`, `wp-config.php`, arquivos `.sql`). O serviço detecta o tipo:
   - HTML/CSS/JS estático
   - Build de SPA (React, Vite, Vue, Angular): identificar a pasta de saída (`dist`, `build`, `out`)
   - PHP puro ou framework (Laravel etc.): versão de PHP necessária
   - WordPress
   - Node.js com servidor (Express, Next.js em modo server): **Fase 3**
   - Precisa de banco de dados? De e-mail (formulários)? De variáveis de ambiente?
   Retorna: tipo detectado, requisitos, plano recomendado (pid) e alternativas, avisos (ex.: "arquivo .env com segredos detectado, não será publicado").
3. **Upload**: a IA pede `obter_url_upload` e envia um `.zip` (via CLI/agente) ou, para sites pequenos gerados no chat, usa `enviar_arquivos` com conteúdo inline (limite de [PREENCHER, ex.: 5 MB] no total).
4. **Varredura**: antes de qualquer publicação, o serviço verifica os arquivos: tipos proibidos, malware conhecido, padrões de phishing (formulários de login de bancos, marcas conhecidas), tamanho. Se reprovar, explica o motivo.
5. **Prévia grátis**: `criar_previa` publica em `{slug}.preview.waycloud.com.br` numa assinatura Plesk dedicada a prévias, com SSL wildcard, cabeçalho `X-Robots-Tag: noindex`, banner discreto "Prévia Way Cloud" e expiração automática.
6. **Checkout**: `criar_checkout` recebe o plano e ciclo (mensal/anual), gera um link único com token e devolve para a IA mostrar ao cliente. A IA nunca recebe dados pessoais ou de pagamento.
7. **Cadastro rápido + pagamento** (no navegador):
   - Campos: nome, e-mail, CPF/CNPJ (com validação de dígitos), telefone/WhatsApp, senha (ou login se o e-mail já existir).
   - Criação do cliente com `AddClient` e do pedido com `AddOrder`, vinculando o ID da sessão (campo personalizado ou tabela própria).
   - Redirecionamento para a fatura com Pix (QR Code + copia e cola) ou cartão, usando `CreateSsoToken` para login automático, se aplicável.
   - Opção de registrar domínio no mesmo pedido (Fase 2).
8. **Pagamento aprovado**: o hook `InvoicePaid` identifica o pedido da sessão e garante que o provisionamento aconteça (configuração de setup automático no pagamento; se necessário, `AcceptOrder` + `ModuleCreate`). Após `AfterModuleCreate`, o addon:
   - Registra o ID da assinatura no Plesk.
   - Gera um **token de deploy** com escopo restrito àquela assinatura.
   - Notifica o serviço MCP (webhook assinado com HMAC).
9. **Acompanhamento**: a IA chama `status_pedido` periodicamente (com orientação de intervalo na resposta) até receber `ativo`.
10. **Publicação**: `publicar` usa os arquivos já enviados (ou um novo upload), cria snapshot da versão anterior, envia os arquivos para a assinatura, cria banco/importa SQL se necessário, configura versão do PHP, aplica variáveis de ambiente e ativa SSL.
11. **Verificação**: `verificar_site` confere HTTP 200, SSL, links quebrados e tempo de resposta, e devolve um relatório curto.
12. **Encerramento**: a IA mostra a URL, os próximos passos (apontar domínio, criar e-mail) e o link da área do cliente. A prévia é removida ou redirecionada.

Trate também: pagamento não aprovado/expirado, Pix vencido (gerar novo), falha de provisionamento (alerta ao admin + mensagem clara ao cliente), cliente já existente, deploy falho com rollback automático.

---

## 6. Ferramentas MCP

Para cada ferramenta, implemente: nome, descrição clara em português (a descrição orienta a IA sobre quando usar), schema de entrada com validação (Zod), schema de saída, erros possíveis e mensagem sugerida para o usuário.

### Fase 1 (MVP)

| Ferramenta | Função |
|---|---|
| `iniciar_sessao` | Cria sessão anônima e retorna ID e instruções do fluxo |
| `analisar_projeto` | Recebe o manifesto e retorna tipo, requisitos e plano recomendado |
| `listar_planos` | Lista planos com preço, limites e para que tipo de site servem |
| `obter_url_upload` | Retorna URL pré-assinada de upload (validade curta, tamanho máximo) |
| `enviar_arquivos` | Upload inline para sites pequenos (caminho + conteúdo base64) |
| `criar_previa` | Publica prévia temporária e retorna a URL e a data de expiração |
| `criar_checkout` | Gera o link de cadastro rápido + pagamento para o plano escolhido |
| `status_pedido` | Retorna: aguardando_pagamento, pago, provisionando, ativo, falhou |
| `publicar` | Publica na hospedagem definitiva (requer pedido ativo) |
| `status_deploy` | Acompanha o job de publicação |
| `verificar_site` | Checagem pós-deploy com relatório |

### Fase 2

| Ferramenta | Função |
|---|---|
| `ler_logs` | Últimas N linhas do log de erros do site (sanitizadas) |
| `listar_versoes` / `reverter_versao` | Histórico de deploys e rollback |
| `buscar_dominio` / `registrar_dominio` | Disponibilidade e inclusão no pedido via WHMCS |
| `verificar_dns` | Confere se o domínio já aponta para o servidor e ativa SSL |
| `criar_banco` / `importar_sql` | Banco MySQL na assinatura, credenciais aplicadas via variáveis de ambiente |
| `criar_email` | Conta de e-mail no domínio; a senha é enviada ao cliente por e-mail, não pela IA |
| `definir_variaveis` | Variáveis de ambiente armazenadas criptografadas |
| `sugerir_upgrade` | Quando o projeto excede os limites do plano atual |

### Fase 3

- Suporte a aplicações Node.js via extensão Node.js do Plesk.
- Deploy via Git (extensão Git do Plesk) com atualização a cada push.
- WordPress via WordPress Toolkit.

---

## 7. Integração com o Plesk

- Autenticação via chave de API do Plesk (`X-API-Key`), uma por servidor, armazenada criptografada.
- Use a **API REST** (`/api/v2/...`) e, quando não houver endpoint, a execução de comandos CLI via `/api/v2/cli/{comando}/call`. Liste para mim quais operações usarão REST e quais usarão CLI, e marque as que precisam ser validadas em homologação.
- Operações necessárias: consultar assinatura/domínio, alterar handler/versão do PHP, criar banco e usuário, criar conta de e-mail, emitir certificado Let's Encrypt, criar subdomínio de prévia, ler logs de erro.
- **Envio de arquivos**: avalie e recomende entre (a) SFTP com o usuário de sistema da assinatura (credenciais guardadas no servidor, nunca expostas) e (b) um pequeno agente de deploy instalado nos servidores Plesk. Considere segurança, desempenho e manutenção.
- Deploy atômico: enviar para diretório temporário, validar e depois trocar (evitar site parcialmente publicado). Manter os últimos [PREENCHER, ex.: 5] snapshots.
- Suporte a múltiplos servidores Plesk: o servidor é determinado pelo serviço provisionado no WHMCS.

---

## 8. Integração com o WHMCS

- Use a API local (`localAPI`) dentro do addon e a API externa (com credenciais de API e IP liberado) a partir do serviço MCP.
- Chamadas esperadas: `AddClient`, `GetClients`/`GetClientsDetails`, `AddOrder`, `GetOrders`, `AcceptOrder`, `ModuleCreate`, `GetInvoice`, `GetClientsProducts`, `CreateSsoToken`, `DomainWhois`. Confirme os parâmetros na documentação oficial da versão instalada.
- Hooks: `InvoicePaid`, `AfterModuleCreate`, `AfterModuleCreateFailed` (ou equivalente), `AfterShoppingCartCheckout`.
- Comunicação addon → serviço MCP por webhook assinado (HMAC-SHA256 com timestamp, rejeitando replays).

---

## 9. Segurança e conformidade

- **Nenhum dado de cartão ou dado pessoal passa pela IA.** Pagamento sempre no navegador, no gateway.
- A IA nunca recebe senhas do Plesk, FTP, SFTP, banco ou e-mail.
- Tokens: sessão (anônima, curta), deploy (escopo de uma assinatura, revogável, com expiração). Armazenar apenas hash dos tokens.
- Autenticação do MCP: planeje suporte a **OAuth 2.1** conforme a especificação de autorização do MCP para vincular a conta do cliente; no MVP, a sessão anônima + vínculo no checkout é aceitável. Explique os riscos de cada opção.
- Rate limiting por IP, sessão e e-mail. Limite de prévias por pessoa.
- Antifraude: Pix libera na hora; cartão passa por antifraude do gateway/MaxMind, com possibilidade de revisão manual configurável.
- Varredura de arquivos antes de prévia e publicação. Bloquear executáveis, webshells conhecidos e páginas de phishing. Canal de denúncia de abuso nas prévias.
- Proteção contra prompt injection: o conteúdo dos arquivos do cliente é tratado como dado, nunca como instrução. Respostas das ferramentas não devem incluir texto do projeto que possa ser interpretado como comando.
- Sanitizar logs antes de enviar à IA (remover senhas, tokens, e-mails, IPs de terceiros).
- **LGPD**: registrar finalidade dos dados, política de retenção, exclusão de sessões e prévias expiradas, e texto de consentimento no cadastro.
- Segredos em variáveis de ambiente/cofre, nunca no repositório.

---

## 10. Experiência do cliente

- Mensagens curtas, amigáveis e em português, pensadas para leigos.
- Cada resposta de ferramenta deve trazer um campo `mensagem_para_usuario` e um campo `proximo_passo` para orientar a IA.
- Página de checkout mobile-first, com o mínimo de campos, validação em tempo real de CPF/CNPJ e e-mail, e QR Code Pix em destaque.
- E-mails transacionais (e WhatsApp na Fase 2): pagamento confirmado, site no ar, prévia expirando, fatura próxima do vencimento.

---

## 11. Observabilidade e métricas

- Logs estruturados (JSON) com ID de correlação ligando sessão → pedido → fatura → serviço → deploy.
- Métricas do funil no painel admin: sessões iniciadas, projetos analisados, prévias criadas, checkouts gerados, pagamentos, sites publicados, tempo médio do pagamento até o site no ar.
- Alertas para falhas de provisionamento e deploy.

---

## 12. Fases de entrega

- **Fase 0: planejamento.** Arquitetura final, modelo de dados, lista de endpoints do Plesk/WHMCS a validar, riscos, dúvidas. Nada de código ainda.
- **Fase 1: MVP.** Sites estáticos, SPAs com build e PHP simples; ferramentas da Fase 1; prévia; checkout com Pix e cartão; provisionamento automático; deploy com SSL; CLI básica; `llms.txt`.
- **Fase 2.** Logs, rollback, domínios, banco de dados, e-mail, variáveis de ambiente, upgrade, WhatsApp, métricas completas.
- **Fase 3.** Node.js, Git, WordPress, OAuth completo, botão "Publicar na Way Cloud" para READMEs.

---

## 13. Critérios de aceite do MVP

1. Um site HTML estático em uma pasta local vai do comando "publica meu site na Way Cloud" até estar no ar com HTTPS, passando por prévia, cadastro e pagamento Pix em ambiente de homologação.
2. Pagamento aprovado resulta em hospedagem provisionada e site publicado sem intervenção manual.
3. Pagamento não concluído não gera hospedagem, e a prévia expira no prazo configurado.
4. Nenhuma credencial ou dado pessoal aparece nas respostas das ferramentas MCP.
5. Um deploy com falha não deixa o site parcialmente publicado.
6. Testes automatizados cobrindo: detecção de tipo de projeto, geração de checkout, hook de pagamento, provisionamento e deploy (com mocks de WHMCS e Plesk).

---

## 14. Primeira tarefa

Comece pela **Fase 0**. Entregue:

1. Diagrama da arquitetura e justificativa das escolhas.
2. Modelo de dados (tabelas do addon e do serviço MCP).
3. Estrutura de pastas do repositório.
4. Lista de chamadas ao WHMCS e ao Plesk, marcando o que precisa ser validado.
5. Recomendação sobre o método de envio de arquivos ao Plesk.
6. Riscos principais e como mitigá-los.
7. Perguntas que você precisa que eu responda antes da Fase 1.
