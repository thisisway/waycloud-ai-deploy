// Every user-facing string lives here as a fixed template. Tool responses NEVER echo text taken
// from the customer's project (prompt-injection defense), only these strings.

export const MENSAGENS = {
  SESSAO_CRIADA: {
    mensagem: "Tudo certo! Vou te ajudar a colocar o seu site no ar na Way Cloud.",
    proximo: "Analise a pasta do projeto e chame analisar_projeto com a lista de arquivos (sem node_modules).",
  },
  PROJETO_ANALISADO: {
    mensagem: "Analisei o seu projeto.",
    proximo: "Conte ao cliente o tipo do projeto e o plano recomendado. Depois envie os arquivos.",
  },
  PROJETO_NAO_SUPORTADO: {
    mensagem: "Ainda não consigo publicar esse tipo de projeto automaticamente.",
    proximo: "Explique ao cliente que esse tipo de projeto será aceito em breve e indique o suporte da Way Cloud.",
  },
  PLANOS_LISTADOS: {
    mensagem: "Estes são os planos da Way Cloud.",
    proximo: "Mostre os planos ao cliente e pergunte qual prefere e se o pagamento será mensal ou anual.",
  },
  SESSAO_INVALIDA: {
    mensagem: "Não encontrei essa sessão. Ela pode ter expirado.",
    proximo: "Chame iniciar_sessao para começar de novo.",
  },
  ENTRADA_INVALIDA: {
    mensagem: "Os dados enviados não estão no formato esperado.",
    proximo: "Corrija os campos informados e tente novamente.",
  },
  UPLOAD_PRONTO: {
    mensagem: "Pronto! Já posso receber o arquivo .zip do seu projeto.",
    proximo: "Faça um PUT do .zip na URL informada, com exatamente o tamanho combinado. Depois chame criar_previa.",
  },
  ARQUIVOS_RECEBIDOS: {
    mensagem: "Recebi os arquivos do seu site.",
    proximo: "Chame criar_previa para publicar uma prévia grátis e mostrar ao cliente.",
  },
  ARQUIVOS_REPROVADOS: {
    mensagem: "Não foi possível aceitar alguns arquivos por segurança.",
    proximo: "Remova arquivos executáveis ou suspeitos e envie de novo. Se for um engano, indique o suporte da Way Cloud.",
  },
  ARQUIVOS_INVALIDOS: {
    mensagem: "Os arquivos enviados não estão em um formato válido.",
    proximo: "Confira os caminhos e o conteúdo (base64) e tente novamente.",
  },
  ARQUIVOS_MUITO_GRANDES: {
    mensagem: "Os arquivos passam do limite para envio direto.",
    proximo: "Use obter_url_upload para enviar o projeto em um .zip.",
  },
  UPLOAD_NAO_ENCONTRADO: {
    mensagem: "Ainda não recebi o arquivo do projeto.",
    proximo: "Envie o .zip para a URL de upload e chame criar_previa de novo.",
  },
  ARQUIVO_INVALIDO: {
    mensagem: "O arquivo .zip enviado não pôde ser lido ou passa dos limites permitidos.",
    proximo: "Gere o .zip de novo, sem node_modules, e envie outra vez.",
  },
  LIMITE_EXCEDIDO: {
    mensagem: "Você atingiu o limite de envios ou prévias desta sessão.",
    proximo: "Aguarde a prévia atual expirar ou use uma prévia já criada.",
  },
  PREVIA_CRIADA: {
    mensagem: "Sua prévia está no ar! Ela é temporária e some sozinha.",
    proximo: "Mostre o link ao cliente e pergunte se quer publicar de verdade. Se sim, escolha o plano e use criar_checkout.",
  },
  PREVIA_INDISPONIVEL_PHP: {
    mensagem: "Sites em PHP não têm prévia grátis, porque só rodam depois da contratação.",
    proximo: "Explique isso ao cliente e, se ele quiser seguir, mostre os planos (listar_planos) e use criar_checkout.",
  },
  PASTA_BUILD_AUSENTE: {
    mensagem: "Não encontrei a pasta com o site pronto (build).",
    proximo: "Rode o build do projeto (por exemplo, npm run build), gere o .zip incluindo a pasta de saída e envie de novo.",
  },
  CHECKOUT_CRIADO: {
    mensagem: "Pronto! Gerei o link para você contratar com segurança.",
    proximo: "Entregue o link ao cliente: ele faz o cadastro rápido e paga no navegador (Pix ou cartão). Depois use status_pedido para acompanhar. Nunca peça dados pessoais ou de pagamento no chat.",
  },
  PLANO_INVALIDO: {
    mensagem: "Esse plano não está disponível.",
    proximo: "Use listar_planos e escolha um dos planos mostrados, com ciclo mensal ou anual.",
  },
  CHECKOUT_INDISPONIVEL: {
    mensagem: "Não consegui gerar o link de pagamento agora.",
    proximo: "Peça ao cliente para tentar de novo em alguns minutos. Se persistir, indique o suporte da Way Cloud.",
  },
  PLANOS_INDISPONIVEIS: {
    mensagem: "Não consegui consultar os planos agora.",
    proximo: "Tente de novo em alguns instantes. Se persistir, indique o suporte da Way Cloud.",
  },
  SEM_PEDIDO: {
    mensagem: "Ainda não há um pedido para esta sessão.",
    proximo: "Gere o link de pagamento com criar_checkout e entregue ao cliente.",
  },
  PEDIDO_AGUARDANDO: {
    mensagem: "Estamos aguardando o pagamento.",
    proximo: "Peça ao cliente para concluir o pagamento no link (Pix ou cartão) e consulte status_pedido de novo em cerca de 30 segundos.",
  },
  PEDIDO_PAGO: {
    mensagem: "Pagamento confirmado! Estamos criando a sua hospedagem.",
    proximo: "Aguarde e consulte status_pedido de novo em cerca de 5 segundos.",
  },
  PEDIDO_ATIVO: {
    mensagem: "Sua hospedagem está pronta!",
    proximo: "Use publicar para colocar o site no ar.",
  },
  PEDIDO_FALHOU: {
    mensagem: "O pagamento foi recebido, mas houve um problema ao criar a hospedagem. Nossa equipe já foi avisada.",
    proximo: "Explique ao cliente que o suporte da Way Cloud vai entrar em contato. Não tente publicar.",
  },
  PEDIDO_NAO_ATIVO: {
    mensagem: "Ainda não posso publicar: a hospedagem deste pedido não está ativa.",
    proximo: "Use status_pedido e aguarde ficar ativo (depois do pagamento). Não tente publicar antes.",
  },
  DEPLOY_INICIADO: {
    mensagem: "Certo! Estou publicando o seu site.",
    proximo: "Consulte status_deploy a cada 5 segundos até o site ser publicado.",
  },
  DEPLOY_EM_ANDAMENTO: {
    mensagem: "Já existe uma publicação em andamento para este site.",
    proximo: "Aguarde ela terminar consultando status_deploy.",
  },
  DEPLOY_NAO_ENCONTRADO: {
    mensagem: "Não encontrei essa publicação.",
    proximo: "Chame publicar para iniciar uma nova publicação.",
  },
  DEPLOY_NA_FILA: {
    mensagem: "A publicação está na fila.",
    proximo: "Consulte status_deploy de novo em cerca de 5 segundos.",
  },
  DEPLOY_ENVIANDO: {
    mensagem: "Estou enviando os arquivos para a hospedagem.",
    proximo: "Consulte status_deploy de novo em cerca de 5 segundos.",
  },
  DEPLOY_VALIDANDO: {
    mensagem: "Estou conferindo o site antes de colocar no ar.",
    proximo: "Consulte status_deploy de novo em cerca de 5 segundos.",
  },
  DEPLOY_PUBLICADO: {
    mensagem: "Seu site está no ar!",
    proximo: "Mostre o endereço ao cliente e use verificar_site para conferir HTTPS, velocidade e links.",
  },
  DEPLOY_FALHOU: {
    mensagem: "Não consegui publicar o site. A versão anterior continua no ar, sem alteração.",
    proximo: "Confira os arquivos do projeto e tente publicar de novo. Se persistir, indique o suporte da Way Cloud.",
  },
  DEPLOY_REVERTIDO: {
    mensagem: "Encontrei um problema na nova versão e voltei automaticamente para a anterior.",
    proximo: "Confira os arquivos do projeto e tente publicar de novo. Se persistir, indique o suporte da Way Cloud.",
  },
  SITE_VERIFICADO: {
    mensagem: "Conferi o seu site e está tudo certo.",
    proximo: "Mostre o resultado ao cliente e explique os próximos passos: apontar o domínio e criar e-mails.",
  },
  SITE_COM_PROBLEMAS: {
    mensagem: "Conferi o seu site e encontrei pontos a corrigir.",
    proximo: "Explique ao cliente o que foi encontrado (HTTPS, tempo de resposta ou links quebrados). Se o HTTPS ainda não está ativo, pode levar alguns minutos.",
  },
  NAO_IMPLEMENTADO: {
    mensagem: "Esta etapa ainda não está disponível.",
    proximo: "Avise o cliente que essa etapa será liberada em breve.",
  },
} as const;

export type MensagemCodigo = keyof typeof MENSAGENS;

export const AVISOS = {
  ENV_EXCLUIDO: "Encontrei um arquivo .env com possíveis segredos. Ele não será publicado.",
  SQL_DETECTADO: "Encontrei arquivos .sql. O projeto provavelmente precisa de um banco de dados.",
  NODE_MODULES_IGNORADO: "A pasta node_modules será ignorada. Ela não deve ser enviada.",
  PASTA_BUILD_AUSENTE: "Não encontrei a pasta com o site pronto. Rode o build do projeto antes de publicar.",
  ARQUIVO_PROIBIDO: "Há arquivos executáveis que não podem ser publicados.",
  CAMINHO_INVALIDO: "Alguns arquivos têm caminhos inválidos e serão ignorados.",
  SEM_INDEX: "Não encontrei um arquivo index.html na raiz do site.",
  VERSAO_PHP_INDISPONIVEL: "A versão de PHP pedida pelo projeto não está disponível. Vamos usar a mais próxima.",
  PROJETO_GRANDE: "O projeto é maior do que o limite de todos os planos.",
  FRAMEWORK_PHP_NAO_SUPORTADO: "Frameworks PHP como Laravel ainda não são publicados automaticamente.",
  WORDPRESS_NAO_SUPORTADO: "Sites WordPress ainda não são publicados automaticamente.",
  NODE_NAO_SUPORTADO: "Aplicações Node.js com servidor ainda não são publicadas automaticamente.",
  ARQUIVOS_DESNECESSARIOS_REMOVIDOS: "Removi arquivos desnecessários (como node_modules e .git) do pacote.",
  TIPO_DESCONHECIDO: "Não consegui identificar o tipo do projeto.",
} as const;

export type AvisoCodigo = keyof typeof AVISOS;
