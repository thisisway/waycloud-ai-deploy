# Agente de deploy da Way Cloud

Script em Bash que roda como **root** em cada servidor Plesk e publica os sites enviados pelo serviço MCP.
Ele só faz conexões de **saída** (HTTPS) para o serviço; não abre nenhuma porta.

## O que ele faz, em ordem
1. Pergunta ao serviço se há um deploy na fila (a cada 5 s).
2. **Valida cada campo** do job: domínio (só letras minúsculas, números, hífen e pontos), UUID, SHA-256, tamanho e versão do PHP.
3. Baixa o pacote e confere o **SHA-256** antes de extrair qualquer coisa.
4. Extrai numa pasta privada, remove symlinks e arquivos especiais, ajusta dono e permissões iguais aos do site atual.
5. **Troca** o `httpdocs` por dois `mv` (mesmo sistema de arquivos): o site anterior vira um *snapshot*.
6. Ajusta o PHP (`plesk bin site --update`) quando o projeto é PHP e faz uma **checagem local** (HTTP 2xx neste servidor).
7. Se qualquer passo depois da troca falhar, **restaura o snapshot** automaticamente. O site nunca fica pela metade.
8. Tenta emitir o certificado Let's Encrypt (se ainda não houver). Sem DNS apontado, o site fica no ar em HTTP até o certificado sair.
9. Mantém só os últimos 5 snapshots.

## Onde ficam as coisas
| O quê | Onde |
|---|---|
| Agente | `/opt/waycloud/waycloud-agent.sh` |
| Configuração e token | `/etc/waycloud-agent.env` (root, modo 600) |
| Snapshots e versões que falharam | `/var/www/vhosts/.waycloud-agent/<domínio>/{snapshots,failed}` (root, modo 700; o cliente não alcança) |
| Logs | `journalctl -u waycloud-agent` |

## Instalar
```
bash install.sh --api https://<serviço>/agent/v1 --token <token> --le-email contato@waycloud.com.br
```
Leia o `install.sh` antes: ele lista tudo o que cria. Para remover: `bash install.sh --uninstall`.

## Atualizar o agente
O serviço entrega a versão atual do script (com o mesmo token do agente). No servidor, como root:
```
set -a; . /etc/waycloud-agent.env; set +a
curl -fsS -H "Authorization: Bearer $WC_TOKEN" "$WC_API/waycloud-agent.sh" -o /tmp/wc-agent.sh   && bash -n /tmp/wc-agent.sh && install -m 750 /tmp/wc-agent.sh /opt/waycloud/waycloud-agent.sh   && systemctl restart waycloud-agent
```

## Certificado (HTTPS)
O Plesk cria todo site com "redirecionar HTTP para HTTPS" ligado. Sem certificado válido isso deixa o site inacessível (e trava a própria validação do Let's Encrypt). Por isso o agente **desliga o redirecionamento** enquanto não há certificado do Let's Encrypt, pede o certificado e só então liga o redirecionamento de volta (`plesk bin site --update <domínio> -ssl-redirect true|false`).
Se o certificado não sair na hora (DNS ainda não propagou, limite do Let's Encrypt...), o domínio entra em `/var/lib/waycloud-agent/ssl-pending/` e é tentado de novo com pausas crescentes (2, 5, 10, 20, 40 e 60 minutos) por até 24 horas. Quando sai, o agente avisa o serviço e a página do cliente mostra o HTTPS ativo.

## Domínio do cliente
Quando o cliente conecta o domínio dele (e o DNS já aponta para nós), o serviço entrega ao agente um trabalho de troca de domínio. O agente:
1. `plesk bin subscription --update <provisório> -new-name <domínio do cliente>` (o Plesk move a pasta do site junto);
2. confere que a pasta ficou em `/var/www/vhosts/<domínio>/httpdocs` e que o site responde nesse nome. Se qualquer coisa fugir do esperado, **volta o nome anterior** e reporta a falha: o site nunca fica pela metade;
3. leva os snapshots de rollback junto e pede o certificado para o domínio (e `www`, se ele também aponta para nós), com o redirecionamento HTTP->HTTPS desligado até o certificado existir (mesma lógica de nova tentativa por 24 h).
Depois o serviço atualiza o domínio do serviço no WHMCS (ação `update_service_domain` do addon, a partir da versão 0.5.0), porque o módulo do Plesk no WHMCS acha a assinatura pelo domínio (suspender, encerrar...).

## Voltar a versão anterior à mão
```
D=/var/www/vhosts/<domínio>; S=$D/../.waycloud-agent/<domínio>/snapshots
ls -1t $S | head                         # snapshots, do mais novo para o mais antigo
mv $D/httpdocs /tmp/httpdocs.ruim && mv $S/<snapshot> $D/httpdocs
```

## Se der problema
- `journalctl -u waycloud-agent -n 50`: cada passo registra o job, o status enviado e o código de erro.
- `token rejected (401)`: o token foi trocado no serviço; atualize `WC_TOKEN` em `/etc/waycloud-agent.env` e `systemctl restart waycloud-agent`.
- Códigos de erro: `invalid_*` (job recusado), `vhost_not_found`, `sha256_mismatch`, `no_index`, `local_check_failed` (voltou ao anterior), `php_handler_failed` (voltou ao anterior).
