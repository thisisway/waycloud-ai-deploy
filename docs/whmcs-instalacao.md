# Addon "Way Cloud AI Deploy" no WHMCS: instalação e homologação

Pacote: `dist/waycloud_ai-0.3.0.zip` (gerado com `pnpm build:addon`; o SHA-256 aparece na saída do comando).
Compatível com WHMCS 8.13 e PHP 8.1. O zip cria só a pasta `modules/addons/waycloud_ai/`, sem tocar em nenhum arquivo do WHMCS.

## 1. Instalar

1. **Enviar o zip:** no cPanel da conta do WHMCS, abra o **Gerenciador de Arquivos**, entre na pasta raiz do WHMCS (a que contém `init.php`), clique em **Upload**, envie o zip e depois **Extrair** na mesma pasta. Confira se existe `modules/addons/waycloud_ai/waycloud_ai.php`.
2. **Ativar:** no admin do WHMCS, **Configurações do Sistema → Módulos de Addon** (Addon Modules), ache **Way Cloud AI Deploy**, clique em **Ativar** e depois em **Configurar**.
3. **Configurar:**
   - **Segredo HMAC:** gere um com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (64 caracteres). O mesmo valor vai no serviço MCP como `ADDON_HMAC_SECRET`. Não compartilhe por chat.
   - **URL do serviço MCP:** `https://mcp.waycloud.com.br` (só é usada para avisar pagamento e provisionamento; enquanto o serviço não existir, os avisos ficam na fila e são reenviados pelo cron).
   - O restante já vem com padrões (Pix `efipix`, domínio provisório `sites.waypreview.com.br`, link válido por 48 h, Termos, Privacidade, `contato@waycloud.com.br`, endereço padrão).
   - **Controle de acesso:** marque os grupos de administradores que podem abrir o addon (ex.: Administrador completo).
4. **Mapa de planos:** no menu **Addons → Way Cloud AI Deploy**, informe o **ID (pid) do produto oculto** de cada tipo: **sites estáticos e SPA = 223** (ai-deploy-speed) e **sites PHP = 224** (ai-deploy-boost). O nome do produto aparece para o cliente no checkout; renomeie no WHMCS se preferir (por exemplo, "Speed BR").
5. **Diagnóstico:** na mesma página, a tabela mostra o que ainda precisa de ajuste. Antes do serviço MCP existir, esperam-se dois itens em "Ajustar": *Serviço MCP* e, se ainda não houver o produto PHP, *Produto para Sites PHP*. Todo o resto deve estar **OK**. Se aparecer "Ajustar" em campo de cliente, gateway ou segredo, me mande o que a tela mostra.

## 2. Testar sem o serviço MCP (homologação)

Use um **e-mail que você controla** e o **produto oculto**. Nada disso afeta os clientes atuais.

1. Gere um link de compra, como o serviço MCP faria (na sua máquina, sem colar o segredo no histórico do terminal):
   ```
   $env:ADDON_URL="https://app.waycloud.com.br/modules/addons/waycloud_ai/api.php"
   $env:ADDON_HMAC_SECRET="<o segredo>"
   pnpm checkout:dev <pid do produto oculto> monthly
   ```
   Ele imprime o link. Se der erro `403` ou uma página da Cloudflare, é o WAF: crie uma regra de exceção para o caminho `/modules/addons/waycloud_ai/api.php` (a requisição é protegida por assinatura HMAC).
2. Abra o link **numa janela anônima**. Deve mostrar o plano, o preço e o formulário.
3. Preencha e envie. Esperado: você cai na **fatura** já logado, com Pix disponível.
4. **Sem gastar dinheiro:** no admin, abra a fatura e use **Adicionar pagamento** (marcar como paga). Isso dispara o provisionamento automático do produto (cria a hospedagem de teste no Plesk).
5. Confira em **Addons → Way Cloud AI Deploy**: a contratação deve passar por `ordered → paid → active`, e os eventos aparecem na tabela (sem dados pessoais).
6. Depois, **cancele o serviço de teste** (Terminate) e, se quiser, o cliente de teste.
7. Numa segunda rodada, pague um Pix real de valor baixo para validar Efí e o caminho de pagamento de verdade.

## 3. O que só a instalação real confirma

Os detalhes abaixo seguem a documentação do WHMCS, mas não puderam ser exercitados sem o seu WHMCS. A página de diagnóstico e os testes acima cobrem cada um:

- Nomes de parâmetros de `AddClient`, `AddOrder`, `CreateSsoToken`, `GetProducts` (preço em BRL) e `SendAdminEmail`.
- Variáveis dos hooks `AfterModuleCreate` (`params.serviceid`, `params.serverid`) e `AfterModuleCreateFailed` (`failureResponseMessage`).
- Formulário do checkout em página de addon: token CSRF do WHMCS e renderização do Smarty.
- Se Efí (Pix) e Iugu (cartão) aceitam o **endereço padrão** ("Não informado", CEP 00000-000). Se recusarem, o próximo passo é pedir só o CEP na tela (com preenchimento automático do endereço).
- `ResetPassword` (versão 0.4.0): o cadastro pela página `waypreview.com.br` não pede senha; logo depois de criar o cliente o addon pede ao WHMCS o e-mail de "definir senha". Se essa chamada não existir na sua versão, o cadastro continua e o addon avisa o admin (sem bloquear a compra); nesse caso o cliente usa "Esqueci a senha" na área do cliente.
- Banner da fatura (versão 0.4.0, hook `ClientAreaFooterOutput`): a fatura de uma compra vinda da página mostra o botão "Voltar para a Way Cloud" e, depois de paga, volta sozinha. Confira se aparece na fatura (`viewinvoice.php`) e se o tema não esconde o rodapé.
- Se o Plesk aceita criar a assinatura em `<slug>.sites.waypreview.com.br` sem que o DNS já exista.

## 4. Desfazer

Em **Módulos de Addon**, clique em **Desativar**: os dados ficam guardados e nada de cobrança muda. Para remover de vez, apague a pasta `modules/addons/waycloud_ai/`. As tabelas `mod_waycloud_*` podem ser apagadas depois, se quiser.
