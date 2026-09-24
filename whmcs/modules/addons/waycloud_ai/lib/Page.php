<?php
declare(strict_types=1);

namespace WayCloud\Ai;

/** Client-area page: index.php?m=waycloud_ai&t=<token>. Thin glue between WHMCS and Checkout. */
final class Page
{
    /** @param array<string,mixed> $vars @return array<string,mixed> */
    public static function handle(array $vars): array
    {
        $settings = Container::settings();
        $checkout = Container::checkout();
        $whmcs = Container::whmcs();

        $token = (string) ($_POST['t'] ?? $_GET['t'] ?? '');
        $errors = [];
        $old = [];
        $loginUrl = null;

        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            $r = $checkout->submit($token, $_POST, $whmcs->currentClientId());
            if ($r['ok'] && $r['redirect'] !== null) {
                header('Location: ' . $r['redirect']);
                exit;
            }
            $errors = $r['errors'];
            $loginUrl = $r['login_url'];
            // Never send the password back to the browser.
            $old = array_intersect_key($_POST, array_flip(['nome', 'email', 'doc_tipo', 'doc_numero', 'telefone']));
        }

        $view = $checkout->view($token);
        return [
            'pagetitle' => 'Finalizar contratação',
            'breadcrumb' => ['index.php?m=waycloud_ai' => 'Contratação'],
            'templatefile' => 'templates/checkout',
            'requirelogin' => false,
            'forcessl' => true,
            'vars' => [
                'wc_state' => $view['state'],
                'wc_plan' => $view['plan_name'],
                'wc_price' => 'R$ ' . number_format($view['price_cents'] / 100, 2, ',', '.'),
                'wc_cycle' => $view['cycle_label'],
                'wc_logged_in' => $view['logged_in'],
                'wc_errors' => $errors,
                'wc_old' => $old,
                'wc_login_url' => $loginUrl,
                'wc_token' => $token,
                'wc_csrf' => function_exists('generate_token') ? generate_token('plain') : '',
                'wc_terms' => $settings->get('terms_url'),
                'wc_privacy' => $settings->get('privacy_url'),
            ],
        ];
    }
}
