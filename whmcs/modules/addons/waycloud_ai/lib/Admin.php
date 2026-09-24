<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** Admin page of the addon: diagnostics, plan map, recent checkouts and events (no personal data). */
final class Admin
{
    private static function h(mixed $v): string
    {
        return htmlspecialchars((string) $v, ENT_QUOTES, 'UTF-8');
    }

    private static function when(mixed $ts): string
    {
        return $ts ? date('d/m/Y H:i', (int) $ts) : '-';
    }

    public static function render(string $moduleLink): string
    {
        $store = Container::store();
        $whmcs = Container::whmcs();
        $settings = Container::settings();
        $notice = '';

        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && isset($_POST['wc_save_plans'])) {
            $map = [];
            foreach (['static' => 'pid_static', 'php' => 'pid_php'] as $type => $field) {
                $pid = filter_var($_POST[$field] ?? '', FILTER_VALIDATE_INT);
                if ($pid !== false && $pid > 0 && $whmcs->productInfo($pid) !== null) {
                    $map[$type] = $pid;
                }
            }
            $store->savePlanMap($map);
            $notice = count($map) === 2 ? 'Mapa de planos salvo.' : 'Salvo, mas algum produto não foi encontrado e ficou de fora.';
        }

        $h = '<h2>Way Cloud AI Deploy</h2>';
        if ($notice !== '') {
            $h .= '<div class="successbox">' . self::h($notice) . '</div>';
        }

        $h .= '<h3>Diagnóstico</h3><table class="datatable" width="100%"><tr><th>Item</th><th>Situação</th><th>Detalhe</th></tr>';
        foreach (Diagnostics::run($store, $whmcs, $settings) as $c) {
            $h .= '<tr><td>' . self::h($c['label']) . '</td><td>' . ($c['ok'] ? '<span style="color:#0b6b3a">OK</span>' : '<b style="color:#b42318">Ajustar</b>') . '</td><td>' . self::h($c['detail']) . '</td></tr>';
        }
        $h .= '</table>';

        $map = $store->planMap();
        $token = function_exists('generate_token') ? generate_token('plain') : '';
        $h .= '<h3>Mapa de planos</h3><p>Informe o ID (pid) do produto oculto de cada tipo de projeto.</p>'
            . '<form method="post" action="' . self::h($moduleLink) . '"><input type="hidden" name="token" value="' . self::h($token) . '">'
            . '<p>Sites estáticos e SPA: <input type="number" name="pid_static" value="' . self::h($map['static'] ?? '') . '" min="1"> '
            . 'Sites PHP: <input type="number" name="pid_php" value="' . self::h($map['php'] ?? '') . '" min="1"> '
            . '<button type="submit" name="wc_save_plans" value="1" class="btn btn-primary">Salvar</button></p></form>';

        $h .= '<h3>Últimas contratações</h3><table class="datatable" width="100%"><tr><th>#</th><th>Status</th><th>Plano (pid)</th><th>Ciclo</th><th>Domínio</th><th>Pedido</th><th>Fatura</th><th>Serviço</th><th>Criada em</th></tr>';
        foreach ($store->recentCheckouts(25) as $c) {
            $h .= '<tr><td>' . self::h($c['id']) . '</td><td>' . self::h($c['status']) . '</td><td>' . self::h($c['pid']) . '</td><td>' . self::h($c['cycle']) . '</td><td>' . self::h($c['domain']) . '</td><td>'
                . self::h($c['order_id'] ?? '-') . '</td><td>' . self::h($c['invoice_id'] ?? '-') . '</td><td>' . self::h($c['service_id'] ?? '-') . '</td><td>' . self::when($c['created_at']) . '</td></tr>';
        }
        $h .= '</table>';

        $h .= '<h3>Eventos recentes</h3><table class="datatable" width="100%"><tr><th>Quando</th><th>Tipo</th><th>Ref.</th><th>Dados</th></tr>';
        foreach ($store->recentEvents(25) as $e) {
            $h .= '<tr><td>' . self::when($e['created_at'] ?? null) . '</td><td>' . self::h($e['type'] ?? '') . '</td><td>' . self::h($e['ref'] ?? '') . '</td><td>' . self::h($e['data'] ?? '') . '</td></tr>';
        }
        return $h . '</table>';
    }
}
