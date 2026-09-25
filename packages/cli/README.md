# waycloud

Publique o seu site na Way Cloud direto do terminal (ou peça para a sua IA rodar): compacta o projeto, cria uma prévia grátis e, com um plano ativo, publica com HTTPS.

```bash
npx waycloud deploy              # compacta a pasta atual, cria a prévia e publica (se houver plano ativo)
npx waycloud plans               # planos e preços
npx waycloud checkout --plano <pid> [--ciclo mensal|anual]   # link de pagamento (Pix ou cartão)
npx waycloud status              # pedido, último deploy e verificação do site
```

- Respeita `.gitignore` e `.waycloudignore` (mesma sintaxe). Nunca envia `.env`, `.git` nem `node_modules`; mantém `dist`, `build` e `out` mesmo quando ignorados.
- O estado da sessão fica em `.waycloud/session.json` (não é enviado). Adicione `.waycloud/` ao seu `.gitignore`.
- Sem dados pessoais ou de pagamento no terminal: o cadastro e o pagamento acontecem no navegador, no link do `checkout`.
- Requer Node 20 ou mais novo. Endereço do serviço alterável com `WAYCLOUD_URL`.

`waycloud logs` e `waycloud rollback` chegam na próxima versão.
