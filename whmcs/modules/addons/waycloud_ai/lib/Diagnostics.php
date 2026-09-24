<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/**
 * Health checks shown in the admin page. They exist because some WHMCS API details can only be
 * confirmed on the live installation; a red line here tells the admin exactly what to fix.
 */
final class Diagnostics
{
    /** @return list<array{label:string, ok:bool, detail:string}> */
    public static function run(Store $store, WhmcsApi $whmcs, Settings $settings): array
    {
        $checks = [];
        $add = static function (string $label, bool $ok, string $detail) use (&$checks): void {
            $checks[] = ['label' => $label, 'ok' => $ok, 'detail' => $detail];
        };

        $secretOk = strlen($settings->get('hmac_secret')) >= Hmac::MIN_SECRET_LENGTH;
        $add('Segredo HMAC', $secretOk, $secretOk ? 'Configurado.' : 'Defina um segredo de pelo menos ' . Hmac::MIN_SECRET_LENGTH . ' caracteres (o mesmo do serviço MCP).');

        $mcp = $settings->mcpUrl();
        if ($mcp === '') {
            $add('Serviço MCP', false, 'Informe a URL do serviço MCP nas configurações do addon.');
        } else {
            $status = Http::get($mcp . '/healthz');
            $add('Serviço MCP', $status === 200, $status === 200 ? 'Respondeu ao teste de saúde.' : 'Sem resposta (HTTP ' . $status . ').');
        }

        $ids = $whmcs->clientCustomFieldIds();
        foreach (['Tipo de documento', 'CPF/CNPJ'] as $name) {
            $add('Campo de cliente "' . $name . '"', isset($ids[$name]), isset($ids[$name]) ? 'Encontrado.' : 'Não encontrado: crie o campo personalizado de cliente com este nome exato.');
        }

        $handled = ['CPF/CNPJ', 'Celular', 'Tipo de documento'];
        $unhandled = array_values(array_diff($whmcs->requiredClientFieldNames(), $handled));
        $add('Campos obrigatórios de cliente', $unhandled === [], $unhandled === []
            ? 'O cadastro rápido preenche todos os campos personalizados obrigatórios.'
            : 'O cadastro rápido não preenche: ' . implode(', ', $unhandled) . '. Torne-os opcionais no WHMCS, ou a compra vai falhar.');

        $map = $store->planMap();
        foreach (['static' => 'Sites estáticos e SPA', 'php' => 'Sites PHP'] as $type => $label) {
            $pid = $map[$type] ?? 0;
            $info = $pid > 0 ? $whmcs->productInfo($pid) : null;
            $add('Produto para ' . $label, $info !== null, $info !== null ? $info['name'] . ' (pid ' . $pid . ')' : 'Escolha o produto na seção "Mapa de planos".');
        }

        $modules = $whmcs->paymentModules();
        $pay = $settings->get('default_payment');
        $add('Forma de pagamento padrão', in_array($pay, $modules, true), in_array($pay, $modules, true) ? $pay . ' está ativo.' : 'O módulo "' . $pay . '" não está ativo entre os gateways.');

        $pending = $store->pendingOutbox();
        $add('Eventos aguardando envio', $pending === 0, $pending === 0 ? 'Nenhum.' : $pending . ' pendente(s): serão reenviados pelo cron do WHMCS.');

        return $checks;
    }
}
