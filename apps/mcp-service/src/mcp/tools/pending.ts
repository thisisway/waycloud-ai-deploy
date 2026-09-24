import { erro } from "@waycloud/shared";
import { defineTool } from "./define.js";

// Registered so the tool list and schemas are final; the behavior arrives in later milestones.
const notYet = async () => erro("NAO_IMPLEMENTADO");

export default [
  defineTool("publicar", "Use só com o pedido ativo: publica o site na hospedagem definitiva com SSL. (M5)", notYet),
  defineTool("status_deploy", "Use depois de publicar para acompanhar o andamento do deploy. (M5)", notYet),
  defineTool("verificar_site", "Use depois do deploy: confere HTTP, SSL, links quebrados e tempo de resposta e devolve um relatório curto. (M5)", notYet),
];
